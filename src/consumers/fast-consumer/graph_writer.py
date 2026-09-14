"""Shared Neptune HTTP REST graph writer — batch upserts for nodes and edges.

L3: GraphBatch.flush() also dual-writes to the RDF/SPARQL store via rdf_writer.
RDF dual-write can be disabled per-deployment with RDF_DUAL_WRITE=false.
"""

import json
import logging
import os
import time

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

# L3: optional RDF dual-write. Defaults ON; set RDF_DUAL_WRITE=false to opt out
# (e.g., during ECS rolling deploys when the SPARQL Lambda is not yet rolled).
RDF_DUAL_WRITE = os.environ.get('RDF_DUAL_WRITE', 'true').lower() != 'false'
try:
    if RDF_DUAL_WRITE:
        from rdf_writer import write_batch as rdf_write_batch
    else:
        rdf_write_batch = None
except ImportError:
    rdf_write_batch = None

logger = logging.getLogger('graph-writer')

NEPTUNE_ENDPOINT = os.environ.get('NEPTUNE_ENDPOINT', '')
NEPTUNE_PORT = os.environ.get('NEPTUNE_PORT', '8182')
OFFSETS_TABLE = os.environ.get('OFFSETS_TABLE', 'digital-thread-offsets')
DLQ_TABLE = os.environ.get('DLQ_TABLE', 'graph-write-dlq')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')

_dynamodb = None


def _get_dynamodb():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource('dynamodb', region_name=REGION)
    return _dynamodb


def escape(s: str) -> str:
    """Escape string for Gremlin query."""
    return str(s).replace("\\", "\\\\").replace("'", "\\'").replace('"', '\\"')


def execute_gremlin(gremlin: str) -> dict:
    """Execute a Gremlin query via Neptune HTTP REST API with SigV4 auth."""
    url = f'https://{NEPTUNE_ENDPOINT}:{NEPTUNE_PORT}/gremlin'
    body = json.dumps({'gremlin': gremlin})

    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()
    request = AWSRequest(method='POST', url=url, data=body,
                         headers={'Content-Type': 'application/json'})
    SigV4Auth(credentials, 'neptune-db', REGION).add_auth(request)

    response = requests.post(url, data=body, headers=dict(request.headers), timeout=30)
    response.raise_for_status()
    return response.json()


def is_processed(event_id: str, node_id: str) -> bool:
    table = _get_dynamodb().Table(OFFSETS_TABLE)
    resp = table.get_item(Key={'PK': f'EVENT#{event_id}', 'SK': f'NODE#{node_id}'})
    return 'Item' in resp


def mark_processed(event_id: str, node_id: str):
    table = _get_dynamodb().Table(OFFSETS_TABLE)
    table.put_item(Item={
        'PK': f'EVENT#{event_id}',
        'SK': f'NODE#{node_id}',
        'processedAt': int(time.time()),
    })


def write_dlq(operation: str, node_id: str, gremlin: str, error: str, event: dict = None):
    """Write a failed graph operation to the DLQ table for troubleshooting/replay."""
    if not DLQ_TABLE:
        return
    try:
        table = _get_dynamodb().Table(DLQ_TABLE)
        table.put_item(Item={
            'PK': f'FAIL#{int(time.time())}#{node_id}',
            'SK': operation,
            'nodeId': node_id,
            'gremlin': gremlin[:4000],  # DDB item size limit
            'error': str(error)[:1000],
            'eventId': (event or {}).get('eventId', ''),
            'eventType': (event or {}).get('eventType', ''),
            'domain': (event or {}).get('domain', ''),
            'failedAt': int(time.time()),
            'ttl': int(time.time()) + 7 * 86400,  # 7-day TTL
        })
    except Exception as e:
        logger.warning('DLQ write failed: %s', e)


# ─── Single-call helpers (used by simple handlers) ──────────────────

def upsert_node(label: str, node_id: str, properties: dict, event: dict = None):
    """Upsert a single vertex. Writes to DLQ on failure."""
    props = ''.join(
        f".property('{escape(k)}', '{escape(v)}')" for k, v in properties.items() if v
    )
    query = f"""
        g.V().has('{escape(label)}', 'id', '{escape(node_id)}').fold().coalesce(
            unfold(),
            addV('{escape(label)}').property('id', '{escape(node_id)}')
        ){props}
    """
    try:
        execute_gremlin(query)
    except Exception as e:
        logger.warning('Node upsert failed %s:%s: %s', label, node_id, e)
        write_dlq('upsert_node', f'{label}:{node_id}', query, str(e), event)
        raise


