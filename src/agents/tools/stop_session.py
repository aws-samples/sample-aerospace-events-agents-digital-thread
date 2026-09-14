"""Tool: stop the current AgentCore session to release the VM.
Agents MUST call this as their final action when processing is complete."""

import logging
import os
import urllib.parse
import urllib.request
import json

from strands import tool
from tools.trace_writer import write_trace
from tools import registry_client

logger = logging.getLogger(__name__)

REGION = os.environ.get('AWS_REGION', 'eu-west-1')


def _get_runtime_arn(agent_id: str) -> str:
    """Resolve the agent's runtime ARN from the AWS Agent Registry."""
    return registry_client.runtime_arn(agent_id) or ''


@tool
def stop_session() -> str:
    """Stop the current agent session and release the VM.
    Call this as your FINAL action when you have finished all processing
    and have no more questions to ask humans. Do NOT call this if you
    are still waiting for a human answer.

    Returns:
        Confirmation that the session stop was requested.
    """
    session_id = os.environ.get('AGENT_SESSION_ID', '')
    agent_id = os.environ.get('AGENT_ID', '')

    if not session_id or not agent_id:
        return 'Cannot stop session — missing session ID or agent ID'

    runtime_arn = _get_runtime_arn(agent_id)

    write_trace('stop_session', {'detail': 'Agent self-stop'})

    try:
        escaped_arn = urllib.parse.quote(runtime_arn, safe='')
        url = f'https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{escaped_arn}/stopruntimesession?qualifier=DEFAULT'

        # Get JWT from the cached token in env (set by trigger Lambda via header)
        token = os.environ.get('AGENT_JWT_TOKEN', '')
        if not token:
            # Fallback: get token via Cognito M2M
            token = _get_jwt()

        if not token:
            return 'Cannot stop session — no JWT token available'

        req = urllib.request.Request(
            url, data=b'{}', method='POST',
            headers={
                'Authorization': f'Bearer {token}',
                'Content-Type': 'application/json',
                'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': session_id,
            },
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            logger.info('Session stopped: %s (HTTP %d)', session_id[:8], resp.status)
            return f'Session {session_id[:8]} stopped successfully. VM released.'

    except Exception as err:
        logger.warning('Session stop failed: %s — %s', session_id[:8], err)
        return f'Session stop attempted but failed: {err}'


def _get_jwt() -> str:
    """Get JWT via Cognito M2M (same pattern as call_agent.py)."""
    import base64
    import boto3

    token_url = os.environ.get('COGNITO_TOKEN_URL', '')
    client_id = os.environ.get('COGNITO_CLIENT_ID', '')
    user_pool_id = os.environ.get('COGNITO_USER_POOL_ID', '')

    if not all([token_url, client_id, user_pool_id]):
        logger.warning('Missing Cognito M2M credentials for session stop')
        return ''

    # Get client secret from Cognito
    cognito = boto3.client('cognito-idp', region_name=REGION)
    resp = cognito.describe_user_pool_client(
        UserPoolId=user_pool_id, ClientId=client_id,
    )
    client_secret = resp['UserPoolClient'].get('ClientSecret', '')
    if not client_secret:
        logger.warning('No client secret found for session stop')
        return ''

    auth = base64.b64encode(f'{client_id}:{client_secret}'.encode()).decode()
    scope = os.environ.get('COGNITO_SCOPE', 'aerospace-agents/invoke')
    data = urllib.parse.urlencode({
        'grant_type': 'client_credentials',
        'scope': scope,
    }).encode()

    req = urllib.request.Request(
        token_url, data=data,
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': f'Basic {auth}',
        },
    )
    body = json.loads(urllib.request.urlopen(req, timeout=10).read())
    return body.get('access_token', '')
