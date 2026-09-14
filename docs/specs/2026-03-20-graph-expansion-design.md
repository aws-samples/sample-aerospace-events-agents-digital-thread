# Neptune Graph Expansion — Design Spec

**Date:** 2026-03-20
**Status:** Approved

Expand the Neptune knowledge graph from QMS-only to all 9 domains, add parameterized query operations, and wire all 10 agents to use the richer graph.

---

## Overview

Three sub-projects executed in order:

1. **Fast Consumer Expansion** — modular handlers write 16 node types + 20 edge types from all 9 domains
2. **Neptune Query Layer** — 6 new parameterized query operations + schema discovery
3. **Agent Graph Integration** — new tools (`query_graph`, `get_graph_schema`) replacing broken `graph_get_node`

---

## Sub-project 2: Fast Consumer Expansion

### Architecture

Single consumer service, modular handlers. One Python module per domain.

```
src/consumers/fast-consumer/
  main.py              — Kafka consumer loop + domain dispatcher
  graph_writer.py      — Shared Neptune HTTP REST upsert helpers
  handlers/
    __init__.py        — Handler registry
    qms.py             — NonConformance + Lot (extracted from main.py)
    mes.py             — WorkOrder + Machine assignment
    plm.py             — Part updates, Drawing, ECO
    erp.py             — PurchaseOrder, Lot, receipt linkage
    srm.py             — Supplier score updates
    wms.py             — Kit staging + lot linkage
    dhr.py             — Certificate, TestRecord
    program.py         — Milestone
    inservice.py       — DigitalTwin, FleetAnomaly
    scada.py           — Machine status updates
```

### Dispatcher

```python
HANDLERS = {
    'aerospace.qms.events': qms.handle,
    'aerospace.mes.events': mes.handle,
    'aerospace.plm.events': plm.handle,
    'aerospace.erp.events': erp.handle,
    'aerospace.srm.events': srm.handle,
    'aerospace.wms.events': wms.handle,
    'aerospace.dhr.events': dhr.handle,
    'aerospace.program.events': program.handle,
    'aerospace.inservice.events': inservice.handle,
    'aerospace.scada.events': scada.handle,
}
```

### Graph Writer API

```python
upsert_node(label: str, node_id: str, properties: dict)
upsert_edge(source_label: str, source_id: str,
            target_label: str, target_id: str,
            edge_label: str, properties: dict = {})
update_node(label: str, node_id: str, properties: dict)
```

All use Neptune HTTP REST + SigV4 auth. Idempotent via `fold().coalesce(unfold(), addV())`.

### Node ID Convention

Each node type uses a natural key as `id`:

| Node Type | ID Property | Example |
|-----------|------------|---------|
| SerialNumber | serialNumber | SN-0047 |
| Part | partNumber | 44821-003 |
| Supplier | supplierId | titan-forge |
| NonConformance | ncrId | NCR-1234 |
| WorkOrder | workOrderId | WO-85432 |
| Machine | machineId | cnc-mill-3 |
| Lot | lotNumber | LOT-7731 |
| Kit | kitId | KIT-12345 |
| Drawing | drawingNumber | DWG-44821-003-512 |
| ECO | ecoId | ECO-2345 |
| PurchaseOrder | poNumber | PO-42356 |
| Certificate | certNumber | CERT-1234 |
| TestRecord | testId | TEST-5432 |
| Milestone | milestoneId | FAI-Complete |
| DigitalTwin | serialNumber | SN-0038 |
| FleetAnomaly | anomalyId | generated UUID |

### Deduplication

Same DynamoDB offset table: `PK=EVENT#{eventId}`, `SK=NODE#{nodeId}`. Skip if already processed.

### Handler Details

**QMS** (`handlers/qms.py`):
- Event: `NON_CONFORMANCE_RAISED`
- Nodes: NonConformance, SerialNumber, Part, Supplier, Lot (if lotNumber present)
- Edges: RAISED_AGAINST (NCR→SN), AFFECTS_PART (NCR→Part), TRACED_TO (NCR→Supplier), USED_LOT (SN→Lot), SUPPLIED_BY (Lot→Supplier), FOR_PART (Lot→Part)

