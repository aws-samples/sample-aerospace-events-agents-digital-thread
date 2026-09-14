# ISA-95 L3 — Research & Recommendations

**Status**: research only — no code changes. Source verified via WebFetch/`gh` API on 2026-05-29.
**Audience**: developer starting ISA-95 L3 work (full OWL ontology + B2MML messaging + Neptune RDF dual-write).
**Decision**: see "Top recommendations" at the bottom; reasoning in the body.

---

## 1. ISA-95 OWL ontology — candidates and license vetting

Amazon-acceptable: Apache-2.0, MIT, BSD, CC-BY (with attribution). REJECT: GPL, AGPL, LGPL, CC-BY-NC, ambiguous/unlicensed.

### Candidates investigated

| # | Source | License | Verdict | Notes |
|---|---|---|---|---|
| 1 | **`iofoundry/ontology` — IOF Production Planning + Core** | **MIT** | **ACCEPT (primary)** | Active (commits within last week, May 2026), 124 stars, well-documented, BFO-grounded. Imports BFO. |
| 2 | `hsu-aut/IndustrialStandard-ODP-DINEN62264-2` | **MIT** | ACCEPT (supporting) | Tagged releases (v1.4.2, v2.0.0). Covers ONLY IEC 62264-2 equipment hierarchy (Enterprise → Site → Area → WorkCenter → WorkUnit). 22 classes, 24 object properties. Useful as targeted hierarchy module. |
| 3 | `kenwenzel/vocabularies` — IEC 62264-1:2013 | **NONE (no LICENSE file)** | **REJECT** | 22 classes, 63 properties, bilingual EN/DE. Last commit Aug 2022. No license = unusable at Amazon despite being technically the most thorough single-file vocabulary. |
| 4 | `JMayrbaeurl/opendigitaltwins-isa95` | MIT | REJECT (not OWL) | DTDL v2 (Azure Digital Twins format), not OWL/Turtle. Wrong format for our use case. |
| 5 | MIMOSA OSA-EAI / CCOM | Closed/unclear | REJECT | MIMOSA publishes CCOM and OSA-EAI but **does not publish an ISA-95 OWL ontology** (verified on `mimosa.org/specifications`). Contrary to what the migration plan assumed. |
| 6 | OAGi (B2MML producer) | N/A | REJECT (no OWL) | OAGi publishes B2MML XSDs (see §2), NOT an OWL ontology. |
| 7 | Eclipse ESMF `esmf-manufacturing-information-model` | MPL-2.0 | NEEDS REVIEW | References IEC 62264 in comments but is not a 1:1 ISA-95 ontology — ESMF's own information model. MPL-2.0 is ambiguous for Amazon use; treat as fallback only if IOF doesn't fit. |
| 8 | DEXPI Industrial-Data-Ontology PLM-Core | unclear | REJECT | Niche, references "AreaIsa95" but not a canonical ISA-95 ontology. |
| 9 | SAREF4INMA (`mariapoveda/saref-ext`) | unclear | DECLINE | References ISA-95 via comments only; SAREF is its own ontology family. |

### Primary recommendation — IOF Production Planning + Core (MIT)

- **Org**: Industrial Ontologies Foundry (`github.com/iofoundry`)
- **Repo**: `iofoundry/ontology` (124 stars, MIT, actively maintained — commits within the last 7 days as of report date)
- **License**: MIT (verified — `LICENSE` file at repo root)
- **Direct download URLs** (raw GitHub):
  - Core: `https://raw.githubusercontent.com/iofoundry/ontology/master/core/Core.rdf` (~404 KB, 294 classes, 75 properties)
  - Production Planning: `https://raw.githubusercontent.com/iofoundry/ontology/master/productionplanning/ProductionPlanning.rdf` (~62 KB, 58 classes)
  - Maintenance: `https://raw.githubusercontent.com/iofoundry/ontology/master/maintenance/`
  - Supply Chain: `https://raw.githubusercontent.com/iofoundry/ontology/master/supplychain/`
- **Namespace IRI base**: `https://spec.industrialontologies.org/ontology/`
  - Core: `https://spec.industrialontologies.org/ontology/core/Core/`
  - ProductionPlanning: `https://spec.industrialontologies.org/ontology/productionplanning/ProductionPlanning/`
