"""Tool: query the aerospace datalake using pre-built named queries."""

import json
import os

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from strands import tool

API_GATEWAY_URL = os.environ.get('API_GATEWAY_URL', '')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')

AVAILABLE_QUERIES = [
    'ncrTrend', 'ncrBySupplier', 'ncrByPart', 'supplierPerformance',
    'workOrderTrend', 'holdImpact', 'programEV', 'milestoneHistory',
    'certEvents', 'machineEvents', 'fleetAnomalies', 'domainEventCounts', 'recentEvents',
]


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
def query_datalake(query_name: str, days: int = 7, entity_id: str = '', limit: int = 100) -> str:
    """Query the aerospace datalake using a pre-built named query.

    Available queries:
    - ncrTrend: NCR count by date + severity (QMS)
    - ncrBySupplier: NCR count by supplier + defect code (QMS)
    - ncrByPart: NCR count by part number + severity (QMS)
    - supplierPerformance: Supplier events over 30 days (SRM)
    - workOrderTrend: Work order count by status over time (MES)
    - holdImpact: HOLD_PLACED + KIT_SHORTAGE events (MES/WMS)
    - programEV: EV_UPDATED events with SPI/CPI (PROGRAM)
    - milestoneHistory: MILESTONE_AT_RISK events (PROGRAM)
    - certEvents: CERT_LINKED + DRAWING_RELEASED + TEST_RECORDED (DHR/PLM)
    - machineEvents: MACHINE_FAULT + PARAMETER_ANOMALY (SCADA)
    - fleetAnomalies: PARAMETER_DEVIATION + ANOMALY_DETECTED (INSERVICE)
    - domainEventCounts: Event count by domain + event_type (all)
    - recentEvents: Last N events for a domain/entity (all)

    Args:
        query_name: One of the available query names listed above
        days: Lookback window in days (default 7, max 90)
        entity_id: Optional entity filter (e.g. supplier ID, part number)
        limit: Max rows to return (default 100, max 500)

    Returns:
        JSON string with query results
    """
    if not API_GATEWAY_URL:
        return json.dumps({'error': 'API_GATEWAY_URL not configured'})

    if query_name not in AVAILABLE_QUERIES:
        return json.dumps({'error': f'Unknown query: {query_name}', 'available': AVAILABLE_QUERIES})

    try:
        data = _sigv4_request(
            f'{API_GATEWAY_URL}query/athena-iam',
            {'query': query_name, 'parameters': {'days': days, 'entityId': entity_id, 'limit': limit}},
        )
        body = json.loads(data.get('body', '{}')) if isinstance(data.get('body'), str) else data
        return json.dumps(body, indent=2)
    except Exception as e:
        return json.dumps({'error': str(e)})