def upsert_edge(source_label: str, source_id: str,
                target_label: str, target_id: str,
                edge_label: str):
    """Upsert a single edge, creating stub nodes if endpoints missing."""
    execute_gremlin(f"""
        g.V().has('{escape(source_label)}', 'id', '{escape(source_id)}').fold().coalesce(
            unfold(), addV('{escape(source_label)}').property('id', '{escape(source_id)}'))
    """)
    execute_gremlin(f"""
        g.V().has('{escape(target_label)}', 'id', '{escape(target_id)}').fold().coalesce(
            unfold(), addV('{escape(target_label)}').property('id', '{escape(target_id)}'))
    """)
    execute_gremlin(f"""
        g.V().has('{escape(source_label)}', 'id', '{escape(source_id)}').as('src')
         .V().has('{escape(target_label)}', 'id', '{escape(target_id)}')
         .coalesce(__.inE('{escape(edge_label)}').where(__.outV().as('src')),
                    __.addE('{escape(edge_label)}').from('src'))
    """)


def update_node(label: str, node_id: str, properties: dict):
    """Update properties on an existing node."""
    props = ''.join(
        f".property('{escape(k)}', '{escape(v)}')" for k, v in properties.items() if v
    )
    if props:
        execute_gremlin(f"""
            g.V().has('{escape(label)}', 'id', '{escape(node_id)}'){props}
        """)


# ─── Batch writer — collects nodes + edges, flushes in 2 queries ────

class GraphBatch:
    """Collect node upserts and edge upserts, flush in batched Gremlin queries.

    Usage:
        batch = GraphBatch()
        batch.add_node('Part', 'P-001', {'partNumber': 'P-001'})
        batch.add_node('Supplier', 'S-001', {'supplierId': 'S-001'})
        batch.add_edge('Part', 'P-001', 'Supplier', 'S-001', 'SUPPLIED_BY')
        batch.flush()

    Nodes are flushed first (one query), then edges (one query per edge).
    Reduces round-trips from N*3 to N+E (N nodes in 1 query, E edges in E queries).
    """

    def __init__(self, event: dict = None):
        self._nodes: list[tuple[str, str, dict]] = []  # (label, id, props)
        self._edges: list[tuple[str, str, str, str, str]] = []  # (src_label, src_id, tgt_label, tgt_id, edge_label)
        self._event = event  # original event for DLQ context

    def add_node(self, label: str, node_id: str, properties: dict):
        self._nodes.append((label, node_id, properties))

    def add_edge(self, source_label: str, source_id: str,
                 target_label: str, target_id: str,
                 edge_label: str):
        self._edges.append((source_label, source_id, target_label, target_id, edge_label))

    def flush(self):
        """Flush all collected nodes and edges to Neptune."""
        if not self._nodes and not self._edges:
            return

        # 1. Batch upsert all nodes in a single Gremlin traversal
        if self._nodes:
            self._flush_nodes()

        # 2. Ensure edge endpoint stubs exist (collect unique endpoints not already in nodes)
        if self._edges:
            self._ensure_edge_endpoints()
            self._flush_edges()

        # 3. ISA-95 L3: RDF dual-write. Failures here are logged but not fatal —
        # Gremlin is the primary store; RDF augments it.
        if rdf_write_batch is not None and (self._nodes or self._edges):
            try:
                rdf_write_batch(list(self._nodes), list(self._edges), self._event)
            except Exception as e:
                logger.warning('rdf dual-write skipped: %s', e)

        self._nodes.clear()
        self._edges.clear()

    def _flush_nodes(self):
        """Upsert all nodes individually."""
        for label, node_id, properties in self._nodes:
            try:
                upsert_node(label, node_id, properties, self._event)
            except Exception:
                pass  # upsert_node already logged + wrote to DLQ

    def _ensure_edge_endpoints(self):
        """Create stub nodes for any edge endpoints not already in the node batch."""
        node_keys = {(label, nid) for label, nid, _ in self._nodes}
        for src_label, src_id, tgt_label, tgt_id, _ in self._edges:
            if (src_label, src_id) not in node_keys:
                try:
                    upsert_node(src_label, src_id, {})
                except Exception:
                    pass
                node_keys.add((src_label, src_id))
            if (tgt_label, tgt_id) not in node_keys:
                try:
                    upsert_node(tgt_label, tgt_id, {})
                except Exception:
                    pass
                node_keys.add((tgt_label, tgt_id))

    def _flush_edges(self):
        """Upsert edges. Each edge is one query."""
        for src_label, src_id, tgt_label, tgt_id, edge_label in self._edges:
            query = f"""
                g.V().has('{escape(src_label)}', 'id', '{escape(src_id)}').as('src')
                 .V().has('{escape(tgt_label)}', 'id', '{escape(tgt_id)}')
                 .coalesce(__.inE('{escape(edge_label)}').where(__.outV().as('src')),
                            __.addE('{escape(edge_label)}').from('src'))
            """
            try:
                execute_gremlin(query)
            except Exception as e:
                logger.warning('Edge %s %s→%s failed: %s', edge_label, src_id, tgt_id, e)
                write_dlq('upsert_edge', f'{src_id}->{tgt_id}', query, str(e), self._event)


