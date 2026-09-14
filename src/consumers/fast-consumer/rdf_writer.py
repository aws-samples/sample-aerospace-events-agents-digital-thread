"""ISA-95:2018 Level 3 — RDF dual-write to Neptune via the query Lambda.

Writes the same logical fact as the Gremlin GraphBatch into the SPARQL store,
into the named graph `https://ares.example/aerospace/digitalthread/abox`.

Strategy:
- Each Gremlin node maps to one IRI (urn-based, see docs/specs/isa95-ontology-source.md)
- Each node label maps to one `rdf:type` triple
- Each node property maps to one data-property triple under `aero:` namespace
- Each edge maps to one object-property triple under `aero:` namespace
- All writes go to the ABox named graph; the TBox graph is untouched

Failures are caught and logged; they do not block Gremlin writes (Gremlin is
the primary store for L3). Future enhancement: dual-write to graph-write-dlq
with a `target` discriminator.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional

import boto3

logger = logging.getLogger("rdf-writer")

LAMBDA_NAME = os.environ.get("NEPTUNE_QUERY_LAMBDA", "aerospace-neptune-query")
ABOX_GRAPH = os.environ.get("RDF_ABOX_GRAPH", "https://ares.example/aerospace/digitalthread/abox")
AERO_NS = "https://ares.example/aerospace-events-agents-digital-thread/"

_lam = None


def _get_lambda():
    global _lam
    if _lam is None:
        _lam = boto3.client("lambda")
    return _lam


# Map Gremlin labels → URN namespace prefix used for subject IRIs.
_LABEL_NS = {
    "MaterialDefinition":         "urn:aerospace:material:",
    "MaterialLot":                "urn:aerospace:lot:",
    "MaterialSublot":             "urn:aerospace:sublot:",
    "Equipment":                  "urn:aerospace:equipment:",
    "JobOrder":                   "urn:aerospace:job:",
    "JobResponse":                "urn:aerospace:job:",
    "OperationsPerformance":      "urn:aerospace:opsperf:",
    "Person":                     "urn:aerospace:person:",
    "PersonnelClass":             "urn:aerospace:personnelclass:",
    "Enterprise":                 "urn:aerospace:hierarchy:enterprise:",
    "Site":                       "urn:aerospace:hierarchy:site:",
    "Area":                       "urn:aerospace:hierarchy:area:",
    "WorkCenter":                 "urn:aerospace:hierarchy:workcenter:",
    "WorkUnit":                   "urn:aerospace:hierarchy:workunit:",
    "ProductDefinitionDocument":  "urn:aerospace:document:",
    "ProcessSegment":             "urn:aerospace:segment:",
    "Supplier":                   "urn:aerospace:supplier:",
    "PurchaseOrder":              "urn:aerospace:po:",
    "ECO":                        "urn:aerospace:eco:",
    "Milestone":                  "urn:aerospace:milestone:",
    "DigitalTwin":                "urn:aerospace:twin:",
    "FleetAnomaly":               "urn:aerospace:anomaly:",
    "ThreadGap":                  "urn:aerospace:gap:",
    "CoherenceVerdict":           "urn:aerospace:verdict:",
    "AsBuiltRecord":              "urn:aerospace:asbuilt:",
}


def iri_for(label: str, node_id: str) -> str:
    """Build the canonical IRI for a Gremlin node."""
    prefix = _LABEL_NS.get(label, "urn:aerospace:unknown:")
    # IRIs must not contain characters that need percent-encoding in N-Triples;
    # node_ids in this project are alphanumeric+dashes+slashes, all valid.
    return f"{prefix}{node_id}"


def _esc_literal(s: str) -> str:
    return str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _esc_local(s: str) -> str:
    """Escape a string for use as a local-name fragment."""
    # Keep alphanumeric/underscore/dash; anything else gets dropped — property
    # keys in this project are camelCase, no special chars.
    return "".join(c if (c.isalnum() or c in "_-") else "_" for c in str(s))


def _node_triples(label: str, node_id: str, props: dict) -> list[str]:
    """Build N-Triples lines for a single node."""
    subj = f"<{iri_for(label, node_id)}>"
    type_iri = f"<{AERO_NS}{label}>"
    triples = [f"{subj} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> {type_iri} ."]
    triples.append(f'{subj} <http://www.w3.org/2000/01/rdf-schema#label> "{_esc_literal(node_id)}" .')
    for k, v in (props or {}).items():
        if v in (None, ""):
            continue
        pred = f"<{AERO_NS}prop/{_esc_local(k)}>"
        triples.append(f'{subj} {pred} "{_esc_literal(v)}" .')
    return triples


def _edge_triple(src_label: str, src_id: str, tgt_label: str, tgt_id: str, edge_label: str) -> str:
    s = f"<{iri_for(src_label, src_id)}>"
    o = f"<{iri_for(tgt_label, tgt_id)}>"
    p = f"<{AERO_NS}rel/{_esc_local(edge_label)}>"
    return f"{s} {p} {o} ."


def write_batch(
    nodes: list[tuple[str, str, dict]],
    edges: list[tuple[str, str, str, str, str]],
    event: Optional[dict] = None,
) -> None:
    """Dual-write the contents of a GraphBatch as RDF triples.

    Errors are logged but never raised — RDF is the secondary store for L3
    and must not block Gremlin writes.
    """
    if not nodes and not edges:
        return

    triples: list[str] = []
    for label, node_id, props in nodes:
        triples.extend(_node_triples(label, node_id, props))
    for src_label, src_id, tgt_label, tgt_id, edge_label in edges:
        triples.append(_edge_triple(src_label, src_id, tgt_label, tgt_id, edge_label))

    nt_block = "\n".join(triples)
    update = f"INSERT DATA {{ GRAPH <{ABOX_GRAPH}> {{\n{nt_block}\n}} }}"

    payload = json.dumps({"operation": "sparql_update", "parameters": {"sparql": update}})
    try:
        t0 = time.time()
        resp = _get_lambda().invoke(FunctionName=LAMBDA_NAME, Payload=payload.encode("utf-8"))
        body = json.loads(resp["Payload"].read().decode("utf-8"))
        if body.get("statusCode") != 200:
            logger.warning("rdf-writer: lambda returned %s — %.2fs", body, time.time() - t0)
        else:
            logger.debug("rdf-writer: %d triples in %.0fms", len(triples), 1000 * (time.time() - t0))
    except Exception as e:
        logger.warning("rdf-writer: dual-write failed (eventId=%s): %s",
                       (event or {}).get("eventId", ""), e)
