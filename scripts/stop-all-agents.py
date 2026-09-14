#!/usr/bin/env python3
"""
Stop all active AgentCore Runtime sessions.

Enumerates the deployed runtimes via bedrock-agentcore-control.list_agent_runtimes,
lists each runtime's session IDs from S3 (Strands S3SessionManager), and stops each
via HTTP with JWT auth (same pattern as deployed agents). Already-stopped sessions
return 404 (counted as 'already stopped').

Usage:
  export AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1
  python3 scripts/stop-all-agents.py              # stop all sessions
  python3 scripts/stop-all-agents.py --cleanup    # also delete S3 session data
  python3 scripts/stop-all-agents.py --agent agent1-conformance  # single agent
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

# Only the 10 demo agents are named aerospace_agent<N>_<...>; this skips unrelated
# leftover runtimes (e.g. spikes) that happen to share the aerospace_ prefix.
AGENT_RUNTIME_RE = re.compile(r'^aerospace_agent\d+_')

import boto3
import httpx

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
ACCOUNT = boto3.client('sts').get_caller_identity()['Account']
SESSION_BUCKET = f'aerospace-agent-sessions-{REGION}-{ACCOUNT}'

# JWT token cache
_token: str = ''
_token_expiry: float = 0


def get_jwt() -> str:
    """Get JWT via Cognito M2M (same as call_agent.py)."""
    global _token, _token_expiry
    if _token and time.time() < _token_expiry - 60:
        return _token

    cfn = boto3.client('cloudformation', region_name=REGION)

    def cfn_output(stack: str) -> dict:
        resp = cfn.describe_stacks(StackName=stack)
        return {o['OutputKey']: o['OutputValue'] for o in resp['Stacks'][0].get('Outputs', [])}

    ac = cfn_output('AerospaceAgentCoreStack')
    app = cfn_output('AerospaceAppStack')

    client_id = ac['MachineClientId']
    domain = ac['CognitoDomainName']
    pool_id = app['UserPoolId']

    cognito = boto3.client('cognito-idp', region_name=REGION)
    secret = cognito.describe_user_pool_client(
        UserPoolId=pool_id, ClientId=client_id
    )['UserPoolClient']['ClientSecret']

    auth = base64.b64encode(f'{client_id}:{secret}'.encode()).decode()
    token_url = f'https://{domain}.auth.{REGION}.amazoncognito.com/oauth2/token'
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
    body = json.loads(urllib.request.urlopen(req, timeout=10).read())
    _token = body['access_token']
    _token_expiry = time.time() + body.get('expires_in', 3600)
    return _token


def _agent_id_from_runtime_name(runtime_name: str) -> str:
    """aerospace_agent1_conformance -> agent1-conformance (matches the S3 session prefix)."""
    return runtime_name.replace('aerospace_', '', 1).replace('_', '-')


def load_registry() -> dict:
    """Build {agent_id: runtime_arn} by listing the deployed AgentCore runtimes.

    Uses bedrock-agentcore-control.list_agent_runtimes — present in the installed SDK
    and independent of the managed AWS Agent Registry (whose list_registries op needs
    boto3>=1.43.0). This is the source of truth for *which runtimes exist*, which is
    all we need to stop their sessions.
    """
    ctrl = boto3.client('bedrock-agentcore-control', region_name=REGION)
    registry = {}
    next_token = None
    while True:
        kwargs = {'nextToken': next_token} if next_token else {}
        resp = ctrl.list_agent_runtimes(**kwargs)
        for rt in resp.get('agentRuntimes', []):
            name = rt.get('agentRuntimeName', '')
            if not AGENT_RUNTIME_RE.match(name):
                continue
            registry[_agent_id_from_runtime_name(name)] = rt['agentRuntimeArn']
        next_token = resp.get('nextToken')
        if not next_token:
            break

    if registry:
        print(f'  Loaded {len(registry)} agents from list_agent_runtimes')
    return registry


def list_sessions(agent_id: str) -> list[str]:
    """List all session IDs for an agent from S3."""
    s3 = boto3.client('s3', region_name=REGION)
    prefix = f'agents/{agent_id}/'
    session_ids = set()

    paginator = s3.get_paginator('list_objects_v2')
    for page in paginator.paginate(Bucket=SESSION_BUCKET, Prefix=prefix):
        for obj in page.get('Contents', []):
            match = re.search(r'session_([a-f0-9-]{36})', obj['Key'])
            if match:
                session_ids.add(match.group(1))

    return sorted(session_ids)


def stop_session(arn: str, session_id: str, token: str) -> tuple[str, str]:
    """Stop a single session via HTTP + JWT. Returns (session_id, result)."""
    escaped = urllib.parse.quote(arn, safe='')
    url = f'https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{escaped}/stopruntimesession?qualifier=DEFAULT'

    try:
        resp = httpx.post(
            url,
            headers={
                'Authorization': f'Bearer {token}',
                'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': session_id,
                'Content-Type': 'application/json',
            },
            json={},
            timeout=15,
        )
        if resp.status_code == 200:
            return (session_id, 'stopped')
        elif resp.status_code == 404:
            return (session_id, 'already')
        else:
            return (session_id, f'HTTP {resp.status_code}: {resp.text[:80]}')
    except Exception as e:
        return (session_id, f'error: {str(e)[:80]}')


def cleanup_sessions(agent_id: str, session_ids: list[str]):
    """Delete S3 session data for given sessions."""
    s3 = boto3.client('s3', region_name=REGION)
    for sid in session_ids:
        prefix = f'agents/{agent_id}//session_{sid}/'
        paginator = s3.get_paginator('list_objects_v2')
        keys = []
        for page in paginator.paginate(Bucket=SESSION_BUCKET, Prefix=prefix):
            keys.extend([obj['Key'] for obj in page.get('Contents', [])])
        if keys:
            # Delete in batches of 1000
            for i in range(0, len(keys), 1000):
                batch = keys[i:i + 1000]
                s3.delete_objects(
                    Bucket=SESSION_BUCKET,
                    Delete={'Objects': [{'Key': k} for k in batch]},
                )


def main():
    parser = argparse.ArgumentParser(description='Stop all AgentCore Runtime sessions')
    parser.add_argument('--agent', type=str, help='Stop sessions for a single agent')
    parser.add_argument('--cleanup', action='store_true', help='Delete S3 session data after stopping')
    args = parser.parse_args()

    print('=== Getting JWT token ===')
    token = get_jwt()
    print(f'  Token: {len(token)} chars')

    print('\n=== Loading agent registry ===')
    registry = load_registry()

    if args.agent:
        if args.agent not in registry:
            print(f'  ERROR: Agent "{args.agent}" not in registry.')
            sys.exit(1)
        registry = {args.agent: registry[args.agent]}

    print(f'  {len(registry)} agents\n')

    total_stopped = 0
    total_already = 0
    total_failed = 0

    for agent_id in sorted(registry.keys()):
        arn = registry[agent_id]
        print(f'  [{agent_id}]')

        sessions = list_sessions(agent_id)
        print(f'    {len(sessions)} sessions in S3')

        if not sessions:
            continue

        stopped = 0
        already = 0
        failed = 0
        errors = []

        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = {
                pool.submit(stop_session, arn, sid, token): sid
                for sid in sessions
            }
            for future in as_completed(futures):
                sid, result = future.result()
                if result == 'stopped':
                    stopped += 1
                elif result == 'already':
                    already += 1
                else:
                    failed += 1
                    errors.append(f'{sid[:8]}: {result}')

        print(f'    stopped={stopped} already={already} failed={failed}')
        if errors[:3]:
            for e in errors[:3]:
                print(f'      {e}')
            if len(errors) > 3:
                print(f'      ... and {len(errors) - 3} more')

        total_stopped += stopped
        total_already += already
        total_failed += failed

        if args.cleanup:
            print(f'    cleaning up {len(sessions)} S3 sessions...')
            cleanup_sessions(agent_id, sessions)
            print(f'    done')

    print(f'\n=== Summary ===')
    print(f'  Stopped:  {total_stopped}')
    print(f'  Already:  {total_already}')
    print(f'  Failed:   {total_failed}')

    if total_failed:
        sys.exit(1)


if __name__ == '__main__':
    main()
