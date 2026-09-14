#!/usr/bin/env python3
"""Import ISA-95 reference ontologies (IOF + hsu-aut) into Neptune RDF mode.

Strategy: parse each RDF file with rdflib, serialize as N-Triples, then write
in batches via the neptune-query Lambda's `sparql_update` op. This keeps the
import path consistent with the dual-write path used by the fast consumer
(no separate VPC/loader configuration).

Idempotent: drops the TBox named graph first, then re-inserts.

Usage:
    AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1 python3 scripts/import-ontology.py

Refs:
    docs/specs/isa95-l3-research.md §2 (license vetting)
    docs/specs/isa95-ontology-source.md (provenance)
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

import boto3

try:
    from rdflib import Graph
except ImportError:
    print("rdflib not installed. Run: pip3 install rdflib", file=sys.stderr)
    sys.exit(1)

LOG = logging.getLogger("import-ontology")
logging.basicConfig(level=logging.INFO, format="%(message)s")

ROOT = Path(__file__).resolve().parent.parent
ONTOLOGY_DIR = ROOT / "config" / "ontology"
LAMBDA_NAME = "aerospace-neptune-query"

TBOX_GRAPH = "https://ares.example/aerospace/digitalthread/tbox"

# (file, format) tuples — `format` matches rdflib's parser names
FILES = [
    (ONTOLOGY_DIR / "iof" / "Core.rdf",                  "xml"),
    (ONTOLOGY_DIR / "iof" / "ProductionPlanning.rdf",    "xml"),
    (ONTOLOGY_DIR / "hsu-aut" / "DINEN62264.owl",        "xml"),
]

BATCH_SIZE = 200  # triples per INSERT DATA call — Lambda body limit is 6MB but smaller chunks are safer


def _esc_literal(s: str) -> str:
    """Escape a string literal for an N-Triples literal token."""
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")


def _term_to_ntriples(term) -> str:
    """Render an rdflib term in N-Triples syntax."""
    from rdflib import URIRef, BNode, Literal
    if isinstance(term, URIRef):
        return f"<{term}>"
    if isinstance(term, BNode):
        return f"_:{term}"
    if isinstance(term, Literal):
        lex = _esc_literal(str(term))
        if term.language:
            return f'"{lex}"@{term.language}'
        if term.datatype:
            return f'"{lex}"^^<{term.datatype}>'
        return f'"{lex}"'
    return str(term)


def _triples_to_ntriples(triples) -> str:
    return " . ".join(
        f"{_term_to_ntriples(s)} {_term_to_ntriples(p)} {_term_to_ntriples(o)}"
        for s, p, o in triples
    ) + " ."


def _invoke(lam, operation: str, parameters: dict) -> dict:
    payload = json.dumps({"operation": operation, "parameters": parameters})
    resp = lam.invoke(FunctionName=LAMBDA_NAME, Payload=payload.encode("utf-8"))
    body = json.loads(resp["Payload"].read().decode("utf-8"))
    if body.get("statusCode") != 200:
        raise RuntimeError(f"Lambda error: {body}")
    return body


def insert_batch(lam, triples_batch) -> None:
    """Insert a batch of triples into the TBox named graph."""
    nt = _triples_to_ntriples(triples_batch)
    update = f"INSERT DATA {{ GRAPH <{TBOX_GRAPH}> {{ {nt} }} }}"
    _invoke(lam, "sparql_update", {"sparql": update})


def main() -> int:
    lam = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "eu-west-1"))

    # 1. Drop the TBox graph for clean re-import.
    LOG.info("Dropping graph <%s>...", TBOX_GRAPH)
    try:
        _invoke(lam, "drop_rdf_graph", {"graphIri": TBOX_GRAPH})
        LOG.info("  dropped (or did not exist)")
    except Exception as e:
        LOG.warning("  drop returned: %s — continuing", e)

    # 2. Parse each file, push in batches.
    total_loaded = 0
    for path, fmt in FILES:
        if not path.exists():
            LOG.error("Missing %s", path)
            return 1
        LOG.info("Loading %s (format=%s)...", path.relative_to(ROOT), fmt)
        g = Graph()
        g.parse(str(path), format=fmt)
        total = len(g)
        LOG.info("  %d triples parsed", total)

        batch = []
        loaded = 0
        for triple in g:
            batch.append(triple)
            if len(batch) >= BATCH_SIZE:
                insert_batch(lam, batch)
                loaded += len(batch)
                batch = []
                if loaded % (BATCH_SIZE * 5) == 0:
                    LOG.info("    %d / %d", loaded, total)
        if batch:
            insert_batch(lam, batch)
            loaded += len(batch)
        LOG.info("  %d triples inserted", loaded)
        total_loaded += loaded

    LOG.info("=== Done ===")
    LOG.info("  Total triples inserted: %d", total_loaded)
    LOG.info("  Named graph: <%s>", TBOX_GRAPH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
