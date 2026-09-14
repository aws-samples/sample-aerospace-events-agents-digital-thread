# ISA-95:2018 Knowledge Graph Migration

**Goal**: migrate the Neptune knowledge graph from ad-hoc node labels to ISA-95:2018 (IEC 62264) compliance, ending at full ISA-95 OWL ontology + B2MML message format.

**Why**: Aerospace manufacturers standardize on ISA-95 vocabularies. Speaking ISA-95 fluently makes the demo credible, and the L2/L3 work meaningfully sharpens what agents can reason about (hierarchy queries, plan-vs-actual divergence, RDF semantics).

**Strategy**: three operational levels. Each ends with a git tag that lets us roll back. Each is independently shippable — we can stop at L1 or L2 if the demo deadline tightens.

---

## Baseline

- **Tag**: `pre-isa95-baseline` (commit `fce1924`)
- **Schema**: 16 ad-hoc node types, 20 ad-hoc edge types
- **Stacks deployed** (eu-west-1, profile `your-aws-profile`): 15 Aerospace* CFN stacks, all healthy
  - AppStack, StorageStack, EventStack, IoTCoreStack, EventBridgeBusStack
  - MskConnectStack, PublisherStack, NeptuneStack, ApiGatewayStack
  - DigitalThreadStack, AgentCoreStack, GeneratorStack, GatewayStack
- **Runtime data plane verified**:
  - Neptune cluster `aerospace-digital-thread` (engine 1.3.2.1) — `available`
  - ECS cluster `aerospace-digital-thread` running `FastConsumerService` + `SlowConsumerService`
  - 10 AgentCore runtimes `aerospace_agent1_conformance` … `aerospace_agent10_scada_anomaly` — all `READY`
- **Rollback**: `git checkout pre-isa95-baseline` + redeploy stacks

### Current node types
`Part`, `SerialNumber`, `Lot`, `WorkOrder`, `Machine`, `Drawing`, `ECO`, `Certificate`, `TestRecord`, `NonConformance`, `Supplier`, `PurchaseOrder`, `Kit`, `Milestone`, `DigitalTwin`, `FleetAnomaly`

### Current edge verbs
`HAS_DRAWING`, `CHANGED_BY`, `FOR_PART`, `FOR_SERIAL`, `RUNS_ON`, `RAISED_AGAINST`, `AFFECTS_PART`, `TRACED_TO`, `SUPPLIED_BY`, `ORDERED_BY`, `ORDERS_FROM`, `ORDERS_PART`, `KITS_FOR`, `USES_LOT`, `HAS_CERT`, `HAS_TEST`, `USED_LOT`, `CERTIFIES_PART`, `CERTIFIES_LOT`, `TESTS_PART`, `TESTED_AT`, `TRACKED_BY`, `IN_SERVICE_AS`, `DETECTED_ON`

---

## ISA-95 mapping reference

ISA-95 (IEC 62264) is the Enterprise–Control System integration standard. The 2018 edition consolidates Parts 1–6. Three pieces matter for us:

1. **Object models** (Part 2): typed entities with defined property sets — `MaterialDefinition`, `MaterialLot`, `MaterialSublot`, `Equipment`, `EquipmentClass`, `Person`, `PersonnelClass`, `JobOrder`, `JobResponse`, `OperationsSegment`, `ProcessSegment`, `OperationsPerformance`, `ProductDefinition`, etc.
2. **Hierarchy model** (Part 1, "Levels"): Enterprise → Site → Area → WorkCenter (Process Cell / Production Line / Storage Zone) → WorkUnit (Unit / Cell / Storage Module).
3. **B2MML** — the XML serialization. A maintained OWL ontology (MIMOSA / OAGi work) maps these classes to RDF.

### Mapping table — current schema → ISA-95

