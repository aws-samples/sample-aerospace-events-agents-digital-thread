"""
Shared Agent Trigger Lambda (Python) — JWT auth for A2A protocol.

Two event sources:
1. SQS (from EventBridge) → new event → invoke AgentCore with JWT
2. DynamoDB Stream (hitl-questions) → answer received → resume with JWT

Uses raw HTTP POST with Cognito M2M Bearer token (not boto3).
"""

import json
import os
import socket
import uuid
import logging
import base64
import urllib.parse
import urllib.error
import time

import boto3
from boto3.dynamodb.types import TypeDeserializer

logger = logging.getLogger()
logger.setLevel(logging.INFO)

AGENT_RUNTIME_ARN = os.environ.get('AGENT_RUNTIME_ARN', '')
COGNITO_TOKEN_URL = os.environ.get('COGNITO_TOKEN_URL', '')
COGNITO_CLIENT_ID = os.environ.get('COGNITO_CLIENT_ID', '')
COGNITO_SCOPE = os.environ.get('COGNITO_SCOPE', 'aerospace-agents/invoke')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')
TRACE_TABLE = 'agent-trace'
AGENT_ID = os.environ.get('AGENT_ID', 'unknown')
# Fire-and-forget dispatch window: long enough for AgentCore to accept the POST
# (or fast-reject with a 424 when the runtime is down), short enough that we never
# block on the full 100s+ agentic run. The agent completes asynchronously.
DISPATCH_TIMEOUT_S = int(os.environ.get('AGENT_DISPATCH_TIMEOUT_S', '10'))

deserializer = TypeDeserializer()

# Cache token across invocations
_cached_token = None
_token_expiry = 0


def get_client_secret():
    """Get Cognito client secret from the UserPool client description."""
    cognito_client = boto3.client('cognito-idp', region_name=REGION)
    # Extract UserPoolId from the token URL
    # Format: https://aerospace-agents-XXXXXXXX.auth.eu-west-1.amazoncognito.com/oauth2/token
    # We need the UserPoolId from env or derive it
    user_pool_id = os.environ.get('COGNITO_USER_POOL_ID', '')
    if not user_pool_id:
        # Try to get from the discovery URL pattern
        logger.warning('COGNITO_USER_POOL_ID not set — cannot get client secret')
        return ''
    resp = cognito_client.describe_user_pool_client(
        UserPoolId=user_pool_id,
        ClientId=COGNITO_CLIENT_ID,
    )
    return resp['UserPoolClient'].get('ClientSecret', '')


