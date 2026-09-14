"""
AgentCore Runtime server — Strands A2AServer for A2A protocol.
Two-phase init:
1. Startup: lightweight agent (no session) for agent card + health check
2. First invocation: recreate full agent with S3SessionManager using real session ID
"""

import logging
import os
import uuid

from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.session.s3_session_manager import S3SessionManager
from runtime.main import load_config, TOOL_REGISTRY, AgentDebugHooks
from tools.gateway_client import create_gateway_mcp_client

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger('agentcore-server')

config = load_config()
agent_name = config.get('agentName', 'Agent')
agent_domain = config.get('domain', 'quality')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')
SESSION_BUCKET = os.environ.get('SESSION_BUCKET', '')
HOST = os.environ.get('HOST', '0.0.0.0')
PORT = int(os.environ.get('PORT', '9000'))

logger.info('AgentCore server starting — agent=%s, domain=%s', agent_name, agent_domain)

a2a_available = False
A2AServer = None
try:
    from strands.multiagent.a2a import A2AServer as _A2AServer
    A2AServer = _A2AServer
    a2a_available = True
    logger.info('A2A support available')
except ImportError:
    logger.info('A2A not available')


def _create_model():
    model_cfg = config.get('model', {})
    return BedrockModel(
        model_id=model_cfg.get('modelId', 'global.anthropic.claude-sonnet-4-6'),
        region_name=REGION,
        temperature=model_cfg.get('temperature', 0),
        max_tokens=model_cfg.get('maxTokens', 4096),
        # Bedrock Guardrail applied only when both are set (empty => no guardrail).
        guardrail_id=os.environ['GUARDRAIL_ID'],
        guardrail_version=os.environ['GUARDRAIL_VERSION'],
    )


_gateway_client = None

def _create_tools():
    global _gateway_client
    tools = [TOOL_REGISTRY[n] for n in config.get('tools', []) if n in TOOL_REGISTRY]
    # Add Gateway MCP client if configured (provides write-back tools)
    if _gateway_client is None and config.get('useGateway', False):
        _gateway_client = create_gateway_mcp_client()
    if _gateway_client:
        tools.append(_gateway_client)
    return tools


def create_full_agent(session_id: str) -> Agent:
    """Create the real agent with S3SessionManager for conversation persistence."""
    sm = S3SessionManager(
        session_id=session_id,
        bucket=SESSION_BUCKET,
        prefix=f"agents/{config.get('agentId', 'unknown')}/",
        region_name=REGION,
    )
    agent = Agent(
        model=_create_model(),
        system_prompt=config.get('systemPrompt', ''),
        tools=_create_tools(),
        hooks=[AgentDebugHooks()],
        session_manager=sm,
        callback_handler=None,
    )
    agent.name = agent_name
    agent.description = config.get('description', agent_name)
    return agent


def build_app() -> FastAPI:
    if not a2a_available:
        from fastapi.responses import JSONResponse
        import threading, json
        from datetime import datetime, timezone
        from runtime.main import handle_request

        app = FastAPI()

        @app.get('/ping')
        async def ping():
            return {'status': 'Healthy'}

        @app.post('/invocations')
        async def invoke_http(request: Request):
            raw_body = await request.body()
            body = json.loads(raw_body)
            input_data = body.get('input', body)
            prompt = input_data.get('prompt', '')
            source = input_data.get('source', 'http')
            session_id = request.headers.get('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', '')
            if not session_id:
                session_id = input_data.get('sessionId', '')
            task_id = str(uuid.uuid4())

            def execute():
                try:
                    handle_request({'sessionId': session_id, 'prompt': prompt, 'source': source})
                except Exception:
                    logger.exception('Agent failed')

            threading.Thread(target=execute, daemon=True).start()
            return JSONResponse(content={'output': {
                'type': 'acknowledged', 'task_id': task_id, 'sessionId': session_id,
                'timestamp': datetime.now(timezone.utc).isoformat(),
            }})
        return app

    # ─── A2A mode ────────────────────────────────────────────────────
    # Phase 1: lightweight agent for agent card (no session manager)
    card_agent = Agent(
        model=_create_model(),
        system_prompt=config.get('systemPrompt', ''),
        tools=_create_tools(),
        hooks=[AgentDebugHooks()],
        callback_handler=None,
    )
    card_agent.name = agent_name
    card_agent.description = config.get('description', agent_name)

    runtime_url = os.environ.get('AGENTCORE_RUNTIME_URL', f'http://{HOST}:{PORT}/')
    a2a_server = A2AServer(agent=card_agent, http_url=runtime_url, serve_at_root=True)

    # Phase 2: on first real invocation, swap in full agent with session manager
    _swapped = False

    class SwapAgentMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request, call_next):
            nonlocal _swapped
            if request.url.path not in ('/ping', '/.well-known/agent-card.json'):
                sid = request.headers.get('X-Amzn-Bedrock-AgentCore-Runtime-Session-Id', '')
                if not sid:
                    sid = 'a2a-' + str(uuid.uuid4())

                # Set env vars for tools on every invocation
                os.environ['AGENT_SESSION_ID'] = sid
                os.environ['AGENT_NAME'] = agent_name
                os.environ['AGENT_DOMAIN'] = agent_domain
                os.environ['AGENT_ID'] = config.get('agentId', 'unknown')

                # Trace context from custom AgentCore headers
                os.environ['CORRELATION_ID'] = request.headers.get(
                    'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Correlation-Id', '')
                os.environ['SOURCE_EVENT_ID'] = request.headers.get(
                    'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Source-Event-Id', '')
                os.environ['SOURCE_EVENT_TYPE'] = request.headers.get(
                    'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Source-Event-Type', '')
                os.environ['PARENT_SESSION_ID'] = request.headers.get(
                    'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Parent-Session-Id', '')

                if not _swapped:
                    logger.info('First invocation — creating agent with session=%s', sid[:12])
                    full_agent = create_full_agent(sid)
                    a2a_server.agent = full_agent
                    _swapped = True
                    logger.info('Agent swapped with S3SessionManager — session=%s', sid[:12])
            return await call_next(request)

    a2a_app = a2a_server.to_fastapi_app()

    app = FastAPI(title='Aerospace Agent Server')
    app.add_middleware(SwapAgentMiddleware)

    @app.get('/ping')
    async def ping():
        return {'status': 'Healthy'}

    app.mount('/', a2a_app)
    return app


app = build_app()

if __name__ == '__main__':
    import uvicorn
    logger.info('Starting on %s:%d (A2A: %s)', HOST, PORT, a2a_available)
    uvicorn.run(app, host=HOST, port=PORT)