| Current label | ISA-95 class | Comment |
|---|---|---|
| `Part` | `MaterialDefinition` | "partNumber" → `MaterialDefinitionID` |
| `SerialNumber` | `MaterialSublot` | Single-unit sublot of a serialized lot |
| `Lot` | `MaterialLot` | 1:1 |
| `WorkOrder` | `JobOrder` (intent) + `JobResponse` (actual) | ISA-95 splits planned vs. actual; we currently conflate |
| `Machine` | `Equipment` (level=WorkUnit) + `EquipmentClass` for type | Add hierarchy edges to Cell/Area/Site |
| `Drawing` | `ProductDefinition` artifact | Or external doc linked via `ProductSegment` |
| `ECO` | No native class — `MaterialDefinition.Version` change record | ISA-95 doesn't model change control; project extension |
| `Certificate`, `TestRecord` | `OperationsPerformance` (Quality test) | Quality is one of the four operations types in Part 3 |
| `NonConformance` | `OperationsPerformance` (Quality, with disposition) | "Non-conforming material" is in the spec |
| `PurchaseOrder`, `Supplier` | **Outside ISA-95 scope** (L4 ERP procurement) | Keep current model, link via `MaterialLot.Supplier` |
| `Kit` | `MaterialSublot` aggregating other sublots/lots | Or `MaterialDefinition` of type "kit" |
| `Milestone`, `DigitalTwin`, `FleetAnomaly` | **Outside ISA-95** (program mgmt + in-service) | Project-specific extensions |
| `assignedOperator` (property) | `Person` / `PersonnelClass` (node) | Promoted in L2 |

### Edge verb renames (ISA-95 vocabulary)

| Current | ISA-95 |
|---|---|
| `RAISED_AGAINST` | `appliesTo` |
| `RUNS_ON` | `equipmentActual` (response) / `equipmentRequested` (order) |
| `KITS_FOR` | `consumedBy` |
| `HAS_CERT`, `HAS_TEST` | `testsAppliedTo` |
| `FOR_PART` | `producesMaterial` (work) / `definesMaterial` (genealogy) |
| `FOR_SERIAL` | `produces` (sublot) |
| `USED_LOT`, `USES_LOT` | `madeFrom` |
| `CERTIFIES_PART`, `CERTIFIES_LOT` | `certifies` |
| `TRACED_TO` | `attributedTo` |
| `SUPPLIED_BY` | `suppliedBy` (kept) |
| `IN_SERVICE_AS` | `instantiatedAs` |
| `DETECTED_ON` | `observedOn` |

---

## Level 1 — vocabulary alignment (~1–2 days)

### Goal
Rename node labels and edge verbs to ISA-95 vocabulary. **No structural changes**. Same 1:1 cardinality. Same handler logic. Just different strings.

### Why this is its own level
Quick win; defensible "ISA-95 aligned" claim; lets us validate the rename pipeline (handlers → query tools → agents → frontend → seed) without taking on structural risk.

### Files to modify

**Fast consumer handlers** (`src/consumers/fast-consumer/handlers/*.py` — 11 files, ~700 lines total):
- `qms.py`: `NonConformance` → `OperationsPerformance` with property `operationsType=Quality, dispositionRequired=true`
- `mes.py`: `WorkOrder` → `JobResponse` (everything currently emitted is post-execution status); add property `isaClass=JobResponse`
- `plm.py`: `Drawing` → `ProductDefinitionDocument`; `ECO` keeps name (project extension)
- `dhr.py`: `Certificate`, `TestRecord` → `OperationsPerformance` with `operationsType=Quality, performanceType=Certificate|Test`
- `erp.py`: `PurchaseOrder`, `Supplier` → keep (out of scope); `Lot` → `MaterialLot`; `Part` → `MaterialDefinition`
- `srm.py`: `Supplier` keeps name (out of scope)
- `wms.py`: `Kit` → `MaterialSublot` with `aggregateRole=Kit`; `Lot` → `MaterialLot`
- `program.py`: `Milestone` keeps name (project extension); `Part` → `MaterialDefinition`
- `inservice.py`: `DigitalTwin`, `FleetAnomaly` keep names (project extensions); `SerialNumber` → `MaterialSublot`
- `scada.py`: events on `Equipment`; rename references

**Common across all handlers**:
- `Part` → `MaterialDefinition`
- `SerialNumber` → `MaterialSublot`
- `Lot` → `MaterialLot`
- `Machine` → `Equipment`
- All edge verbs renamed per table above

**Query layer** (`src/agents/tools/`):
- `query_graph.py`: update operation strings (`get_node`, `query_by_type`, etc.) to accept new labels
- `get_graph_schema.py`: full rewrite — return ISA-95-named node types with descriptions

**Neptune Lambda** (`src/lambdas/neptune-query/index.ts`):
- Any hardcoded label literals updated

**Frontend** (`src/frontend/src/`):
- `components/digitalThread/ThreadGraph.tsx` (or wherever node-type → color/icon registry lives): map new names
- `pages/DigitalThreadPage.tsx`: any label-specific filters
- i18n: `en.json`, `fr.json` — add labels for new types if displayed

