"""Tool: get the datalake table schema for writing custom SQL queries."""

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
    response = requests.post(url, data=data, headers=dict(request.headers), timeout=30)
    return response.json()


@tool
def get_datalake_schema() -> str:
    """Get the aerospace datalake table schema — column names, types, descriptions, and tips.

    Call this before writing custom SQL with query_datalake_sql to understand
    the table structure and available columns.

    Returns:
        JSON with table name, columns (name, type, description), available named queries, and SQL tips
    """
    if not API_GATEWAY_URL:
        return json.dumps({'error': 'API_GATEWAY_URL not configured'})

    try:
        data = _sigv4_request(
            f'{API_GATEWAY_URL}query/athena-iam',
            {'query': 'getSchema'},
        )
        body = json.loads(data.get('body', '{}')) if isinstance(data.get('body'), str) else data
        return json.dumps(body, indent=2)
    except Exception as e:
        return json.dumps({'error': str(e)})
