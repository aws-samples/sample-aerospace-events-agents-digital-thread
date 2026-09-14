# Domain Views + Datalake Query Access — Design Spec

**Date:** 2026-03-19
**Status:** Approved

Two features that expand the Digital Thread page and agent data access.

---

## Feature A: Domain Views on Digital Thread

### Goal

Add single-select domain tabs to the Digital Thread graph so a presenter can focus on one domain at a time during a demo: Engineering, Manufacturing, Quality, Supply Chain, or Fleet.

### Approach

Frontend-only filtering. The Neptune `get_thread_state` query already returns all nodes with their vertex label (`type` field). The frontend maps types to domains and filters locally.

### Domain-to-Node-Type Mapping

```
Engineering:    Part, CertMilestone
Manufacturing:  WorkOrder, Machine, AsBuiltRecord
Quality:        NonConformance, ThreadGap, CoherenceVerdict
Supply Chain:   Supplier
Fleet:          DigitalTwin, FleetAnomaly
```

`SerialNumber` is always visible (root anchor).

### Tab Bar

Replaces the current `Thread View | Cert Readiness` toggle. Tabs:

```
All | Engineering | Manufacturing | Quality | Supply Chain | Fleet
```

- Default: `All` (current behavior unchanged)
- Selecting a domain filters nodes to that domain's types + SerialNumber
- Edges filtered to only show edges where both endpoints are visible
- Graph re-layouts via force simulation restart
- Stats row (Nodes, Gaps, Verdicts) reflects filtered counts
- Gaps panel shows only gaps linked to visible NCRs (Quality only)

### Node Rendering

- Keep type color as node fill (NCR=red, Part=blue, etc.)
- Add subtle domain-color ring around nodes when a domain is active
- Legend updates to show only the active domain's node types

### Files

| File | Change |
|------|--------|
| `DigitalThreadPage.tsx` | Add `activeDomain` state, domain tab bar, filtering logic |
| `ThreadGraph.tsx` | Domain color ring, filtered legend |
| `DomainTabs.tsx` | **New** — tab bar component |
| `domainMap.ts` | **New** — DOMAIN_MAP, DOMAIN_COLORS, getDomain() |

### No Backend Changes

All filtering on existing `get_thread_state` response data.

---

## Feature B: Datalake Query Access for Agents

### Goal

Agents currently only have `query_ncr_trends` (1 hardcoded Athena query). Expand to 13 named queries covering all 10 agents' documented data needs, plus a freeform SQL escape hatch with guardrails.

### Approach: Hybrid

1. **Pre-built named queries** — deterministic, fast, tested
2. **Freeform SQL tool** — for edge cases agents can't anticipate
3. **Schema discovery tool** — agents call before writing SQL

### Named Queries (13)

| # | Name | Domain | SQL Pattern | Agents |
|---|------|--------|-------------|--------|
| 1 | `ncrTrend` | Quality | NCR count by date + severity | agent1 |
| 2 | `ncrBySupplier` | Quality/SRM | NCR count by supplier + defect code | agent1, agent4 |
| 3 | `ncrByPart` | Quality/Eng | NCR count by part number + severity | agent2 |
| 4 | `supplierPerformance` | SRM | Supplier events (OTD, scores, receipts) 30d | agent4 |
| 5 | `workOrderTrend` | MES | WO count by status over time | agent3 |
| 6 | `holdImpact` | MES/WMS | HOLD_PLACED + KIT_SHORTAGE by date + entity | agent3 |
| 7 | `programEV` | Program | EV_UPDATED events (SPI/CPI from payload) | agent8 |
| 8 | `milestoneHistory` | Program | MILESTONE_AT_RISK by milestone + confidence | agent8 |
| 9 | `certEvents` | DHR/PLM | CERT_LINKED + DRAWING_RELEASED + TEST_RECORDED | agent5, agent7 |
| 10 | `machineEvents` | SCADA | MACHINE_FAULT + PARAMETER_ANOMALY by entity | agent6, agent10 |
| 11 | `fleetAnomalies` | InService | PARAMETER_DEVIATION + ANOMALY_DETECTED | agent9 |
| 12 | `domainEventCounts` | All | Event count by domain + event_type | any |
| 13 | `recentEvents` | All | Last N events for a domain/entity | any |