**Agent prompts** (`config/agents/agent*.yaml`, all 10):
- System prompts reference node types by name. Search-and-replace per agent.
- Update tool description hints in `system_prompt` if they enumerate types

**Seed + scripts**:
- `scripts/seed-baseline.py`: any hardcoded type names in graph-writer calls (most go through DDB → consumer, but verify)
- `scripts/replay-dlq.py`: any payload-shape assumptions

### Acceptance criteria — L1 operational

1. Reset demo (`./scripts/reset-demo.sh --no-restart`)
2. Seed baseline succeeds; Neptune contains nodes with new ISA-95 labels (no ad-hoc labels remain)
3. `query_graph` with `node_type=MaterialSublot` returns the same data that `node_type=SerialNumber` returned before
4. `get_graph_schema` lists ISA-95 names
5. Run drama scenario → agents resolve correctly using new vocabulary
6. Digital Thread page renders cleanly with new node names
7. All 10 agents validated via `scripts/validate-agents.py --ping`

### Tag
`git tag -a isa95-level-1-operational -m "ISA-95:2018 vocabulary alignment complete. Node labels and edge verbs renamed; structure unchanged."`

---

## Level 2 — hierarchy + plan/actual + Person + ProcessSegment (~1 week)

### Goal
Add the structural pieces that make agents materially smarter:
- **Hierarchy nodes** — Enterprise / Site / Area / WorkCenter / WorkUnit as first-class master data
- **Plan vs. actual split** — every `JobOrder` now has zero-or-more `JobResponse` nodes representing actual execution events
- **Person nodes** — operators promoted from string property to graph nodes with `PersonnelClass`
- **ProcessSegment** — recipe steps as ordered nodes per `JobOrder`
- **MaterialClass** groupings — query at category level

### Why this is its own level
This is where ISA-95 actually pays off. Hierarchy queries become single Gremlin traversals ("any unresolved NCRs in Area `WBA-01` last 30 days"), plan-vs-actual divergence is graph-structural, and operator queries (DHR signing chain) become real.

### Master data design

**Seed data** (new file `scripts/seed-master-data.py`, plus committed JSON in `config/master-data/`):
```
Enterprise: Ares
  Site: Meridian
    Area: Wing Box Final Assembly (WBA-MRD)
      WorkCenter: Cell A (cellId=CELL-A)
        WorkUnit: Machine MX-401 (machineId=MX-401)
        WorkUnit: Machine MX-402
      WorkCenter: Cell B
        WorkUnit: Machine MX-501
  Site: Ashford
    Area: Wing Box Sub-Assembly (WBS-ASH)
      ...
```

Edge: `Equipment → LOCATED_IN → WorkCenter → PART_OF → Area → PART_OF → Site → PART_OF → Enterprise`

**Person seed** (new `config/master-data/personnel.json`):
- ~20 operators, ~5 inspectors, ~3 supervisors
- Each has `PersonnelClass` membership (Operator-A2, Inspector-Level-3, etc.)
- Edge: `JobResponse → assignedTo → Person`, `OperationsPerformance → signedBy → Person`

### JobOrder/JobResponse split

**Source-side** (cleanest): MES generator emits two event types
- `JOB_ORDER_RELEASED` → creates `JobOrder` with `state=RELEASED`
- `JOB_RESPONSE_RECORDED` → creates `JobResponse` linked to `JobOrder`, captures actual equipment/operator/timestamp/segment

**Consumer-side** (less generator change): one event creates both nodes; we synthesize the JobOrder from existing fields, JobResponse from execution fields. Simpler but loses the temporal separation.

**Recommendation**: do source-side for MES (the canonical case), consumer-side everywhere else. Trade-off captured in handler code.

### ProcessSegment

Each `MaterialDefinition` has an ordered list of `ProcessSegments` (e.g., `S1: Drill`, `S2: Inspect`, `S3: Fasten`). For demo simplicity, generate from the work-order operation list. `JobOrder.requestsSegment → ProcessSegment` and `JobResponse.executedSegment → ProcessSegment`.

This is what enables the Conformance Agent to detect "S2 inspection step skipped" structurally rather than by string matching.

### Files to add / modify

**New nodes/edges in handlers**:
- `mes.py`: emit JobOrder, JobResponse, JobSegments; link to Equipment, Person, ProcessSegment
- All handlers: replace flat `assignedOperator: "FL-OP-12"` property → `Person` node + `assignedTo` edge
- All handlers: when emitting Equipment, look up its `WorkCenter` from a static map (loaded from seed) and add `LOCATED_IN` edge

