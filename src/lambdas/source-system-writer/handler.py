"""Source system writer Lambda — routes by API Gateway path to the correct DDB table.

Each path maps to one operation:
  POST /systems/qms/update-disposition     → qms-demo   (update NCR disposition)
  POST /systems/mes/release-hold           → mes-demo   (release work order hold)
  POST /systems/srm/update-score           → srm-demo   (update supplier score)
  POST /systems/plm/create-eco             → plm-demo   (create engineering change)
  POST /systems/program/update-milestone   → program-demo (update milestone status)
  POST /systems/inservice/log-maintenance  → inservice-demo (log maintenance action)
"""

import json
import logging
import os
import time
import uuid
from decimal import Decimal

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'eu-west-1'))

# Path → handler_function (populated below)
ROUTE_MAP = {}


def _now():
    return time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())


def _agent_stamp(body: dict) -> dict:
    """Build common agent metadata fields for every DDB write."""
    ctx = body.get('agent_context', {})
    return {
        'lastModifiedBy': f"agent:{ctx.get('agentId', 'unknown')}",
        'correlationId': ctx.get('correlationId', ''),
        'sessionId': ctx.get('sessionId', ''),
        'updatedAt': _now(),
    }


def _validate(body: dict, required_fields: list[str]) -> str | None:
    """Return error message if validation fails, None if OK."""
    for field in required_fields:
        if not body.get(field):
            return f"Missing required field: {field}"
    # agent_context is optional — agents may not always include it
    return None


def _success(domain: str, entity_id: str, operation: str) -> dict:
    return {
        'statusCode': 200,
        'body': json.dumps({
            'status': 'success',
            'domain': domain,
            'entity_id': entity_id,
            'operation': operation,
            'timestamp': _now(),
        }),
    }


def _stamp_values(body: dict) -> dict:
    """Build ExpressionAttributeValues for the agent stamp fields."""
    stamp = _agent_stamp(body)
    return {
        ':mod': stamp['lastModifiedBy'],
        ':cid': stamp['correlationId'],
        ':sid': stamp['sessionId'],
        ':ts': stamp['updatedAt'],
    }


# ─── Operation Handlers ─────────────────────────────────────────────

def handle_update_disposition(body: dict) -> dict:
    err = _validate(body, ['entity_id', 'reason'])
    if err:
        return {'statusCode': 400, 'body': json.dumps({'error': err})}
    payload = body.get('payload', {})
    disposition = payload.get('disposition', 'USE_AS_IS')
    table = dynamodb.Table('qms-demo')
    table.update_item(
        Key={'PK': f"NCR#{body['entity_id']}", 'SK': 'METADATA'},
        UpdateExpression='SET #status = :status, disposition = :disp, dispositionReason = :reason, '
                         'lastModifiedBy = :mod, correlationId = :cid, sessionId = :sid, updatedAt = :ts',
        ExpressionAttributeNames={'#status': 'status'},
        ExpressionAttributeValues={
            ':status': 'DISPOSITIONED',
            ':disp': disposition,
            ':reason': body['reason'],
            **_stamp_values(body),
        },
    )
    return _success('QMS', body['entity_id'], 'update_ncr_disposition')


def handle_release_hold(body: dict) -> dict:
    err = _validate(body, ['entity_id', 'reason'])
    if err:
        return {'statusCode': 400, 'body': json.dumps({'error': err})}
    table = dynamodb.Table('mes-demo')
    table.update_item(
        Key={'PK': f"WO#{body['entity_id']}", 'SK': 'METADATA'},
        UpdateExpression='SET holdStatus = :hs, holdReleaseReason = :reason, '
                         'lastModifiedBy = :mod, correlationId = :cid, sessionId = :sid, updatedAt = :ts',
        ExpressionAttributeValues={
            ':hs': 'RELEASED',
            ':reason': body['reason'],
            **_stamp_values(body),
        },
    )
    return _success('MES', body['entity_id'], 'release_work_order_hold')


def handle_update_score(body: dict) -> dict:
    err = _validate(body, ['entity_id', 'reason'])
    if err:
        return {'statusCode': 400, 'body': json.dumps({'error': err})}
    payload = body.get('payload', {})
    score = Decimal(str(payload.get('score', 50)))
    table = dynamodb.Table('srm-demo')
    table.update_item(
        Key={'PK': f"SUPPLIER#{body['entity_id']}", 'SK': 'METADATA'},
        UpdateExpression='SET qualityScore = :score, scoreReason = :reason, '
                         'lastModifiedBy = :mod, correlationId = :cid, sessionId = :sid, updatedAt = :ts',
        ExpressionAttributeValues={
            ':score': score,
            ':reason': body['reason'],
            **_stamp_values(body),
        },
    )
    return _success('SRM', body['entity_id'], 'update_supplier_score')


