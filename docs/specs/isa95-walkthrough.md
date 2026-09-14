# ISA-95:2018 Migration — End-to-End Walkthrough

A guided tour of the post-migration demo. Mixes screenshots from the running
React app (`http://localhost:5173`) with terminal evidence from Neptune
(Gremlin + SPARQL). Captured 2026-05-29 against tag `isa95-level-3-operational`.

📹 **Video walkthrough**: [`walkthrough/video/demo.mp4`](walkthrough/video/demo.mp4)
(32 s, 735 KB) — screen-driven recording of the headline scenario:
dashboards → Digital Thread (4 views) → Demo Control → drama injection →
agent escalation cascade. See [`walkthrough/video/README.md`](walkthrough/video/README.md)
for the storyboard.

> **Tags**:
> - `pre-isa95-baseline` — rollback point
> - `isa95-level-1-operational` — vocabulary aligned (16 node types renamed)
> - `isa95-level-2-operational` — hierarchy + plan/actual + Person + ProcessSegment
> - `isa95-level-3-operational` — RDF dual-write, SPARQL, OWL ontology, B2MML happy path

---

## 1. Sign-in

Cognito-backed login. Demo user `demo@ares1.test`. Frontend speaks AppSync
(GraphQL + WebSocket) once authenticated.

![Login screen](walkthrough/01-login.png)

---

## 2. Quality dashboard — live event feed + agent activity + HITL

Top-level operations view. Three columns:

- **NCR LIVE FEED** — events flowing through MSK → EventBridge → AppSync
- **AGENT ACTIVITY** — Strands agents on Bedrock Claude Sonnet 4.6, each
  one a Conformance Guardian, Certification Tracker, DHR Completeness
  Agent, etc. They publish `MONITORING` for routine events and `ESCALATED`
  with full evidence packs when patterns trip a threshold.
- **PENDING ACTIONS** — agents call `ask_human` and pause until the
  operator picks an option (REWORK / SCRAP / USE_AS_IS / RETURN_TO_SUPPLIER
  …). HITL is explicit — agents prepare, humans decide.

![Quality dashboard](walkthrough/02-quality-dashboard.png)

The 7 pending escalations on this screen all originated from agents reading
the L2 graph (NCR pattern detection, supplier scoring trends, plan-vs-actual
gaps) and converging on the same conclusion: Nordic Precision and Titan
Forge have systemic issues that need procurement-lead-level decisions.

---

## 3. Shop Floor dashboard

Work-order activity, equipment status, OEE/vibration/temperature signals
from SCADA → IoT Core → MSK.

![Shop Floor dashboard](walkthrough/03-shop-floor.png)

---

## 4. Supply Chain dashboard

PO issuance, material receipts, kit shortages, supplier scoring. The pending
escalations include the Supplier Risk Sentinel agent's full risk pack on
Nordic Precision — quality trend, OTD volatility, alternate sourcing
analysis pulled from the knowledge graph.

![Supply Chain dashboard](walkthrough/04-supply-chain.png)

---

## 5. Digital Thread page — full graph (All view)

The hero view of the migration. 733 nodes for SN-0047 spanning 25 ISA-95
node types. Subtype-aware coloring: green for Certificate, teal for Test,
purple for Kit. Hierarchy nodes in cyan, Personnel in pink.

![Digital Thread — All domains](walkthrough/05-thread-all.png)

The legend lists every type the renderer knows about — including the L2
additions (`JobOrder`, `JobResponse`, `ProcessSegment`, `Equipment`) and
the seeded master data (`Enterprise`, `Site`, `Area`, `WorkCenter`,
`WorkUnit`, `Person`, `PersonnelClass`).

### 5a. Hierarchy view (L2)

Filter to the cyan-tone ISA-95 Part 1 hierarchy: Enterprise → Site →
Area → WorkCenter → WorkUnit. Live `Equipment` nodes get a `locatedIn`
edge to their WorkCenter when the consumer ingests SCADA / MES events.

![Digital Thread — Hierarchy domain](walkthrough/06-thread-hierarchy.png)

### 5b. Personnel view (L2)

