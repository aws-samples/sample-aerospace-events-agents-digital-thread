"""CloudFormation Custom Resource: AWS Agent Registry lifecycle.

Manages one Registry + one A2A RegistryRecord per agent, since CloudFormation has no
native resource types for the AgentCore Agent Registry (preview). Each record carries
the agent's A2A agent card (schemaVersion 0.3.0) in descriptors.a2a.agentCard.inlineContent;
the card's "url" is the runtime invocation endpoint that call_agent dispatches to.

Ported from aws-samples/sample-multi-agent-on-agentcore (MCP variant), adapted for A2A.
See spikes/agent-registry/FINDINGS.md for the probed API contract.

ResourceProperties:
  Action=MANAGE_REGISTRY: RegistryName, RegistryDescription?, AutoApproval?("true"/"false")
  Action=MANAGE_RECORD:   RegistryId, RecordName, RecordDescription, RecordVersion,
                          RuntimeArn, AgentName, AgentDomain?, Skills?(JSON array)
                          The Lambda builds the A2A agent card (incl. escaped runtime URL)
                          from these — TS can't URL-escape an unresolved CFN token at synth.

Requires botocore >= 1.43.0 — the Lambda bundles it (Lambda's built-in SDK lags the preview).
"""

import json
import logging
import os
import time
import urllib.parse
import urllib.request

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
A2A_SCHEMA_VERSION = '0.3.0'  # only 0.3.x accepted for descriptorType=A2A (spike-confirmed)
# Phase 1 dual-write: the registry is non-authoritative (USE_AGENT_REGISTRY=false), so a
# preview-API hiccup on Create must NOT roll back the whole AgentCoreStack (10 runtimes + JSON
# map). Fail soft = return SUCCESS on Create failures. Flip to 'false' in Phase 2 when the
# registry becomes authoritative and its integrity should gate the deploy.
FAIL_SOFT = os.environ.get('REGISTRY_FAIL_SOFT', 'true').lower() == 'true'

client = boto3.client('agent-registry-control', region_name=REGION)


def send_response(event, status, data=None, reason=''):
    body = json.dumps({
        'Status': status,
        'Reason': reason or 'See CloudWatch logs',
        'PhysicalResourceId': (data or {}).get('PhysicalResourceId')
            or event.get('PhysicalResourceId') or event['RequestId'],
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data or {},
    }).encode()
    req = urllib.request.Request(event['ResponseURL'], data=body, method='PUT',
                                 headers={'Content-Type': ''})
    urllib.request.urlopen(req)


def _wait_registry_ready(registry_id, max_wait=120):
    start = time.time()
    while time.time() - start < max_wait:
        status = client.get_registry(registryId=registry_id).get('status', '')
        if status in ('READY', 'ACTIVE'):
            return status
        if 'FAIL' in status:
            raise RuntimeError(f'Registry entered {status}')
        time.sleep(4)  # nosemgrep: arbitrary-sleep -- intentional retry backoff
    raise TimeoutError(f'Registry {registry_id} not ready within {max_wait}s')


def handle_registry(event, props):
    request_type = event['RequestType']
    name = props['RegistryName']
    description = props.get('RegistryDescription', '')
    # IAM-authorized discovery so the runtime agents (SigV4) can search/list records.
    discovery = {'authorizerType': 'AWS_IAM'}

    if request_type == 'Create':
        resp = client.create_registry(name=name, description=description,
                                      discoveryConfiguration=discovery)
        arn = resp['registryArn']
        registry_id = arn.split('/')[-1]
        _wait_registry_ready(registry_id)
        logger.info('Created registry %s', registry_id)
        return {'PhysicalResourceId': registry_id, 'RegistryId': registry_id, 'RegistryArn': arn}

    if request_type == 'Update':
        registry_id = event['PhysicalResourceId']
        client.update_registry(registryId=registry_id, description=description)
        _wait_registry_ready(registry_id)
        arn = client.get_registry(registryId=registry_id).get('registryArn', '')
        return {'PhysicalResourceId': registry_id, 'RegistryId': registry_id, 'RegistryArn': arn}

    # Delete
    registry_id = event['PhysicalResourceId']
    try:
        for r in client.list_registry_records(registryId=registry_id).get('registryRecords', []):
            rid = r.get('recordId') or r.get('recordArn', '').split('/')[-1]
            try:
                client.delete_registry_record(registryId=registry_id, recordId=rid)
            except Exception as e:
                logger.warning('delete record %s: %s', rid, e)
        time.sleep(3)  # nosemgrep: arbitrary-sleep -- intentional retry backoff
        client.delete_registry(registryId=registry_id)
        logger.info('Deleted registry %s', registry_id)
    except client.exceptions.ResourceNotFoundException:
        logger.info('Registry %s already gone', registry_id)
    except Exception as e:
        logger.warning('delete registry %s: %s', registry_id, e)
    return {'PhysicalResourceId': registry_id}


def _build_agent_card(props):
    """Build the A2A agent card from CR props. The runtime ARN is resolved by CFN before
    the Lambda runs, so we can URL-escape it here (TS can't escape a synth-time token)."""
    runtime_arn = props['RuntimeArn']
    escaped = urllib.parse.quote(runtime_arn, safe='')
    url = f'https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{escaped}/invocations/'
    skills = props.get('Skills')
    if isinstance(skills, str):
        try:
            skills = json.loads(skills)
        except ValueError:
            skills = []
    return json.dumps({
        'name': props['RecordName'],
        'description': props.get('RecordDescription', props['AgentName'])[:250],
        'url': url,
        'version': props.get('RecordVersion', '1.0.0'),
        'protocolVersion': A2A_SCHEMA_VERSION,
        'capabilities': {'streaming': True},
        'defaultInputModes': ['text/plain'],
        'defaultOutputModes': ['text/plain'],
        'skills': skills or [{
            'id': props['AgentName'],
            'name': props['AgentName'],
            'description': props.get('RecordDescription', '')[:250],
            'tags': [props.get('AgentDomain', 'quality')],
        }],
    })