**MES** (`handlers/mes.py`):
- Event: `WORK_ORDER_STARTED` → WorkOrder, SerialNumber, Part, Machine (from cell mapping). Edges: FOR_PART (WO→Part), FOR_SERIAL (WO→SN), RUNS_ON (WO→Machine)
- Event: `OPERATION_COMPLETED` → update WorkOrder properties
- Event: `HOLD_PLACED` → update WorkOrder status=HOLD, holdReason

**PLM** (`handlers/plm.py`):
- Event: `PART_RELEASED` → upsert Part with revision + description
- Event: `DRAWING_RELEASED` → Drawing node. Edge: HAS_DRAWING (Part→Drawing)
- Event: `ECO_INITIATED` → ECO node. Edge: CHANGED_BY (Part→ECO)

**ERP** (`handlers/erp.py`):
- Event: `PO_ISSUED` → PurchaseOrder, Supplier. Edge: ORDERS_FROM (PO→Supplier)
- Event: `MATERIAL_RECEIVED` → Lot, Supplier, Part. Edges: SUPPLIED_BY (Lot→Supplier), FOR_PART (Lot→Part), ORDERED_BY (Lot→PO if linkable)

**SRM** (`handlers/srm.py`):
- Event: `SUPPLIER_SCORE_UPDATED` / `SUPPLIER_OTD_DEGRADED` → update Supplier properties (otdPercent, qualityScore, qualificationStatus)

**WMS** (`handlers/wms.py`):
- Event: `KIT_STAGED` / `KIT_SHORTAGE_DETECTED` → Kit, Lot. Edges: KITS_FOR (Kit→WO), USES_LOT (Kit→Lot)

**DHR** (`handlers/dhr.py`):
- Event: `OPERATION_SIGNED` → update SerialNumber op signoff tracking
- Event: `CERT_LINKED` → Certificate. Edge: HAS_CERT (SN→Certificate)
- Event: `TEST_RECORDED` → TestRecord. Edge: HAS_TEST (SN→TestRecord)

**Program** (`handlers/program.py`):
- Event: `MILESTONE_AT_RISK` / `EV_UPDATED` → Milestone. Edge: TRACKED_BY (Part→Milestone)

**InService** (`handlers/inservice.py`):
- Event (status=NORMAL) → DigitalTwin (update flightHours). Edge: IN_SERVICE_AS (SN→DigitalTwin)
- Event (status=ANOMALY) → FleetAnomaly. Edge: DETECTED_ON (FleetAnomaly→DigitalTwin)

**SCADA** (`handlers/scada.py`):
- Events from IoT→MSK → update Machine properties (status, lastOee, lastVibration)

---

## Graph Schema

### Node Types (16)

| Label | Domain | ID Property | Key Properties |
|-------|--------|------------|----------------|
| SerialNumber | Core | serialNumber | serialNumber |
| Part | Engineering | partNumber | partNumber, description, revision, status |
| Supplier | Supply Chain | supplierId | supplierId, supplierName, otdPercent, qualityScore, qualificationStatus |
| NonConformance | Quality | ncrId | ncrId, severity, defectCode, status, partNumber, supplierId, lotNumber |
| WorkOrder | Manufacturing | workOrderId | workOrderId, status, cell, operationNumber, holdReason |
| Machine | Shop Floor | machineId | machineId, cellId, status, lastOee |
| Lot | Supply Chain | lotNumber | lotNumber, partNumber, supplierId, receivedAt |
| Kit | Supply Chain | kitId | kitId, status, shortage |
| Drawing | Engineering | drawingNumber | drawingNumber, revisionLetter, status |
| ECO | Engineering | ecoId | ecoId, description, status |
| PurchaseOrder | Supply Chain | poNumber | poNumber, quantity, status |
| Certificate | Compliance | certNumber | certNumber, certType, linked |
| TestRecord | Compliance | testId | testId, testType, result |
| Milestone | Program | milestoneId | milestoneId, confidence, status |
| DigitalTwin | Fleet | serialNumber | serialNumber, flightHours, lastStatus |
| FleetAnomaly | Fleet | anomalyId | parameter, deviation, status |

