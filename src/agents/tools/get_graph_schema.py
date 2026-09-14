"""Tool: get the Neptune graph schema for writing graph queries."""

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
def get_graph_schema() -> str:
    """Get the Neptune knowledge graph schema — node types, edge types, properties, and tips.

    Call this before using query_graph to understand what nodes, edges, and
    properties are available in the graph.

    Returns:
        JSON with nodeTypes, edgeTypes, and querying tips
    """
    if not API_GATEWAY_URL:
        return json.dumps({'error': 'API_GATEWAY_URL not configured'})

    try:
        data = _sigv4_request(
            f'{API_GATEWAY_URL}query/neptune-iam',
            {'operation': 'get_graph_schema', 'parameters': {}},
        )
        body = json.loads(data.get('body', '{}')) if isinstance(data.get('body'), str) else data
        return json.dumps(body, indent=2)
    except Exception as e:
        return json.dumps({'error': str(e)})