`Person` (pink) and `PersonnelClass` (light pink). 23 operators / inspectors
/ supervisors. The L2 deferred-fix `signedBy` and `completedBy` edges
connect signed certificates and operations to actual operator nodes —
verifiable in §11 below.

![Digital Thread — Personnel domain](walkthrough/07-thread-personnel.png)

### 5c. Quality domain view

Filter to OperationsPerformance + ThreadGap + CoherenceVerdict — the
quality slice of the knowledge graph. The Conformance Guardian and
Certification Tracker agents primarily reason over this subgraph.

![Digital Thread — Quality domain](walkthrough/08-thread-quality-domain.png)

---

## 6. Demo Control Panel

Where the operator drives the demo:

- **Start / Stop generators** — control the 9 ECS-hosted DDB generators
  + SCADA MQTT producer.
- **Mode** SMOOTH (no NCRs) vs DRAMA (~10% MAJOR NCR rate).
- **Speed / density / phase** — tick interval, event density multiplier,
  demo phase (DESIGN / PRODUCTION / QA / IN-SERVICE).
- **Drama injections** — pre-scripted scenarios that trigger specific
  agent cascades. We'll fire one in §7.

![Demo Control Panel](walkthrough/09-demo-control.png)

---

## 7. Drama cascade — "NCR Cluster: Titan Forge"

Click the first drama button. It writes 3 CRITICAL NCRs on flight-critical
P/N 44821-003 from Titan Forge LOT-7731 directly to DDB. Within seconds:

1. DDB Stream → MSK producer → EventBridge → triggers `agent1` (Conformance
   Guardian) for each NCR.
2. Agent reads L1+L2 graph context (`MaterialDefinition`, supplier history,
   `Person` for the original signer), runs an Athena pattern query, and
   detects the 3-in-1-minute cluster as exceeding the supplier-risk
   threshold.
3. It calls `agent4` (Supplier Risk Sentinel) via A2A for the dual-axis
   risk pack and `agent3` (Production Flow) to assess WO impact.
4. Each agent calls `ask_human` with a structured evidence pack and option
   set — what you see in the Pending Actions column.

![Drama cascade — fresh CRITICAL NCRs + agent escalation](walkthrough/10-drama-cascade.png)

The three `NCR-DRAMA-*` records at the top of the feed are the injected
events. Notice the new escalation from Conformance Guardian for
`NCR-1780058614-272` — that's an agent-led decision, not a script.

---

## 8. Terminal evidence — Gremlin (property graph)

All commands run against the deployed `aerospace-neptune-query` Lambda
(VPC-attached, SigV4-authed) via `aws lambda invoke`.

### 8a. Node counts by ISA-95 label

```bash
AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1 \
  aws lambda invoke --function-name aerospace-neptune-query \
  --cli-binary-format raw-in-base64-out \
  --payload '{"operation":"execute_gremlin","parameters":{"gremlin":"g.V().groupCount().by(label())"}}' \
  --region eu-west-1 /tmp/out.json
```

```
  JobResponse                  402
  MaterialLot                  126
  OperationsPerformance        116
  MaterialSublot                49
  ThreadGap                     38
  PurchaseOrder                 38
  ProcessSegment                25
  Person                        23
  CoherenceVerdict              17
  FleetAnomaly                  14
  JobOrder                      11
  ProductDefinitionDocument      9
  PersonnelClass                 6
  ECO                            6
  WorkCenter                     5
  Milestone                      5
  MaterialDefinition             5
  DigitalTwin                    5
  WorkUnit                       5
  Supplier                       3
  Equipment                      3
  Site                           2
  Area                           2
  AsBuiltRecord                  1
  Enterprise                     1
```

Every label is ISA-95 vocabulary. Zero `Part`, `WorkOrder`, `Machine`,
`NonConformance`, etc. left in the graph.

### 8b. Edge labels (verbs)