Slow consumer continues writing: ThreadGap, CoherenceVerdict, AsBuiltRecord (unchanged).

### Edge Types (20)

| Label | Source | Target | Domain |
|-------|--------|--------|--------|
| RAISED_AGAINST | NonConformance | SerialNumber | Quality |
| AFFECTS_PART | NonConformance | Part | Quality |
| TRACED_TO | NonConformance | Supplier | Quality |
| FOR_PART | WorkOrder | Part | Manufacturing |
| FOR_SERIAL | WorkOrder | SerialNumber | Manufacturing |
| RUNS_ON | WorkOrder | Machine | Manufacturing |
| HAS_DRAWING | Part | Drawing | Engineering |
| CHANGED_BY | Part | ECO | Engineering |
| SUPPLIED_BY | Lot | Supplier | Supply Chain |
| FOR_PART | Lot | Part | Supply Chain |
| ORDERED_BY | Lot | PurchaseOrder | Supply Chain |
| ORDERS_FROM | PurchaseOrder | Supplier | Supply Chain |
| KITS_FOR | Kit | WorkOrder | Supply Chain |
| USES_LOT | Kit | Lot | Supply Chain |
| USED_LOT | SerialNumber | Lot | Compliance |
| HAS_CERT | SerialNumber | Certificate | Compliance |
| HAS_TEST | SerialNumber | TestRecord | Compliance |
| IN_SERVICE_AS | SerialNumber | DigitalTwin | Fleet |
| DETECTED_ON | FleetAnomaly | DigitalTwin | Fleet |
| TRACKED_BY | Part | Milestone | Program |

---

## Sub-project 1: Neptune Query Layer

### New Operations

Added to `src/lambdas/neptune-query/index.ts`:

| Operation | Parameters | Returns |
|-----------|-----------|---------|
| `get_thread_state` | serialNumber | Full 3-hop subgraph (existing, unchanged) |
| `get_node` | nodeId, nodeLabel | Single node + immediate neighbors + edges |
| `query_by_type` | nodeLabel, filters (JSON), limit | Nodes matching label + property filters |
| `traverse` | startId, startLabel, edgeLabel, direction (out/in/both), targetLabel, depth (1-5) | Path of nodes + edges |
| `query_neighbors` | nodeId, nodeLabel, edgeLabels (comma-separated), targetLabels (comma-separated) | Filtered neighbors |
| `count_by_type` | nodeLabel, groupBy (property) | Aggregated counts |
| `get_graph_schema` | (none) | Static: all node types, edge types, properties, tips |

### Schema Discovery Response

```json
{
  "nodeTypes": [
    { "label": "SerialNumber", "idProperty": "serialNumber", "properties": [...], "domain": "Core" },
    ...
  ],
  "edgeTypes": [
    { "label": "RAISED_AGAINST", "source": "NonConformance", "target": "SerialNumber" },
    ...
  ],
  "tips": [
    "Use get_node for a single node + neighbors",
    "Use traverse with depth 1-5 for relationship chains",
    "Use query_by_type with filters for finding nodes by property",
    "SerialNumber is the central hub — most nodes reachable within 3 hops"
  ]
}
```

---

## Sub-project 3: Agent Graph Integration

### New Agent Tools

Replace `graph_get_node.py` with 2 new tools:

**`get_graph_schema.py`** — schema discovery
```python
@tool
def get_graph_schema() -> str:
    """Get the Neptune graph schema — node types, edge types, properties, and query tips."""
```