### Common Parameters

All named queries accept:
- `days` — lookback window (default 7, max 90)
- `entityId` — optional entity filter (empty = all)
- `limit` — row limit (default 100, max 500)

### Freeform SQL Operation

- Operation: `freeformSql`
- Body: `{ query: 'freeformSql', parameters: { sql: 'SELECT ...' } }`
- Guardrails (enforced in Lambda):
  1. **Read-only** — reject if SQL doesn't start with SELECT (case-insensitive, trimmed)
  2. **Row limit** — append `LIMIT 100` if no LIMIT clause present
  3. **Timeout** — 60s Athena query timeout
  4. **Table whitelist** — reject if SQL references anything other than `aerospace_events.domain_events`

### Schema Discovery Operation

- Operation: `getSchema`
- Returns: column names, types, 5 sample rows
- Hardcoded in Lambda (schema is static, no Athena query needed)

### Lambda Changes

Expand `src/lambdas/athena-query/index.ts`:
- QUERIES map: 1 → 13 named queries
- Generic handler: execute SQL, return rows as JSON array (no per-query aggregation)
- New operations: `freeformSql`, `getSchema`
- Existing API Gateway routes unchanged: `POST /query/athena` (Cognito) + `POST /query/athena-iam` (SigV4)

### Agent Tools (Python)

Three new tools replace `query_ncr_trends.py`:

**`query_datalake.py`** — named queries
```python
@tool
def query_datalake(query_name: str, days: int = 7, entity_id: str = '', limit: int = 100) -> str:
    """Query the aerospace datalake using a pre-built query."""
```

**`get_datalake_schema.py`** — schema discovery
```python
@tool
def get_datalake_schema() -> str:
    """Get the datalake table schema — columns, types, sample rows."""
```

**`query_datalake_sql.py`** — freeform SQL
```python
@tool
def query_datalake_sql(sql: str) -> str:
    """Run a custom SELECT query against aerospace_events.domain_events."""
```

All tools call API Gateway at `POST /query/athena-iam` with SigV4 auth (same pattern as current `query_ncr_trends.py`).

### Agent Tool Assignments

| Agent | query_datalake | get_datalake_schema | query_datalake_sql |
|-------|:-:|:-:|:-:|
| agent1-conformance | Y | Y | Y |
| agent2-change-impact | Y | | |
| agent3-production-flow | Y | | |
| agent4-supplier-risk | Y | Y | Y |
| agent5-certification | Y | | |
| agent6-predictive-maint | Y | | |
| agent7-dhr-assembler | Y | | |
| agent8-program-risk | Y | Y | Y |
| agent9-fleet-health | Y | | |
| agent10-scada-anomaly | Y | | |

Agent YAML configs updated with tool allowlists and hints about relevant named queries.

### Files

| File | Change |
|------|--------|
| `src/lambdas/athena-query/index.ts` | Expand to 13 queries + freeformSql + getSchema |
| `src/agents/tools/query_datalake.py` | **New** — named query tool |
| `src/agents/tools/get_datalake_schema.py` | **New** — schema discovery tool |
| `src/agents/tools/query_datalake_sql.py` | **New** — freeform SQL tool |
| `src/agents/tools/query_ncr_trends.py` | **Delete** |
| `src/agents/runtime/main.py` | Update tool imports |
| `config/agents/*.yaml` | Update tool allowlists (10 files) |

---

## Deployment

- **Feature A**: No deploy needed (frontend only, `npm run dev`)
- **Feature B**: Deploy `AerospaceApiGatewayStack` (Lambda) + `AerospaceAgentCoreStack` (agent configs)

## Build Order

1. Feature A — domain views (frontend, instant iteration)
2. Feature B — datalake queries (Lambda + tools + deploy + agent config)