- **Format**: RDF/XML (loadable directly into Neptune via bulk loader `format=rdfxml` or via `rdflib` Python).
- **Version**: 202502 ("December 2025 maturity provisional")
- **Imports**: BFO (Basic Formal Ontology) — bring `bfo.owl` along for full reasoning support.
- **Why primary**: only candidate that is (a) MIT-licensed, (b) actively maintained, (c) substantive (300+ classes covering material, equipment, process, plan), (d) explicitly aligned with ISA-95 / IEC 62264 / MES domains, and (e) cited in peer-reviewed publications on ERP/MES/PLM interoperability.

### Supporting recommendation — `hsu-aut/IndustrialStandard-ODP-DINEN62264-2` (MIT)

Use **only for the equipment hierarchy** if IOF Core's hierarchy doesn't map cleanly to L2 master data:
- Direct download: `https://raw.githubusercontent.com/hsu-aut/IndustrialStandard-ODP-DINEN62264-2/v2.0.0/DINEN62264.owl`
- License: MIT (`LICENSE` verified — Copyright 2019 ConstantinHildebrandt)
- Namespace: `http://www.w3id.org/hsu-aut/DINEN62264-2#`
- Classes: `Enterprise`, `Site`, `Area`, `Work_Center`, `Work_Unit`, `Process_Cell`, `Production_Line`, `Storage_Zone`, `Storage_Unit`, `Unit`, `Work_Cell`. Object properties: `consistsOf`/`isPartOf` chain (`AreaConsistsOfCenter`, `CenterIsPartOfArea`, etc.) — exactly what we need for hierarchy traversal.
- Tag a fixed version (`v2.0.0`) in `owl:imports` to pin against future changes.

### What we do NOT have

