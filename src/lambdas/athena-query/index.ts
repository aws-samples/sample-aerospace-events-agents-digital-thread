/**
 * Athena query Lambda — 13 named queries + freeform SQL + schema discovery.
 * Called via API Gateway with Cognito auth or IAM SigV4.
 */

import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } from '@aws-sdk/client-athena';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const WORKGROUP = process.env.ATHENA_WORKGROUP || 'aerospace-dashboards';
const DATABASE = 'aerospace_events';
const TABLE = 'domain_events';
const FQ_TABLE = `${DATABASE}.${TABLE}`;
const athena = new AthenaClient({});
const bedrock = new BedrockRuntimeClient({});
// Sonnet inference profile — same one the agents/read_drawing tool use (access already granted).
const TEXT2SQL_MODEL = process.env.TEXT2SQL_MODEL || 'global.anthropic.claude-sonnet-4-6';

// --- Helpers ---

function safeInt(val: any, fallback: number, max: number): number {
  const n = parseInt(val);
  if (isNaN(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function escapeStr(s: string): string {
  return s.replace(/'/g, "''");
}

function entityFilter(entityId?: string): string {
  if (!entityId) return '';
  return `AND entity_id = '${escapeStr(entityId)}'`;
}

// --- Named Queries ---

const QUERIES: Record<string, (p: any) => string> = {
  ncrTrend: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date,
      JSON_EXTRACT_SCALAR(payload, '$.severity') AS severity,
      COUNT(*) AS cnt
    FROM ${FQ_TABLE}
    WHERE domain = 'QMS' AND event_type = 'NON_CONFORMANCE_RAISED'
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 7, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    GROUP BY 1, 2 ORDER BY 1
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  ncrBySupplier: (p) => `
    SELECT JSON_EXTRACT_SCALAR(payload, '$.supplierId') AS supplier_id,
      JSON_EXTRACT_SCALAR(payload, '$.defectCode') AS defect_code,
      JSON_EXTRACT_SCALAR(payload, '$.severity') AS severity,
      COUNT(*) AS cnt
    FROM ${FQ_TABLE}
    WHERE domain = 'QMS' AND event_type = 'NON_CONFORMANCE_RAISED'
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 7, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    GROUP BY 1, 2, 3 ORDER BY cnt DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  ncrByPart: (p) => `
    SELECT JSON_EXTRACT_SCALAR(payload, '$.partNumber') AS part_number,
      JSON_EXTRACT_SCALAR(payload, '$.severity') AS severity,
      COUNT(*) AS cnt
    FROM ${FQ_TABLE}
    WHERE domain = 'QMS' AND event_type = 'NON_CONFORMANCE_RAISED'
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 7, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    GROUP BY 1, 2 ORDER BY cnt DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  supplierPerformance: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date, event_type, entity_id AS supplier_id,
      payload
    FROM ${FQ_TABLE}
    WHERE domain = 'SRM'
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 30, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    ORDER BY occurred_at DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  workOrderTrend: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date, event_type, COUNT(*) AS cnt
    FROM ${FQ_TABLE}
    WHERE domain = 'MES'
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 7, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    GROUP BY 1, 2 ORDER BY 1
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  holdImpact: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date, event_type, entity_id, payload
    FROM ${FQ_TABLE}
    WHERE event_type IN ('HOLD_PLACED', 'KIT_SHORTAGE_DETECTED')
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 7, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    ORDER BY occurred_at DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  programEV: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date, entity_id, payload
    FROM ${FQ_TABLE}
    WHERE domain = 'PROGRAM' AND event_type = 'EV_UPDATED'
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 30, 90)}' DAY AS VARCHAR)
    ORDER BY occurred_at DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  milestoneHistory: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date, entity_id AS milestone, payload
    FROM ${FQ_TABLE}
    WHERE event_type = 'MILESTONE_AT_RISK'
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 30, 90)}' DAY AS VARCHAR)
    ORDER BY occurred_at DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  certEvents: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date, event_type, entity_id, domain, payload
    FROM ${FQ_TABLE}
    WHERE event_type IN ('CERT_LINKED', 'DRAWING_RELEASED', 'TEST_RECORDED')
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 30, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    ORDER BY occurred_at DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  machineEvents: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date, event_type, entity_id, payload
    FROM ${FQ_TABLE}
    WHERE event_type IN ('MACHINE_FAULT', 'PARAMETER_ANOMALY')
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 7, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    ORDER BY occurred_at DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  fleetAnomalies: (p) => `
    SELECT SUBSTR(occurred_at, 1, 10) AS date, event_type, entity_id, payload
    FROM ${FQ_TABLE}
    WHERE domain = 'INSERVICE'
      AND occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 30, 90)}' DAY AS VARCHAR)
      ${entityFilter(p.entityId)}
    ORDER BY occurred_at DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  domainEventCounts: (p) => `
    SELECT domain, event_type, COUNT(*) AS cnt
    FROM ${FQ_TABLE}
    WHERE occurred_at >= CAST(current_date - INTERVAL '${safeInt(p.days, 7, 90)}' DAY AS VARCHAR)
    GROUP BY 1, 2 ORDER BY cnt DESC
    LIMIT ${safeInt(p.limit, 100, 500)}`,

  recentEvents: (p) => `
    SELECT occurred_at, domain, event_type, entity_id, source_system, payload
    FROM ${FQ_TABLE}
    WHERE 1=1
      ${p.domain ? `AND domain = '${escapeStr(p.domain)}'` : ''}
      ${entityFilter(p.entityId)}
    ORDER BY occurred_at DESC
    LIMIT ${safeInt(p.limit, 20, 500)}`,
};

// --- Schema (static) ---

const SCHEMA = {
  table: FQ_TABLE,
  columns: [
    { name: 'event_id', type: 'string', description: 'Unique event identifier (UUID)' },
    { name: 'event_type', type: 'string', description: 'e.g. NON_CONFORMANCE_RAISED, WORK_ORDER_STARTED' },
    { name: 'event_version', type: 'string', description: 'Schema version (1.0)' },
    { name: 'domain', type: 'string', description: 'Source domain: QMS, MES, PLM, ERP, SRM, WMS, DHR, PROGRAM, INSERVICE' },
    { name: 'source_system', type: 'string', description: 'Source system name (e.g. qms-demo)' },
    { name: 'occurred_at', type: 'string', description: 'ISO 8601 timestamp' },
    { name: 'correlation_id', type: 'string', description: 'Correlation chain ID' },
    { name: 'entity_id', type: 'string', description: 'Primary entity (e.g. NCR-1234, WO-5678, SN-0047)' },
    { name: 'entity_type', type: 'string', description: 'Entity type (NonConformance, WorkOrder, Part, etc.)' },
    { name: 'payload', type: 'string', description: "JSON string with event-specific data. Use JSON_EXTRACT_SCALAR(payload, '$.field')" },
    { name: 'diff', type: 'string', description: 'JSON diff (nullable)' },
    { name: 'actor_user_id', type: 'string', description: 'User or system that caused the event' },
    { name: 'actor_system', type: 'string', description: 'Source system identifier' },
    { name: 'schema_version', type: 'string', description: 'Event schema version' },
  ],
  availableQueries: Object.keys(QUERIES),
  tips: [
    "All columns are strings. Cast numerics from payload with CAST(JSON_EXTRACT_SCALAR(payload, '$.field') AS DOUBLE)",
    "Date filtering: occurred_at >= CAST(current_date - INTERVAL '7' DAY AS VARCHAR)",
    'Payload fields vary by event_type. Common: severity, partNumber, supplierId, status',
  ],
};

// --- Query execution ---

async function executeQuery(sql: string, timeoutMs: number = 60000): Promise<{ rows: any[]; executionMs: number }> {
  const start = Date.now();
  const maxPolls = Math.floor(timeoutMs / 500);

  const { QueryExecutionId } = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    WorkGroup: WORKGROUP,
    QueryExecutionContext: { Database: DATABASE },
  }));

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }));
    const state = QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Query ${state}: ${QueryExecution?.Status?.StateChangeReason}`);
    }
  }

  const { ResultSet } = await athena.send(new GetQueryResultsCommand({ QueryExecutionId }));
  const rows = ResultSet?.Rows ?? [];
  const header = rows[0]?.Data?.map((d: any) => d.VarCharValue) ?? [];
  const data = rows.slice(1).map((row: any) => {
    const obj: Record<string, any> = {};
    row.Data?.forEach((d: any, i: number) => { obj[header[i]] = d.VarCharValue; });
    return obj;
  });

  return { rows: data, executionMs: Date.now() - start };
}

