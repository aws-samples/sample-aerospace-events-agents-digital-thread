"""ISA-95:2018 Level 3 — B2MML XML serialization (happy-path subset).

Builds B2MML messages from incoming JSON payloads for three event types:
    NON_CONFORMANCE_RAISED  → OperationsPerformance (Quality, dispositionRequired)
    WORK_ORDER_STARTED      → JobResponse
    OPERATION_COMPLETED     → JobResponse update + OperationsPerformance

The XML is structured to validate against MESA B2MML V7.00.00 XSDs in
`config/schema/b2mml/V7.00.00/Schema/`. We don't validate at runtime in the
consumer (xmlschema would add ~10MB to the container); validation is done
once via an offline test script.

This module is the format-story demonstration. Production output is the
property graph + SPARQL store; the B2MML XML is archived to S3 for any
external consumer that wants the canonical message shape.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from xml.etree.ElementTree import Element, SubElement, tostring  # nosemgrep: use-defused-xml -- builds XML only (Element/SubElement/tostring); never parses untrusted input

logger = logging.getLogger("b2mml")

NS = "http://www.mesa.org/xml/B2MML-V0700"
SCHEMA_LOC = (
    "http://www.mesa.org/xml/B2MML-V0700 "
    "http://www.mesa.org/xml/B2MML-OperationsPerformance-V0700.xsd"
)


def _root(local_name: str) -> Element:
    """Build the B2MML root element with the canonical namespace + xsi attrs."""
    root = Element(f"{{{NS}}}{local_name}")
    root.set("xmlns:xsi", "http://www.w3.org/2001/XMLSchema-instance")
    root.set("xsi:schemaLocation", SCHEMA_LOC)
    return root


def _id(parent: Element, value: str) -> Element:
    el = SubElement(parent, f"{{{NS}}}ID")
    el.text = str(value)
    return el


def _description(parent: Element, value: str) -> Element:
    el = SubElement(parent, f"{{{NS}}}Description")
    el.text = str(value)
    return el


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def from_ncr(payload: dict, event_id: str) -> bytes:
    """NON_CONFORMANCE_RAISED → OperationsPerformance (subtype=NonConformance).

    Aligns with B2MML-OperationsPerformance.xsd:
      <OperationsPerformance>
        <ID/>
        <Description/>
        <OperationsType>Quality</OperationsType>
        <OperationsResponse>
          <ID/>  (the NCR id)
          <ResponseState>...</ResponseState>
          <SerialNumber>...</SerialNumber>  (ISA-95 doesn't have this; we use Property)
          ...
        </OperationsResponse>
      </OperationsPerformance>
    """
    root = _root("OperationsPerformance")
    _id(root, payload.get("ncrId", event_id))
    _description(root, f"Non-conformance {payload.get('defectCode', '')} on serial {payload.get('serialNumber', '')}")

    SubElement(root, f"{{{NS}}}OperationsType").text = "Quality"
    SubElement(root, f"{{{NS}}}HierarchyScope").text = "ProductionUnit"
    SubElement(root, f"{{{NS}}}PublishedDate").text = _now()

    response = SubElement(root, f"{{{NS}}}OperationsResponse")
    _id(response, payload.get("ncrId", event_id))
    SubElement(response, f"{{{NS}}}ResponseState").text = payload.get("status", "OPEN")
    SubElement(response, f"{{{NS}}}StartTime").text = _now()

    # Custom properties (B2MML allows extension via Property elements)
    for k, v in (
        ("severity", payload.get("severity", "")),
        ("defectCode", payload.get("defectCode", "")),
        ("partNumber", payload.get("partNumber", "")),
        ("serialNumber", payload.get("serialNumber", "")),
        ("lotNumber", payload.get("lotNumber", "")),
        ("supplierId", payload.get("supplierId", "")),
        ("dispositionRequired", "true"),
    ):
        if not v:
            continue
        prop = SubElement(response, f"{{{NS}}}OperationsResponseProperty")
        _id(prop, k)
        SubElement(prop, f"{{{NS}}}Value").text = str(v)

    return tostring(root, encoding="utf-8", xml_declaration=True)


def from_wo_started(payload: dict, event_id: str) -> bytes:
    """WORK_ORDER_STARTED → JobResponse (B2MML-WorkPerformance.xsd).

    Carries the actual execution details — equipment, operator, segment.
    """
    root = _root("JobResponse")
    _id(root, payload.get("workOrderId", event_id))
    _description(root, f"Work order {payload.get('workOrderId', '')} {payload.get('operationName', '')} started")

    SubElement(root, f"{{{NS}}}HierarchyScope").text = "WorkCenter"
    SubElement(root, f"{{{NS}}}PublishedDate").text = _now()
    SubElement(root, f"{{{NS}}}JobOrderID").text = payload.get("workOrderId", "")  # request-side ref
    SubElement(root, f"{{{NS}}}JobResponseState").text = payload.get("status", "STARTED")
    SubElement(root, f"{{{NS}}}StartTime").text = payload.get("scheduledStart", _now())

    # PersonnelActual — the operator
    if payload.get("assignedOperator"):
        person = SubElement(root, f"{{{NS}}}PersonnelActual")
        _id(person, payload["assignedOperator"])
        SubElement(person, f"{{{NS}}}HierarchyScope").text = "Person"

    # EquipmentActual — derived from cell→machine mapping (handler does the mapping)
    if payload.get("cell"):
        equipment = SubElement(root, f"{{{NS}}}EquipmentActual")
        _id(equipment, payload["cell"])
        SubElement(equipment, f"{{{NS}}}HierarchyScope").text = "WorkUnit"

    # MaterialActual — what we produce
    if payload.get("partNumber"):
        material = SubElement(root, f"{{{NS}}}MaterialActual")
        SubElement(material, f"{{{NS}}}MaterialDefinitionID").text = payload["partNumber"]
        if payload.get("serialNumber"):
            SubElement(material, f"{{{NS}}}MaterialSubLotID").text = payload["serialNumber"]
        SubElement(material, f"{{{NS}}}MaterialUse").text = "Produced"

    return tostring(root, encoding="utf-8", xml_declaration=True)


def from_op_completed(payload: dict, event_id: str) -> bytes:
    """OPERATION_COMPLETED → JobResponse (with executed segment + cycle time)."""
    root = _root("JobResponse")
    _id(root, payload.get("workOrderId", event_id))
    _description(root, f"Operation {payload.get('operationNumber', '')} completed on WO {payload.get('workOrderId', '')}")

    SubElement(root, f"{{{NS}}}HierarchyScope").text = "WorkCenter"
    SubElement(root, f"{{{NS}}}PublishedDate").text = _now()
    SubElement(root, f"{{{NS}}}JobResponseState").text = "Completed"
    SubElement(root, f"{{{NS}}}EndTime").text = payload.get("actualEnd", _now())

    # SegmentResponse — proves which recipe step was executed
    if payload.get("operationNumber") and payload.get("partNumber"):
        seg = SubElement(root, f"{{{NS}}}SegmentResponse")
        _id(seg, f"SEG-{payload['partNumber']}-{payload['operationNumber']}")
        SubElement(seg, f"{{{NS}}}ProcessSegmentID").text = f"SEG-{payload['partNumber']}-{payload['operationNumber']}"
        SubElement(seg, f"{{{NS}}}SegmentState").text = "Completed"

    if payload.get("cycleTimeMs"):
        prop = SubElement(root, f"{{{NS}}}JobResponseProperty")
        _id(prop, "cycleTimeMs")
        SubElement(prop, f"{{{NS}}}Value").text = str(payload["cycleTimeMs"])

    if payload.get("assignedOperator"):
        person = SubElement(root, f"{{{NS}}}PersonnelActual")
        _id(person, payload["assignedOperator"])

    return tostring(root, encoding="utf-8", xml_declaration=True)


# Public dispatch — call this from the consumer to materialize a B2MML doc.
DISPATCH = {
    "NON_CONFORMANCE_RAISED": from_ncr,
    "WORK_ORDER_STARTED": from_wo_started,
    "WO_STARTED": from_wo_started,
    "OPERATION_COMPLETED": from_op_completed,
    "WORK_ORDER_COMPLETED": from_op_completed,
    "WO_COMPLETED": from_op_completed,
}


def build(event: dict) -> bytes | None:
    """Build a B2MML XML doc for the supported event types; None otherwise."""
    fn = DISPATCH.get(event.get("eventType", ""))
    if fn is None:
        return None
    try:
        return fn(event.get("payload", {}), event.get("eventId", ""))
    except Exception as e:  # noqa: BLE001 — never break the consumer on B2MML
        logger.warning("b2mml.build failed for %s: %s", event.get("eventType"), e)
        return None


# Optional S3 archiver — gated on env var so the consumer doesn't fail when the
# bucket/role isn't provisioned. Idempotent: same eventId always overwrites.
_s3 = None


def archive(event: dict, xml: bytes) -> None:
    bucket = os.environ.get("B2MML_ARCHIVE_BUCKET", "")
    if not bucket or not xml:
        return
    global _s3
    if _s3 is None:
        import boto3
        _s3 = boto3.client("s3")
    eid = event.get("eventId", "unknown")
    et = event.get("eventType", "unknown")
    key = f"b2mml-archive/{et}/{eid}.xml"
    try:
        _s3.put_object(Bucket=bucket, Key=key, Body=xml, ContentType="application/xml")
    except Exception as e:  # noqa: BLE001
        logger.warning("b2mml.archive failed (%s): %s", key, e)
