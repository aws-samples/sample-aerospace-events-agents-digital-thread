"""Tool: run custom SQL SELECT queries against the aerospace datalake."""

import json
import os

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from strands import tool

API_GATEWAY_URL = os.environ.get('API_GATEWAY_URL', '')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')


def _sigv4_request(url: str, body: dict) -> dict:
    data = json.dumps(body)
    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()
    request = AWSRequest(method='POST', url=url, data=data,
                         headers={'Content-Type': 'application/json'})
    SigV4Auth(credentials, 'execute-api', REGION).add_auth(request)
    response = requests.post(url, data=data, headers=dict(request.headers), timeout=65)
    return response.json()


@tool
def query_datalake_sql(sql: str) -> str:
    """Run a custom SQL SELECT query against the aerospace datalake.

    Table: aerospace_events.domain_events (all columns are strings)
    Only SELECT queries allowed. Auto-limited to 100 rows. 60s timeout.

    Call get_datalake_schema first to see available columns and SQL tips.

    Example: SELECT domain, event_type, COUNT(*) as cnt FROM aerospace_events.domain_events
             WHERE occurred_at >= CAST(current_date - INTERVAL '7' DAY AS VARCHAR)
             GROUP BY 1, 2 ORDER BY cnt DESC

    Args:
        sql: A SELECT query against aerospace_events.domain_events

    Returns:
        JSON with query results (rows) and execution time
    """
    if not API_GATEWAY_URL:
        return json.dumps({'error': 'API_GATEWAY_URL not configured'})

    try:
        data = _sigv4_request(
            f'{API_GATEWAY_URL}query/athena-iam',
            {'query': 'freeformSql', 'parameters': {'sql': sql}},
        )
        body = json.loads(data.get('body', '{}')) if isinstance(data.get('body'), str) else data
        return json.dumps(body, indent=2)
    except Exception as e:
        return json.dumps({'error': str(e)})