def get_jwt_token():
    """Get or refresh Cognito M2M JWT token."""
    global _cached_token, _token_expiry

    if _cached_token and time.time() < _token_expiry - 60:
        return _cached_token

    if not COGNITO_TOKEN_URL or not COGNITO_CLIENT_ID:
        logger.error('COGNITO_TOKEN_URL or COGNITO_CLIENT_ID not set')
        return None

    client_secret = get_client_secret()
    if not client_secret:
        logger.error('Could not get client secret')
        return None

    import urllib.request

    auth = base64.b64encode(f'{COGNITO_CLIENT_ID}:{client_secret}'.encode()).decode()
    data = urllib.parse.urlencode({
        'grant_type': 'client_credentials',
        'scope': COGNITO_SCOPE,
    }).encode()

    req = urllib.request.Request(
        COGNITO_TOKEN_URL,
        data=data,
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': f'Basic {auth}',
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
            _cached_token = body['access_token']
            _token_expiry = time.time() + body.get('expires_in', 3600)
            logger.info('Got M2M JWT token (%d chars, expires in %ds)', len(_cached_token), body.get('expires_in', 0))
            return _cached_token
    except Exception as err:
        logger.exception('Failed to get JWT token: %s', err)
        return None


def unmarshall(dynamodb_item: dict) -> dict:
    return {k: deserializer.deserialize(v) for k, v in dynamodb_item.items()}


def write_trace(correlation_id: str, session_id: str, action: str, detail: dict):
    """Write a trace record to the agent-trace DDB table."""
    try:
        dynamodb = boto3.resource('dynamodb', region_name=REGION)
        table = dynamodb.Table(TRACE_TABLE)
        now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
        table.put_item(Item={
            'PK': f'TRACE#{correlation_id}',
            'SK': f'{now}#{session_id[:12]}',
            'correlationId': correlation_id,
            'sessionId': session_id,
            'agentId': AGENT_ID,
            'agentName': os.environ.get('AGENT_NAME', AGENT_ID),
            'action': action,
            'timestamp': now,
            'ttl': int(time.time()) + 7 * 86400,
            **detail,
        })
    except Exception as e:
        logger.warning('Trace write failed: %s', e)



def invoke_agent(session_id: str, prompt: str, source: str,
                 correlation_id: str = '', source_event_id: str = '',
                 source_event_type: str = '', parent_session_id: str = ''):
    if not AGENT_RUNTIME_ARN:
        logger.error('AGENT_RUNTIME_ARN not set')
        return

    # Session ID must be 33+ characters for AgentCore
    if len(session_id) < 33:
        session_id = session_id + '-' + str(uuid.uuid4())[:33 - len(session_id) - 1]

    token = get_jwt_token()
    if not token:
        logger.error('No JWT token — cannot invoke agent')
        return

    logger.info('Invoking AgentCore (JWT) — session=%s, source=%s, corr=%s', session_id[:8], source, correlation_id[:8])

    try:
        import urllib.request

        escaped_arn = urllib.parse.quote(AGENT_RUNTIME_ARN, safe='')
        url = f'https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{escaped_arn}/invocations?qualifier=DEFAULT'

        # A2A JSON-RPC format (message/send)
        payload = json.dumps({
            'jsonrpc': '2.0',
            'method': 'message/send',
            'params': {
                'message': {
                    'role': 'user',
                    'messageId': str(uuid.uuid4()),
                    'parts': [{'kind': 'text', 'text': prompt}],
                },
                'configuration': {
                    'acceptedOutputModes': ['text'],
                },
            },
            'id': str(uuid.uuid4()),
        }).encode()

        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
            'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': session_id,
        }
        # Custom trace headers (passed through to agent container)
        if correlation_id:
            headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Correlation-Id'] = correlation_id
        if source_event_id:
            headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Source-Event-Id'] = source_event_id
        if source_event_type:
            headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Source-Event-Type'] = source_event_type
        if parent_session_id:
            headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Parent-Session-Id'] = parent_session_id

        req = urllib.request.Request(url, data=payload, headers=headers, method='POST')

        # Fire-and-forget: an agentic run + its A2A fan-out takes 100s+, far longer
        # than any Lambda/urllib timeout. Once AgentCore has accepted the POST the
        # session runs asynchronously on the runtime and writes its own trace/findings
        # independently of this Lambda — so we only need to confirm the request was
        # ACCEPTED, not wait for the answer. A short read timeout here is the SUCCESS
        # path (agent is working), not a failure. Genuine dependency errors (e.g. the
        # HTTP 424 seen when the runtime container is down) still surface below.
        try:
            with urllib.request.urlopen(req, timeout=DISPATCH_TIMEOUT_S) as resp:
                logger.info('AgentCore accepted (session=%s): HTTP %s', session_id[:8], resp.status)
        except socket.timeout:
            logger.info('AgentCore dispatched (session=%s) — running async, response not awaited', session_id[:8])
        except urllib.error.URLError as e:
            # read-timeout can also arrive wrapped as URLError(reason=timeout)
            if isinstance(getattr(e, 'reason', None), socket.timeout):
                logger.info('AgentCore dispatched (session=%s) — running async, response not awaited', session_id[:8])
            else:
                raise

    except urllib.error.HTTPError as err:
        # A real dependency failure (e.g. 424 Failed Dependency = runtime container
        # crash-looping). This IS an error worth surfacing.
        logger.error('AgentCore invocation failed (session=%s): HTTP %s %s', session_id[:8], err.code, err.reason)
    except Exception as err:
        logger.exception('AgentCore invocation error: %s', err)