// --- Freeform SQL guardrails ---

function validateFreeformSql(sql: string): string | null {
  // Strip comments first so a table name inside /* */ or -- cannot satisfy the checks below.
  const trimmed = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  // Allow a plain SELECT or a CTE (WITH … SELECT) — both are read-only.
  if (!/^(SELECT|WITH)\s/i.test(trimmed)) return 'Only SELECT queries are allowed';
  if (!/aerospace_events\.domain_events/i.test(trimmed)) return 'Query must reference aerospace_events.domain_events';
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|MERGE)\b/i;
  if (forbidden.test(trimmed)) return 'Only SELECT queries are allowed';
  return null;
}

function ensureLimit(sql: string): string {
  if (/\bLIMIT\s+\d+/i.test(sql)) return sql;
  return sql.replace(/;?\s*$/, ' LIMIT 100');
}

// --- Text-to-SQL (NL → Athena SQL via Bedrock) ---
// System prompt is the spike's V3 deliverable: schema + samples + payload field catalog
// is what drives generation from ~80% to 100% valid SQL (model-independent). See
// spikes/text2sql/FINDINGS.md.
const TEXT2SQL_SYSTEM = `You convert a natural-language question into exactly ONE valid Amazon Athena SQL SELECT statement.
Athena uses the Trino/Presto SQL dialect. Output ONLY the SQL inside a \`\`\`sql code block — no prose.

Table: aerospace_events.domain_events  (every column is type STRING/VARCHAR)
Columns: event_id, event_type, event_version, domain, source_system,
  occurred_at (ISO8601 timestamp stored AS A STRING, e.g. '2026-05-22T00:39:30.000Z'),
  correlation_id, entity_id, entity_type, payload (a JSON document stored as a STRING),
  diff, actor_user_id, actor_system, schema_version
domain values: QMS, MES, PLM, ERP, SRM, WMS, DHR, PROGRAM, INSERVICE
event_type values include: NON_CONFORMANCE_RAISED, WORK_ORDER_STARTED, WORK_ORDER_COMPLETED,
  HOLD_PLACED, INVOICE_MATCHED, PO_CONFIRMED, EV_UPDATED, DT_ANOMALY, DT_NORMAL,
  SUPPLIER_SCORE_UPDATED, PART_RELEASED.

RULES:
1. Query only aerospace_events.domain_events. Emit a SINGLE SELECT (or WITH … SELECT). Never DDL/DML/multiple statements.
2. Read a payload field with JSON_EXTRACT_SCALAR(payload, '$.fieldName'). Do NOT invent top-level columns for payload fields.
3. All columns are strings. For numeric compare/aggregate/order on a payload number: CAST(JSON_EXTRACT_SCALAR(payload,'$.x') AS DOUBLE).
4. occurred_at is an ISO8601 STRING. Filter by string comparison:
   last N days:  occurred_at >= CAST(current_date - INTERVAL 'N' DAY AS VARCHAR)
   this month:   occurred_at >= CAST(date_trunc('month', current_date) AS VARCHAR)
   Do NOT call date functions directly on occurred_at.
5. Scope with event_type/domain (NCRs => event_type='NON_CONFORMANCE_RAISED'; earned value => event_type='EV_UPDATED'; fleet anomalies => event_type='DT_ANOMALY').
6. Trino string funcs only; single-quote string literals. Alias aggregates; add a sensible LIMIT for "top N".

PAYLOAD FIELD CATALOG (extract via JSON_EXTRACT_SCALAR):
  NON_CONFORMANCE_RAISED: severity (MINOR|MAJOR|CRITICAL), defectCode, partNumber, supplierId, supplierName, status, serialNumber, lotNumber, ncrId
  EV_UPDATED: period ('YYYY-MM'), cpi (number), spi (number), programId
  DT_ANOMALY/DT_NORMAL: serialNumber, parameter, actualValue (number), expectedValue (number), deviation (number), unit, flightHours (number), status
  INVOICE_MATCHED: supplierId, supplierName, invoiceAmount (number), currency, matchType, partNumber, invoiceId, status
  WORK_ORDER_STARTED/WORK_ORDER_COMPLETED: workOrderId, partNumber, serialNumber, operationName, operationNumber, cell, assignedOperator, status
  SUPPLIER_SCORE_UPDATED: supplierId, supplierName, period, overallScore, qualityScore, otdPercent, qualificationStatus (score fields are numeric values stored as quoted strings — still CAST(... AS DOUBLE)).
GUIDANCE:
7. "daily trend" => substr(occurred_at,1,10) AS day … ORDER BY day.
8. "critical" NCR => severity='CRITICAL'; "critical or major" => IN ('CRITICAL','MAJOR').
9. "most recent period" => filter to max(period) or ORDER BY period DESC.`;

