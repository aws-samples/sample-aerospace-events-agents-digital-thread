/**
 * Neptune Query Lambda — queries graph via HTTP REST API with SigV4 auth.
 * Parses GraphSON format into clean JSON for the frontend.
 */

import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';

const ENDPOINT = process.env.NEPTUNE_ENDPOINT!;
const PORT = process.env.NEPTUNE_PORT || '8182';
const REGION = process.env.AWS_REGION || 'eu-west-1';

// ISA-95:2018 vocabulary. See docs/specs/isa95-migration.md L1.
// MaterialSublot + OperationsPerformance carry a `subtype` property to keep
// previously distinct concepts (Serialized vs Kit; NCR vs Cert vs Test) queryable.
const GRAPH_SCHEMA = {
  nodeTypes: [
    { label: 'MaterialSublot', idProperty: 'serialNumber', properties: ['serialNumber', 'kitId', 'subtype', 'aggregateRole', 'status', 'shortage'], domain: 'Core', notes: 'subtype=Serialized for individual units, subtype=Kit for kit aggregations' },
    { label: 'MaterialDefinition', idProperty: 'partNumber', properties: ['partNumber', 'description', 'revision', 'status'], domain: 'Engineering', notes: 'ISA-95 part definition' },
    { label: 'ProductDefinitionDocument', idProperty: 'drawingNumber', properties: ['drawingNumber', 'revisionLetter', 'status'], domain: 'Engineering', notes: 'Released drawings' },
    { label: 'ECO', idProperty: 'ecoId', properties: ['ecoId', 'description', 'status'], domain: 'Engineering', notes: 'Project extension — change orders' },
    { label: 'Supplier', idProperty: 'supplierId', properties: ['supplierId', 'supplierName', 'otdPercent', 'qualityScore', 'qualificationStatus'], domain: 'Supply Chain', notes: 'Outside ISA-95 scope (L4 ERP)' },
    { label: 'MaterialLot', idProperty: 'lotNumber', properties: ['lotNumber', 'partNumber', 'supplierId', 'receivedAt'], domain: 'Supply Chain' },
    { label: 'PurchaseOrder', idProperty: 'poNumber', properties: ['poNumber', 'quantity', 'status'], domain: 'Supply Chain', notes: 'Outside ISA-95 scope (L4 ERP)' },
    { label: 'OperationsPerformance', idProperty: 'ncrId|certNumber|testId', properties: ['subtype', 'operationsType', 'performanceType', 'severity', 'defectCode', 'certType', 'testType', 'result', 'status', 'partNumber', 'supplierId', 'lotNumber', 'serialNumber'], domain: 'Quality', notes: 'subtype ∈ {NonConformance, Certificate, Test}; operationsType=Quality' },
    { label: 'JobResponse', idProperty: 'workOrderId', properties: ['workOrderId', 'isaClass', 'status', 'cell', 'operationNumber', 'holdReason'], domain: 'Manufacturing', notes: 'Actual work execution. JobOrder/JobResponse split is L2.' },
    { label: 'Equipment', idProperty: 'machineId', properties: ['machineId', 'cellId', 'status', 'lastOee', 'lastVibration'], domain: 'Shop Floor', notes: 'ISA-95 level=WorkUnit; hierarchy edges added in L2' },
    { label: 'Milestone', idProperty: 'milestoneId', properties: ['milestoneId', 'milestoneName', 'confidence', 'status'], domain: 'Program', notes: 'Project extension' },
    { label: 'DigitalTwin', idProperty: 'serialNumber', properties: ['serialNumber', 'flightHours', 'lastStatus'], domain: 'Fleet', notes: 'Project extension (in-service)' },
    { label: 'FleetAnomaly', idProperty: 'anomalyId', properties: ['anomalyId', 'parameter', 'deviation', 'status', 'serialNumber'], domain: 'Fleet', notes: 'Project extension (in-service)' },
    { label: 'ThreadGap', idProperty: 'id', properties: ['gapType', 'description', 'severity', 'serialNumber', 'sourceEventId'], domain: 'Quality', notes: 'Slow consumer output' },
    { label: 'CoherenceVerdict', idProperty: 'id', properties: ['verdictType', 'confidence', 'reasoning', 'serialNumber', 'sourceEventId'], domain: 'Quality', notes: 'Slow consumer output' },
    { label: 'AsBuiltRecord', idProperty: 'serialNumber', properties: ['completenessScore', 'serialNumber', 'lastUpdated'], domain: 'Quality', notes: 'Slow consumer output' },
    // ISA-95:2018 Level 2 — hierarchy master data (seeded in Phase A)
    { label: 'Enterprise', idProperty: 'id', properties: ['id', 'name'], domain: 'Hierarchy', notes: 'ISA-95 Part 1 hierarchy root' },
    { label: 'Site', idProperty: 'id', properties: ['id', 'name', 'enterpriseId'], domain: 'Hierarchy', notes: 'ISA-95 Part 1 — partOf Enterprise' },
    { label: 'Area', idProperty: 'id', properties: ['id', 'name', 'siteId'], domain: 'Hierarchy', notes: 'ISA-95 Part 1 — partOf Site' },
    { label: 'WorkCenter', idProperty: 'id', properties: ['id', 'name', 'areaId', 'cellId'], domain: 'Hierarchy', notes: 'ISA-95 Part 1 — partOf Area; Equipment locatedIn here' },
    { label: 'WorkUnit', idProperty: 'id', properties: ['id', 'name', 'workCenterId', 'type'], domain: 'Hierarchy', notes: 'ISA-95 Part 1 — partOf WorkCenter; finest hierarchy grain' },
    // ISA-95:2018 Level 2 — Personnel (seeded in Phase A)
    { label: 'Person', idProperty: 'id', properties: ['id', 'name', 'personnelClassId', 'siteId'], domain: 'Personnel', notes: 'Operators/inspectors as graph nodes; assignedTo edge from JobResponse/OperationsPerformance' },
    { label: 'PersonnelClass', idProperty: 'id', properties: ['id', 'name', 'qualification'], domain: 'Personnel', notes: 'ISA-95 Part 2 personnel classification (e.g. Operator-A2, Inspector-Level-3)' },
    // ISA-95:2018 Level 2 — Phase B (NOT YET SEEDED in Neptune; schema published in advance)
    { label: 'JobOrder', idProperty: 'workOrderId', properties: ['workOrderId', 'isaClass', 'requestedSegmentIds', 'scheduledStart', 'requestedOperator'], domain: 'Manufacturing', notes: 'Phase B — planned intent; isaClass=JobOrder. requestsExecution → JobResponse, requestsSegment → ProcessSegment' },
    { label: 'ProcessSegment', idProperty: 'id', properties: ['id', 'segmentNumber', 'segmentName', 'ordering', 'materialDefinitionId'], domain: 'Manufacturing', notes: 'Phase B — recipe step. definedFor → MaterialDefinition. Used for plan-vs-actual diff.' },
  ],
  edgeTypes: [
    { label: 'appliesTo', source: 'OperationsPerformance', target: 'MaterialSublot' },
    { label: 'affectsMaterial', source: 'OperationsPerformance', target: 'MaterialDefinition' },
    { label: 'attributedTo', source: 'OperationsPerformance', target: 'Supplier' },
    { label: 'producesMaterial', source: 'JobResponse', target: 'MaterialDefinition' },
    { label: 'produces', source: 'JobResponse', target: 'MaterialSublot' },
    { label: 'equipmentActual', source: 'JobResponse', target: 'Equipment' },
    { label: 'hasDocument', source: 'MaterialDefinition', target: 'ProductDefinitionDocument' },
    { label: 'changedBy', source: 'MaterialDefinition', target: 'ECO' },
    { label: 'suppliedBy', source: 'MaterialLot', target: 'Supplier' },
    { label: 'definesMaterial', source: 'MaterialLot', target: 'MaterialDefinition' },
    { label: 'orderedBy', source: 'MaterialLot', target: 'PurchaseOrder' },
    { label: 'orderedFrom', source: 'PurchaseOrder', target: 'Supplier' },
    { label: 'consumedBy', source: 'MaterialSublot', target: 'JobResponse' },
    { label: 'madeFrom', source: 'MaterialSublot', target: 'MaterialLot' },
    { label: 'testsAppliedTo', source: 'MaterialSublot', target: 'OperationsPerformance' },
    { label: 'testsAppliedTo', source: 'OperationsPerformance', target: 'MaterialDefinition' },
    { label: 'certifies', source: 'OperationsPerformance', target: 'MaterialDefinition' },
    { label: 'certifies', source: 'OperationsPerformance', target: 'MaterialLot' },
    { label: 'executedDuring', source: 'OperationsPerformance', target: 'JobResponse' },
    { label: 'ordersMaterial', source: 'PurchaseOrder', target: 'MaterialDefinition' },
    { label: 'instantiatedAs', source: 'MaterialSublot', target: 'DigitalTwin' },
    { label: 'observedOn', source: 'FleetAnomaly', target: 'DigitalTwin' },
    { label: 'trackedBy', source: 'MaterialDefinition', target: 'Milestone' },
    // ISA-95:2018 Level 2 — hierarchy + personnel (Phase A)
    { label: 'partOf', source: 'Site', target: 'Enterprise' },
    { label: 'partOf', source: 'Area', target: 'Site' },
    { label: 'partOf', source: 'WorkCenter', target: 'Area' },
    { label: 'partOf', source: 'WorkUnit', target: 'WorkCenter' },
    { label: 'locatedIn', source: 'Equipment', target: 'WorkCenter' },
    { label: 'memberOf', source: 'Person', target: 'PersonnelClass' },
    { label: 'assignedToSite', source: 'Person', target: 'Site' },
    // ISA-95:2018 Level 2 — plan/actual + segments (Phase B; edges declared, may not be present yet)
    { label: 'assignedTo', source: 'JobResponse', target: 'Person' },
    { label: 'assignedTo', source: 'OperationsPerformance', target: 'Person' },
    { label: 'requestsExecution', source: 'JobOrder', target: 'JobResponse' },
    { label: 'requestsSegment', source: 'JobOrder', target: 'ProcessSegment' },
    { label: 'executedSegment', source: 'JobResponse', target: 'ProcessSegment' },
    { label: 'definedFor', source: 'ProcessSegment', target: 'MaterialDefinition' },
    // ISA-95:2018 Level 2 — DHR signing chain
    { label: 'signedBy', source: 'OperationsPerformance', target: 'Person' },
    { label: 'signedBy', source: 'MaterialSublot', target: 'Person' },
    { label: 'completedBy', source: 'MaterialSublot', target: 'Person' },
  ],
  tips: [
    'ISA-95:2018 vocabulary (Level 2 alignment: hierarchy + plan/actual + Person + ProcessSegment). See docs/specs/isa95-migration.md.',
    'Use get_node to retrieve a single node + its immediate neighbors and edges',
    'Use traverse with depth 1-5 for relationship chains (e.g. Supplier -> MaterialLot -> MaterialDefinition -> MaterialSublot)',
    'Use query_by_type to find nodes by label + property filters (e.g. OperationsPerformance with subtype=NonConformance and severity=CRITICAL)',
    'Use query_neighbors to get filtered neighbors by edge type and target type',
    'Use count_by_type for aggregation (e.g. count OperationsPerformance grouped by subtype)',
    'MaterialSublot is the central hub — most nodes are reachable within 3 hops',
    'OperationsPerformance covers NCRs, Certificates, and Tests — filter by `subtype` property',
    'Use get_thread_state for the full Digital Thread view of a MaterialSublot (serial number)',
    // ISA-95 L2 — hierarchy navigation
    'Hierarchy: Enterprise <- Site <- Area <- WorkCenter <- WorkUnit, all linked by `partOf` edges (child -> parent)',
    'Use query_hierarchy(level, id, direction=down|up) to walk the partOf chain. direction=down (default) returns descendants; direction=up returns ancestors.',
    'Equipment is anchored to a WorkCenter via `locatedIn`. To find equipment in an Area, traverse from Area down through partOf and gather Equipment via locatedIn.',
    // ISA-95 L2 — personnel
    'Person is a first-class node — `assignedTo` edge attaches Person to JobResponse / OperationsPerformance instead of a flat operator string.',
    'Person -> PersonnelClass via `memberOf` (qualification grouping); Person -> Site via `assignedToSite`.',
    'Querying "all signoffs by Inspector-Level-3" = query_by_type(PersonnelClass, qualification=Inspector-Level-3) -> traverse memberOf in -> traverse assignedTo in to OperationsPerformance.',
    // ISA-95 L2 — plan vs actual
    'JobOrder = planned intent (requestedSegmentIds, scheduledStart). JobResponse = actual execution. They are linked by `requestsExecution`.',
    'Use query_plan_vs_actual(jobOrderId) to diff requested vs executed segments — returns missingSegments (skipped) and extraSegments (added). This is the structural way to detect skipped inspection steps.',
    'ProcessSegment is a recipe step ordered per MaterialDefinition (definedFor). JobOrder -> requestsSegment -> ProcessSegment; JobResponse -> executedSegment -> ProcessSegment.',
  ],
};