def handle_new_event(sqs_body: str):
    body = json.loads(sqs_body)
    event = body.get('detail', {}).get('value', body)

    # Skip seed baseline events — they're historical data, not live events
    payload = event.get('payload', {})
    actor = event.get('actor', {})
    if payload.get('raisedBy') == 'seed-baseline' or payload.get('lastModifiedBy') == 'seed-baseline' or actor.get('userId') == 'seed-baseline':
        return

    session_id = str(uuid.uuid4())
    event_type = event.get('eventType', 'unknown')
    entity_id = event.get('entityId', 'unknown')
    source_event_id = event.get('eventId', entity_id)
    correlation_id = event.get('correlationId', '') or source_event_id

    prompt = f"""You received this aerospace event. Analyze it and take appropriate action.

Event Type: {event_type}
Entity ID: {entity_id}
Domain: {event.get('domain', 'QMS')}
Occurred At: {event.get('occurredAt', 'unknown')}

Payload:
{json.dumps(event.get('payload', event), indent=2)}

Analyze this event following your instructions."""

    logger.info('New event: %s:%s -> session %s, corr=%s', event_type, entity_id, session_id[:8], correlation_id[:8])

    write_trace(correlation_id, session_id, 'invoked', {
        'source': 'eventbridge',
        'sourceEventId': source_event_id,
        'sourceEventType': event_type,
        'entityId': entity_id,
    })

    invoke_agent(session_id, prompt, 'eventbridge',
                 correlation_id=correlation_id,
                 source_event_id=source_event_id,
                 source_event_type=event_type)


def handle_hitl_answer(record: dict):
    if record.get('eventName') != 'MODIFY':
        return

    new_image = unmarshall(record['dynamodb']['NewImage'])
    old_image = unmarshall(record['dynamodb']['OldImage']) if record['dynamodb'].get('OldImage') else {}

    if old_image.get('status') != 'PENDING' or new_image.get('status') != 'ANSWERED':
        return

    session_id = new_image.get('sessionId', '')
    answer = new_image.get('answer', 'No answer provided')
    question = new_image.get('question', '')
    correlation_id = new_image.get('correlationId', '')
    source_event_id = new_image.get('sourceEventId', '')

    if not session_id:
        logger.warning('No sessionId in HITL record — cannot resume')
        return

    # Only resume if THIS agent asked the question
    record_agent = new_image.get('agentName', '')
    my_agent_name = os.environ.get('AGENT_NAME', '')
    if record_agent and my_agent_name and record_agent != my_agent_name:
        logger.info('HITL answer for %s, not me (%s) — skipping', record_agent, my_agent_name)
        return

    prompt = f"""The human operator has responded to your question.

Your question was: "{question}"

Human's answer: "{answer}"

Continue processing based on the human's decision. Publish your final findings."""

    logger.info('HITL resume: session %s, corr=%s — answer: %s', session_id[:8], correlation_id[:8], answer[:80])

    if correlation_id:
        write_trace(correlation_id, session_id, 'hitl_resume', {
            'source': 'hitl_resume',
            'sourceEventId': source_event_id,
            'detail': json.dumps({'question': question[:200], 'answer': answer[:200]}),
        })

    invoke_agent(session_id, prompt, 'hitl_resume',
                 correlation_id=correlation_id,
                 source_event_id=source_event_id)


def handler(event, context):
    for record in event.get('Records', []):
        if record.get('eventSource') == 'aws:sqs':
            handle_new_event(record['body'])
        elif record.get('eventSource') == 'aws:dynamodb':
            handle_hitl_answer(record)
