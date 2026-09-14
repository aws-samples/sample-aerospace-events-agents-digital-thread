#!/usr/bin/env python3
"""Seed ISA-95:2018 master data into Neptune.

Master data (Enterprise / Site / Area / WorkCenter / WorkUnit + Personnel) is
reference data, not events — this script writes it directly to Neptune by
invoking the existing `aerospace-neptune-query` Lambda's `execute_gremlin`
operation. Idempotent: every upsert uses `g.V().has(label,id,X).fold().coalesce(unfold(),...)`.

Usage:
    AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1 python3 scripts/seed-master-data.py

Refs docs/specs/isa95-migration.md L2.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import boto3

LOG = logging.getLogger("seed-master-data")
logging.basicConfig(level=logging.INFO, format="%(message)s")

ROOT = Path(__file__).resolve().parent.parent
HIERARCHY_FILE = ROOT / "config" / "master-data" / "hierarchy.json"
PERSONNEL_FILE = ROOT / "config" / "master-data" / "personnel.json"
SEGMENTS_FILE = ROOT / "config" / "master-data" / "process-segments.json"

LAMBDA_NAME = "aerospace-neptune-query"


def _esc(s: Any) -> str:
    """Escape single-quotes for Gremlin string literals."""
    return str(s).replace("\\", "\\\\").replace("'", "\\'")


def _props(d: dict) -> str:
    """Render a property bag as chained .property() calls."""
    return "".join(
        f".property('{_esc(k)}', '{_esc(v)}')" for k, v in d.items() if v not in (None, "")
    )


def _upsert_node(label: str, node_id: str, properties: dict) -> str:
    """Idempotent vertex upsert."""
    return (
        f"g.V().has('{_esc(label)}', 'id', '{_esc(node_id)}').fold().coalesce("
        f"unfold(),"
        f"addV('{_esc(label)}').property('id', '{_esc(node_id)}')"
        f"){_props(properties)}"
    )


def _upsert_edge(src_label: str, src_id: str, tgt_label: str, tgt_id: str, edge_label: str) -> str:
    """Idempotent edge upsert (assumes both endpoints already exist)."""
    return (
        f"g.V().has('{_esc(src_label)}', 'id', '{_esc(src_id)}').as('src')."
        f"V().has('{_esc(tgt_label)}', 'id', '{_esc(tgt_id)}')."
        f"coalesce("
        f"__.inE('{_esc(edge_label)}').where(__.outV().as('src')),"
        f"__.addE('{_esc(edge_label)}').from('src')"
        f")"
    )


def _invoke_gremlin(lam, gremlin: str) -> dict:
    payload = json.dumps({"operation": "execute_gremlin", "parameters": {"gremlin": gremlin}})
    resp = lam.invoke(FunctionName=LAMBDA_NAME, Payload=payload.encode("utf-8"))
    body = json.loads(resp["Payload"].read().decode("utf-8"))
    if body.get("statusCode") != 200:
        raise RuntimeError(f"Lambda error: {body}")
    return body


def seed_hierarchy(lam, hierarchy: dict) -> dict:
    counts = {"Enterprise": 0, "Site": 0, "Area": 0, "WorkCenter": 0, "WorkUnit": 0,
              "edges": 0}

    ent = hierarchy["enterprise"]
    _invoke_gremlin(lam, _upsert_node("Enterprise", ent["id"], {"name": ent["name"]}))
    counts["Enterprise"] += 1

    for s in hierarchy["sites"]:
        _invoke_gremlin(lam, _upsert_node("Site", s["id"], {"name": s["name"]}))
        _invoke_gremlin(lam, _upsert_edge("Site", s["id"], "Enterprise", s["enterpriseId"], "partOf"))
        counts["Site"] += 1
        counts["edges"] += 1

    for a in hierarchy["areas"]:
        _invoke_gremlin(lam, _upsert_node("Area", a["id"], {"name": a["name"], "siteId": a["siteId"]}))
        _invoke_gremlin(lam, _upsert_edge("Area", a["id"], "Site", a["siteId"], "partOf"))
        counts["Area"] += 1
        counts["edges"] += 1

    for w in hierarchy["workCenters"]:
        _invoke_gremlin(
            lam,
            _upsert_node("WorkCenter", w["id"], {
                "name": w["name"],
                "areaId": w["areaId"],
                "cellId": w.get("cellId", ""),
            }),
        )
        _invoke_gremlin(lam, _upsert_edge("WorkCenter", w["id"], "Area", w["areaId"], "partOf"))
        counts["WorkCenter"] += 1
        counts["edges"] += 1

    for u in hierarchy["workUnits"]:
        # WorkUnit IDs match Equipment.id used by handlers, so the handler-emitted
        # Equipment node and this WorkUnit node share the same ID space — we
        # store WorkUnit metadata as a separate label for the master-data view.
        _invoke_gremlin(
            lam,
            _upsert_node("WorkUnit", u["id"], {
                "name": u["name"],
                "workCenterId": u["workCenterId"],
                "type": u.get("type", ""),
            }),
        )
        _invoke_gremlin(lam, _upsert_edge("WorkUnit", u["id"], "WorkCenter", u["workCenterId"], "partOf"))
        counts["WorkUnit"] += 1
        counts["edges"] += 1

    return counts


def seed_personnel(lam, personnel: dict) -> dict:
    counts = {"PersonnelClass": 0, "Person": 0, "edges": 0}

    for pc in personnel["personnelClasses"]:
        _invoke_gremlin(
            lam,
            _upsert_node("PersonnelClass", pc["id"], {
                "name": pc["name"],
                "qualification": pc.get("qualification", ""),
            }),
        )
        counts["PersonnelClass"] += 1

    for p in personnel["people"]:
        _invoke_gremlin(
            lam,
            _upsert_node("Person", p["id"], {
                "name": p["name"],
                "personnelClassId": p["personnelClassId"],
                "siteId": p.get("siteId", ""),
            }),
        )
        _invoke_gremlin(
            lam,
            _upsert_edge("Person", p["id"], "PersonnelClass", p["personnelClassId"], "memberOf"),
        )
        if p.get("siteId"):
            _invoke_gremlin(
                lam,
                _upsert_edge("Person", p["id"], "Site", p["siteId"], "assignedToSite"),
            )
        counts["Person"] += 1
        counts["edges"] += 1 + (1 if p.get("siteId") else 0)

    return counts


def seed_segments(lam, segments_doc: dict) -> dict:
    counts = {"ProcessSegment": 0, "edges": 0}
    for seg in segments_doc["segments"]:
        seg_id = f'SEG-{seg["partNumber"]}-{seg["opNumber"]}'
        _invoke_gremlin(
            lam,
            _upsert_node("ProcessSegment", seg_id, {
                "id": seg_id,
                "segmentNumber": seg["opNumber"],
                "segmentName": seg["name"],
                "ordering": str(seg["ordering"]),
                "materialDefinitionId": seg["partNumber"],
            }),
        )
        # Ensure MaterialDefinition exists (handler may not have written it yet)
        _invoke_gremlin(
            lam,
            _upsert_node("MaterialDefinition", seg["partNumber"], {"partNumber": seg["partNumber"]}),
        )
        _invoke_gremlin(
            lam,
            _upsert_edge("ProcessSegment", seg_id, "MaterialDefinition", seg["partNumber"], "definedFor"),
        )
        counts["ProcessSegment"] += 1
        counts["edges"] += 1
    return counts


def main() -> int:
    missing = [p for p in (HIERARCHY_FILE, PERSONNEL_FILE, SEGMENTS_FILE) if not p.exists()]
    if missing:
        LOG.error("Missing master-data file(s): %s", missing)
        return 1

    hierarchy = json.loads(HIERARCHY_FILE.read_text())
    personnel = json.loads(PERSONNEL_FILE.read_text())
    segments = json.loads(SEGMENTS_FILE.read_text())

    lam = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "eu-west-1"))

    LOG.info("=== Seeding hierarchy ===")
    h_counts = seed_hierarchy(lam, hierarchy)
    LOG.info("  %s", h_counts)

    LOG.info("=== Seeding personnel ===")
    p_counts = seed_personnel(lam, personnel)
    LOG.info("  %s", p_counts)

    LOG.info("=== Seeding process segments ===")
    s_counts = seed_segments(lam, segments)
    LOG.info("  %s", s_counts)

    LOG.info("=== Done ===")
    LOG.info("  Run again at any time — all upserts are idempotent.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
