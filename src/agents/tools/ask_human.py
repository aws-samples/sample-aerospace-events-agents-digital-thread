"""Tool: ask a human for a decision via AppSync createHITLQuestion mutation.
Persists to DDB (for stream-based resume) and fires subscription for dashboard."""

import json
import os
import time
import uuid

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from strands import tool
from tools.trace_writer import write_trace

APPSYNC_URL = os.environ.get('APPSYNC_URL', '')
HITL_TABLE = os.environ.get('HITL_TABLE', 'hitl-questions')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')
AGENT_NAME = os.environ.get('AGENT_NAME', 'Agent')
DOMAIN = os.environ.get('AGENT_DOMAIN', 'quality')

CREATE_HITL = """
  mutation CreateHITLQuestion($input: CreateHITLQuestionInput!) {
    createHITLQuestion(input: $input) {
      taskId sessionId agentName domainId question options evidence priority status correlationId sourceEventId createdAt
    }
  }
"""


@tool
def ask_human(question: str, options: list[str], evidence: str = '', priority: str = 'MEDIUM') -> str:
    """Ask a human operator for a decision. The question appears on the dashboard.
    Returns immediately — the agent session will be resumed when the human answers.

    Args:
        question: The question to ask the human
        options: List of possible answers (2-4 options)
        evidence: Supporting evidence to help the human decide
        priority: Priority level (LOW, MEDIUM, HIGH, CRITICAL)

    Returns:
        Acknowledgement message. The agent should publish preliminary findings and exit.
    """
    task_id = str(uuid.uuid4())
    session_id = os.environ.get('AGENT_SESSION_ID', '')
    created_at = int(time.time())

    correlation_id = os.environ.get('CORRELATION_ID', '')
    source_event_id = os.environ.get('SOURCE_EVENT_ID', '')

    input_data = {
        'taskId': task_id,
        'sessionId': session_id,
        'agentName': AGENT_NAME,
        'domainId': DOMAIN,
        'question': question,
        'options': options,
        'evidence': evidence,
        'priority': priority,
        'status': 'PENDING',
        'correlationId': correlation_id,
        'sourceEventId': source_event_id,
        'createdAt': created_at,
    }

    write_trace('ask_human', {'question': question[:200], 'priority': priority})

    # Try AppSync mutation first (persists + fires subscription)
    if APPSYNC_URL:
        try:
            body = json.dumps({'query': CREATE_HITL, 'variables': {'input': input_data}})
            session = boto3.Session()
            credentials = session.get_credentials().get_frozen_credentials()
            request = AWSRequest(method='POST', url=APPSYNC_URL, data=body,
                                 headers={'Content-Type': 'application/json'})
            SigV4Auth(credentials, 'appsync', REGION).add_auth(request)
            response = requests.post(APPSYNC_URL, data=body, headers=dict(request.headers), timeout=15)
            result = response.json()

            if not result.get('errors'):
                return (
                    f'Question sent to human operators (taskId: {task_id}). '
                    f'Awaiting human response. You should now publish your preliminary findings '
                    f'and complete this session. You will be re-invoked with the human\'s answer.'
                )
            # Fall through to DDB direct write on AppSync error
        except Exception:
            pass

    # Fallback: direct DynamoDB write (still triggers DDB Stream for resume)
    dynamodb = boto3.resource('dynamodb', region_name=REGION)
    table = dynamodb.Table(HITL_TABLE)
    table.put_item(Item={
        'PK': f'HITL#{task_id}',
        'SK': 'QUESTION',
        **input_data,
    })

    return (
        f'Question sent to human operators (taskId: {task_id}). '
        f'Awaiting human response. You should now publish your preliminary findings '
        f'and complete this session. You will be re-invoked with the human\'s answer.'
    )
