"""Gateway MCP client — connects to AgentCore Gateway for source system write tools.

Provides a Strands MCPClient that agents include in their tools list.
The client is initialized lazily on first use and reuses the Cognito token.
"""

import base64
import logging
import os
import time
from functools import partial

import boto3
import httpx
from strands.tools.mcp import MCPClient
from mcp.client.streamable_http import streamablehttp_client

logger = logging.getLogger('gateway_client')

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
GATEWAY_MCP_URL = os.environ.get('GATEWAY_MCP_URL', '')
GATEWAY_CLIENT_ID = os.environ.get('GATEWAY_CLIENT_ID', '')
GATEWAY_SCOPE = os.environ.get('GATEWAY_SCOPE', 'aerospace-gateway/write')
COGNITO_TOKEN_URL = os.environ.get('COGNITO_TOKEN_URL', '')
COGNITO_USER_POOL_ID = os.environ.get('COGNITO_USER_POOL_ID', '')

_token = None
_token_expiry = 0
_client_secret = None


def _get_client_secret() -> str:
    """Fetch Gateway M2M client secret from Cognito (cached)."""
    global _client_secret
    if _client_secret:
        return _client_secret
    cognito = boto3.client('cognito-idp', region_name=REGION)
    resp = cognito.describe_user_pool_client(
        UserPoolId=COGNITO_USER_POOL_ID,
        ClientId=GATEWAY_CLIENT_ID,
    )
    _client_secret = resp['UserPoolClient']['ClientSecret']
    return _client_secret


def _get_token() -> str:
    """Get a valid Cognito OAuth2 token for Gateway access (cached, auto-refresh)."""
    global _token, _token_expiry
    if _token and time.time() < _token_expiry - 60:
        return _token

    secret = _get_client_secret()
    auth = base64.b64encode(f"{GATEWAY_CLIENT_ID}:{secret}".encode()).decode()
    resp = httpx.post(COGNITO_TOKEN_URL, headers={
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': f'Basic {auth}',
    }, data={
        'grant_type': 'client_credentials',
        'scope': GATEWAY_SCOPE,
    })
    resp.raise_for_status()
    data = resp.json()
    _token = data['access_token']
    _token_expiry = time.time() + data.get('expires_in', 3600)
    logger.info('Obtained Gateway Cognito token')
    return _token


def create_gateway_mcp_client() -> MCPClient | None:
    """Create a Strands MCPClient for the AgentCore Gateway.

    Returns None if GATEWAY_MCP_URL is not configured (Gateway not deployed).
    The client should be included in the agent's tools list — Strands auto-starts it.
    """
    if not GATEWAY_MCP_URL or not GATEWAY_CLIENT_ID:
        logger.info('Gateway not configured — skipping MCP client')
        return None

    token = _get_token()
    url = GATEWAY_MCP_URL
    if not url.endswith('/'):
        url += '/'

    logger.info('Creating Gateway MCP client: %s', url)
    return MCPClient(
        transport_callable=partial(
            streamablehttp_client,
            url=url,
            headers={'Authorization': f'Bearer {token}'},
            timeout=120,
            terminate_on_close=False,
        ),
    )
