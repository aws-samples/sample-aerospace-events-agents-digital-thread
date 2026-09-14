#!/usr/bin/env python3
"""Local Strands agent that connects to deployed AgentCore Gateway.
Exercises write tools to validate the write-back pipeline end-to-end.

Usage:
    export AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1

    # Auto-test all 6 tools:
    python scripts/test-gateway-agent.py

    # Interactive chat mode:
    python scripts/test-gateway-agent.py --interactive

    # Cleanup test data:
    python scripts/test-gateway-agent.py --cleanup
"""

import argparse
import base64
import json
import logging
import os
import sys
import time
from functools import partial

import boto3
import httpx

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger('test-gateway-agent')

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
PROFILE = os.environ.get('AWS_PROFILE', 'your-aws-profile')


# ─── Resolve CDK outputs ─────────────────────────────────────────────

def get_stack_output(stack_name: str, output_key: str) -> str:
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    cfn = session.client('cloudformation')
    resp = cfn.describe_stacks(StackName=stack_name)
    for output in resp['Stacks'][0].get('Outputs', []):
        if output['OutputKey'] == output_key:
            return output['OutputValue']
    raise ValueError(f"Output {output_key} not found in {stack_name}")


def resolve_config() -> dict:
    """Resolve Gateway URL + Cognito credentials from CDK outputs."""
    gateway_url = get_stack_output('AerospaceGatewayStack', 'GatewayUrl')
    user_pool_id = get_stack_output('AerospaceAppStack', 'UserPoolId')
    # Gateway has its own M2M client (separate from the agent-to-agent client)
    client_id = get_stack_output('AerospaceGatewayStack', 'GatewayClientId')
    cognito_domain = get_stack_output('AerospaceAgentCoreStack', 'CognitoDomainName')
    token_url = f"https://{cognito_domain}.auth.{REGION}.amazoncognito.com/oauth2/token"

    # Get client secret from Cognito
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    cognito_client = session.client('cognito-idp')
    resp = cognito_client.describe_user_pool_client(
        UserPoolId=user_pool_id, ClientId=client_id,
    )
    client_secret = resp['UserPoolClient']['ClientSecret']

    return {
        'gateway_url': gateway_url,
        'token_url': token_url,
        'client_id': client_id,
        'client_secret': client_secret,
        'scope': 'aerospace-gateway/write',
    }


# ─── Cognito Token ────────────────────────────────────────────────────

def get_cognito_token(config: dict) -> str:
    auth = base64.b64encode(
        f"{config['client_id']}:{config['client_secret']}".encode()
    ).decode()
    resp = httpx.post(config['token_url'], headers={
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': f'Basic {auth}',
    }, data={
        'grant_type': 'client_credentials',
        'scope': config['scope'],
    })
    resp.raise_for_status()
    return resp.json()['access_token']


# ─── MCP Gateway Agent ───────────────────────────────────────────────

def create_agent(config: dict):
    from strands import Agent
    from strands.models.bedrock import BedrockModel
    from strands.tools.mcp import MCPClient
    from mcp.client.streamable_http import streamablehttp_client

    token = get_cognito_token(config)
    gateway_mcp_url = config['gateway_url']
    if not gateway_mcp_url.endswith('/'):
        gateway_mcp_url += '/'

    logger.info('Connecting to Gateway: %s', gateway_mcp_url)

    mcp_client = MCPClient(
        transport_callable=partial(
            streamablehttp_client,
            url=gateway_mcp_url,
            headers={'Authorization': f'Bearer {token}'},
            timeout=120,
            terminate_on_close=False,
        ),
    )

    model = BedrockModel(
        model_id='global.anthropic.claude-sonnet-4-6',
        region_name=REGION,
        temperature=0,
        max_tokens=4096,
    )

    agent = Agent(
        model=model,
        tools=[mcp_client],
        system_prompt=(
            "You are a test agent for the AgentCore Gateway write tools.\n"
            "When asked to test a tool, call it with the provided test data and report the result.\n"
            "Always include agent_context with agentId='test-gateway-agent', "
            "sessionId='spike-test', correlationId='spike-test' in every tool call.\n"
        ),
    )
    return agent, mcp_client


# ─── Test Scenarios ───────────────────────────────────────────────────