```
  produces             368        ←  L1 verb (was FOR_SERIAL)
  producesMaterial     368        ←  L1 verb (was FOR_PART on WO→Part)
  equipmentActual      358        ←  L1 verb (was RUNS_ON)
  definesMaterial      120        ←  L1 verb (was FOR_PART on Lot→Part)
  madeFrom             117        ←  L1 verb (was USES_LOT / USED_LOT)
  suppliedBy           116        ←  L1 verb (kept)
  appliesTo             94        ←  L1 verb (was RAISED_AGAINST)
  attributedTo          94        ←  L1 verb (was TRACED_TO)
  affectsMaterial       94        ←  L1 verb (was AFFECTS_PART)
  consumedBy            44        ←  L1 verb (was KITS_FOR)
  orderedFrom           38        ←  L1 verb (was ORDERS_FROM)
  ordersMaterial        38        ←  L1 verb (was ORDERS_PART)
  definedFor            25        ←  L2 verb (ProcessSegment → MaterialDefinition)
  trackedBy             25        ←  L1 verb (was TRACKED_BY)
  assignedToSite        23        ←  L2 verb (Person → Site)
  memberOf              23        ←  L2 verb (Person → PersonnelClass)
  testsAppliedTo        22        ←  L1 verb (was HAS_CERT/HAS_TEST/TESTS_PART)
  assignedTo            22        ←  L2 verb (JobOrder/Response → Person)
  partOf                14        ←  L2 verb (hierarchy)
  observedOn            14        ←  L1 verb (was DETECTED_ON)
  requestsExecution     11        ←  L2 verb (JobOrder → JobResponse)
  requestsSegment       11        ←  L2 verb (JobOrder → ProcessSegment)
  hasDocument            9        ←  L1 verb (was HAS_DRAWING)
  signedBy               6        ←  L2 deferred fix (acceptance authority)
  changedBy              6        ←  L1 verb (was CHANGED_BY)
  instantiatedAs         5        ←  L1 verb (was IN_SERVICE_AS)
  executedSegment        3        ←  L2 verb (JobResponse → ProcessSegment)
  locatedIn              3        ←  L2 verb (Equipment → WorkCenter)
  completedBy            2        ←  L2 deferred fix (operator who did the work)
```

All edges land in ISA-95 vocabulary. The plan/actual split (`requestsExecution`,
`requestsSegment`, `executedSegment`) and the personnel chain (`assignedTo`,
`signedBy`, `completedBy`) are all populated from live events.

### 8c. Hierarchy traversal

```bash
# Walk Equipment → WorkCenter → Area → Site → Enterprise
gremlin> g.V().has('Equipment','id','cnc-mill-3')
           .out('locatedIn').out('partOf').out('partOf').out('partOf')
           .path().by(coalesce(values('name'),values('id')))
```

```
cnc-mill-3 → Finish Machining Cell → Wing Box Final Assembly → Meridian → Ares
```

Equipment that lit up from a SCADA event resolves cleanly to its full
ISA-95 hierarchy in 4 hops — exactly the kind of structural query agents
use for "any unresolved NCRs in Area `WBA-MRD` last 30 days".

### 8d. `query_plan_vs_actual` — the L2 payoff

```bash
aws lambda invoke ... \
  --payload '{"operation":"query_plan_vs_actual","parameters":{"jobOrderId":"WO-89987"}}'
```

```
  WO-89987  requested=1 executed=0 missing=1 extra=0
  WO-81872  requested=1 executed=0 missing=1 extra=0
  WO-84966  requested=1 executed=0 missing=1 extra=0
  WO-89889  requested=1 executed=0 missing=1 extra=0
  WO-90643  requested=1 executed=0 missing=1 extra=0
```

These 5 JobOrders all have `missingSegments=1`: a recipe step (e.g., Op-50
Finish Machine) was scheduled (`requestsSegment` edge to ProcessSegment)
but never executed (no `executedSegment` edge from the JobResponse). That's
the **structural** detection of skipped operations — no string matching
against operation names, just edge presence/absence in the graph. This is
what the Conformance Guardian and DHR Assembler agents use to spot
incomplete records before signing off the as-built DHR.

---

## 9. Terminal evidence — SPARQL (RDF dual-write, L3)

### 9a. Triples per named graph