**`query_graph.py`** — parameterized graph queries
```python
@tool
def query_graph(operation: str, node_id: str = '', node_label: str = '',
                filters: str = '{}', edge_label: str = '', direction: str = 'out',
                target_label: str = '', depth: int = 1, group_by: str = '',
                limit: int = 50) -> str:
    """Query the Neptune knowledge graph.

    Operations: get_node, query_by_type, traverse, query_neighbors,
    count_by_type, get_thread_state
    """
```

### Tool Registry

```python
TOOL_REGISTRY = {
    'get_graph_schema': get_graph_schema,
    'query_graph': query_graph,
    'query_datalake': query_datalake,
    'get_datalake_schema': get_datalake_schema,
    'query_datalake_sql': query_datalake_sql,
    'publish_finding': publish_finding,
    'ask_human': ask_human,
    'call_agent': call_agent,
    'list_agents': list_agents,
    'search_agents': search_agents,
}
```

### Agent YAML Config Updates

All 10 agents get `query_graph` + `get_graph_schema` replacing `graph_get_node`.

| Agent | Key graph operations | Key node types |
|-------|---------------------|----------------|
| agent1-conformance | query_by_type(NCR, {supplierId}), traverse(Supplier→Lot→Part) | NCR, Supplier, Lot |
| agent2-change-impact | traverse(Part→ECO), query_neighbors(Part, [CHANGED_BY, HAS_DRAWING]) | Part, ECO, Drawing |
| agent3-production-flow | query_neighbors(Machine, [RUNS_ON]), query_by_type(WO, {status:HOLD}) | WorkOrder, Machine, Kit |
| agent4-supplier-risk | traverse(Supplier→Lot→Part→SN), query_by_type(NCR, {supplierId}) | Supplier, Lot, PurchaseOrder |
| agent5-certification | count_by_type(Certificate), query_neighbors(SN, [HAS_CERT, HAS_TEST]) | Certificate, TestRecord, ThreadGap |
| agent6-predictive-maint | get_node(Machine), query_neighbors(Machine, [RUNS_ON]) | Machine, WorkOrder |
| agent7-dhr-assembler | query_neighbors(SN, [HAS_CERT, HAS_TEST]), count_by_type | Certificate, TestRecord |
| agent8-program-risk | query_by_type(Milestone, {status:AT_RISK}), get_thread_state | Milestone |
| agent9-fleet-health | traverse(Lot→SN, depth 1), query_by_type(FleetAnomaly) | DigitalTwin, FleetAnomaly, Lot |
| agent10-scada-anomaly | get_node(Machine), query_neighbors(Machine, [RUNS_ON]) | Machine, WorkOrder |

System prompts updated with operation hints and relevant node types per agent.

---

## Deployment

| Stack | Change | Order |
|-------|--------|-------|
| DigitalThreadStack | Fast consumer container image (new handlers) | 1st |
| ApiGatewayStack | Neptune Lambda (new operations) | 2nd |
| AgentCoreStack | Agent YAML configs (new tools + prompts) | 3rd |

## Build Order

1. `graph_writer.py` + 10 handler modules (consumer code)
2. Refactor `main.py` dispatcher
3. Neptune Lambda new operations + schema
4. Agent tools (`query_graph.py`, `get_graph_schema.py`)
5. Agent YAML configs (10 files)
6. Deploy DigitalThreadStack → ApiGatewayStack → AgentCoreStack
7. Run generators → verify nodes in Neptune → verify agent queries

## Domain Map Update

The frontend `domainMap.ts` already maps these node types to domains. New types to add:

```typescript
Engineering: ['Part', 'CertMilestone', 'Drawing', 'ECO'],
Manufacturing: ['WorkOrder', 'Machine', 'AsBuiltRecord'],
Quality: ['NonConformance', 'ThreadGap', 'CoherenceVerdict'],
'Supply Chain': ['Supplier', 'Lot', 'Kit', 'PurchaseOrder'],
Fleet: ['DigitalTwin', 'FleetAnomaly'],
```

Also add `Program: ['Milestone']` as a new domain tab, or fold Milestone into Engineering.