async function neptuneQuery(gremlin: string): Promise<any> {
  const url = `https://${ENDPOINT}:${PORT}/gremlin`;
  const body = JSON.stringify({ gremlin });

  const request = new HttpRequest({
    method: 'POST',
    protocol: 'https:',
    hostname: ENDPOINT,
    port: parseInt(PORT),
    path: '/gremlin',
    headers: { 'Content-Type': 'application/json', host: `${ENDPOINT}:${PORT}` },
    body,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: REGION,
    service: 'neptune-db',
    sha256: Sha256,
  });

  const signed = await signer.sign(request);
  const response = await fetch(url, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Neptune ${response.status}: ${text}`);
  }
  return response.json();
}

/**
 * SPARQL query/update against Neptune's /sparql endpoint.
 * `mode='query'` for SELECT/CONSTRUCT/ASK/DESCRIBE.
 * `mode='update'` for INSERT DATA / DELETE / etc.
 */
async function neptuneSparql(sparql: string, mode: 'query' | 'update' = 'query'): Promise<any> {
  const url = `https://${ENDPOINT}:${PORT}/sparql`;
  const param = mode === 'update' ? 'update' : 'query';
  const body = `${param}=${encodeURIComponent(sparql)}`;
  const accept = mode === 'update' ? 'application/json' : 'application/sparql-results+json';

  const request = new HttpRequest({
    method: 'POST',
    protocol: 'https:',
    hostname: ENDPOINT,
    port: parseInt(PORT),
    path: '/sparql',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': accept,
      host: `${ENDPOINT}:${PORT}`,
    },
    body,
  });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region: REGION,
    service: 'neptune-db',
    sha256: Sha256,
  });

  const signed = await signer.sign(request);
  const response = await fetch(url, {
    method: 'POST',
    headers: signed.headers as Record<string, string>,
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Neptune SPARQL ${response.status}: ${text}`);
  }
  if (mode === 'update') {
    return { ok: true };
  }
  return response.json();
}

/** Recursively unwrap GraphSON @type/@value wrappers into plain JS values */
function unwrapGraphSON(val: any): any {
  if (val === null || val === undefined) return val;
  if (typeof val !== 'object') return val;

  // Handle @type/@value wrappers
  if ('@type' in val && '@value' in val) {
    const t = val['@type'];
    const v = val['@value'];

    if (t === 'g:List' || t === 'g:Set') return (v as any[]).map(unwrapGraphSON);
    if (t === 'g:Map') {
      // g:Map @value is a flat array [key, val, key, val, ...]
      const obj: Record<string, any> = {};
      for (let i = 0; i < v.length; i += 2) {
        obj[unwrapGraphSON(v[i])] = unwrapGraphSON(v[i + 1]);
      }
      return obj;
    }
    if (t === 'g:Int32' || t === 'g:Int64' || t === 'g:Double' || t === 'g:Float') return v;
    if (t === 'g:Vertex') return unwrapGraphSON(v);
    if (t === 'g:Edge') return unwrapGraphSON(v);
    if (t === 'g:Property') return unwrapGraphSON(v);
    return unwrapGraphSON(v);
  }

  // Handle arrays
  if (Array.isArray(val)) return val.map(unwrapGraphSON);

  // Handle plain objects
  const obj: Record<string, any> = {};
  for (const [k, v] of Object.entries(val)) {
    obj[k] = unwrapGraphSON(v);
  }
  return obj;
}

/** Extract first value from a GraphSON property (which is always a list) */
function prop(obj: any, key: string): any {
  const v = obj?.[key];
  return Array.isArray(v) ? v[0] : v;
}

// Gremlin string literals are built by interpolation, so every caller-supplied value is
// constrained to characters that cannot terminate a quoted literal (no quotes,
// backslashes, backticks or control characters).
class ValidationError extends Error { name = 'ValidationError'; }
function lit(s: string): string {
  if (!/^[\w .:#\/@+,()-]{0,256}$/.test(s)) throw new ValidationError(`Invalid characters in parameter: ${s.slice(0, 40)}`);
  return s;
}

async function getThreadState(serialNumber: string) {
  // Check existence
  const check = await neptuneQuery(`g.V().has('MaterialSublot', 'id', '${lit(serialNumber)}').count()`);
  const count = unwrapGraphSON(check?.result?.data);
  if (Array.isArray(count) && count[0] === 0) return { error: `No thread found for ${serialNumber}` };

  // Get all connected nodes (3 hops)
  const nodesRaw = await neptuneQuery(`
    g.V().has('MaterialSublot', 'id', '${lit(serialNumber)}')
      .repeat(both().simplePath()).times(3).emit().dedup()
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const rawNodes = unwrapGraphSON(nodesRaw?.result?.data) ?? [];

  // Get edges — query each node's outgoing edges individually
  const nodeIds = rawNodes.map((n: any) => n.id).filter(Boolean);
  const allNodeIds = [serialNumber, ...nodeIds];
  let directEdges: any[] = [];

  // Batch edge query: get all edges where both endpoints are in our node set
  try {
    const edgesRaw = await neptuneQuery(`
      g.E().where(outV().has('id', within(${allNodeIds.map(id => `'${lit(id)}'`).join(',')})))
           .where(inV().has('id', within(${allNodeIds.map(id => `'${lit(id)}'`).join(',')})))
           .project('label', 'source', 'target')
           .by(label())
           .by(outV().values('id'))
           .by(inV().values('id'))
    `);
    directEdges = unwrapGraphSON(edgesRaw?.result?.data) ?? [];
  } catch (e) {
    console.warn('Edge query failed, continuing without edges:', e);
  }

  // Get gaps
  const gapsRaw = await neptuneQuery(`
    g.V().hasLabel('ThreadGap').has('serialNumber', '${lit(serialNumber)}').valueMap()
  `);
  const rawGaps = unwrapGraphSON(gapsRaw?.result?.data) ?? [];

  // Get verdicts
  const verdictsRaw = await neptuneQuery(`
    g.V().hasLabel('CoherenceVerdict').has('serialNumber', '${lit(serialNumber)}').valueMap()
  `);
  const rawVerdicts = unwrapGraphSON(verdictsRaw?.result?.data) ?? [];

  // Get AsBuilt
  const asBuiltRaw = await neptuneQuery(`
    g.V().has('AsBuiltRecord', 'serialNumber', '${lit(serialNumber)}').valueMap()
  `);
  const rawAsBuilt = unwrapGraphSON(asBuiltRaw?.result?.data)?.[0] ?? null;

  // Parse nodes
  const nodes = [
    { id: serialNumber, label: serialNumber, type: 'MaterialSublot', properties: { subtype: 'Serialized' } },
    ...rawNodes.map((n: any) => ({
      id: n.id ?? 'unknown',
      label: n.id ?? n.label ?? 'unknown',
      type: n.label ?? 'Unknown',
      properties: Object.fromEntries(
        Object.entries(n.props ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
      ),
    })),
  ];

  // Parse edges
  const edges = directEdges.map((e: any) => ({
    source: e.source,
    target: e.target,
    label: e.label,
  }));

  // Parse gaps
  const gaps = rawGaps.map((g: any) => ({
    gapType: prop(g, 'gapType') ?? 'UNKNOWN',
    description: prop(g, 'description') ?? '',
    severity: prop(g, 'severity') ?? 'MEDIUM',
    sourceEventId: prop(g, 'sourceEventId') ?? '',
    serialNumber: prop(g, 'serialNumber') ?? '',
    id: prop(g, 'id') ?? '',
  }));

  // Parse verdicts
  const verdicts = rawVerdicts.map((v: any) => ({
    verdictType: prop(v, 'verdictType') ?? 'UNKNOWN',
    confidence: prop(v, 'confidence') ?? 0,
    reasoning: prop(v, 'reasoning') ?? '',
    sourceEventId: prop(v, 'sourceEventId') ?? '',
    id: prop(v, 'id') ?? '',
  }));

  // Parse AsBuilt
  const asBuilt = rawAsBuilt ? {
    completenessScore: prop(rawAsBuilt, 'completenessScore') ?? 50,
    serialNumber: prop(rawAsBuilt, 'serialNumber') ?? serialNumber,
  } : null;

  return {
    serialNumber,
    nodeCount: nodes.length,
    nodes,
    edges,
    gaps,
    verdicts,
    asBuilt,
  };
}

function parseNodes(rawNodes: any[]): any[] {
  return rawNodes.map((n: any) => ({
    id: n.id ?? 'unknown',
    type: n.label ?? 'Unknown',
    properties: Object.fromEntries(
      Object.entries(n.props ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
    ),
  }));
}

async function getNode(nodeId: string, nodeLabel: string) {
  const nodeRaw = await neptuneQuery(`
    g.V().has('${lit(nodeLabel)}', 'id', '${lit(nodeId)}')
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const rawNodes = unwrapGraphSON(nodeRaw?.result?.data) ?? [];
  if (rawNodes.length === 0) return { error: `Node ${nodeId} (${nodeLabel}) not found` };

  const neighborsRaw = await neptuneQuery(`
    g.V().has('${lit(nodeLabel)}', 'id', '${lit(nodeId)}')
      .both().dedup()
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);

  const edgesRaw = await neptuneQuery(`
    g.V().has('${lit(nodeLabel)}', 'id', '${lit(nodeId)}')
      .bothE().project('label', 'source', 'target')
      .by(label()).by(outV().values('id')).by(inV().values('id'))
  `);

  return {
    node: parseNodes(rawNodes)[0],
    neighbors: parseNodes(unwrapGraphSON(neighborsRaw?.result?.data) ?? []),
    edges: (unwrapGraphSON(edgesRaw?.result?.data) ?? []).map((e: any) => ({
      source: e.source, target: e.target, label: e.label,
    })),
  };
}

async function queryByType(nodeLabel: string, filters: Record<string, string>, limit: number) {
  let filterClause = '';
  for (const [k, v] of Object.entries(filters)) {
    if (v) filterClause += `.has('${lit(k)}', '${lit(v)}')`;
  }

  const raw = await neptuneQuery(`
    g.V().hasLabel('${lit(nodeLabel)}')${filterClause}
      .limit(${Math.min(Math.max(limit, 1), 200)})
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const nodes = parseNodes(unwrapGraphSON(raw?.result?.data) ?? []);
  return { nodes, count: nodes.length };
}

async function traverse(startId: string, startLabel: string, edgeLabel: string,
                        direction: string, targetLabel: string, depth: number) {
  const dir = direction === 'in' ? 'in' : direction === 'both' ? 'both' : 'out';
  const edgeFilter = edgeLabel ? `('${lit(edgeLabel)}')` : '()';
  const labelFilter = targetLabel ? `.hasLabel('${lit(targetLabel)}')` : '';

  const raw = await neptuneQuery(`
    g.V().has('${lit(startLabel)}', 'id', '${lit(startId)}')
      .repeat(${dir}E${edgeFilter}.otherV()${labelFilter}.simplePath()).times(${depth}).emit()
      .dedup().limit(100)
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const nodes = parseNodes(unwrapGraphSON(raw?.result?.data) ?? []);
  return { startNode: startId, depth, nodes, count: nodes.length };
}

async function queryNeighbors(nodeId: string, nodeLabel: string,
                              edgeLabels: string, targetLabels: string) {
  const edges = edgeLabels ? edgeLabels.split(',').map(e => `'${lit(e.trim())}'`).join(',') : '';
  const edgeFilter = edges ? `.hasLabel(${edges})` : '';
  const targets = targetLabels ? targetLabels.split(',').map(t => `'${lit(t.trim())}'`).join(',') : '';
  const targetFilter = targets ? `.hasLabel(${targets})` : '';

  const raw = await neptuneQuery(`
    g.V().has('${lit(nodeLabel)}', 'id', '${lit(nodeId)}')
      .bothE()${edgeFilter}.otherV()${targetFilter}
      .dedup().limit(100)
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const nodes = parseNodes(unwrapGraphSON(raw?.result?.data) ?? []);
  return { sourceNode: nodeId, neighbors: nodes, count: nodes.length };
}

/**
 * ISA-95 L2 — walk the `partOf` hierarchy chain.
 * direction='down' (default): return all descendants (e.g. all WorkCenters/WorkUnits under an Area).
 * direction='up': return all ancestors (e.g. find the Enterprise above a WorkUnit).
 *
 * `partOf` edges go child -> parent (Site -> Enterprise, Area -> Site, WorkCenter -> Area, WorkUnit -> WorkCenter).
 * So descendants are reached via `in('partOf')` and ancestors via `out('partOf')`.
 */
async function queryHierarchy(level: string, id: string, direction: string) {
  const dir = direction === 'up' ? 'out' : 'in';
  const raw = await neptuneQuery(`
    g.V().has('${lit(level)}', 'id', '${lit(id)}')
      .repeat(__.${dir}('partOf')).emit().dedup()
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const nodes = parseNodes(unwrapGraphSON(raw?.result?.data) ?? []);
  return { rootLevel: level, rootId: id, direction: direction === 'up' ? 'up' : 'down', nodes, count: nodes.length };
}

/**
 * ISA-95 L2 — diff a JobOrder's requested ProcessSegments against its JobResponse's executed ProcessSegments.
 * Returns missingSegments (planned but not executed → skipped) and extraSegments (executed but not planned).
 *
 * Edge model: JobOrder -[requestsExecution]-> JobResponse,
 *             JobOrder -[requestsSegment]-> ProcessSegment,
 *             JobResponse -[executedSegment]-> ProcessSegment.
 */
async function queryPlanVsActual(jobOrderId: string) {
  // Fetch JobOrder
  const orderRaw = await neptuneQuery(`
    g.V().has('JobOrder', 'id', '${lit(jobOrderId)}')
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const orderNodes = parseNodes(unwrapGraphSON(orderRaw?.result?.data) ?? []);
  if (orderNodes.length === 0) return { error: `JobOrder ${jobOrderId} not found` };
  const jobOrder = orderNodes[0];

  // Fetch linked JobResponse(s) via requestsExecution
  const responseRaw = await neptuneQuery(`
    g.V().has('JobOrder', 'id', '${lit(jobOrderId)}')
      .out('requestsExecution').hasLabel('JobResponse')
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const responseNodes = parseNodes(unwrapGraphSON(responseRaw?.result?.data) ?? []);
  const jobResponse = responseNodes[0] ?? null;

  // Requested segments
  const reqRaw = await neptuneQuery(`
    g.V().has('JobOrder', 'id', '${lit(jobOrderId)}')
      .out('requestsSegment').hasLabel('ProcessSegment')
      .project('id', 'label', 'props')
      .by(coalesce(values('id'), constant('unknown')))
      .by(label())
      .by(valueMap())
  `);
  const requestedSegments = parseNodes(unwrapGraphSON(reqRaw?.result?.data) ?? []);

  // Executed segments (only if JobResponse exists)
  let executedSegments: any[] = [];
  if (jobResponse) {
    const execRaw = await neptuneQuery(`
      g.V().has('JobOrder', 'id', '${lit(jobOrderId)}')
        .out('requestsExecution').hasLabel('JobResponse')
        .out('executedSegment').hasLabel('ProcessSegment')
        .dedup()
        .project('id', 'label', 'props')
        .by(coalesce(values('id'), constant('unknown')))
        .by(label())
        .by(valueMap())
    `);
    executedSegments = parseNodes(unwrapGraphSON(execRaw?.result?.data) ?? []);
  }

  const reqIds = new Set(requestedSegments.map(s => s.id));
  const execIds = new Set(executedSegments.map(s => s.id));
  const missingSegments = requestedSegments.filter(s => !execIds.has(s.id));
  const extraSegments = executedSegments.filter(s => !reqIds.has(s.id));

  return {
    jobOrder,
    jobResponse,
    requestedSegments,
    executedSegments,
    missingSegments,
    extraSegments,
    summary: {
      requestedCount: requestedSegments.length,
      executedCount: executedSegments.length,
      missingCount: missingSegments.length,
      extraCount: extraSegments.length,
      hasResponse: jobResponse !== null,
    },
  };
}

async function countByType(nodeLabel: string, groupBy: string) {
  if (groupBy) {
    const raw = await neptuneQuery(`
      g.V().hasLabel('${lit(nodeLabel)}')
        .groupCount().by('${lit(groupBy)}')
    `);
    const data = unwrapGraphSON(raw?.result?.data) ?? [{}];
    return { label: nodeLabel, groupBy, counts: data[0] ?? {} };
  }

  const raw = await neptuneQuery(`
    g.V().hasLabel('${lit(nodeLabel)}').count()
  `);
  const count = unwrapGraphSON(raw?.result?.data)?.[0] ?? 0;
  return { label: nodeLabel, count };
}

// CORS: echo the request Origin only when it is on the ALLOWED_ORIGINS allowlist.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean);
function corsHeaders(event: any): Record<string, string> {
  const origin = event?.headers?.origin ?? event?.headers?.Origin;
  return origin && ALLOWED_ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type,Authorization', Vary: 'Origin' }
    : {};
}

const FREEFORM_OPS = new Set(['execute_gremlin', 'execute_sparql', 'sparql_update', 'drop_all', 'drop_rdf_graph']);

export const handler = async (event: any): Promise<any> => {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(event) };

  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body ?? event);
    const { operation, parameters } = body;

    // Free-form and destructive operations serve the pipeline (direct Lambda invoke) and the
    // IAM-authenticated agent route only; the browser's Cognito route gets the structured ops.
    if (FREEFORM_OPS.has(operation) && String(event?.path ?? '').endsWith('/query/neptune')) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: `${operation} is not available on this route` }) };
    }

    let result;
    switch (operation) {
      case 'get_thread_state':
        result = await getThreadState(parameters.serialNumber);
        break;
      case 'get_node':
        result = await getNode(parameters.nodeId, parameters.nodeLabel);
        break;
      case 'query_by_type':
        result = await queryByType(parameters.nodeLabel, parameters.filters || {}, parameters.limit || 50);
        break;
      case 'traverse':
        result = await traverse(parameters.startId || parameters.nodeId, parameters.startLabel || parameters.nodeLabel,
          parameters.edgeLabel || parameters.edgeLabels || '', parameters.direction || 'out',
          parameters.targetLabel || '', Math.min(parameters.depth || 1, 5));
        break;
      case 'query_neighbors':
        result = await queryNeighbors(parameters.nodeId, parameters.nodeLabel,
          parameters.edgeLabels || parameters.edgeLabel || '', parameters.targetLabels || parameters.targetLabel || '');
        break;
      case 'count_by_type':
        result = await countByType(parameters.nodeLabel, parameters.groupBy || '');
        break;
      case 'query_hierarchy':
        if (!parameters.level || !parameters.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing level or id parameter' }) };
        result = await queryHierarchy(parameters.level, parameters.id, parameters.direction || 'down');
        break;
      case 'query_plan_vs_actual':
        if (!parameters.jobOrderId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing jobOrderId parameter' }) };
        result = await queryPlanVsActual(parameters.jobOrderId);
        break;
      case 'get_graph_schema':
        result = GRAPH_SCHEMA;
        break;
      case 'execute_gremlin':
        if (!parameters.gremlin) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing gremlin parameter' }) };
        result = unwrapGraphSON((await neptuneQuery(parameters.gremlin))?.result?.data);
        break;
      case 'execute_sparql': {
        // ISA-95 L3: SPARQL SELECT/CONSTRUCT/ASK/DESCRIBE for the RDF side of dual-write.
        if (!parameters.sparql) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing sparql parameter' }) };
        result = await neptuneSparql(parameters.sparql, 'query');
        break;
      }
      case 'sparql_update': {
        // ISA-95 L3: SPARQL UPDATE for dual-write (INSERT DATA, DELETE, named-graph manipulations).
        if (!parameters.sparql) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing sparql parameter' }) };
        result = await neptuneSparql(parameters.sparql, 'update');
        break;
      }
      case 'drop_all':
        await neptuneQuery("g.V().drop()");
        result = { dropped: true };
        break;
      case 'drop_rdf_graph': {
        // ISA-95 L3 helper: clear a single named graph (for re-loading the TBox during dev).
        const graphIri = parameters.graphIri || '';
        if (!graphIri) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing graphIri parameter' }) };
        // Reject anything that could break out of the <...> IRI (whitespace, angle brackets, quotes) before interpolating.
        if (!/^[^\s<>"']+$/.test(graphIri)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid graphIri' }) };
        await neptuneSparql(`DROP GRAPH <${graphIri}>`, 'update');  // nosemgrep: tainted-sql-string -- graphIri validated above; dev-only op behind Cognito auth
        result = { dropped: true, graphIri };
        break;
      }
      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown: ${operation}`, available: ['get_thread_state', 'get_node', 'query_by_type', 'traverse', 'query_neighbors', 'count_by_type', 'query_hierarchy', 'query_plan_vs_actual', 'get_graph_schema', 'execute_gremlin', 'execute_sparql', 'sparql_update', 'drop_rdf_graph'] }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err: any) {
    console.error('Error:', err);
    if (err?.name === 'ValidationError') return { statusCode: 400, headers, body: JSON.stringify({ error: err.message }) };
    console.error('neptune-query error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