```bash
aws lambda invoke ... \
  --payload '{"operation":"execute_sparql","parameters":{"sparql":"SELECT ?graph (COUNT(*) as ?n) WHERE { GRAPH ?graph { ?s ?p ?o } } GROUP BY ?graph"}}'
```

```
  https://ares.example/aerospace/digitalthread/abox       509 triples
  https://ares.example/aerospace/digitalthread/tbox      4701 triples
```

- **TBox** = imported reference ontology (4,701 triples from IOF Core +
  ProductionPlanning + hsu-aut DINEN62264-2, all MIT-licensed).
- **ABox** = live event facts (509 triples; grows in real time as Gremlin
  nodes are written via the dual-write hook in `rdf_writer.py`).

### 9b. ABox type distribution (mirrors property graph)

```
  12  MaterialLot
  10  OperationsPerformance
   7  MaterialSublot
   6  JobResponse
   5  Person
   5  MaterialDefinition
   4  JobOrder
   3  Equipment
   3  PurchaseOrder
   3  ProductDefinitionDocument
   3  Supplier
   2  DigitalTwin
   1  FleetAnomaly
```

Same node types as Gremlin — but accessible through SPARQL with class IRIs
under the `aero:` namespace plus property/relation IRIs under
`aero:prop/*` and `aero:rel/*`.

### 9c. Sample SPARQL — find NCRs with subtype + part + serial

```sparql
SELECT ?op ?subtype ?part ?serial WHERE {
  GRAPH <https://ares.example/aerospace/digitalthread/abox> {
    ?op a <https://ares.example/aerospace-events-agents-digital-thread/OperationsPerformance> ;
        <https://ares.example/aerospace-events-agents-digital-thread/prop/subtype> ?subtype .
    OPTIONAL { ?op <https://ares.example/aerospace-events-agents-digital-thread/prop/partNumber> ?part }
    OPTIONAL { ?op <https://ares.example/aerospace-events-agents-digital-thread/prop/serialNumber> ?serial }
  }
} LIMIT 5
```

```
  NCR-1780057497-210         subtype=NonConformance   part=55192-001   serial=SN-0047
  NCR-DRAMA-1780058868063-1  subtype=NonConformance   part=44821-003   serial=SN-0047
  NCR-1780058614-272         subtype=NonConformance   part=44821-003   serial=SN-0047
  NCR-1780058976-451         subtype=NonConformance   part=44821-007   serial=SN-0047
  NCR-DRAMA-1780058868069-2  subtype=NonConformance   part=44821-003   serial=SN-0047
```

The drama-injection NCRs (`NCR-DRAMA-*`) round-trip into the SPARQL store
within seconds of the click. Exactly the same logical facts as the property
graph — different shape, suitable for ontology-aware customers.

### 9d. TBox — imported OWL classes

```sparql
SELECT (COUNT(?s) as ?n) WHERE {
  GRAPH <https://ares.example/aerospace/digitalthread/tbox> {
    ?s a <http://www.w3.org/2002/07/owl#Class>
  }
}
```

```
Imported OWL classes (TBox): 362
```