// Payload fields the catalog knows about — a generated SQL referencing a '$.field' NOT
// in this set is a likely hallucination (the spike's silent failure mode). Reject it.
const KNOWN_PAYLOAD_FIELDS = new Set([
  'severity', 'defectCode', 'partNumber', 'supplierId', 'supplierName', 'status', 'serialNumber',
  'lotNumber', 'ncrId', 'period', 'cpi', 'spi', 'programId', 'parameter', 'actualValue',
  'expectedValue', 'deviation', 'unit', 'flightHours', 'invoiceAmount', 'currency', 'matchType',
  'invoiceId', 'workOrderId', 'operationName', 'operationNumber', 'cell', 'assignedOperator',
  'overallScore', 'qualityScore', 'otdPercent', 'qualificationStatus',
]);

function hallucinatedFields(sql: string): string[] {
  const bad: string[] = [];
  const re = /\$\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    if (!KNOWN_PAYLOAD_FIELDS.has(m[1])) bad.push(m[1]);
  }
  return [...new Set(bad)];
}

function extractSql(modelText: string): string {
  // model returns ```sql … ``` (or occasionally a bare statement)
  const fenced = /```(?:sql)?\s*([\s\S]*?)```/i.exec(modelText);
  return (fenced ? fenced[1] : modelText).trim().replace(/;\s*$/, '');
}