def _descriptors(agent_card_json):
    # GA agent-registry shape: recordType=AGENT carries the A2A card under a2aAgentCard.data.
    return {'a2aAgentCard': {'data': agent_card_json, 'dataSchemaVersion': A2A_SCHEMA_VERSION}}


def handle_record(event, props):
    request_type = event['RequestType']
    registry_id = props['RegistryId']
    name = props['RecordName']
    description = props.get('RecordDescription', '')[:1000]
    version = props.get('RecordVersion', '1.0.0')
    agent_card_json = _build_agent_card(props)

    if request_type == 'Create':
        return _create_record(registry_id, name, description, version, agent_card_json)

    if request_type == 'Update':
        # PhysicalResourceId is "<registryId>:<recordId>" — recover the registry the record
        # actually lives in. If the registry was recreated (id changed), the old record is in a
        # now-gone registry: create a fresh one in the new registry (CFN then DELETEs the old).
        old_registry_id, _, record_id = event['PhysicalResourceId'].rpartition(':')
        if old_registry_id and old_registry_id != registry_id:
            logger.info('Registry changed %s -> %s; recreating record %s', old_registry_id, registry_id, name)
            return _create_record(registry_id, name, description, version, agent_card_json)
        try:
            client.update_registry_record(
                registryId=registry_id, recordId=record_id,
                description={'optionalValue': description}, recordVersion=version,
                descriptors={'optionalValue': _descriptors(agent_card_json)})
            _submit_for_approval(registry_id, record_id)
            logger.info('Updated record %s', record_id)
            return {'PhysicalResourceId': f'{registry_id}:{record_id}', 'RecordId': record_id}
        except client.exceptions.ResourceNotFoundException:
            logger.info('Record %s gone; recreating', record_id)
            return _create_record(registry_id, name, description, version, agent_card_json)

    # Delete
    _, _, record_id = event['PhysicalResourceId'].rpartition(':')
    try:
        client.delete_registry_record(registryId=registry_id, recordId=record_id)
        logger.info('Deleted record %s', record_id)
    except client.exceptions.ResourceNotFoundException:
        logger.info('Record %s already gone', record_id)
    except Exception as e:
        logger.warning('delete record %s: %s', record_id, e)
    return {'PhysicalResourceId': event['PhysicalResourceId']}


def _create_record(registry_id, name, description, version, agent_card_json):
    resp = client.create_registry_record(
        registryId=registry_id, name=name, description=description,
        recordType='AGENT', recordVersion=version,
        descriptors=_descriptors(agent_card_json))
    arn = resp.get('recordArn', '')
    record_id = arn.split('/')[-1] if arn else resp.get('recordId', '')
    logger.info('Created record %s (%s)', record_id, name)
    _submit_for_approval(registry_id, record_id)
    return {'PhysicalResourceId': f'{registry_id}:{record_id}', 'RecordId': record_id}


def _submit_for_approval(registry_id, record_id):
    """Records land in DRAFT. Submit, then force-approve: the registry's
    autoApprovalRules are empty, so a submit alone leaves the record PENDING_APPROVAL
    and it never becomes discoverable. Explicitly set APPROVED."""
    for _ in range(12):
        try:
            if client.get_registry_record(
                    registryId=registry_id, recordId=record_id).get('status') != 'CREATING':
                break
        except Exception:
            pass
        time.sleep(4)  # nosemgrep: arbitrary-sleep -- intentional retry backoff
    try:
        client.submit_registry_record_for_approval(registryId=registry_id, recordId=record_id)
    except Exception as e:
        logger.warning('submit for approval %s: %s', record_id, e)
    try:
        client.update_registry_record_status(
            registryId=registry_id, recordId=record_id,
            status='APPROVED', statusReason='Auto-approved by the aerospace sample deploy')
        logger.info('Approved record %s', record_id)
    except Exception as e:
        logger.warning('approve %s: %s', record_id, e)


def lambda_handler(event, context):
    action = event.get('ResourceProperties', {}).get('Action', '')
    logger.info('RequestType=%s Action=%s', event['RequestType'], action)
    try:
        props = event['ResourceProperties']
        if action == 'MANAGE_REGISTRY':
            data = handle_registry(event, props)
        elif action == 'MANAGE_RECORD':
            data = handle_record(event, props)
        else:
            raise ValueError(f'Unknown action: {action}')
        send_response(event, 'SUCCESS', data)
    except Exception as e:
        logger.error('Error: %s', e, exc_info=True)
        # Phase 1: don't let a non-authoritative RECORD write roll back the agent fleet.
        # Soften RECORD Create only. The REGISTRY itself must NOT be softened — downstream
        # resources GetAtt its RegistryArn/RegistryId, so a soft success without those
        # attributes breaks the stack ("Vendor response doesn't contain RegistryArn").
        if FAIL_SOFT and action == 'MANAGE_RECORD' and event.get('RequestType') == 'Create':
            logger.warning('FAIL_SOFT: record Create failed; returning SUCCESS so the stack is not rolled back')
            send_response(event, 'SUCCESS', {'PhysicalResourceId': event['RequestId'], 'FailSoft': 'true'})
        else:
            send_response(event, 'FAILED', reason=str(e))
