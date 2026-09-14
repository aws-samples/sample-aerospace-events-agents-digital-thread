"""
Strands Agent Runtime — request handler with S3 session persistence.
Each invocation creates/resumes an agent. S3SessionManager preserves
conversation history across sessions for HITL resume.
"""

import json
import logging
import os
import sys
import uuid

import boto3
import yaml
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.session.s3_session_manager import S3SessionManager
from strands.hooks import (
    HookProvider, HookRegistry,
    BeforeInvocationEvent, AfterInvocationEvent,
    BeforeToolCallEvent, AfterToolCallEvent,
)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools.query_graph import query_graph
from tools.get_graph_schema import get_graph_schema
from tools.query_datalake import query_datalake
from tools.get_datalake_schema import get_datalake_schema
from tools.query_datalake_sql import query_datalake_sql
from tools.read_drawing import read_drawing
from tools.publish_finding import publish_finding
from tools.ask_human import ask_human
from tools.call_agent import call_agent, list_agents, search_agents
from tools.stop_session import stop_session

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger('agent-runtime')

TOOL_REGISTRY = {
    'query_graph': query_graph,
    'get_graph_schema': get_graph_schema,
    'query_datalake': query_datalake,
    'get_datalake_schema': get_datalake_schema,
    'query_datalake_sql': query_datalake_sql,
    'read_drawing': read_drawing,
    'publish_finding': publish_finding,
    'ask_human': ask_human,
    'call_agent': call_agent,
    'list_agents': list_agents,
    'search_agents': search_agents,
    'stop_session': stop_session,
}

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
SESSION_BUCKET = os.environ.get('SESSION_BUCKET', 'aerospace-agent-sessions')


class AgentDebugHooks(HookProvider):
    """Logs all agent lifecycle events for debugging."""

    def register_hooks(self, registry: HookRegistry) -> None:
        registry.add_callback(BeforeInvocationEvent, self.on_start)
        registry.add_callback(AfterInvocationEvent, self.on_end)
        registry.add_callback(BeforeToolCallEvent, self.on_tool)
        registry.add_callback(AfterToolCallEvent, self.on_tool_done)

    def on_start(self, event: BeforeInvocationEvent) -> None:
        logger.info('=== Agent invocation started ===')

    def on_end(self, event: AfterInvocationEvent) -> None:
        logger.info('=== Agent invocation completed ===')

    def on_tool(self, event: BeforeToolCallEvent) -> None:
        name = event.tool_use.get('name', 'unknown')
        inp = json.dumps(event.tool_use.get('input', {}))[:200]
        logger.info('>> Tool: %s(%s)', name, inp)

    def on_tool_done(self, event: AfterToolCallEvent) -> None:
        logger.info('>> Tool %s done', event.tool_use.get('name', 'unknown'))


def load_config() -> dict:
    """Load agent config from S3, env var, or local file."""
    # 1. S3 config (preferred for AgentCore)
    s3_uri = os.environ.get('AGENT_CONFIG_S3', '')
    if s3_uri and s3_uri.startswith('s3://'):
        parts = s3_uri.replace('s3://', '').split('/', 1)
        bucket, key = parts[0], parts[1]
        logger.info('Loading config from S3: %s', s3_uri)
        s3 = boto3.client('s3', region_name=REGION)
        obj = s3.get_object(Bucket=bucket, Key=key)
        return yaml.safe_load(obj['Body'].read().decode('utf-8'))

    # 2. Inline env var
    config_str = os.environ.get('AGENT_CONFIG', '')
    if config_str:
        return yaml.safe_load(config_str)

    # 3. Local file
    config_path = os.environ.get('AGENT_CONFIG_PATH', '/app/config.yaml')
    with open(config_path) as f:
        return yaml.safe_load(f)


def create_agent(config: dict, session_id: str) -> Agent:
    """Create a Strands agent with S3 session persistence."""
    model_config = config.get('model', {})

    model = BedrockModel(
        model_id=model_config.get('modelId', 'global.anthropic.claude-sonnet-4-6'),
        region_name=REGION,
        temperature=model_config.get('temperature', 0),
        max_tokens=model_config.get('maxTokens', 4096),
        # Bedrock Guardrail applied only when both are set (empty => no guardrail).
        guardrail_id=os.environ['GUARDRAIL_ID'],
        guardrail_version=os.environ['GUARDRAIL_VERSION'],
    )

    tool_names = config.get('tools', [])
    tools = [TOOL_REGISTRY[name] for name in tool_names if name in TOOL_REGISTRY]

    # Add Gateway MCP client for source system write-back
    if config.get('useGateway', False):
        try:
            from tools.gateway_client import create_gateway_mcp_client
            gw = create_gateway_mcp_client()
            if gw:
                tools.append(gw)
        except Exception as e:
            logger.warning('Failed to create Gateway MCP client: %s', e)

    session_manager = S3SessionManager(
        session_id=session_id,
        bucket=SESSION_BUCKET,
        prefix=f"agents/{config.get('agentId', 'unknown')}/",
        region_name=REGION,
    )

    return Agent(
        model=model,
        system_prompt=config.get('systemPrompt', ''),
        tools=tools,
        hooks=[AgentDebugHooks()],
        session_manager=session_manager,
        callback_handler=None,
    )


def handle_request(request: dict) -> dict:
    """Handle a single agent invocation (new event or HITL resume)."""
    config = load_config()
    agent_name = config.get('agentName', 'Agent')

    session_id = request.get('sessionId', str(uuid.uuid4()))
    prompt = request.get('prompt', '')
    source = request.get('source', 'unknown')

    # Set env vars for tools
    os.environ['AGENT_SESSION_ID'] = session_id
    os.environ['AGENT_NAME'] = agent_name
    os.environ['AGENT_DOMAIN'] = config.get('domain', 'quality')
    os.environ['AGENT_ID'] = config.get('agentId', 'unknown')

    logger.info('%s handling request — session=%s, source=%s', agent_name, session_id[:8], source)

    agent = create_agent(config, session_id)

    try:
        result = agent(prompt)
        logger.info('%s completed — session=%s', agent_name, session_id[:8])
        return {'status': 'completed', 'sessionId': session_id, 'response': str(result)[:500]}
    except Exception as e:
        logger.exception('%s error — session=%s', agent_name, session_id[:8])
        return {'status': 'error', 'sessionId': session_id, 'error': str(e)}


# --- Entry points ---

def lambda_handler(event, context):
    """Lambda handler — invoked by the shared trigger Lambda."""
    return handle_request(event)


if __name__ == '__main__':
    # Local testing
    config = load_config()
    print(f"Agent: {config.get('agentName')}, Tools: {config.get('tools')}")
    if len(sys.argv) > 1:
        result = handle_request({'prompt': sys.argv[1], 'source': 'cli'})
        print(json.dumps(result, indent=2))