async function generateSql(question: string): Promise<string> {
  const resp = await bedrock.send(new InvokeModelCommand({
    modelId: TEXT2SQL_MODEL,
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,          // Sonnet-5 tokenizer + adaptive thinking share the budget
      messages: [{ role: 'user', content: [{ type: 'text', text: `${TEXT2SQL_SYSTEM}\n\nQuestion: ${question}` }] }],
    }),
  }));
  const parsed = JSON.parse(new TextDecoder().decode(resp.body));
  // adaptive thinking may prepend a thinking block — take the last text block
  const textBlocks = (parsed.content ?? []).filter((c: any) => c.type === 'text');
  const text = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '';
  return extractSql(text);
}

// --- Handler ---

// CORS: echo the request Origin only when it is on the ALLOWED_ORIGINS allowlist.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
function corsHeaders(event: any): Record<string, string> {
  const origin = event?.headers?.origin ?? event?.headers?.Origin;
  return origin && ALLOWED_ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type,Authorization', Vary: 'Origin' }
    : {};
}

export const handler = async (event: any): Promise<any> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { query, parameters = {} } = body;

    // Schema discovery
    if (query === 'getSchema') {
      return { statusCode: 200, headers, body: JSON.stringify(SCHEMA) };
    }

    // Freeform SQL
    if (query === 'freeformSql') {
      const sql = parameters.sql;
      if (!sql) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing sql parameter' }) };
      const err = validateFreeformSql(sql);
      if (err) return { statusCode: 400, headers, body: JSON.stringify({ error: err }) };
      const safeSql = ensureLimit(sql);
      const { rows, executionMs } = await executeQuery(safeSql, 60000);
      return { statusCode: 200, headers, body: JSON.stringify({ data: rows, executionMs, sql: safeSql }) };
    }

    // Text-to-SQL: NL question → Bedrock-generated SQL → SAME guardrails as freeform → execute.
    // The generated SQL is ALWAYS returned (even on rejection) so the UI can show it.
    if (query === 'text2sql') {
      const question = (parameters.question || '').trim();
      if (!question) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing question parameter' }) };

      let generatedSql: string;
      try {
        generatedSql = await generateSql(question);
      } catch (e: any) {
        const denied = /AccessDenied|not authorized|Throttl/i.test(e.message || '');
        return { statusCode: denied ? 503 : 500, headers,
          body: JSON.stringify({ question, error: denied ? 'The query assistant is unavailable right now — try a named panel.' : 'Generation failed' }) };
      }

      // Guardrail chain — the model is an untrusted author.
      if (/;\s*\S/.test(generatedSql))  // a second statement after a semicolon
        return { statusCode: 400, headers, body: JSON.stringify({ question, generatedSql, error: 'Only a single statement is allowed.' }) };
      const vErr = validateFreeformSql(generatedSql);
      if (vErr) return { statusCode: 400, headers, body: JSON.stringify({ question, generatedSql, error: vErr }) };
      const bad = hallucinatedFields(generatedSql);
      if (bad.length) return { statusCode: 400, headers, body: JSON.stringify({ question, generatedSql, error: `Generated query references unknown payload field(s): ${bad.join(', ')}. Try rephrasing.` }) };

      const safeSql = ensureLimit(generatedSql);
      const { rows, executionMs } = await executeQuery(safeSql, 55000);
      return { statusCode: 200, headers, body: JSON.stringify({ question, generatedSql: safeSql, data: rows, executionMs }) };
    }

    // Named query
    const queryFn = QUERIES[query];
    if (!queryFn) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown query: ${query}`, available: Object.keys(QUERIES) }) };
    }

    const sql = queryFn(parameters);
    const { rows, executionMs } = await executeQuery(sql);
    return { statusCode: 200, headers, body: JSON.stringify({ data: rows, executionMs }) };
  } catch (err: any) {
    console.error('Query error:', err);
    console.error('athena-query error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
