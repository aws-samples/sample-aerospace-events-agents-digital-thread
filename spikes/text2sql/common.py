"""Shared helpers for the text-to-SQL spike: Bedrock invoke + Athena run.

THROWAWAY SPIKE CODE — not production. See FINDINGS.md.
"""
import json
import os
import re
import time

import boto3

REGION = "eu-west-1"
# Override with T2SQL_MODEL env var. Default is the spike's baseline model.
MODEL_ID = os.environ.get("T2SQL_MODEL", "global.anthropic.claude-sonnet-4-6")
MAX_TOKENS = int(os.environ.get("T2SQL_MAX_TOKENS", "2048"))
WORKGROUP = "aerospace-dashboards"
DATABASE = "aerospace_events"
TABLE = "domain_events"

_bedrock = boto3.client("bedrock-runtime", region_name=REGION)
_athena = boto3.client("athena", region_name=REGION)


def _is_sonnet5(model_id: str) -> bool:
    return "sonnet-5" in model_id


def ask_bedrock(system_prompt: str, question: str, model_id: str = None) -> str:
    """Return the text Claude produced for one NL question.

    Sonnet 5 rejects non-default temperature/top_p/top_k (400) and runs adaptive
    thinking by default, so the response can contain a `thinking` block before the
    `text` block. We omit temperature for Sonnet 5 and always pick the text block.
    """
    model_id = model_id or MODEL_ID
    payload = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "messages": [{"role": "user", "content": question}],
    }
    if not _is_sonnet5(model_id):
        payload["temperature"] = 0  # deterministic-ish for older models
    resp = _bedrock.invoke_model(modelId=model_id, body=json.dumps(payload))
    body = json.loads(resp["body"].read())
    # Pick the first text block (skip any thinking blocks from adaptive thinking).
    texts = [c["text"] for c in body.get("content", []) if c.get("type") == "text"]
    return texts[0] if texts else ""


_SQL_FENCE = re.compile(r"```(?:sql)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_sql(text: str) -> str:
    """Pull a single SQL statement out of the model output.

    Handles ```sql fences, bare SELECT, and trailing prose. Strips a trailing ';'.
    """
    m = _SQL_FENCE.search(text)
    sql = m.group(1) if m else text
    # If still prose-y, grab from first SELECT/WITH to end.
    m2 = re.search(r"\b(WITH|SELECT)\b", sql, re.IGNORECASE)
    if m2:
        sql = sql[m2.start():]
    return sql.strip().rstrip(";").strip()


# Real payload JSON fields observed in the live table, per inspection.
# Used to catch HALLUCINATED field names — the failure that "valid+non-empty" hides.
KNOWN_PAYLOAD_FIELDS = {
    # NON_CONFORMANCE_RAISED
    "severity", "supplierName", "supplierId", "serialNumber", "ncrId", "lotNumber",
    "defectCode", "partNumber", "status", "raisedBy", "createdAt", "updatedAt",
    "lastModifiedBy", "PK", "SK",
    # EV_UPDATED
    "period", "cpi", "spi", "programId",
    # DT_ANOMALY / DT_NORMAL
    "parameter", "actualValue", "expectedValue", "deviation", "unit", "flightHours",
    # INVOICE_MATCHED
    "matchType", "invoiceAmount", "taxCode", "currency", "invoiceId", "materialDefinitionId",
    # WORK_ORDER_STARTED/COMPLETED
    "operationName", "cell", "operationNumber", "workOrderId", "assignedOperator",
    # SUPPLIER_SCORE_UPDATED
    "otdPercent", "overallScore", "qualityScore", "qualificationStatus",
}

_PATH_RE = re.compile(r"\$\.([A-Za-z_][A-Za-z0-9_]*)")


def hallucinated_fields(sql: str):
    """Return payload JSON paths referenced in the SQL that don't exist in the table."""
    refs = set(_PATH_RE.findall(sql))
    return sorted(refs - KNOWN_PAYLOAD_FIELDS)


def null_key_result(sample):
    """True if an aggregate returned only NULL group keys (hallucinated-dimension signal).

    sample[0] is the header; data rows follow. Flags when the first column of every
    data row is NULL/empty — the classic 'GROUP BY a field that doesn't exist' symptom.
    """
    data = sample[1:] if sample else []
    if not data:
        return False
    return all((row[0] is None or row[0] == "") for row in data)


def run_athena(sql: str, timeout_s: int = 60):
    """Execute SQL. Returns dict: valid, rows, latency_s, error, rowcount, sample."""
    t0 = time.time()
    try:
        q = _athena.start_query_execution(
            QueryString=sql,
            QueryExecutionContext={"Database": DATABASE},
            WorkGroup=WORKGROUP,
        )
    except Exception as e:  # malformed request never even starts
        return {"valid": False, "rowcount": 0, "latency_s": round(time.time() - t0, 2),
                "error": f"start_query_execution: {e}", "sample": []}
    qid = q["QueryExecutionId"]
    state, reason = "RUNNING", ""
    while time.time() - t0 < timeout_s:
        r = _athena.get_query_execution(QueryExecutionId=qid)
        state = r["QueryExecution"]["Status"]["State"]
        if state in ("SUCCEEDED", "FAILED", "CANCELLED"):
            reason = r["QueryExecution"]["Status"].get("StateChangeReason", "")
            break
        time.sleep(0.8)  # nosemgrep: arbitrary-sleep -- throwaway spike
    latency = round(time.time() - t0, 2)
    if state != "SUCCEEDED":
        return {"valid": False, "rowcount": 0, "latency_s": latency,
                "error": reason or f"state={state}", "sample": []}
    res = _athena.get_query_results(QueryExecutionId=qid, MaxResults=11)
    rows = [[c.get("VarCharValue") for c in row["Data"]] for row in res["ResultSet"]["Rows"]]
    data_rows = rows[1:] if rows else []  # drop header
    return {"valid": True, "rowcount": len(data_rows), "latency_s": latency,
            "error": None, "sample": rows[:6]}
