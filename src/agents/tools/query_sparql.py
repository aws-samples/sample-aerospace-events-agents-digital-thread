"""Tool: query the Neptune RDF/SPARQL store (ISA-95:2018 Level 3)."""

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
def query_sparql(sparql: str) -> str:
    """Run a SPARQL SELECT/CONSTRUCT/ASK/DESCRIBE query against the Neptune RDF store.

    The RDF store contains:
    - **TBox** in named graph `<https://ares.example/aerospace/digitalthread/tbox>`:
      ISA-95 reference ontologies (IOF Core + ProductionPlanning + hsu-aut DINEN62264-2).
      Use this to ask "what classes/properties exist", or to walk class hierarchies.
    - **ABox** in named graph `<https://ares.example/aerospace/digitalthread/abox>`:
      Live event facts. Every property-graph node has a parallel triple here.
      Subjects use stable URN IRIs:
        urn:aerospace:material:{partNumber}        (MaterialDefinition)
        urn:aerospace:lot:{lotNumber}              (MaterialLot)
        urn:aerospace:sublot:{serialNumber}        (MaterialSublot)
        urn:aerospace:equipment:{machineId}        (Equipment)
        urn:aerospace:job:{workOrderId}            (JobOrder | JobResponse)
        urn:aerospace:opsperf:{ncrId|certNumber|testId} (OperationsPerformance)
        urn:aerospace:person:{personId}            (Person)
      Properties live under <https://ares.example/aerospace-events-agents-digital-thread/prop/{name}>.
      Object relations live under <https://ares.example/aerospace-events-agents-digital-thread/rel/{name}>.

    Tips:
    - Always restrict to a named graph: GRAPH <abox-iri> { ... } or GRAPH <tbox-iri> { ... }
    - For pattern queries the SELECT form is easiest; for subgraph extraction use CONSTRUCT.
    - When searching for an aerospace fact, use the ABox; when walking the ISA-95 class
      tree, use the TBox.
    - The Gremlin store (use query_graph) and SPARQL store hold the same logical facts in
      different shapes. Pick whichever is more ergonomic for the question.

    Example — find all OperationsPerformance subjects with their type:
        SELECT ?op ?type WHERE {
          GRAPH <https://ares.example/aerospace/digitalthread/abox> {
            ?op a <https://ares.example/aerospace-events-agents-digital-thread/OperationsPerformance> .
            ?op <https://ares.example/aerospace-events-agents-digital-thread/prop/subtype> ?type .
          }
        } LIMIT 20

    Args:
        sparql: A SPARQL 1.1 query string (SELECT / CONSTRUCT / ASK / DESCRIBE).

    Returns:
        JSON string with the SPARQL results-format response (or an error).
    """
    if not API_GATEWAY_URL:
        return json.dumps({'error': 'API_GATEWAY_URL not configured'})
    if not sparql or not sparql.strip():
        return json.dumps({'error': 'sparql parameter is required'})

    try:
        data = _sigv4_request(
            f'{API_GATEWAY_URL}query/neptune-iam',
            {'operation': 'execute_sparql', 'parameters': {'sparql': sparql}},
        )
        body = json.loads(data.get('body', '{}')) if isinstance(data.get('body'), str) else data
        return json.dumps(body, indent=2)
    except Exception as e:
        return json.dumps({'error': str(e)})
