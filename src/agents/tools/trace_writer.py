"""Shared trace writer — logs agent actions to agent-trace DDB table."""

import json
import os
import time
import logging

import boto3

logger = logging.getLogger('trace-writer')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')
TRACE_TABLE = 'agent-trace'

_table = None


def _get_table():
    global _table
    if not _table:
        _table = boto3.resource('dynamodb', region_name=REGION).Table(TRACE_TABLE)
    return _table


def write_trace(action: str, detail: dict | None = None):
    """Write a trace record for the current agent invocation."""
    correlation_id = os.environ.get('CORRELATION_ID', '')
    if not correlation_id:
        return

    session_id = os.environ.get('AGENT_SESSION_ID', '')
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())

    try:
        _get_table().put_item(Item={
            'PK': f'TRACE#{correlation_id}',
            'SK': f'{now}#{session_id[:12]}#{action}',
            'correlationId': correlation_id,
            'sessionId': session_id,
            'agentId': os.environ.get('AGENT_ID', 'unknown'),
            'agentName': os.environ.get('AGENT_NAME', 'Agent'),
            'action': action,
            'sourceEventId': os.environ.get('SOURCE_EVENT_ID', ''),
            'parentSessionId': os.environ.get('PARENT_SESSION_ID', ''),
            'timestamp': now,
            'ttl': int(time.time()) + 7 * 86400,
            **(({'detail': json.dumps(detail)} if detail else {})),
        })
    except Exception as e:
        logger.warning('Trace write failed: %s', e)