**New seed scripts** (`scripts/seed-master-data.py`):
- One-shot bootstrap that writes hierarchy + personnel directly to Neptune (no DDB roundtrip — these are reference data, not events)
- Idempotent (uses `g.V().has(id, x).fold().coalesce(unfold(), addV(...))`)
- Runs once at deploy time or via Demo Control Panel "Seed Master Data" button

**New CDK** (or extend `digital-thread-stack.ts`):
- Lambda or Custom Resource invoking the master-data seeder on stack create / update

**Generator changes** (`src/generators/generators/`):
- MES generator: emit two events per work order (or attach `phase=ORDER|RESPONSE` flag)
- All generators: use a small registry of operator IDs (matching `personnel.json`) instead of random strings

**Frontend**:
- Digital Thread page: hierarchy filter (Enterprise/Site/Area/WorkCenter dropdowns)
- ThreadGraph: render hierarchy edges with distinct color
- New "Personnel" view (optional) — operator activity over time
- Update domain map for new node types

**Agent prompts**:
- Surface hierarchy traversal in agent prompts ("you can query for all Equipment in WorkCenter X")
- Surface plan-vs-actual: "compare JobOrder.requestedSegments to JobResponse.executedSegments to detect skipped steps"

**Query tools**:
- `query_graph.py`: new operation `query_hierarchy(level=Site|Area|WorkCenter, id)` that returns descendants
- `query_graph.py`: new operation `query_plan_vs_actual(jobOrderId)` that diffs requested vs. executed

### Acceptance criteria — L2 operational

1. Reset demo + seed master data + seed baseline
2. Neptune contains: 1 Enterprise, 2 Sites, ≥3 Areas, ≥6 WorkCenters, ≥10 WorkUnits, ~25 Person nodes
3. Every `Equipment` has a `LOCATED_IN` edge to a `WorkCenter`
4. Every `JobResponse` has an `assignedTo` edge to a `Person`
5. New drama scenario: "operator skipped inspection step" → Conformance Agent uses `query_plan_vs_actual` to detect → produces structurally-grounded finding
6. Digital Thread page hierarchy filter narrows the graph correctly
7. `query_hierarchy(WorkCenter, CELL-A)` returns all events traceable to that cell
8. All 10 agents validated

### Tag
`git tag -a isa95-level-2-operational -m "ISA-95:2018 hierarchy + plan/actual + Person + ProcessSegment. Agents reason structurally over plant hierarchy."`

---

## Level 3 — full ISA-95 OWL ontology + B2MML (~2+ weeks)

### Goal
ISA-95 OWL ontology becomes the schema spine. Generators emit B2MML XML. Fast consumer parses B2MML → property graph (Neptune) **and** RDF triples (optional Neptune RDF mode or external triplestore for reasoning experiments). Every node carries an `rdf:type` IRI from the ISA-95 namespace.

### Why this is its own level
This is the "true ontology" version. It's literally interoperable with any other ISA-95 system. Worth doing if Ares stakeholders want to plug in their own ontology toolchain. Skippable if the demo audience cares about behavior more than format.

### Approach

1. **Import the ontology**:
   - Pick a maintained ISA-95 OWL release (MIMOSA / OAGi). Vet license.
   - Store under `config/ontology/isa95.owl` (or `.ttl`)
   - Document version + provenance in `docs/specs/isa95-ontology-source.md`

2. **B2MML schema**:
   - Pull the official B2MML XSDs (V0700 or current)
   - Store under `config/schema/b2mml/` (committed)
   - Generate Python dataclasses via `xsdata` or similar

3. **Generator → B2MML**:
   - Each generator emits B2MML XML messages (`MaterialLot.xsd`, `JobResponse.xsd`, `OperationsPerformance.xsd`, etc.)
   - Wrapped in our existing event envelope (correlationId, eventId, source, etc.) — payload is `{format: "b2mml", body: "<xml>...</xml>"}`

4. **Consumer parses B2MML**:
   - Fast consumer adds a B2MML parser layer (xsdata-deserialized objects) before handler dispatch
   - Each handler receives typed B2MML object, writes to graph
   - Graph nodes get `rdf:type` property pointing into ISA-95 OWL

5. **Optional RDF mode**:
   - Neptune supports both property-graph (Gremlin) and RDF (SPARQL). We can dual-write or pick one.
   - If dual-write: Gremlin remains primary (existing query tools work), SPARQL endpoint exposed for reasoning experiments.
   - If RDF-only: rewrite `query_graph.py` to SPARQL. More disruptive.
   - **Recommendation**: dual-write. Gremlin is fast for our query patterns, SPARQL for ontology demos.

