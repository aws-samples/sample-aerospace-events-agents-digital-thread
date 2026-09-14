"""Tool: query the Neptune knowledge graph with parameterized operations."""

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
def query_graph(operation: str, node_id: str = '', node_label: str = '',
                filters: str = '{}', edge_label: str = '', direction: str = 'out',
                target_label: str = '', depth: int = 1, group_by: str = '',
                limit: int = 50, level: str = '', job_order_id: str = '') -> str:
    """Query the Neptune knowledge graph (ISA-95:2018 vocabulary).

    Operations:
    - get_node: Get a node + its immediate neighbors (node_id + node_label required)
    - query_by_type: Find nodes by label + filters (node_label required, filters as JSON string)
    - traverse: Follow edges from a start node (node_id, node_label, edge_label, direction, target_label, depth)
    - query_neighbors: Get filtered neighbors (node_id, node_label, edge_label=comma-separated labels)
    - count_by_type: Aggregate counts (node_label required, group_by optional property name)
    - get_thread_state: Full 3-hop subgraph for a MaterialSublot (node_id = serial number)
    - query_hierarchy: Walk the ISA-95 partOf chain (level + node_id required; direction='down' returns
      descendants — e.g. all WorkUnits under an Area; direction='up' returns ancestors)
    - query_plan_vs_actual: Diff a JobOrder's requested segments vs its JobResponse's executed segments
      (job_order_id required). Returns missingSegments (skipped), extraSegments (added), and a summary —
      the structural way to detect skipped inspection steps.

    Call get_graph_schema first to see available node types, edge types, and properties.

    Args:
        operation: One of get_node, query_by_type, traverse, query_neighbors, count_by_type,
                   get_thread_state, query_hierarchy, query_plan_vs_actual
        node_id: Node ID (e.g. 'SN-0047', 'titan-forge', 'NCR-1234'); also used as the starting hierarchy
                 node id when operation=query_hierarchy
        node_label: ISA-95 node type (e.g. 'MaterialSublot', 'Supplier', 'OperationsPerformance')
        filters: JSON string of property filters for query_by_type
                 (e.g. '{"subtype":"NonConformance","severity":"CRITICAL"}')
        edge_label: Edge type for traverse/query_neighbors (e.g. 'attributedTo', 'affectsMaterial')
        direction: Traversal direction. For traverse/query_neighbors: 'out', 'in', or 'both' (default 'out').
                   For query_hierarchy: 'down' (descendants, default) or 'up' (ancestors).
        target_label: Target node type for traverse (optional filter)
        depth: Traversal depth 1-5 (default 1)
        group_by: Property to group by for count_by_type (e.g. 'subtype' for OperationsPerformance)
        limit: Max results (default 50)
        level: Hierarchy level for query_hierarchy: 'Enterprise', 'Site', 'Area', 'WorkCenter', or 'WorkUnit'
        job_order_id: JobOrder ID for query_plan_vs_actual (e.g. 'WO-12345')

    Returns:
        JSON string with query results
    """
    if not API_GATEWAY_URL:
        return json.dumps({'error': 'API_GATEWAY_URL not configured'})

    try:
        params = {}
        if node_id:
            params['nodeId'] = node_id
        if node_label:
            params['nodeLabel'] = node_label
        if operation == 'query_by_type':
            params['filters'] = json.loads(filters) if isinstance(filters, str) else filters
        if edge_label:
            params['edgeLabels'] = edge_label
        if direction:
            params['direction'] = direction
        if target_label:
            params['targetLabel'] = target_label
        if depth > 1:
            params['depth'] = depth
        if group_by:
            params['groupBy'] = group_by
        if limit != 50:
            params['limit'] = limit
        if operation == 'get_thread_state':
            params['serialNumber'] = node_id
        if operation == 'query_hierarchy':
            params['level'] = level
            params['id'] = node_id
            # direction=down|up (default down). Override the default 'out' from traverse semantics.
            params['direction'] = direction if direction in ('down', 'up') else 'down'
        if operation == 'query_plan_vs_actual':
            params['jobOrderId'] = job_order_id

        data = _sigv4_request(
            f'{API_GATEWAY_URL}query/neptune-iam',
            {'operation': operation, 'parameters': params},
        )
        body = json.loads(data.get('body', '{}')) if isinstance(data.get('body'), str) else data
        return json.dumps(body, indent=2)
    except Exception as e:
        return json.dumps({'error': str(e)})