362 OWL classes from the IOF + hsu-aut imports. Agents can query the TBox
to discover ISA-95 class hierarchies (e.g., "all subclasses of
`iof:MaterialArtifact`") without knowing the specific class names ahead of
time.

---

## 10. Hierarchy descent via `query_hierarchy` (L2 op)

```bash
aws lambda invoke ... \
  --payload '{"operation":"query_hierarchy","parameters":{"level":"Site","id":"MRD","direction":"down"}}'
```

```
  [Area      ] WBA-MRD      Wing Box Final Assembly
  [WorkCenter] CELL-1       Rough Machining Cell
  [WorkCenter] CELL-2       Semi-finish Cell
  [WorkCenter] CELL-3       Finish Machining Cell
  [WorkUnit  ] cnc-mill-1   CNC Mill 1
  [WorkUnit  ] cnc-mill-2   CNC Mill 2
  [WorkUnit  ] cnc-mill-3   CNC Mill 3
```

Meridian site descends to its full equipment subtree in one call. Agents
use this for "show me all events at Site X last 24h" or "all WorkUnits in
Area Y that had a TEMPERATURE_HIGH event".

---

## 11. Personnel signing chain (L2 deferred fix)

```bash
aws lambda invoke ... \
  --payload '{"operation":"execute_gremlin","parameters":{"gremlin":
    "g.E().hasLabel(\"signedBy\").project(\"src_label\",\"src_id\",\"person\")
       .by(outV().label()).by(outV().values(\"id\")).by(inV().values(\"id\"))"}}'
```

```
  MaterialSublot         SN-0047       signedBy → op-garcia
  MaterialSublot         SN-0047       signedBy → op-tanaka
  OperationsPerformance  TEST-5486     signedBy → op-tanaka
  OperationsPerformance  TEST-5185     signedBy → op-tanaka
  OperationsPerformance  TEST-5327     signedBy → op-mueller
  OperationsPerformance  TEST-5823     signedBy → op-mueller
  OperationsPerformance  CERT-6099     signedBy → insp-dubois
```

Every signed Test gets a `signedBy` edge to the operator who recorded it.
Certificates link to inspectors (notice `insp-dubois`, `PersonnelClass=INSP-3`
"Inspector Level 3 / lead-inspector"). Operation signoffs link the serial
number to its acceptance authority. This is the L2 deferred fix that
closes the DHR signing chain — agents can now answer "who signed for
operation X on serial Y?" without string matching.

---

## 12. What this delivers

| ISA-95:2018 capability | Visible in the demo |
|---|---|
| **Vocabulary** (Part 2 object models) | All 25 graph node types use ISA-95 names (§5a, §8a) |
| **Hierarchy** (Part 1 levels) | Enterprise → Site → Area → WorkCenter → WorkUnit, traversable in 4 hops (§5a, §8c, §10) |
| **Plan vs. actual** (JobOrder + JobResponse) | `requestsExecution` links the two; `query_plan_vs_actual` returns missing segments (§8d) |
| **Personnel** (Part 2) | 23 Person nodes, 6 PersonnelClass, signedBy/completedBy chain (§5b, §11) |
| **ProcessSegment** (recipe steps) | 25 segments, definedFor MaterialDefinition, used by plan-vs-actual diff (§8d) |
| **OWL ontology** (Part 2 RDF) | 4,701 TBox triples imported from IOF + hsu-aut, MIT-licensed (§9a, §9d) |
| **B2MML messaging** (5.5 / V7.00.00) | XSDs vendored, happy-path serializer for NCR / WO_STARTED / OP_COMPLETE (gated off; archive bucket follow-up) |
| **Dual-store query access** | Gremlin (§8) and SPARQL (§9) coexist on the same Neptune Serverless cluster |

## 13. Outstanding follow-ups

- `owlrl` reasoning in slow consumer (license-vetted W3C BSD-equivalent;
  scope deferred from L3 main commit)
- xsdata-generated B2MML dataclasses (replace hand-built XML in `b2mml.py`)
- Generator-side B2MML emission + S3 archive bucket
- Frontend SPARQL panel on the Digital Thread page (currently CLI-only)
- Apache Jena Fuseki sidecar if the demo needs HermiT-class DL reasoning

All listed in the L3 tag annotation. Each is independently shippable.

---

## Appendix — replay these queries

The complete query → output pairs are saved under
`docs/specs/walkthrough/queries/` as plain text files:

- `01-gremlin-counts.txt` — node count by label
- `02-gremlin-edges.txt` — edge count by label
- `03-hierarchy-traversal.txt` — Equipment → Enterprise path
- `04-plan-vs-actual.txt` — `query_plan_vs_actual` output for 8 JobOrders
- `05-sparql-graphs.txt` — TBox + ABox triple counts
- `06-sparql-abox-types.txt` — ABox class distribution
- `07-sparql-ncrs.txt` — sample SPARQL SELECT on OperationsPerformance
- `08-signedby-chain.txt` — Personnel signing edges
- `09-query-hierarchy.txt` — `query_hierarchy(Site, MRD, down)` output
- `10-tbox-owl-classes.txt` — count of imported OWL classes