- No single Apache-2.0/MIT OWL release of ISA-95 Part 2 object models (`MaterialDefinition`, `MaterialLot`, `JobOrder`, `JobResponse`, `OperationsPerformance`) directly. **IOF Core covers most of this** but uses BFO-grounded names (e.g., `iof:MaterialArtifact` rather than ISA-95's literal `MaterialDefinition`). Mapping table needed in our `config/ontology/isa95-iof-mapping.ttl`.
- No GPL/LGPL exposure if we stick to IOF + hsu-aut.

### Fallback (if IOF doesn't fit)

Hand-build a minimal `aerospace-isa95.owl` with the 12 core classes we already use — this is what the L1/L2 mapping table in `isa95-migration.md` already enumerates. Skeleton:

```turtle
@prefix : <https://ares.example/ontology/aerospace-isa95#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

:MaterialDefinition a owl:Class ; rdfs:label "MaterialDefinition" .
:MaterialLot a owl:Class ; rdfs:label "MaterialLot" .
:MaterialSublot a owl:Class ; rdfs:subClassOf :MaterialLot .
:Equipment a owl:Class .
:EquipmentClass a owl:Class .
:Person a owl:Class .
:PersonnelClass a owl:Class .
:JobOrder a owl:Class .
:JobResponse a owl:Class .
:OperationsSegment a owl:Class .
:ProcessSegment a owl:Class .
:OperationsPerformance a owl:Class .
:Enterprise a owl:Class . :Site a owl:Class . :Area a owl:Class .
:WorkCenter a owl:Class . :WorkUnit a owl:Class .
```
~50 lines for the 12 classes + key object properties. Use only if IOF mapping turns out to be too far from ISA-95 literals for the demo audience.

---

## 2. B2MML schemas

### Source

- **Repo**: `MESAInternational/B2MML-BatchML` (the canonical, official repo)
- **Latest release**: **V7.00.00** ("Version 7, with 2018 ISA-95 changes"), released 2020-11-05
- **License**: MESA International custom license — **permissive, attribution-only** (free use/copy/modify/redistribute provided "B2MML is used courtesy of MESA International" credit is preserved). No copyleft, no field-of-use restriction. **ACCEPTABLE** (treat as BSD-equivalent for review purposes; **not** CC-BY-SA as the migration plan assumed).
- **Direct download**: `git clone https://github.com/MESAInternational/B2MML-BatchML.git` or zip from `https://github.com/MESAInternational/B2MML-BatchML/archive/refs/tags/V7.00.00.zip`
- **License URL**: `https://github.com/MESAInternational/B2MML-BatchML/blob/master/LICENSE`

### XSDs we need (subset of the 30+ files in `Schema/`)

Confirmed via `gh api repos/MESAInternational/B2MML-BatchML/contents/Schema`:

| Our event type | B2MML XSD | Path |
|---|---|---|
| All (foundation) | `B2MML-Common.xsd` | `Schema/B2MML-Common.xsd` |
| All (foundation) | `B2MML-CoreComponents.xsd` | `Schema/B2MML-CoreComponents.xsd` |
| `MATERIAL_RECEIVED`, ERP/SRM lots | `B2MML-Material.xsd` (MaterialLot, MaterialSublot, MaterialDefinition) | `Schema/B2MML-Material.xsd` |
| `WO_STARTED`, `WO_COMPLETED` | `B2MML-WorkSchedule.xsd` (JobOrder) + `B2MML-WorkPerformance.xsd` (JobResponse) | `Schema/B2MML-WorkSchedule.xsd`, `Schema/B2MML-WorkPerformance.xsd` |
| `OP_COMPLETE`, op signing | `B2MML-OperationsPerformance.xsd` | `Schema/B2MML-OperationsPerformance.xsd` |
| `CERT_LINKED`, `TEST_RECORDED` | `B2MML-OperationsPerformance.xsd` (with `OperationsType=Quality`) + `B2MML-OperationsTest.xsd` | `Schema/B2MML-OperationsPerformance.xsd`, `Schema/B2MML-OperationsTest.xsd` |
| `NCR_RAISED` | `B2MML-OperationsPerformance.xsd` (Quality, with `disposition` field) | same as above |
| Equipment master data | `B2MML-Equipment.xsd` | `Schema/B2MML-Equipment.xsd` |
| Person/operator master data | `B2MML-Personnel.xsd` | `Schema/B2MML-Personnel.xsd` |
| ProcessSegment | `B2MML-ProcessSegment.xsd` | `Schema/B2MML-ProcessSegment.xsd` |
| Plant hierarchy | `B2MML-OperationalLocation.xsd` | `Schema/B2MML-OperationalLocation.xsd` |
| (Convenience) | `B2MML-AllExtensions.xsd` (master include for codegen) | `Schema/B2MML-AllExtensions.xsd` |
| (Convenience) | `AllSchemas.xsd` (single-file root used to generate JSON Schema) | `Schema/AllSchemas.xsd` |

**Recommended commit shape**: `config/schema/b2mml/V7.00.00/Schema/*.xsd` — preserve the official path so cross-references between XSDs (`<xsd:include schemaLocation="B2MML-Common.xsd"/>`) keep resolving.

### Python tooling — `xsdata`

- `xsdata` (PyPI: `xsdata`, MIT) handles XSD 1.0 and 1.1, with a documented "naive" simplification model. The B2MML XSDs are vanilla XSD 1.0 with `xsd:include`/`xsd:import` — **no exotic features**. Standard codegen pattern:
  ```bash
  xsdata generate config/schema/b2mml/V7.00.00/Schema/AllSchemas.xsd \
    --package src.consumers.fast_consumer.b2mml_models \
    --output dataclasses
  ```
- `AllSchemas.xsd` already wraps the whole set — use it as the single entry point.
- Validation at runtime: `xsdata.formats.dataclass.parsers.XmlParser` raises on schema violations; pair with `xmlschema` Python lib (PyPI `xmlschema`, MIT) for stricter pre-publish validation in the producer Lambda.
- Known caveats: `xsdata` flattens xsd:choice in some cases — round-trip serialization may not byte-equal the input. Acceptable for our purpose (consumer parses, doesn't re-emit).

---

## 3. Practical integration

### 3.1 Event-type → B2MML schema mapping

Concrete map for every current event type (from MEMORY.md):

| Event type | Source domain | B2MML message | XSD |
|---|---|---|---|
| `NCR_RAISED`, `NCR_DISPOSITIONED`, `NCR_CLOSED` | QMS | `OperationsPerformance` with `OperationsType=Quality`, `dispositionRequired=true` | `B2MML-OperationsPerformance.xsd` |
| `WO_RELEASED` | MES | `JobOrder` (intent) | `B2MML-WorkSchedule.xsd` |
| `WO_STARTED`, `OP_COMPLETE`, `WO_COMPLETED`, `OPERATION_SIGNED` | MES, DHR | `JobResponse` (actual) | `B2MML-WorkPerformance.xsd` |
| `CERT_LINKED` | DHR | `OperationsPerformance` with `performanceType=Certificate` | `B2MML-OperationsPerformance.xsd` + `B2MML-OperationsTest.xsd` |
| `TEST_RECORDED` | DHR | `OperationsPerformance` with `performanceType=Test` | `B2MML-OperationsPerformance.xsd` + `B2MML-OperationsTest.xsd` |
| `MATERIAL_RECEIVED` | ERP | `MaterialLot` + `MaterialActual` | `B2MML-Material.xsd` |
| `LOT_GENEALOGY`, `LOT_CONSUMED` | ERP, WMS | `MaterialSublot` + `MaterialLotProperty.GenealogyParent` | `B2MML-Material.xsd` |
| `KIT_ISSUED`, `KIT_SHORTAGE_DETECTED` | WMS | `MaterialSublot` (kit aggregate) | `B2MML-Material.xsd` |
| `DRAWING_RELEASED`, `ECO_APPROVED` | PLM | extend with custom `ProductDefinitionDocument` segment in `B2MML-Common.xsd` `Extensions` slot — ISA-95 doesn't model design change control natively | `B2MML-Common.xsd` (extension) |
| `SUPPLIER_SCORE_UPDATED`, `PO_*` | SRM, ERP | OUT OF ISA-95 SCOPE — keep current JSON; reference `MaterialLot.Supplier` | n/a |
| `MILESTONE_AT_RISK` | Program | OUT OF ISA-95 SCOPE — keep current JSON | n/a |
| `MACHINE_TELEMETRY`, SCADA threshold breach | SCADA | `OperationsEvent` (event-driven) or `Equipment.EquipmentProperty` snapshot | `B2MML-OperationsEvent.xsd`, `B2MML-Equipment.xsd` |
| In-service telemetry | InService | OUT OF ISA-95 SCOPE — keep current JSON | n/a |

### 3.2 Neptune RDF dual-write — verified facts

- **Confirmed (from AWS FAQ, verbatim)**: "each Neptune Database cluster can store both property graph data and RDF data" — single cluster works.
- **Confirmed (from AWS FAQ, verbatim)**: "You cannot execute a query for property graph data (Gremlin or openCypher) over RDF data or vice-versa" — the two stores are isolated. Migration plan's "dual-write" pattern is correct: write the same logical fact to both stores in the consumer.
- **SPARQL endpoint URL** (eu-west-1, our cluster): `https://aerospace-digital-thread.cluster-<id>.eu-west-1.neptune.amazonaws.com:8182/sparql`
  - SELECT/CONSTRUCT: HTTP POST with `query=...` form-encoded
  - INSERT DATA / UPDATE: HTTP POST with `update=...` form-encoded
  - SigV4 IAM auth (same pattern as our existing Gremlin Lambda)
- **Bulk loader supports** (confirmed from `load-api-reference-load.md`): `csv` (Gremlin), `opencypher` (CSV), `ntriples`, `nquads`, `rdfxml`, `turtle`. Single loader API; the `format` parameter selects.
- **Default named graph gotcha**: SPARQL UPDATE without explicit `GRAPH <iri>` writes to fallback `http://aws.amazon.com/neptune/vocab/v01/DefaultNamedGraph`. **Recommendation**: pick our own base — e.g., `https://ares.example/aerospace/digitalthread/` — and always wrap inserts in `INSERT DATA { GRAPH <...> { triples } }` to keep the working set discoverable.
- **Base IRI**: as of engine 1.2.1.0, default base is `http://aws.amazon.com/neptune/default/`. Always set explicit `BASE` in updates to avoid surprise relative IRI resolution.
- **Datetime gotcha**: Neptune stores all `xsd:dateTime` as UTC and discards original timezone. Don't rely on round-tripping local-time stamps.
- **Numeric limit**: integer/float/decimal capped at 64 bits — irrelevant for our payload but worth noting.
- **Cost**: same single Serverless cluster handles both modes; resource contention is the only operational risk. Negligible at our seed-baseline volume (~1100 items).

### 3.3 Recommended write strategy

1. **Fast consumer** keeps writing property graph (Gremlin) — existing handlers, no disruption to existing Gremlin agents/queries.
2. **Add `rdf_writer.py`** — new module in `src/consumers/fast-consumer/` that runs alongside the GraphBatch flush:
   - Maps each handler's parsed B2MML object → triples, e.g.:
     ```turtle
     <urn:aerospace:lot:LOT-1234> a iof:MaterialArtifact ;
       isa95:material <urn:aerospace:material:WB-PANEL-A> ;
       isa95:hasSupplier <urn:aerospace:supplier:S-019> ;
       isa95:lotQuantity "100"^^xsd:decimal ;
       prov:generatedAtTime "2026-05-29T10:00:00Z"^^xsd:dateTime .
     ```
   - Writes via SPARQL `INSERT DATA` over HTTPS with SigV4 (reuse pattern from Gremlin Lambda — `requests` + `aws-requests-auth`).
3. **DLQ**: extend existing `graph-write-dlq` DDB table with a `target` discriminator (`gremlin` | `sparql`) so failures in either store land in the same replay queue.
4. **Idempotency**: SPARQL doesn't have native upsert. Pattern: `DELETE { ?s ?p ?o } WHERE { ?s ?p ?o . FILTER (?s = <urn>) }; INSERT DATA { ... }` in a single update — Neptune executes as a transaction.

---

## 4. Stretch / risk — OWL reasoning in our deployment shape

### Reasoner candidates

| Reasoner | Python interface | License | Verdict | Notes |
|---|---|---|---|---|
| **`owlrl`** | direct, on top of `rdflib` | **W3C Software License** | **ACCEPT** | OWL 2 RL profile + RDFS. Pure Python, runs anywhere. Materializes inferred triples in-memory. Acceptable license for Amazon (W3C is BSD-equivalent, non-copyleft). |
| `reasonable` | Python bindings | **BSD-3-Clause** | ACCEPT | Rust-backed OWL 2 RL reasoner, fast. Verified license via `gh api repos/gtfierro/reasonable`. |
| `owlready2` (HermiT bundled) | Python | **LGPL-3.0** | **REJECT** | Verified LGPL via direct repo LICENSE.txt. Don't use even though HermiT is more powerful. |
| HermiT (Java, standalone) | subprocess | LGPL-2.1 | REJECT | Same problem. |
| Pellet | Java | AGPL-3.0 | REJECT | AGPL is hard reject. |
| Stardog (commercial) | n/a | proprietary | DECLINE | External triplestore, scope creep for the demo. |
| Apache Jena (Fuseki + reasoner) | Java | Apache-2.0 | ACCEPT (heavy) | Standalone server. Acceptable license but adds infra. |

### Feasibility in our deployment shape

- **Neptune does NOT run an OWL reasoner natively**. SPARQL queries see only asserted triples. AWS docs confirm this (no inference engine in the Neptune SPARQL stack).
- **Three viable approaches**:
  1. **In-process materialization in the slow consumer** (recommended for L3): when the slow consumer (Cert Readiness Agent) starts a reasoning pass, it (a) `CONSTRUCT`s the relevant subgraph from Neptune, (b) loads it into an in-memory `rdflib.Graph`, (c) runs `owlrl.DeductiveClosure(OWLRL_Semantics).expand(g)`, (d) `INSERT DATA`s the new triples back into a separate named graph (e.g., `<...digitalthread/inferred/>`). Keeps reasoning bounded to relevant slices. No new infra.
  2. **Pre-materialize at load time**: run the reasoner once over the imported IOF ontology + master data, store the closure in a `<...digitalthread/tbox-closure/>` named graph. Re-run when ontology version bumps. Adds an offline step but cheap.
  3. **External Apache Jena Fuseki** with `owl-rl`-equivalent rules. Sidecar service. Use if (1) and (2) prove insufficient for the demo's reasoning ambition. **Don't do this for the demo unless absolutely necessary** — adds CDK complexity and a second graph store.
- **Strands-on-AgentCore feasibility**: agents already hit Neptune via API Gateway. Add a `query_sparql` tool (mirror of `query_gremlin`) — straightforward. Reasoning materialization is a separate slow-consumer responsibility, not an agent tool.

### Recommendation

- **L3 reasoning**: option 1 (in-process `owlrl` in slow consumer) — minimal infra delta, license-safe, sufficient for demo-grade inference (e.g., "Equipment subClassOf WorkUnit" → "Cell-A is also a WorkUnit").
- **Don't promise**: full DL reasoning (HermiT-class). OWL 2 RL is a profile — class hierarchy and property chains work; cardinality restrictions with disjunction don't. Communicate this to stakeholders.
- **Acceptance criterion**: at least one inferred triple visible in SPARQL after closure pass (per the migration plan's existing L3 acceptance criterion 5).

---

## 5. Top recommendations (decision-ready)

1. **Ontology**: pull `iofoundry/ontology` (MIT, active) at a pinned commit into `config/ontology/iof/`. Layer `hsu-aut/IndustrialStandard-ODP-DINEN62264-2` v2.0.0 on top for ISA-95-literal hierarchy class names. Write a thin `config/ontology/aerospace-isa95-mapping.ttl` that aligns our 16 graph types to IOF + hsu-aut IRIs. Reject everything else — kenwenzel is unlicensed; MIMOSA never published one; OAGi only does B2MML.
2. **B2MML**: `MESAInternational/B2MML-BatchML` V7.00.00 (custom permissive license — attribution-only, no copyleft). Commit only `Schema/*.xsd`. Generate Python dataclasses with `xsdata` from `AllSchemas.xsd`. Use 7 XSDs operationally: Material, WorkSchedule, WorkPerformance, OperationsPerformance, OperationsTest, Equipment, Personnel, ProcessSegment, OperationalLocation, Common.
3. **Neptune dual-write**: confirmed feasible on the existing Serverless cluster. Add `rdf_writer.py` to fast consumer; reuse SigV4 + `requests` pattern from the Gremlin Lambda. Always write to an explicit named graph; never rely on the default fallback.
4. **Reasoning**: `owlrl` (W3C license) running in-process in the slow consumer. Materialize a small inferred-triples named graph; expose to SPARQL. Reject `owlready2`/HermiT (LGPL). Don't introduce Apache Jena unless option 1 proves insufficient.
5. **Docs/provenance**: per the migration plan, create `docs/specs/isa95-ontology-source.md` capturing: source repos + commit SHAs, license texts, version pinning rationale, and the exact `owl:imports` URLs we use.

---

## 6. Verified URLs (for `docs/specs/isa95-ontology-source.md`)

| Asset | URL | License URL |
|---|---|---|
| IOF ontology repo | https://github.com/iofoundry/ontology | https://github.com/iofoundry/ontology/blob/master/LICENSE |
| IOF Core RDF | https://raw.githubusercontent.com/iofoundry/ontology/master/core/Core.rdf | (MIT, see repo LICENSE) |
| IOF ProductionPlanning RDF | https://raw.githubusercontent.com/iofoundry/ontology/master/productionplanning/ProductionPlanning.rdf | (MIT) |
| hsu-aut DINEN62264-2 | https://github.com/hsu-aut/IndustrialStandard-ODP-DINEN62264-2 | https://github.com/hsu-aut/IndustrialStandard-ODP-DINEN62264-2/blob/master/LICENSE |
| hsu-aut OWL (pinned v2.0.0) | https://raw.githubusercontent.com/hsu-aut/IndustrialStandard-ODP-DINEN62264-2/v2.0.0/DINEN62264.owl | (MIT) |
| B2MML repo | https://github.com/MESAInternational/B2MML-BatchML | https://github.com/MESAInternational/B2MML-BatchML/blob/master/LICENSE |
| B2MML V7.00.00 zip | https://github.com/MESAInternational/B2MML-BatchML/archive/refs/tags/V7.00.00.zip | (MESA permissive) |
| owlrl (PyPI) | https://pypi.org/project/owlrl/ | W3C Software License |
| xsdata (PyPI) | https://pypi.org/project/xsdata/ | MIT |
| Neptune SPARQL FAQ confirmation | https://aws.amazon.com/neptune/faqs/ | n/a (AWS doc) |
| Neptune bulk loader formats | https://docs.aws.amazon.com/neptune/latest/userguide/load-api-reference-load.html | n/a (AWS doc) |
| Neptune SPARQL compliance | https://docs.aws.amazon.com/neptune/latest/userguide/feature-sparql-compliance.html | n/a (AWS doc) |
