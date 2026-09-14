"""Tool: read a PLM 2D engineering drawing (PNG in S3) with Bedrock Claude vision
and extract the toleranced bore dimension.

The unstructured-data payoff for the BORE_DIAMETER_OOT defect: the conformance agent
correlates the as-designed bore tolerance (read off the drawing) against the
as-measured value carried on the NCR.

Resolution path (ISA-95): a part is a `MaterialDefinition` node; its drawing is a
`ProductDefinitionDocument` node linked via the `hasDocument` edge. We reuse the same
neptune-query Lambda + SigV4 mechanism as query_graph.py — operation=query_neighbors
from the part's MaterialDefinition over `hasDocument` — and read `drawingS3Key` /
`drawingS3Bucket` off the resolved drawing node.

Required IAM on the agent runtime role (wired in the AgentCore stack separately):
  - bedrock:InvokeModel on the Claude inference profile (already granted)
  - s3:GetObject on the drawings prefix (datalake/drawings/*)
  - execute-api:Invoke on the API Gateway neptune-iam endpoint (already granted)
"""

import base64
import json
import os

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from strands import tool

from tools.trace_writer import write_trace

API_GATEWAY_URL = os.environ.get('API_GATEWAY_URL', '')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')
MODEL_ID = 'global.anthropic.claude-sonnet-4-6'  # same inference profile the agents use

PROMPT = (
    "This is a 2D mechanical engineering drawing. Read it and extract the following as "
    "strict JSON with these keys: partNumber, revision, boreNominalDiameterMm (number), "
    "boreToleranceUpperMm (number), boreToleranceLowerMm (number), fitClass. "
    "Use only what is shown on the drawing. Respond with JSON only, no prose."
)


def _sigv4_request(url: str, body: dict) -> dict:
    data = json.dumps(body)
    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()
    request = AWSRequest(method='POST', url=url, data=data,
                         headers={'Content-Type': 'application/json'})
    SigV4Auth(credentials, 'execute-api', REGION).add_auth(request)
    response = requests.post(url, data=data, headers=dict(request.headers), timeout=30)
    return response.json()


def _resolve_drawing(part_number: str) -> dict:
    """Resolve the ProductDefinitionDocument linked to the part's MaterialDefinition.

    Returns the drawing node's properties (incl. drawingS3Key / drawingS3Bucket / drawingUri)
    or {} if the part has no linked drawing.
    """
    data = _sigv4_request(
        f'{API_GATEWAY_URL}query/neptune-iam',
        {'operation': 'query_neighbors', 'parameters': {
            'nodeId': part_number,
            'nodeLabel': 'MaterialDefinition',
            'edgeLabels': 'hasDocument',
            'targetLabel': 'ProductDefinitionDocument',
        }},
    )
    body = json.loads(data.get('body', '{}')) if isinstance(data.get('body'), str) else data
    neighbors = body.get('neighbors', [])
    if not neighbors:
        return {}
    return neighbors[0].get('properties', {})


@tool
def read_drawing(part_number: str) -> str:
    """Read the part's 2D engineering drawing (PNG) with vision and extract its bore tolerance.

    Resolves the part's released drawing in the knowledge graph (MaterialDefinition
    --hasDocument--> ProductDefinitionDocument), fetches the PNG from S3, and uses
    Bedrock Claude vision to read the toleranced bore dimension off the drawing.

    Use this on a BORE_DIAMETER_OOT / bore NCR to obtain the as-designed bore tolerance,
    then compare it to the as-measured value on the NCR.

    Args:
        part_number: The part number (e.g. '44821-003')

    Returns:
        JSON string with partNumber, revision, boreNominalDiameterMm, boreToleranceUpperMm,
        boreToleranceLowerMm, fitClass — or a JSON error.
    """
    if not API_GATEWAY_URL:
        return json.dumps({'error': 'API_GATEWAY_URL not configured'})

    try:
        drawing = _resolve_drawing(part_number)
        if not drawing:
            return json.dumps({'error': f'No drawing linked to part {part_number}'})

        s3_key = drawing.get('drawingS3Key', '')
        bucket = drawing.get('drawingS3Bucket', '')
        if not bucket and drawing.get('drawingUri', '').startswith('s3://'):
            # s3://bucket/key/... — recover the bucket from the URI.
            bucket = drawing['drawingUri'][len('s3://'):].split('/', 1)[0]
        if not s3_key or not bucket:
            return json.dumps({'error': f'Drawing for {part_number} has no S3 reference',
                               'drawing': drawing})

        obj = boto3.client('s3', region_name=REGION).get_object(Bucket=bucket, Key=s3_key)
        img_b64 = base64.standard_b64encode(obj['Body'].read()).decode()

        client = boto3.client('bedrock-runtime', region_name=REGION)
        resp = client.invoke_model(
            modelId=MODEL_ID,
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 1024,
                'messages': [{
                    'role': 'user',
                    'content': [
                        {'type': 'image', 'source': {
                            'type': 'base64', 'media_type': 'image/png', 'data': img_b64}},
                        {'type': 'text', 'text': PROMPT},
                    ],
                }],
            }),
        )
        text = json.loads(resp['body'].read())['content'][0]['text'].strip()
        # Vision sometimes wraps the JSON in a ```json … ``` fence — unwrap it.
        if text.startswith('```'):
            text = text.split('```', 2)[1].lstrip('json').strip()
        extracted = json.loads(text)

        write_trace('read_drawing', {
            'partNumber': part_number,
            's3Key': s3_key,
            'boreNominalDiameterMm': extracted.get('boreNominalDiameterMm'),
            'boreToleranceUpperMm': extracted.get('boreToleranceUpperMm'),
            'boreToleranceLowerMm': extracted.get('boreToleranceLowerMm'),
        })
        return json.dumps(extracted, indent=2)
    except Exception as e:
        return json.dumps({'error': str(e)})