TEST_SCENARIOS = [
    {
        'tool': 'update_ncr_disposition',
        'prompt': 'Call update_ncr_disposition with entity_id "TEST-NCR-001", '
                  'reason "gateway-spike-test", and payload disposition "USE_AS_IS".',
    },
    {
        'tool': 'release_work_order_hold',
        'prompt': 'Call release_work_order_hold with entity_id "TEST-WO-001" '
                  'and reason "gateway-spike-test".',
    },
    {
        'tool': 'update_supplier_score',
        'prompt': 'Call update_supplier_score with entity_id "TEST-SUPPLIER-001", '
                  'reason "gateway-spike-test", and payload score 75.',
    },
    {
        'tool': 'create_engineering_change',
        'prompt': 'Call create_engineering_change with entity_id "TEST-ECO-001", '
                  'reason "gateway-spike-test", and payload partNumber "TEST-PART-001" '
                  'changeType "REVISION".',
    },
    {
        'tool': 'update_milestone_status',
        'prompt': 'Call update_milestone_status with entity_id "TEST-MS-001", '
                  'reason "gateway-spike-test", and payload status "AT_RISK".',
    },
    {
        'tool': 'log_maintenance_action',
        'prompt': 'Call log_maintenance_action with entity_id "TEST-SN-001", '
                  'reason "gateway-spike-test", and payload actionType "ADVISORY".',
    },
]


def run_auto_tests(config: dict):
    agent, mcp_client = create_agent(config)
    passed = 0
    failed = 0

    # Agent auto-starts the MCP client — don't use `with mcp_client:`
    # List available tools
    logger.info('Listing Gateway tools...')
    result = agent('What tools do you have? Just list their names.')
    print(f"\n--- Tool Discovery ---\n{result}\n")

    for scenario in TEST_SCENARIOS:
        tool = scenario['tool']
        logger.info('Testing: %s', tool)
        try:
            result = agent(scenario['prompt'])
            output = str(result)
            lower = output.lower()
            if 'internal error' in lower or 'failed to' in lower:
                logger.error('FAIL: %s — %s', tool, output[:200])
                failed += 1
            else:
                logger.info('PASS: %s', tool)
                passed += 1
        except Exception as e:
            logger.error('FAIL: %s — %s', tool, e)
            failed += 1

    print(f"\n=== Results: {passed} passed, {failed} failed ===")
    return failed == 0


def run_interactive(config: dict):
    agent, mcp_client = create_agent(config)
    print("Interactive mode. Type 'quit' to exit.\n")

    while True:
        try:
            prompt = input('> ')
        except (EOFError, KeyboardInterrupt):
            break
        if prompt.strip().lower() in ('quit', 'exit'):
            break
        result = agent(prompt)
        print(f"\n{result}\n")


def cleanup_test_data():
    """Delete all TEST-* items from source system tables."""
    session = boto3.Session(profile_name=PROFILE, region_name=REGION)
    ddb = session.resource('dynamodb', region_name=REGION)
    tables_pks = [
        ('qms-demo', 'NCR#TEST-'),
        ('mes-demo', 'WO#TEST-'),
        ('srm-demo', 'SUPPLIER#TEST-'),
        ('plm-demo', 'ECO#TEST-'),
        ('program-demo', 'PROGRAM#TEST-'),
        ('inservice-demo', 'SN#TEST-'),
    ]
    for table_name, pk_prefix in tables_pks:
        table = ddb.Table(table_name)
        resp = table.scan(
            FilterExpression=boto3.dynamodb.conditions.Attr('PK').begins_with(pk_prefix),
        )
        items = resp.get('Items', [])
        if items:
            logger.info('Deleting %d TEST items from %s', len(items), table_name)
            for item in items:
                table.delete_item(Key={'PK': item['PK'], 'SK': item['SK']})
        else:
            logger.info('No TEST items in %s', table_name)
    print('Cleanup complete.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Test AgentCore Gateway write tools')
    parser.add_argument('--interactive', action='store_true', help='Interactive chat mode')
    parser.add_argument('--cleanup', action='store_true', help='Delete TEST-* items from DDB')
    args = parser.parse_args()

    if args.cleanup:
        cleanup_test_data()
        sys.exit(0)

    config = resolve_config()
    logger.info('Gateway URL: %s', config['gateway_url'])

    if args.interactive:
        run_interactive(config)
    else:
        success = run_auto_tests(config)
        sys.exit(0 if success else 1)