6. **Reasoning** (stretch goal):
   - Use `owlrl` or HermiT to materialize inferred triples (e.g., `Equipment subClassOf MES:WorkUnit` lets you query at superclass level)
   - Bedrock-driven Cert Readiness Agent could consume reasoner output for stronger compliance claims

### New components

- `src/lambdas/b2mml-validator`: pre-publish XSD validation Lambda (rejects invalid messages before MSK)
- `src/consumers/fast-consumer/b2mml_parser.py`: XML → typed dataclass dispatcher
- `src/consumers/fast-consumer/rdf_writer.py`: dual-write to RDF endpoint
- `config/ontology/`, `config/schema/b2mml/`: committed reference data
- `docs/specs/isa95-ontology-source.md`: provenance, license, version

### Files to modify

**Generators** (`src/generators/`):
- Refactor `scenario_runner.py` and per-system generators to emit B2MML
- Keep current JSON path as fallback during migration (feature flag)

**Consumers**:
- `fast-consumer/main.py`: add B2MML detection + parse step
- `slow-consumer/`: same; Cert Readiness Agent reads B2MML structures

**CDK**:
- `digital-thread-stack.ts`: enable Neptune RDF mode (or provision separate RDF cluster)
- `event-stack.ts` or new `b2mml-stack.ts`: validator Lambda + DLQ wiring

**Agents**:
- All 10: update prompts to reference ISA-95 OWL classes by IRI
- Optional new tool `query_sparql` for the agents that benefit from ontology reasoning (Cert Readiness, Conformance)

**Frontend**:
- Digital Thread page: optional "show ontology IRIs" toggle
- New "Ontology" page that visualizes the loaded ISA-95 OWL classes (using something like ontology-visualization or `webvowl`)

### Acceptance criteria — L3 operational

1. Generators emit valid B2MML XML; XSD validator passes 100% of seed events
2. Consumer parses B2MML and writes both property graph + RDF
3. SPARQL endpoint returns expected triples for a sample serial number
4. ISA-95 OWL ontology loaded; `rdf:type` triples present
5. Reasoner produces at least one inferred triple (e.g., `Cell-A rdf:type WorkCenter` even though only `LOCATED_IN` edge was written) — proves ontology is live
6. End-to-end demo runs identically to L2 from the user's perspective
7. New B2MML demo scenario: emit a malformed message → DLQ → operator replays via UI

### Tag
`git tag -a isa95-level-3-operational -m "ISA-95:2018 full ontology + B2MML messaging. Property graph + RDF dual-write; SPARQL reasoning available."`

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Renaming breaks dashboards mid-migration | Each level is committed and tagged; rollback is `git checkout pre-isa95-baseline` + redeploy |
| ECS rolling deploy puts old + new consumer side-by-side briefly | Deploy during a quiet window; or accept the gap (events get dual-handled until old task drains) |
| Master data drift between seed and Neptune | Seeder is idempotent; Demo Control Panel button to re-seed |
| B2MML parsing performance | xsdata is fast (~1ms per message); validator Lambda runs in parallel; benchmark before committing |
| ISA-95 OWL ontology license | Vet before commit; some MIMOSA artifacts are GPL-incompatible — use OAGi releases preferentially |
| Agent prompt regressions on rename | Run `validate-agents.py --ping` after each level; have a small set of "golden" scenarios with expected outputs |
| Neptune dual property-graph + RDF cost | Single-instance Serverless cluster handles both modes; cost delta negligible |

## Operating procedure for fresh sessions

To pick up this work in a new session:

1. Read this file (`docs/specs/isa95-migration.md`)
2. Read `MEMORY.md` for project state
3. `git tag --list 'isa95-*' 'pre-isa95-*'` — see how far we got
4. `TaskList` — see open tasks
5. Continue from the lowest open task

Each level commit message should reference this doc: `Refs docs/specs/isa95-migration.md L<N>`.

---

## Tag scheme summary

| Tag | Meaning |
|---|---|
| `pre-isa95-baseline` | Last commit before any ISA-95 work (rollback point) |
| `isa95-level-1-operational` | Vocabulary aligned, structure unchanged |
| `isa95-level-2-operational` | Hierarchy, plan/actual, Person, ProcessSegment |
| `isa95-level-3-operational` | Full OWL + B2MML, SPARQL reasoning available |
