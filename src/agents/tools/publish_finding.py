"""Tool: publish an agent finding via AppSync createAgentFinding mutation.
Persists to DDB and fires subscription for real-time dashboard updates."""

import json
import os
import uuid
from datetime import datetime, timezone

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from strands import tool
from tools.trace_writer import write_trace

APPSYNC_URL = os.environ.get('APPSYNC_URL', '')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')
DOMAIN = os.environ.get('AGENT_DOMAIN', 'quality')

CREATE_FINDING = """
  mutation CreateAgentFinding($input: CreateAgentFindingInput!) {
    createAgentFinding(input: $input) {
      findingId agentName domain entityId summary action evidence sessionId correlationId sourceEventId createdAt
    }
  }
"""

# Keep legacy mutation for backward compat with dashboard event stream
PUBLISH_EVENT = """
  mutation PublishDashboardEvent($input: PublishDashboardEventInput!) {
    publishDashboardEvent(input: $input) {
      eventId eventType domain entityId occurredAt channel payload
    }
  }
"""


def _appsync_call(query: str, variables: dict) -> dict:
    """Execute an AppSync mutation with IAM SigV4 auth."""
    body = json.dumps({'query': query, 'variables': variables})
    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()
    request = AWSRequest(method='POST', url=APPSYNC_URL, data=body,
                         headers={'Content-Type': 'application/json'})
    SigV4Auth(credentials, 'appsync', REGION).add_auth(request)
    response = requests.post(APPSYNC_URL, data=body, headers=dict(request.headers), timeout=15)
    return response.json()


@tool
def publish_finding(summary: str, action: str, entity_id: str = '', evidence: str = '') -> str:
    """Publish an agent finding to the dashboard.

    Args:
        summary: Brief description of the finding
        action: One of MONITOR, RECOMMEND, ESCALATE, DRAFT
        entity_id: The entity this finding relates to (e.g., NCR ID)
        evidence: Supporting evidence or data

    Returns:
        Confirmation message
    """
    if not APPSYNC_URL:
        return 'APPSYNC_URL not configured — finding not published'

    finding_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    agent_name = os.environ.get('AGENT_NAME', 'Agent')
    session_id = os.environ.get('AGENT_SESSION_ID', '')
    correlation_id = os.environ.get('CORRELATION_ID', '')
    source_event_id = os.environ.get('SOURCE_EVENT_ID', '')

    try:
        # 1. Create finding (persists to DDB + triggers onCreateAgentFinding subscription)
        result = _appsync_call(CREATE_FINDING, {
            'input': {
                'findingId': finding_id,
                'agentName': agent_name,
                'domain': DOMAIN,
                'entityId': entity_id or finding_id,
                'summary': summary,
                'action': action,
                'evidence': evidence,
                'sessionId': session_id,
                'correlationId': correlation_id,
                'sourceEventId': source_event_id,
                'createdAt': now,
            }
        })

        if result.get('errors'):
            return f'Publish failed: {json.dumps(result["errors"])}'

        # 2. Also publish as dashboard event (for legacy NCR feed + other dashboards)
        _appsync_call(PUBLISH_EVENT, {
            'input': {
                'eventId': finding_id,
                'eventType': 'AGENT_FINDING',
                'domain': 'QMS',
                'entityId': entity_id or finding_id,
                'occurredAt': now,
                'channel': DOMAIN,
                'payload': json.dumps({
                    'agentName': agent_name,
                    'summary': summary,
                    'action': action,
                    'evidence': evidence,
                    'entityId': entity_id,
                }),
            }
        })

        write_trace('publish_finding', {'summary': summary[:200], 'action': action, 'entityId': entity_id})
        return f'Finding published: {action} — {summary[:100]}'
    except Exception as e:
        return f'Publish error: {e}'
