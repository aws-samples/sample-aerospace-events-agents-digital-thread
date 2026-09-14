"""
Slow consumer — Certification Readiness Agent (Strands).
Reads cert-relevant events from MSK, invokes a Strands agent with Bedrock,
writes CoherenceVerdict and ThreadGap nodes to Neptune via HTTP REST API.
"""

import json
import logging
import os
import time

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from kafka import KafkaConsumer

from cert_readiness_agent import assess_cert_readiness

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger('slow-consumer')

BOOTSTRAP_SERVERS = os.environ.get('BOOTSTRAP_SERVERS', '')
NEPTUNE_ENDPOINT = os.environ.get('NEPTUNE_ENDPOINT', '')
NEPTUNE_PORT = os.environ.get('NEPTUNE_PORT', '8182')
OFFSETS_TABLE = os.environ.get('OFFSETS_TABLE', 'digital-thread-offsets')
TOPICS = ['aerospace.qms.events']
GROUP_ID = 'digital-thread-slow'
REGION = os.environ.get('AWS_REGION', 'eu-west-1')

CERT_RELEVANT = {'NON_CONFORMANCE_RAISED', 'NCR_CLOSED', 'INSPECTION_COMPLETED', 'FAI_APPROVED'}


def neptune_query(gremlin: str) -> dict:
    """Execute a Gremlin query via Neptune HTTP REST API with SigV4 auth."""
    url = f'https://{NEPTUNE_ENDPOINT}:{NEPTUNE_PORT}/gremlin'
    body = json.dumps({'gremlin': gremlin})

    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()
    request = AWSRequest(method='POST', url=url, data=body, headers={'Content-Type': 'application/json'})
    SigV4Auth(credentials, 'neptune-db', REGION).add_auth(request)

    response = requests.post(url, data=body, headers=dict(request.headers), timeout=30)
    response.raise_for_status()
    return response.json()


def escape(s: str) -> str:
    return s.replace("'", "\\'").replace('"', '\\"')


def is_processed(dynamodb, event_id: str, node_id: str) -> bool:
    table = dynamodb.Table(OFFSETS_TABLE)
    resp = table.get_item(Key={'PK': f'SLOW#{event_id}', 'SK': f'NODE#{node_id}'})
    return 'Item' in resp


def mark_processed(dynamodb, event_id: str, node_id: str):
    table = dynamodb.Table(OFFSETS_TABLE)
    table.put_item(Item={
        'PK': f'SLOW#{event_id}',
        'SK': f'NODE#{node_id}',
        'processedAt': int(time.time()),
    })


def write_verdict(dynamodb, event: dict, verdict: dict):
    """Write CoherenceVerdict and/or ThreadGap nodes to Neptune via HTTP."""
    event_id = event['eventId']
    payload = event.get('payload', {})
    sn = escape(payload.get('serialNumber', 'SN-0047'))

    verdict_id = f'VERDICT-{event_id[:8]}'
    if is_processed(dynamodb, event_id, verdict_id):
        logger.info('Verdict already written for %s', event_id)
        return

    # Write CoherenceVerdict node
    neptune_query(f"""
        g.V().has('CoherenceVerdict', 'id', '{escape(verdict_id)}').fold().coalesce(
            unfold(), addV('CoherenceVerdict').property('id', '{escape(verdict_id)}')
        ).property('verdictType', '{escape(verdict.get("verdict_type", "UNKNOWN"))}')
         .property('confidence', {verdict.get('confidence', 0)})
         .property('reasoning', '{escape(verdict.get("reasoning", "")[:2000])}')
         .property('serialNumber', '{sn}')
         .property('sourceEventId', '{escape(event_id)}')
    """)

    # Write ThreadGap nodes
    for gap in verdict.get('gaps_opened', []):
        gap_id = f'GAP-{event_id[:8]}-{gap.get("gap_type", "X")[:10]}'
        neptune_query(f"""
            g.V().has('ThreadGap', 'id', '{escape(gap_id)}').fold().coalesce(
                unfold(), addV('ThreadGap').property('id', '{escape(gap_id)}')
            ).property('gapType', '{escape(gap.get("gap_type", "UNKNOWN"))}')
             .property('description', '{escape(gap.get("description", "")[:2000])}')
             .property('severity', '{escape(gap.get("severity", "MEDIUM"))}')
             .property('serialNumber', '{sn}')
             .property('sourceEventId', '{escape(event_id)}')
        """)

    # Upsert AsBuiltRecord
    neptune_query(f"""
        g.V().has('AsBuiltRecord', 'id', 'ABR-{sn}').fold().coalesce(
            unfold(), addV('AsBuiltRecord').property('id', 'ABR-{sn}').property('completenessScore', 50)
        ).property('serialNumber', '{sn}')
         .property('lastUpdated', {int(time.time())})
    """)

    mark_processed(dynamodb, event_id, verdict_id)
    logger.info('Wrote verdict %s (%s, confidence=%.2f) + %d gaps',
                verdict_id, verdict.get('verdict_type'), verdict.get('confidence', 0),
                len(verdict.get('gaps_opened', [])))


def main():
    logger.info('Slow consumer (Strands Cert Readiness Agent, HTTP REST) starting')

    if not BOOTSTRAP_SERVERS or not NEPTUNE_ENDPOINT:
        logger.error('Missing BOOTSTRAP_SERVERS or NEPTUNE_ENDPOINT')
        return

    dynamodb = boto3.resource('dynamodb', region_name=REGION)

    # Test Neptune connectivity
    try:
        result = neptune_query("g.V().limit(1)")
        logger.info('Neptune HTTP connectivity OK')
    except Exception as e:
        logger.error('Neptune HTTP connectivity FAILED: %s', e)
        raise

    from aws_msk_iam_sasl_signer import MSKAuthTokenProvider

    class MSKTokenProvider:
        def token(self):
            token, _ = MSKAuthTokenProvider.generate_auth_token(REGION)
            return token

    tp = MSKTokenProvider()

    consumer = KafkaConsumer(
        *TOPICS,
        bootstrap_servers=BOOTSTRAP_SERVERS.split(','),
        group_id=GROUP_ID,
        auto_offset_reset='latest',
        enable_auto_commit=False,
        security_protocol='SASL_SSL',
        sasl_mechanism='OAUTHBEARER',
        sasl_oauth_token_provider=tp,
        value_deserializer=lambda m: json.loads(m.decode('utf-8')),
    )

    logger.info('Connected to MSK and Neptune (HTTP REST)')

    for message in consumer:
        try:
            event = message.value
            event_type = event.get('eventType')

            if event_type not in CERT_RELEVANT:
                consumer.commit()
                continue

            # Skip seed baseline events — historical data, no Bedrock assessment needed
            payload = event.get('payload', {})
            actor = event.get('actor', {})
            if payload.get('raisedBy') == 'seed-baseline' or payload.get('lastModifiedBy') == 'seed-baseline' or actor.get('userId') == 'seed-baseline':
                logger.info('Skipping seed event: %s:%s', event_type, event.get('entityId'))
                consumer.commit()
                continue

            logger.info('Assessing cert readiness for %s:%s', event_type, event.get('entityId'))
            verdict = assess_cert_readiness(event)

            if verdict:
                write_verdict(dynamodb, event, verdict)

            consumer.commit()
        except Exception:
            logger.exception('Error processing message offset=%s', message.offset)


if __name__ == '__main__':
    main()