def handle_create_eco(body: dict) -> dict:
    err = _validate(body, ['reason'])
    if err:
        return {'statusCode': 400, 'body': json.dumps({'error': err})}
    payload = body.get('payload', {})
    eco_id = body.get('entity_id') or f"ECO-{int(time.time())}-{uuid.uuid4().hex[:4]}"
    stamp = _agent_stamp(body)
    table = dynamodb.Table('plm-demo')
    table.put_item(Item={
        'PK': f"ECO#{eco_id}",
        'SK': 'METADATA',
        'ecoId': eco_id,
        'partNumber': payload.get('partNumber', ''),
        'changeType': payload.get('changeType', 'REVISION'),
        'status': 'INITIATED',
        'reason': body['reason'],
        'createdAt': _now(),
        **stamp,
    })
    return _success('PLM', eco_id, 'create_engineering_change')


def handle_update_milestone(body: dict) -> dict:
    err = _validate(body, ['entity_id', 'reason'])
    if err:
        return {'statusCode': 400, 'body': json.dumps({'error': err})}
    payload = body.get('payload', {})
    table = dynamodb.Table('program-demo')
    table.update_item(
        Key={'PK': f"PROGRAM#{body['entity_id']}", 'SK': 'METADATA'},
        UpdateExpression='SET riskStatus = :rs, riskReason = :reason, '
                         'lastModifiedBy = :mod, correlationId = :cid, sessionId = :sid, updatedAt = :ts',
        ExpressionAttributeValues={
            ':rs': payload.get('status', 'AT_RISK'),
            ':reason': body['reason'],
            **_stamp_values(body),
        },
    )
    return _success('Program', body['entity_id'], 'update_milestone_status')


def handle_log_maintenance(body: dict) -> dict:
    err = _validate(body, ['entity_id', 'reason'])
    if err:
        return {'statusCode': 400, 'body': json.dumps({'error': err})}
    payload = body.get('payload', {})
    action_id = f"MA-{int(time.time())}-{uuid.uuid4().hex[:4]}"
    stamp = _agent_stamp(body)
    table = dynamodb.Table('inservice-demo')
    table.put_item(Item={
        'PK': f"SN#{body['entity_id']}",
        'SK': f"MAINTENANCE#{action_id}",
        'actionId': action_id,
        'serialNumber': body['entity_id'],
        'actionType': payload.get('actionType', 'ADVISORY'),
        'reason': body['reason'],
        'createdAt': _now(),
        **stamp,
    })
    return _success('InService', body['entity_id'], 'log_maintenance_action')


# ─── Route Map ──────────────────────────────────────────────────────

ROUTE_MAP = {
    '/systems/qms/update-disposition': handle_update_disposition,
    '/systems/mes/release-hold': handle_release_hold,
    '/systems/srm/update-score': handle_update_score,
    '/systems/plm/create-eco': handle_create_eco,
    '/systems/program/update-milestone': handle_update_milestone,
    '/systems/inservice/log-maintenance': handle_log_maintenance,
}


def lambda_handler(event, context):
    """API Gateway proxy integration handler."""
    path = event.get('path', '')
    logger.info('Writer Lambda invoked: path=%s', path)
    logger.info('Writer Lambda event body: %s', event.get('body', '')[:500])

    try:
        body = json.loads(event.get('body', '{}'))
    except (json.JSONDecodeError, TypeError):
        return {'statusCode': 400, 'body': json.dumps({'error': 'Invalid JSON body'})}

    handler_fn = ROUTE_MAP.get(path)
    if not handler_fn:
        return {'statusCode': 404, 'body': json.dumps({'error': f'Unknown path: {path}'})}

    logger.info('Writer Lambda parsed body: %s', json.dumps(body)[:500])

    try:
        result = handler_fn(body)
        logger.info('Writer Lambda success: path=%s entity=%s', path, body.get('entity_id', ''))
        return result
    except Exception as e:
        logger.exception('Writer Lambda error: path=%s', path)
        return {'statusCode': 500, 'body': json.dumps({'error': str(e)})}
