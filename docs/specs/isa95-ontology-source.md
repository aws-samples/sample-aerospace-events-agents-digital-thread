# ISA-95 L3 — Ontology Provenance

Reference data for the ISA-95:2018 Level 3 (RDF + B2MML) implementation.
See `docs/specs/isa95-l3-research.md` for the research that drove these choices.

## Vendored ontologies

| File | Source | Version pin | License | License file |
|---|---|---|---|---|
| `config/ontology/iof/Core.rdf` | [iofoundry/ontology](https://github.com/iofoundry/ontology) | `master` (snapshot 2026-05-29) | MIT | `config/ontology/iof/LICENSE` |
| `config/ontology/iof/ProductionPlanning.rdf` | [iofoundry/ontology](https://github.com/iofoundry/ontology) | `master` (snapshot 2026-05-29) | MIT | `config/ontology/iof/LICENSE` |
| `config/ontology/hsu-aut/DINEN62264.owl` | [hsu-aut/IndustrialStandard-ODP-DINEN62264-2](https://github.com/hsu-aut/IndustrialStandard-ODP-DINEN62264-2) | `v2.0.0` | MIT | `config/ontology/hsu-aut/LICENSE` |

## Namespace IRIs

| Prefix | IRI |
|---|---|
| `iof-core` | `https://spec.industrialontologies.org/ontology/core/Core/` |
| `iof-pp` | `https://spec.industrialontologies.org/ontology/productionplanning/ProductionPlanning/` |
| `isa95` | `http://www.w3id.org/hsu-aut/DINEN62264-2#` |
| `aero` | `https://ares.example/aerospace-events-agents-digital-thread/` |

## Aerospace mapping IRIs

Each L1/L2 graph node has a stable URN-style IRI used for both the RDF subject
and as a stable identifier across producers:

| Node label (Gremlin) | IRI pattern |
|---|---|
| `MaterialDefinition` | `urn:aerospace:material:{partNumber}` |
| `MaterialLot` | `urn:aerospace:lot:{lotNumber}` |
| `MaterialSublot` | `urn:aerospace:sublot:{serialNumber}` (or `:{kitId}` for kit subtype) |
| `Equipment` | `urn:aerospace:equipment:{machineId}` |
| `JobOrder` / `JobResponse` | `urn:aerospace:job:{workOrderId}` |
| `OperationsPerformance` | `urn:aerospace:opsperf:{ncrId|certNumber|testId}` |
| `Person` | `urn:aerospace:person:{personId}` |
| `PersonnelClass` | `urn:aerospace:personnelclass:{classId}` |
| `Enterprise/Site/Area/WorkCenter/WorkUnit` | `urn:aerospace:hierarchy:{level}:{id}` |
| `ProductDefinitionDocument` | `urn:aerospace:document:{drawingNumber}` |
| `ProcessSegment` | `urn:aerospace:segment:{segmentId}` |

## Named graphs

| Named graph IRI | Purpose |
|---|---|
| `https://ares.example/aerospace/digitalthread/tbox` | Imported ontologies (IOF + hsu-aut) — TBox |
| `https://ares.example/aerospace/digitalthread/abox` | Live event facts (ABox) — every Gremlin node also written as triples here |
| `https://ares.example/aerospace/digitalthread/inferred` | Reserved for future reasoner output (deferred from L3 main) |

## How updates flow

1. Each fast-consumer handler still writes property-graph nodes via `GraphBatch`
2. The new `rdf_writer.py` writes the same logical fact as triples to the ABox
   named graph via the Neptune Lambda's `insert_triples` operation
3. Failures land in the same `graph-write-dlq` table with a `target` discriminator
   (`gremlin` | `sparql`) for replay

## Re-pulling vendored files

```bash
# IOF (master HEAD)
curl -o config/ontology/iof/Core.rdf \
  https://raw.githubusercontent.com/iofoundry/ontology/master/core/Core.rdf
curl -o config/ontology/iof/ProductionPlanning.rdf \
  https://raw.githubusercontent.com/iofoundry/ontology/master/productionplanning/ProductionPlanning.rdf

# hsu-aut (pinned v2.0.0)
curl -o config/ontology/hsu-aut/DINEN62264.owl \
  https://raw.githubusercontent.com/hsu-aut/IndustrialStandard-ODP-DINEN62264-2/v2.0.0/DINEN62264.owl
```

## License notes

Both ontologies are MIT — permissive, attribution-only, no copyleft.
The raw files retain their original copyright notices and headers; we do not
modify them. The mapping (`config/ontology/aerospace-isa95-mapping.ttl`, when
authored) is our own work and inherits the project license.
