/**
 * HITL + Demo Control Lambda — HITL questions + demo-control table operations.
 */

import { DynamoDBClient, ScanCommand, UpdateItemCommand, PutItemCommand, GetItemCommand, BatchWriteItemCommand, QueryCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall, marshall } from '@aws-sdk/util-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { ECSClient, UpdateServiceCommand, ListServicesCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand } from '@aws-sdk/client-athena';
import { randomUUID } from 'crypto';

const HITL_TABLE = process.env.HITL_TABLE || 'hitl-questions';
const CONTROL_TABLE = 'demo-control';
const client = new DynamoDBClient({});

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
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? event);
    const { operation, parameters = {} } = body;

    // --- HITL Operations ---

    if (operation === 'list') {
      const result = await client.send(new ScanCommand({
        TableName: HITL_TABLE,
        FilterExpression: '#s = :status',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: marshall({ ':status': parameters.status ?? 'PENDING' }),
      }));

      const items = (result.Items ?? []).map(unmarshall).map((item) => ({
        taskId: item.taskId,
        agentName: item.agentName,
        domainId: item.domainId,
        question: item.question,
        options: (item.options ?? []).map((o: any) => typeof o === 'string' ? o : o.S ?? o),
        evidence: item.evidence,
        priority: item.priority,
        status: item.status,
        createdAt: item.createdAt,
      }));

      return { statusCode: 200, headers, body: JSON.stringify({ items }) };
    }

    if (operation === 'answer') {
      const { taskId, answer } = parameters;
      await client.send(new UpdateItemCommand({
        TableName: HITL_TABLE,
        Key: marshall({ PK: `HITL#${taskId}`, SK: 'QUESTION' }),
        UpdateExpression: 'SET #s = :status, answer = :answer, answeredAt = :now',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: marshall({ ':status': 'ANSWERED', ':answer': answer, ':now': Math.floor(Date.now() / 1000) }),
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ taskId, status: 'ANSWERED' }) };
    }

    // --- Demo Control Operations ---

    if (operation === 'read-control') {
      const result = await client.send(new GetItemCommand({
        TableName: CONTROL_TABLE,
        Key: marshall({ PK: 'DEMO_CLOCK', SK: 'STATE' }),
      }));
      const item = result.Item ? unmarshall(result.Item) : {};
      return { statusCode: 200, headers, body: JSON.stringify({ item }) };
    }

    if (operation === 'clear-scenario-lock') {
      await client.send(new DeleteItemCommand({
        TableName: CONTROL_TABLE,
        Key: marshall({ PK: 'DEMO_CLOCK', SK: 'SCENARIO_LOCK' }),
      }));
      await client.send(new DeleteItemCommand({
        TableName: CONTROL_TABLE,
        Key: marshall({ PK: 'DEMO_CLOCK', SK: 'SEED_STATUS' }),
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ cleared: true }) };
    }

    if (operation === 'read-seed-status') {
      const result = await client.send(new GetItemCommand({
        TableName: CONTROL_TABLE,
        Key: marshall({ PK: 'DEMO_CLOCK', SK: 'SEED_STATUS' }),
      }));
      const item = result.Item ? unmarshall(result.Item) : null;
      return { statusCode: 200, headers, body: JSON.stringify({ item }) };
    }

    if (operation === 'write-control') {
      const { key, value } = parameters;
      await client.send(new PutItemCommand({
        TableName: CONTROL_TABLE,
        Item: marshall({ PK: key || 'DEMO_CLOCK', SK: 'STATE', ...value }),
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ written: true }) };
    }

    // --- Agent Trace ---

    if (operation === 'query-trace') {
      const correlationId = parameters.correlationId;
      if (!correlationId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'correlationId required' }) };

      const result = await client.send(new QueryCommand({
        TableName: 'agent-trace',
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': { S: `TRACE#${correlationId}` } },
        ScanIndexForward: true,
      }));

      const items = (result.Items ?? []).map((i: any) => unmarshall(i));
      return { statusCode: 200, headers, body: JSON.stringify({ correlationId, items, count: items.length }) };
    }

    // --- Agent Observability: list ALL runs (one per correlationId) with derived status ---
    if (operation === 'list-runs') {
      // Scan the trace table, group rows by correlationId, summarize each run.
      const rows: any[] = [];
      let ExclusiveStartKey: any;
      do {
        const scan: any = await client.send(new ScanCommand({
          TableName: 'agent-trace', ExclusiveStartKey,
        }));
        for (const it of scan.Items ?? []) rows.push(unmarshall(it));
        ExclusiveStartKey = scan.LastEvaluatedKey;
      } while (ExclusiveStartKey && rows.length < 20000);

      const byRun = new Map<string, any[]>();
      for (const r of rows) {
        const cid = r.correlationId || (r.PK || '').replace('TRACE#', '');
        if (!cid) continue;
        if (!byRun.has(cid)) byRun.set(cid, []);
        byRun.get(cid)!.push(r);
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const runs = [...byRun.entries()].map(([correlationId, recs]) => {
        recs.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
        const first = recs[0];
        const last = recs[recs.length - 1];
        const actions = recs.map((r) => r.action);
        const agents = [...new Set(recs.map((r) => r.agentName || r.agentId).filter(Boolean))];
        const escalated = recs.some((r) => {
          try { return JSON.parse(r.detail || '{}').action === 'ESCALATE'; } catch { return false; }
        });
        // source entity: from the first invoked record's detail/sourceEventId
        let sourceEntity = first.entityId || first.sourceEventId || '';
        for (const r of recs) {
          try { const d = JSON.parse(r.detail || '{}'); if (d.entityId || d.serialNumber || d.partNumber) { sourceEntity = d.entityId || d.serialNumber || d.partNumber; break; } } catch { /* ignore */ }
        }
        // derive status from the action stream
        const startMs = Date.parse(first.timestamp);
        const endMs = Date.parse(last.timestamp);
        const ageSec = nowSec - Math.floor(endMs / 1000);
        let status: string;
        if (actions.includes('stop_session')) status = 'completed';
        else if (last.action === 'ask_human') status = 'awaiting_human';
        else if (ageSec < 600) status = 'in_flight';
        else status = 'stalled';

        return {
          correlationId,
          entryAgent: first.agentName || first.agentId || 'unknown',
          agentCount: agents.length,
          actionCount: recs.length,
          escalated,
          sourceEntity,
          sourceEventType: first.sourceEventType || '',
          startedAt: first.timestamp,
          durationMs: isNaN(startMs) || isNaN(endMs) ? null : Math.max(0, endMs - startMs),
          status,
        };
      });

      runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      const limited = runs.slice(0, 300);
      const counts = runs.reduce((acc: any, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
      return { statusCode: 200, headers, body: JSON.stringify({ runs: limited, total: runs.length, counts }) };
    }

    // --- Graph DLQ ---

    if (operation === 'dlq-status') {
      try {
        const scan = await client.send(new ScanCommand({
          TableName: 'graph-write-dlq',
          Select: 'ALL_ATTRIBUTES',
          Limit: 50,
        }));
        const items = (scan.Items ?? []).map((i) => {
          const u = unmarshall(i);
          return { pk: u.PK, sk: u.SK, nodeId: u.nodeId, error: (u.error || '').slice(0, 120), failedAt: u.failedAt };
        });
        items.sort((a: any, b: any) => (b.failedAt || 0) - (a.failedAt || 0));
        return { statusCode: 200, headers, body: JSON.stringify({ count: scan.Count ?? 0, scannedCount: scan.ScannedCount ?? 0, items }) };
      } catch (e: any) {
        return { statusCode: 200, headers, body: JSON.stringify({ count: 0, items: [], error: e.name }) };
      }
    }

    if (operation === 'dlq-replay') {
      const results: string[] = [];
      let replayed = 0, failed = 0;
      try {
        const scan = await client.send(new ScanCommand({ TableName: 'graph-write-dlq' }));
        const items = (scan.Items ?? []).map((i) => unmarshall(i));
        results.push(`${items.length} DLQ entries found`);

        const lambdaClient = new LambdaClient({});
        for (const item of items) {
          const gremlin = item.gremlin;
          if (!gremlin) { results.push(`SKIP ${item.SK} — no gremlin`); failed++; continue; }

          const resp = await lambdaClient.send(new InvokeCommand({
            FunctionName: process.env.NEPTUNE_QUERY_FN || 'aerospace-neptune-query',
            Payload: Buffer.from(JSON.stringify({
              body: JSON.stringify({ operation: 'execute_gremlin', parameters: { gremlin } }),
            })),
          }));
          const body = JSON.parse(new TextDecoder().decode(resp.Payload));
          const status = body.statusCode || 500;

          if (status === 200) {
            await client.send(new BatchWriteItemCommand({
              RequestItems: { 'graph-write-dlq': [{ DeleteRequest: { Key: { PK: marshall(item.PK), SK: marshall(item.SK) } } }] },
            }));
            replayed++;
          } else {
            const err = JSON.parse(body.body || '{}').error || `HTTP ${status}`;
            results.push(`FAIL ${item.nodeId}: ${err.slice(0, 80)}`);
            failed++;
          }
        }
        results.push(`Replayed: ${replayed}, Failed: ${failed}`);
      } catch (e: any) {
        results.push(`Error: ${e.name}`);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ replayed, failed, results }) };
    }

    // --- Seed Baseline ---

    if (operation === 'seed-baseline') {
      try {
        const lambdaClient = new LambdaClient({});
        await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.SEED_FN || 'aerospace-seed-baseline',
          InvocationType: 'Event', // async — returns immediately
          Payload: Buffer.from('{}'),
        }));
        return { statusCode: 200, headers, body: JSON.stringify({ seeding: true, message: 'Seed Lambda invoked. Data flows through pipeline in ~2 min.' }) };
      } catch (e: any) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Seed failed: ${e.name}` }) };
      }
    }

    // --- Generator Controls ---

    if (operation === 'generator-status') {
      try {
        const ecs = new ECSClient({});
        const cluster = process.env.GENERATOR_CLUSTER || 'aerospace-demo-generator';
        const svcs = await ecs.send(new ListServicesCommand({ cluster }));
        const svcArn = svcs.serviceArns?.[0];
        if (!svcArn) return { statusCode: 200, headers, body: JSON.stringify({ status: 'NOT_FOUND' }) };
        const desc = await ecs.send(new DescribeServicesCommand({ cluster, services: [svcArn] }));
        const svc = desc.services?.[0];
        return { statusCode: 200, headers, body: JSON.stringify({
          status: (svc?.desiredCount ?? 0) > 0 ? 'RUNNING' : 'STOPPED',
          desiredCount: svc?.desiredCount ?? 0,
          runningCount: svc?.runningCount ?? 0,
        }) };
      } catch (e: any) {
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'UNKNOWN', error: e.name }) };
      }
    }

    if (operation === 'start-generators') {
      const ecs = new ECSClient({});
      const cluster = process.env.GENERATOR_CLUSTER || 'aerospace-demo-generator';
      const svcs = await ecs.send(new ListServicesCommand({ cluster }));
      const svcArn = svcs.serviceArns?.[0];
      if (svcArn) {
        await ecs.send(new UpdateServiceCommand({ cluster, service: svcArn, desiredCount: 1 }));
        return { statusCode: 200, headers, body: JSON.stringify({ started: true }) };
      }
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No generator service found' }) };
    }

    if (operation === 'stop-generators') {
      const ecs = new ECSClient({});
      const cluster = process.env.GENERATOR_CLUSTER || 'aerospace-demo-generator';
      const svcs = await ecs.send(new ListServicesCommand({ cluster }));
      const svcArn = svcs.serviceArns?.[0];
      if (svcArn) {
        await ecs.send(new UpdateServiceCommand({ cluster, service: svcArn, desiredCount: 0 }));
        return { statusCode: 200, headers, body: JSON.stringify({ stopped: true }) };
      }
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No generator service found' }) };
    }

    // --- Drama Injections ---

    if (operation === 'inject-drama') {
      const { scenario } = parameters;
      const now = new Date().toISOString();
      const qmsClient = new DynamoDBClient({});

      if (scenario === 'ncr-cluster') {
        // Inject 3 CRITICAL NCRs from titan-forge on flight-critical part
        for (let i = 0; i < 3; i++) {
          const ncrId = `NCR-DRAMA-${Date.now()}-${i}`;
          await qmsClient.send(new PutItemCommand({
            TableName: 'qms-demo',
            Item: marshall({
              PK: `NCR#${ncrId}`, SK: 'METADATA',
              ncrId, partNumber: '44821-003', serialNumber: 'SN-0047',
              defectCode: 'BORE_DIAMETER_OOT', severity: 'CRITICAL',
              supplierId: 'titan-forge', supplierName: 'Titan Forge',
              lotNumber: 'LOT-7731', status: 'OPEN',
              workOrderId: `WO-${80000 + i}`, operationNumber: 'Op-50',
              raisedBy: 'drama-injection', correlationId: randomUUID(),
              createdAt: now, updatedAt: now,
            }),
          }));
        }
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: 3 }) };
      }

      if (scenario === 'bearing-wear') {
        // Inject escalating vibration readings to scada-demo
        const readings = [1.2, 2.1, 2.8];
        for (const value of readings) {
          await qmsClient.send(new PutItemCommand({
            TableName: 'qms-demo',
            Item: marshall({
              PK: `NCR#NCR-BEARING-${Date.now()}`, SK: 'METADATA',
              ncrId: `NCR-BEARING-${Date.now()}`,
              partNumber: 'cnc-mill-3-spindle', serialNumber: 'SN-0047',
              defectCode: 'PARAMETER_ANOMALY', severity: value > 2.0 ? 'CRITICAL' : 'MAJOR',
              supplierId: 'internal', supplierName: 'Shop Floor',
              status: 'OPEN', raisedBy: 'drama-injection',
              correlationId: randomUUID(), createdAt: now, updatedAt: now,
            }),
          }));
          await new Promise((r) => setTimeout(r, 500));
        }
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: readings.length }) };
      }

      if (scenario === 'fleet-anomaly') {
        // Inject correlated fleet anomalies
        for (const sn of ['SN-0038', 'SN-0041']) {
          await qmsClient.send(new PutItemCommand({
            TableName: 'inservice-demo',
            Item: marshall({
              PK: `DT#${sn}`, SK: `READING#${Date.now()}#hydraulic_pressure_psi`,
              serialNumber: sn, parameter: 'hydraulic_pressure_psi',
              expectedValue: 3000, actualValue: 3450, deviation: 150,
              unit: 'psi', status: 'ANOMALY', flightHours: sn === 'SN-0038' ? 6500 : 4200,
              createdAt: now, updatedAt: now, lastModifiedBy: 'drama-injection',
            }),
          }));
        }
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: 2 }) };
      }

      if (scenario === 'supplier-otd-drop') {
        // Titan Forge OTD crashes — triggers Supplier Risk Sentinel
        await qmsClient.send(new PutItemCommand({
          TableName: 'srm-demo',
          Item: marshall({
            PK: 'SUPPLIER#titan-forge', SK: `SCORE#${now.slice(0, 7)}#DRAMA`,
            supplierId: 'titan-forge', supplierName: 'Titan Forge',
            otdPercent: '55.0', qualityScore: '68.0', overallScore: '61.5',
            qualificationStatus: 'CONDITIONAL', period: now.slice(0, 7),
            createdAt: now, updatedAt: now, lastModifiedBy: 'drama-injection',
          }),
        }));
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: 1 }) };
      }

      if (scenario === 'kit-shortage-cascade') {
        // Multiple kit shortages blocking active WOs
        for (let i = 0; i < 3; i++) {
          await qmsClient.send(new PutItemCommand({
            TableName: 'wms-demo',
            Item: marshall({
              PK: `KIT#KIT-DRAMA-${Date.now()}-${i}`, SK: 'METADATA',
              kitId: `KIT-DRAMA-${Date.now()}-${i}`,
              workOrderId: `WO-${80000 + i}`, partNumber: '44821-003',
              status: 'SHORT', shortage: true, requiredQty: 10, stagedQty: 3,
              locationId: 'STAGE-A1', lotNumber: 'LOT-7731',
              createdAt: now, updatedAt: now, lastModifiedBy: 'drama-injection',
            }),
          }));
        }
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: 3 }) };
      }

      if (scenario === 'cert-gap-critical') {
        // NDT test failure on flight-critical part
        await qmsClient.send(new PutItemCommand({
          TableName: 'dhr-demo',
          Item: marshall({
            PK: 'SN#SN-0047', SK: `TEST#TEST-DRAMA-${Date.now()}`,
            serialNumber: 'SN-0047', testId: `TEST-DRAMA-${Date.now()}`,
            testType: 'NDT_UT', result: 'FAIL',
            recordedBy: 'drama-injection',
            createdAt: now, updatedAt: now, lastModifiedBy: 'drama-injection',
          }),
        }));
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: 1 }) };
      }

      if (scenario === 'milestone-at-risk') {
        // FAI-Complete milestone drops to critical confidence
        await qmsClient.send(new PutItemCommand({
          TableName: 'program-demo',
          Item: marshall({
            PK: 'PROGRAM#ARES-1', SK: `MILESTONE#FAI-Complete#${Date.now()}`,
            programId: 'ARES-1', milestoneId: 'FAI-Complete',
            milestoneName: 'FAI Complete', confidence: 45, status: 'AT_RISK',
            createdAt: now, updatedAt: now, lastModifiedBy: 'drama-injection',
          }),
        }));
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: 1 }) };
      }

      if (scenario === 'single-ncr') {
        // 1 MAJOR NCR from unknown supplier — agent1 only, clean linear flow
        const ncrId = `NCR-SINGLE-${Date.now()}`;
        await qmsClient.send(new PutItemCommand({
          TableName: 'qms-demo',
          Item: marshall({
            PK: `NCR#${ncrId}`, SK: 'METADATA',
            ncrId, partNumber: '44821-012', serialNumber: 'SN-0047',
            defectCode: 'POSITION_OOT', severity: 'MAJOR',
            supplierId: 'precision-aero-gmbh', supplierName: 'Precision Aero GmbH',
            lotNumber: 'LOT-9001', status: 'OPEN',
            workOrderId: 'WO-70050', operationNumber: 'Op-50',
            raisedBy: 'drama-injection', correlationId: randomUUID(),
            createdAt: now, updatedAt: now,
          }),
        }));
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: 1 }) };
      }

      if (scenario === 'simple-supplier-event') {
        // Single supplier score update — triggers agent4 only, no cascade
        await qmsClient.send(new PutItemCommand({
          TableName: 'srm-demo',
          Item: marshall({
            PK: 'SUPPLIER#precision-aero-gmbh', SK: `SCORE#${now.slice(0, 7)}#DRAMA-${Date.now()}`,
            supplierId: 'precision-aero-gmbh', supplierName: 'Precision Aero GmbH',
            otdPercent: '78.5', qualityScore: '82.0', overallScore: '80.3',
            qualificationStatus: 'QUALIFIED', period: now.slice(0, 7),
            createdAt: now, updatedAt: now, lastModifiedBy: 'drama-injection',
          }),
        }));
        return { statusCode: 200, headers, body: JSON.stringify({ injected: scenario, count: 1 }) };
      }

      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown scenario: ${scenario}` }) };
    }

    // --- Reset Demo ---

    if (operation === 'reset-demo') {
      const results: string[] = [];
      const TABLES = [
        'qms-demo', 'mes-demo', 'plm-demo', 'erp-demo', 'srm-demo',
        'wms-demo', 'dhr-demo', 'program-demo', 'inservice-demo',
        'hitl-questions', 'digital-thread-offsets', 'graph-write-dlq', 'agent-trace', 'demo-control',
      ];

      // 1. Pause generator (desired=0)
      try {
        const ecs = new ECSClient({});
        const cluster = process.env.GENERATOR_CLUSTER || 'aerospace-demo-generator';
        const svcs = await ecs.send(new ListServicesCommand({ cluster }));
        const svcArn = svcs.serviceArns?.[0];
        if (svcArn) {
          await ecs.send(new UpdateServiceCommand({ cluster, service: svcArn, desiredCount: 0 }));
          results.push('Generator paused');
        }
      } catch (e: any) { results.push(`Generator pause failed: ${e.name}`); }

      // 2. Wipe DDB tables
      for (const tableName of TABLES) {
        try {
          // Paginated scan to handle tables with >500 items
          let allItems: Record<string, any>[] = [];
          let lastKey: Record<string, any> | undefined;
          do {
            const scan = await client.send(new ScanCommand({
              TableName: tableName, ProjectionExpression: 'PK,SK',
              ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
            }));
            allItems.push(...(scan.Items ?? []));
            lastKey = scan.LastEvaluatedKey;
          } while (lastKey);

          const items = allItems;
          if (items.length === 0) { results.push(`${tableName}: empty`); continue; }

          // Batch delete in groups of 25
          for (let i = 0; i < items.length; i += 25) {
            const batch = items.slice(i, i + 25);
            await client.send(new BatchWriteItemCommand({
              RequestItems: {
                [tableName]: batch.map((item) => ({
                  DeleteRequest: { Key: { PK: item.PK, SK: item.SK } },
                })),
              },
            }));
          }
          results.push(`${tableName}: ${items.length} deleted`);
        } catch (e: any) { results.push(`${tableName}: error — ${e.name}`); }
      }

      // 3. Drop Neptune graph
      try {
        const lambdaClient = new LambdaClient({});
        const neptuneResponse = await lambdaClient.send(new InvokeCommand({
          FunctionName: process.env.NEPTUNE_QUERY_FN || 'aerospace-neptune-query',
          Payload: Buffer.from(JSON.stringify({ body: JSON.stringify({ operation: 'drop_all' }) })),
        }));
        const neptuneBody = JSON.parse(new TextDecoder().decode(neptuneResponse.Payload));
        const inner = JSON.parse(neptuneBody.body || '{}');
        results.push(inner.dropped ? 'Neptune: graph dropped' : 'Neptune: drop may have failed');
      } catch (e: any) { results.push(`Neptune: error — ${e.name}`); }

      // 4. Clear Iceberg data via Athena DELETE (preserves Firehose metadata sync)
      // NEVER delete events/ directly or recreate the Glue table — Firehose loses sync
      try {
        const athena = new AthenaClient({});
        const startResp = await athena.send(new StartQueryExecutionCommand({
          QueryString: 'DELETE FROM aerospace_events.domain_events WHERE 1=1',
          WorkGroup: 'aerospace-dashboards',
          QueryExecutionContext: { Database: 'aerospace_events' },
        }));
        const qid = startResp.QueryExecutionId!;
        let status = 'RUNNING';
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const check = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: qid }));
          status = check.QueryExecution?.Status?.State || 'UNKNOWN';
          if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) break;
        }
        results.push(`Iceberg DELETE: ${status}`);
      } catch (e: any) { results.push(`Iceberg DELETE: error — ${e.name}`); }

      // 4b. Clean up S3 — session data + Firehose error files only
      try {
        const s3 = new S3Client({});
        const bucket = process.env.DATALAKE_BUCKET || '';
        const sessionBucket = process.env.SESSION_BUCKET || '';

        for (const { b, prefix } of [
          { b: sessionBucket, prefix: 'agents/' },
          { b: bucket, prefix: 'iceberg-failed/' },
          { b: bucket, prefix: 'iceberg-failedIcebergCommitFailed/' },
        ]) {
          if (!b) continue;
          const listed = await s3.send(new ListObjectsV2Command({ Bucket: b, Prefix: prefix, MaxKeys: 1000 }));
          const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key! }));
          if (objects.length > 0) {
            await s3.send(new DeleteObjectsCommand({ Bucket: b, Delete: { Objects: objects } }));
            results.push(`s3://${b}/${prefix}: ${objects.length} deleted`);
          } else {
            results.push(`s3://${b}/${prefix}: empty`);
          }
        }
      } catch (e: any) { results.push(`S3 cleanup: error — ${e.name}`); }

      results.push('Generators stopped. Use Start Generators to resume.');
      return { statusCode: 200, headers, body: JSON.stringify({ results }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown operation: ${operation}` }) };
  } catch (err: any) {
    console.error('hitl-query error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
