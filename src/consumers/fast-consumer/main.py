"""
Fast consumer — reads from MSK with per-topic threads, dispatches to domain handlers.
Writes to Neptune via HTTP REST API. No Bedrock calls.

Each topic gets its own consumer thread for concurrent processing.
Same-entity events stay ordered (Kafka partition key = entityId).
"""

import json
import logging
import os
import sys
import threading
import time

from kafka import KafkaConsumer

from graph_writer import execute_gremlin
from handlers import TOPIC_HANDLERS

# ISA-95 L3: B2MML happy-path serialization for NCR + WO_STARTED + OP_COMPLETE.
# Optional — gated on B2MML_ENABLED env var so the consumer doesn't write XML
# during dev or when the archive bucket isn't provisioned.
B2MML_ENABLED = os.environ.get('B2MML_ENABLED', 'false').lower() == 'true'
if B2MML_ENABLED:
    import b2mml as b2mml_mod
else:
    b2mml_mod = None

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger('fast-consumer')

BOOTSTRAP_SERVERS = os.environ.get('BOOTSTRAP_SERVERS', '')
NEPTUNE_ENDPOINT = os.environ.get('NEPTUNE_ENDPOINT', '')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')

TOPICS = list(TOPIC_HANDLERS.keys())


def consume_topic(topic: str, handler, bootstrap_servers: str):
    """Consume a single MSK topic in its own thread."""
    thread_name = topic.split('.')[-2]  # e.g. 'qms' from 'aerospace.qms.events'
    logger.info('[%s] Starting consumer thread for %s', thread_name, topic)
    try:
        _consume_topic_inner(topic, handler, bootstrap_servers, thread_name)
    except Exception:
        logger.exception('[%s] CONSUMER THREAD CRASHED for %s', thread_name, topic)
    logger.warning('[%s] Consumer thread EXITED (should never happen)', thread_name)


def _consume_topic_inner(topic: str, handler, bootstrap_servers: str, thread_name: str):

    from aws_msk_iam_sasl_signer import MSKAuthTokenProvider

    class MSKTokenProvider:
        def token(self):
            token, _ = MSKAuthTokenProvider.generate_auth_token(REGION)
            return token

    tp = MSKTokenProvider()

    logger.info('[%s] Creating KafkaConsumer (TLS+SASL)...', thread_name)
    group_id = f'digital-thread-fast-{thread_name}'

    # Each topic thread gets its own consumer with a unique group ID suffix
    consumer = KafkaConsumer(
        topic,
        bootstrap_servers=bootstrap_servers.split(','),
        group_id=group_id,
        auto_offset_reset='latest',
        enable_auto_commit=False,
        security_protocol='SASL_SSL',
        sasl_mechanism='OAUTHBEARER',
        sasl_oauth_token_provider=tp,
        value_deserializer=lambda m: json.loads(m.decode('utf-8')),
        request_timeout_ms=30000,
        session_timeout_ms=15000,
    )

    # Verify connection by fetching topic metadata
    partitions = consumer.partitions_for_topic(topic)
    if partitions:
        logger.info('[%s] CONNECTED — topic=%s partitions=%s group=%s', thread_name, topic, partitions, group_id)
    else:
        logger.error('[%s] FAILED — topic=%s has no partitions (topic may not exist in MSK)', thread_name, topic)
        return

    # Log current offsets
    assignment = consumer.assignment()
    logger.info('[%s] Assigned partitions: %s', thread_name, assignment)
    for tp_part in assignment:
        pos = consumer.position(tp_part)
        logger.info('[%s] Partition %s position=%s', thread_name, tp_part.partition, pos)

    logger.info('[%s] Waiting for messages...', thread_name)
    processed = 0

    for message in consumer:
        try:
            event = message.value
            et = event.get('eventType', '?')
            eid = event.get('entityId', '?')
            if processed == 0:
                logger.info('[%s] First message received: %s:%s offset=%s', thread_name, et, eid, message.offset)
            handler(event)
            # ISA-95 L3: B2MML XML side-effect (best-effort, never fails the handler)
            if b2mml_mod is not None:
                xml = b2mml_mod.build(event)
                if xml is not None:
                    b2mml_mod.archive(event, xml)
            consumer.commit()
            processed += 1
            if processed % 50 == 0:
                logger.info('[%s] Processed %d events (last: %s:%s)', thread_name, processed, et, eid)
        except Exception:
            logger.exception('[%s] Error processing %s:%s offset=%s', thread_name, et, eid, message.offset)


def main():
    logger.info('Fast consumer starting — %d topics, concurrent mode', len(TOPICS))

    if not BOOTSTRAP_SERVERS or not NEPTUNE_ENDPOINT:
        logger.error('Missing BOOTSTRAP_SERVERS or NEPTUNE_ENDPOINT')
        sys.exit(1)

    # Test Neptune connectivity
    try:
        result = execute_gremlin("g.V().limit(1)")
        logger.info('Neptune connectivity OK: %s', result.get('status', {}).get('code'))
    except Exception as e:
        logger.error('Neptune connectivity FAILED: %s', e)
        raise

    # Launch one thread per topic — staggered to avoid MSK connection contention
    threads = []
    for i, topic in enumerate(TOPICS):
        handler = TOPIC_HANDLERS[topic]
        t = threading.Thread(
            target=consume_topic,
            args=(topic, handler, BOOTSTRAP_SERVERS),
            name=f'consumer-{topic.split(".")[-2]}',
            daemon=True,
        )
        t.start()
        threads.append(t)
        logger.info('Launched thread %d/%d for %s', i + 1, len(TOPICS), topic)
        # Stagger thread startup: 2s between each to avoid overwhelming MSK with
        # 10 simultaneous TLS+SASL connections on t3.small brokers
        if i < len(TOPICS) - 1:
            time.sleep(2)  # nosemgrep: arbitrary-sleep -- intentional MSK poll/backoff

    logger.info('All %d consumer threads launched — waiting 30s for connections to stabilize', len(threads))
    time.sleep(30)  # nosemgrep: arbitrary-sleep -- intentional MSK poll/backoff

    # Report which threads are alive
    alive = [t.name for t in threads if t.is_alive()]
    dead = [t.name for t in threads if not t.is_alive()]
    logger.info('Thread status: %d alive, %d dead', len(alive), len(dead))
    if dead:
        logger.error('DEAD threads: %s', dead)
    for t in alive:
        logger.info('  ALIVE: %s', t)

    # Keep main thread alive — daemon threads die when main exits
    try:
        while True:
            # Periodic health check every 60s
            time.sleep(60)  # nosemgrep: arbitrary-sleep -- intentional MSK poll/backoff
            alive = [t.name for t in threads if t.is_alive()]
            dead = [t.name for t in threads if not t.is_alive()]
            if dead:
                logger.error('DEAD threads detected: %s (alive: %d)', dead, len(alive))
    except KeyboardInterrupt:
        logger.info('Shutting down...')


if __name__ == '__main__':
    main()
