"""Tool: call another agent via A2A protocol using Strands A2AAgent + Cognito M2M JWT.

Pattern: manually fetch agent card with auth, pre-set on A2AAgent to skip discovery,
then use httpx client with JWT headers + qualifier param for the actual JSON-RPC call.
"""

import json
import os
import time
import base64
import uuid
import urllib.parse
import urllib.request
import logging

import boto3
import httpx
from a2a.types import AgentCard
from a2a.client.client import ClientConfig
from a2a.client.client_factory import ClientFactory
from strands import tool
from strands.agent.a2a_agent import A2AAgent
from tools.trace_writer import write_trace
from tools import registry_client

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
COGNITO_TOKEN_URL = os.environ.get('COGNITO_TOKEN_URL', '')
COGNITO_CLIENT_ID = os.environ.get('COGNITO_CLIENT_ID', '')
COGNITO_SCOPE = os.environ.get('COGNITO_SCOPE', 'aerospace-agents/invoke')
AGENT_ID = os.environ.get('AGENT_ID', 'unknown')

logger = logging.getLogger('call_agent')

_token = None
_token_expiry = 0
_client_secret = None


def _get_client_secret() -> str:
    global _client_secret
    if _client_secret:
        return _client_secret
    user_pool_id = os.environ.get('COGNITO_USER_POOL_ID', '')
    if not user_pool_id or not COGNITO_CLIENT_ID:
        logger.error('Missing COGNITO_USER_POOL_ID=%s or COGNITO_CLIENT_ID=%s',
                     user_pool_id[:10] if user_pool_id else 'EMPTY',
                     COGNITO_CLIENT_ID[:10] if COGNITO_CLIENT_ID else 'EMPTY')
        return ''
    try:
        cognito = boto3.client('cognito-idp', region_name=REGION)
        resp = cognito.describe_user_pool_client(UserPoolId=user_pool_id, ClientId=COGNITO_CLIENT_ID)
        _client_secret = resp['UserPoolClient'].get('ClientSecret', '')
        return _client_secret
    except Exception as e:
        logger.error('Failed to get client secret: %s', e)
        return ''


def _get_jwt() -> str:
    global _token, _token_expiry
    if _token and time.time() < _token_expiry - 60:
        return _token
    secret = _get_client_secret()
    if not secret:
        return ''
    auth = base64.b64encode(f'{COGNITO_CLIENT_ID}:{secret}'.encode()).decode()
    data = urllib.parse.urlencode({'grant_type': 'client_credentials', 'scope': COGNITO_SCOPE}).encode()
    req = urllib.request.Request(
        COGNITO_TOKEN_URL, data=data,
        headers={'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': f'Basic {auth}'})
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = json.loads(resp.read())
        _token = body['access_token']
        _token_expiry = time.time() + body.get('expires_in', 3600)
        logger.info('Got M2M JWT (%d chars)', len(_token))
        return _token


def _build_a2a_agent(target_agent: str, base_url: str) -> A2AAgent:
    """Build an A2AAgent with pre-fetched agent card and JWT auth."""
    token = _get_jwt()
    if not token:
        raise ValueError('Could not get JWT token')

    session_id = str(uuid.uuid4())

    # 1. Fetch agent card with auth (AgentCore requires Bearer token for GET too)
    card_url = f'{base_url}.well-known/agent-card.json?qualifier=DEFAULT'
    card_resp = httpx.get(card_url, headers={'Authorization': f'Bearer {token}'}, timeout=15)
    card_data = card_resp.json()
    card_data['url'] = base_url
    agent_card = AgentCard.model_validate(card_data)
    logger.info('Fetched agent card for %s: %s (%d skills)', target_agent, card_data.get('name'), len(card_data.get('skills', [])))

    # 2. Create httpx client with JWT + qualifier + trace headers for JSON-RPC calls
    call_headers = {
        'Authorization': f'Bearer {token}',
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': session_id,
    }
    # Forward trace context to child agent (same correlationId, current session as parent)
    correlation_id = os.environ.get('CORRELATION_ID', '')
    if correlation_id:
        call_headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Correlation-Id'] = correlation_id
    source_event_id = os.environ.get('SOURCE_EVENT_ID', '')
    if source_event_id:
        call_headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Source-Event-Id'] = source_event_id
    source_event_type = os.environ.get('SOURCE_EVENT_TYPE', '')
    if source_event_type:
        call_headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Source-Event-Type'] = source_event_type
    parent_sid = os.environ.get('AGENT_SESSION_ID', '')
    if parent_sid:
        call_headers['X-Amzn-Bedrock-AgentCore-Runtime-Custom-Parent-Session-Id'] = parent_sid

    httpx_client = httpx.AsyncClient(
        headers=call_headers,
        params={'qualifier': 'DEFAULT'},
        timeout=60.0,
    )
    factory = ClientFactory(ClientConfig(httpx_client=httpx_client))

    # 3. Create A2AAgent and pre-set the card (skips agent card discovery)
    agent = A2AAgent(endpoint=base_url, a2a_client_factory=factory)
    agent._agent_card = agent_card
    return agent


@tool
def list_agents() -> str:
    """List all available aerospace agents you can call via A2A.

    Returns:
        JSON list of agent IDs available for cross-agent calls
    """
    return json.dumps(registry_client.list_agent_ids(exclude=AGENT_ID))


@tool
def search_agents(query: str) -> str:
    """Search for agents by capability (e.g., "supplier quality", "fleet anomalies").

    With the AWS Agent Registry this is a semantic search over agent descriptions —
    describe what you need, not just an agent name fragment.

    Args:
        query: What you need help with, in natural language

    Returns:
        JSON list of matching agent IDs
    """
    matches = registry_client.search(query, exclude=AGENT_ID)
    if matches:
        return json.dumps(matches)
    return json.dumps({'message': f'No match for "{query}"',
                       'available': registry_client.list_agent_ids(exclude=AGENT_ID)})


@tool
def call_agent(target_agent: str, message: str) -> str:
    """Call another aerospace agent via A2A protocol to request analysis or action.

    Use this when your analysis reveals something that another domain's agent should act on.
    The target agent will reason about your message and return its assessment.

    Args:
        target_agent: The agent ID (e.g., "agent4-supplier-risk"). Use list_agents to discover.
        message: What you found and what you need from the target agent

    Returns:
        The target agent's response text
    """
    # Resolve the target's A2A endpoint from the AWS Agent Registry (agent card url).
    base_url = registry_client.resolve_url(target_agent)
    if not base_url:
        return json.dumps({'error': f'Unknown agent: {target_agent}',
                           'available': registry_client.list_agent_ids(exclude=AGENT_ID)})

    logger.info('A2A call: %s → %s', AGENT_ID, target_agent)
    write_trace('call_agent', {'targetAgent': target_agent, 'message': message[:200]})

    try:
        a2a_agent = _build_a2a_agent(target_agent, base_url)
        result = a2a_agent(message)
        content = result.message.get('content', [])
        for part in content:
            if isinstance(part, dict) and 'text' in part:
                logger.info('A2A response from %s (%d chars)', target_agent, len(part['text']))
                return part['text']
        return str(result.message)
    except Exception as e:
        logger.error('A2A call to %s failed: %s', target_agent, e)
        return json.dumps({'error': f'A2A call failed: {str(e)}'})
