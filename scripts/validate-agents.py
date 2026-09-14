#!/usr/bin/env python3
"""
Validate all agent cards — uses Strands A2AAgent, matching exactly how deployed
agents call each other via call_agent.py.

For each agent:
1. Gets JWT token via Cognito M2M (client_credentials grant)
2. Fetches the agent card with JWT auth (manual GET, like call_agent.py)
3. Validates the card parses as AgentCard (a2a.types)
4. Optionally sends a test message via Strands A2AAgent (--ping)

Usage:
  export AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1
  python3 scripts/validate-agents.py              # card validation only
  python3 scripts/validate-agents.py --ping       # also send A2A message via Strands
  python3 scripts/validate-agents.py --agent agent1-conformance --ping  # single agent
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request

import boto3
import httpx
from a2a.types import AgentCard
from a2a.client.client import ClientConfig
from a2a.client.client_factory import ClientFactory
from strands.agent.a2a_agent import A2AAgent

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
SESSION_BUCKET = f'aerospace-agent-sessions-{REGION}-{boto3.client("sts").get_caller_identity()["Account"]}'

_cfn_cache: dict = {}
_token: str = ''
_token_expiry: float = 0
_client_secret: str = ''


# ─── CloudFormation helpers ─────────────────────────────────────────

def cfn_output(stack: str, key: str) -> str:
    if stack not in _cfn_cache:
        cfn = boto3.client('cloudformation', region_name=REGION)
        resp = cfn.describe_stacks(StackName=stack)
        _cfn_cache[stack] = {o['OutputKey']: o['OutputValue'] for o in resp['Stacks'][0].get('Outputs', [])}
    return _cfn_cache[stack].get(key, '')


# ─── Cognito M2M JWT (same pattern as call_agent.py) ────────────────

def get_client_secret(user_pool_id: str, client_id: str) -> str:
    global _client_secret
    if _client_secret:
        return _client_secret
    cognito = boto3.client('cognito-idp', region_name=REGION)
    resp = cognito.describe_user_pool_client(UserPoolId=user_pool_id, ClientId=client_id)
    _client_secret = resp['UserPoolClient'].get('ClientSecret', '')
    return _client_secret


def get_jwt(client_id: str, user_pool_id: str, token_url: str) -> str:
    global _token, _token_expiry
    if _token and time.time() < _token_expiry - 60:
        return _token

    secret = get_client_secret(user_pool_id, client_id)
    if not secret:
        print('  ERROR: Could not get client secret')
        return ''

    auth = base64.b64encode(f'{client_id}:{secret}'.encode()).decode()
    data = urllib.parse.urlencode({
        'grant_type': 'client_credentials',
        'scope': 'aerospace-agents/invoke',
    }).encode()

    req = urllib.request.Request(
        token_url, data=data,
        headers={
            'Content-Type': 'application/x-www-form-urlencoded',
            'Authorization': f'Basic {auth}',
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = json.loads(resp.read())
        _token = body['access_token']
        _token_expiry = time.time() + body.get('expires_in', 3600)
        print(f'  JWT token: {len(_token)} chars, expires in {body.get("expires_in", 0)}s')
        return _token


REGISTRY_NAME = 'aerospace-agents'


def _load_registry_from_aws() -> dict:
    """Build {agent_id: arn} from approved A2A records in the managed AWS Agent
    Registry. Requires boto3>=1.43.0. Raises on any SDK/registry failure."""
    ctrl = boto3.client('bedrock-agentcore-control', region_name=REGION)

    rid = next(
        (r['registryId'] for r in ctrl.list_registries().get('registries', [])
         if r.get('name') == REGISTRY_NAME),
        None,
    )
    if not rid:
        return {}

    out: dict = {}
    for rec in ctrl.list_registry_records(registryId=rid).get('registryRecords', []):
        if rec.get('status') != 'APPROVED' or rec.get('descriptorType') != 'A2A':
            continue
        full = ctrl.get_registry_record(registryId=rid, recordId=rec['recordId'])
        inline = full['descriptors']['a2a']['agentCard']['inlineContent']
        url = json.loads(inline)['url']
        arn = urllib.parse.unquote(url.split('/runtimes/', 1)[1].split('/invocations', 1)[0])
        out[rec['name']] = arn
    return out


def _load_registry_from_s3() -> dict:
    s3 = boto3.client('s3', region_name=REGION)
    obj = s3.get_object(Bucket=SESSION_BUCKET, Key='configs/agent-registry.json')
    return json.loads(obj['Body'].read().decode('utf-8'))


def load_registry() -> dict:
    try:
        registry = _load_registry_from_aws()
        if registry:
            print('  Source: AWS Agent Registry (registry)')
            return registry
    except Exception as e:
        print(f'  AWS Agent Registry unavailable ({e}) — falling back')
    print('  Source: S3 (JSON map)')
    return _load_registry_from_s3()


# ─── Agent card fetch (same as call_agent.py _build_a2a_agent step 1) ─

def fetch_agent_card(agent_id: str, arn: str, token: str) -> AgentCard | None:
    escaped = urllib.parse.quote(arn, safe='')
    base_url = f'https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{escaped}/invocations/'
    card_url = f'{base_url}.well-known/agent-card.json?qualifier=DEFAULT'

    try:
        card_resp = httpx.get(card_url, headers={'Authorization': f'Bearer {token}'}, timeout=15)
        card_resp.raise_for_status()
        card_data = card_resp.json()
        card_data['url'] = base_url
        agent_card = AgentCard.model_validate(card_data)
        skills = card_data.get('skills', [])
        print(f'    Card OK — name="{agent_card.name}", skills={len(skills)}')
        for skill in skills:
            print(f'      - {skill.get("id", "?")}')
        return agent_card
    except httpx.HTTPStatusError as e:
        print(f'    CARD FAILED — HTTP {e.response.status_code}: {e.response.text[:200]}')
        return None
    except Exception as e:
        print(f'    CARD FAILED — {e}')
        return None


# ─── A2A ping via Strands A2AAgent (same as call_agent.py _build_a2a_agent) ─

def ping_agent(agent_id: str, arn: str, token: str, agent_card: AgentCard) -> bool:
    """Send a test message using Strands A2AAgent — identical to deployed call_agent.py."""
    escaped = urllib.parse.quote(arn, safe='')
    base_url = f'https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{escaped}/invocations/'

    session_id = f'validate-to-{agent_id}-{int(time.time())}'
    while len(session_id) < 33:
        session_id += 'x'

    # httpx client with JWT + qualifier (same as call_agent.py)
    httpx_client = httpx.AsyncClient(
        headers={
            'Authorization': f'Bearer {token}',
            'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': session_id,
        },
        params={'qualifier': 'DEFAULT'},
        timeout=60.0,
    )
    factory = ClientFactory(ClientConfig(httpx_client=httpx_client))

    # Create A2AAgent and pre-set the card (skips agent card discovery)
    agent = A2AAgent(endpoint=base_url, a2a_client_factory=factory)
    agent._agent_card = agent_card

    try:
        result = agent('Health check: respond with "OK" and your agent name.')
        content = result.message.get('content', [])
        for part in content:
            if isinstance(part, dict) and 'text' in part:
                text = part['text'][:150].replace('\n', ' ')
                print(f'    Response: "{text}"')
                return True
        print(f'    Response (raw): {str(result.message)[:200]}')
        return True
    except Exception as e:
        print(f'    PING FAILED — {e}')
        return False


# ─── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Validate all aerospace agent cards via Strands A2AAgent')
    parser.add_argument('--ping', action='store_true', help='Send a test A2A message via Strands A2AAgent')
    parser.add_argument('--agent', type=str, help='Validate a single agent by ID')
    args = parser.parse_args()

    print('=== Loading Cognito config ===')
    client_id = cfn_output('AerospaceAgentCoreStack', 'MachineClientId')
    domain = cfn_output('AerospaceAgentCoreStack', 'CognitoDomainName')
    user_pool_id = cfn_output('AerospaceAppStack', 'UserPoolId')
    token_url = f'https://{domain}.auth.{REGION}.amazoncognito.com/oauth2/token'
    print(f'  Client ID: {client_id[:10]}...')
    print(f'  Token URL: {token_url}')

    print('\n=== Getting JWT token ===')
    token = get_jwt(client_id, user_pool_id, token_url)
    if not token:
        print('FATAL: Could not get JWT token')
        sys.exit(1)

    print('\n=== Loading agent registry ===')
    registry = load_registry()
    print(f'  {len(registry)} agents found')

    if args.agent:
        if args.agent not in registry:
            print(f'  ERROR: Agent "{args.agent}" not in registry. Available: {sorted(registry.keys())}')
            sys.exit(1)
        registry = {args.agent: registry[args.agent]}

    print('\n=== Validating agent cards ===')
    results = {'card_ok': [], 'card_fail': [], 'ping_ok': [], 'ping_fail': []}

    for agent_id in sorted(registry.keys()):
        arn = registry[agent_id]
        print(f'\n  [{agent_id}]')
        print(f'    ARN: ...{arn.split("/")[-1]}')

        card = fetch_agent_card(agent_id, arn, token)
        if card:
            results['card_ok'].append(agent_id)
        else:
            results['card_fail'].append(agent_id)
            continue

        if args.ping:
            print(f'    Sending A2A message via Strands A2AAgent...')
            if ping_agent(agent_id, arn, token, card):
                results['ping_ok'].append(agent_id)
            else:
                results['ping_fail'].append(agent_id)

    print(f'\n=== Results ===')
    total = len(registry)
    print(f'  Cards:  {len(results["card_ok"])}/{total} OK')
    if results['card_fail']:
        print(f'  Cards FAILED: {", ".join(results["card_fail"])}')
    if args.ping:
        print(f'  Pings:  {len(results["ping_ok"])}/{len(results["card_ok"])} OK')
        if results['ping_fail']:
            print(f'  Pings FAILED: {", ".join(results["ping_fail"])}')

    if results['card_fail'] or results['ping_fail']:
        sys.exit(1)
    print('  All agents validated successfully!')


if __name__ == '__main__':
    main()
