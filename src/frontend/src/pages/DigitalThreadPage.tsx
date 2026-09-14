import { useState, useMemo } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { ThreadGraph, ThreadGraphLegend, type ThreadNode, type ThreadEdge } from '../components/digitalThread/ThreadGraph';
import { CompletenessGauge } from '../components/digitalThread/CompletenessGauge';
import { DomainTabs } from '../components/digitalThread/DomainTabs';
import { AskThreadNavigator } from '../components/digitalThread/AskThreadNavigator';
import { type DomainName, isNodeVisible } from '../components/digitalThread/domainMap';
import { Search, GitBranch, AlertTriangle, Loader2 } from 'lucide-react';
import { Markdown } from '../components/ui/Markdown';

const API_URL = import.meta.env.VITE_API_GATEWAY_URL || '';

async function queryNeptune(operation: string, parameters: Record<string, any>) {
  if (!API_URL) return null;
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();

  const response = await fetch(`${API_URL}query/neptune`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation, parameters }),
  });

  if (!response.ok) throw new Error(`Query failed: ${response.status}`);
  const result = await response.json();
  return typeof result.body === 'string' ? JSON.parse(result.body) : result;
}

function mapNodesToGraph(data: any): { nodes: ThreadNode[]; edges: ThreadEdge[] } {
  if (!data || data.error) return { nodes: [], edges: [] };

  // Data is already parsed by the Lambda — no GraphSON unwrapping needed
  const seen = new Set<string>();
  const nodes: ThreadNode[] = [];

  for (const n of data.nodes ?? []) {
    if (!n.id || seen.has(n.id)) continue;
    seen.add(n.id);
    nodes.push({
      id: n.id,
      label: n.id,
      type: n.type ?? n.label ?? 'Unknown',
      properties: n.properties ?? {},
    });
  }

  // Add gap nodes not already in nodes
  for (const gap of data.gaps ?? []) {
    const id = gap.id || `gap-${nodes.length}`;
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({
        id,
        label: gap.gapType ?? 'Gap',
        type: 'ThreadGap',
        properties: gap,
      });
    }
  }

  // Add verdict nodes
  for (const v of data.verdicts ?? []) {
    const id = v.id || `verdict-${nodes.length}`;
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({
        id,
        label: v.verdictType ?? 'Verdict',
        type: 'CoherenceVerdict',
        properties: v,
      });
    }
  }

  // Edges from Neptune
  const edges: ThreadEdge[] = (data.edges ?? [])
    .filter((e: any) => e.source && e.target && seen.has(e.source) && seen.has(e.target))
    .map((e: any) => ({ source: e.source, target: e.target, label: e.label ?? '' }));

  // Build a map of sourceEventId → NCR node id for linking gaps/verdicts.
  // ISA-95: NCRs are OperationsPerformance with subtype=NonConformance.
  const eventIdToNcr = new Map<string, string>();
  for (const n of nodes) {
    const isNcr = n.type === 'OperationsPerformance' && n.properties?.subtype === 'NonConformance';
    if (isNcr && n.properties?.sourceEventId) {
      eventIdToNcr.set(n.properties.sourceEventId, n.id);
    }
  }

  // Synthetic edges: ThreadGap → NCR (via sourceEventId)
  for (const gap of data.gaps ?? []) {
    const gapId = gap.id || '';
    const ncrId = eventIdToNcr.get(gap.sourceEventId);
    if (gapId && ncrId && seen.has(gapId)) {
      edges.push({ source: gapId, target: ncrId, label: 'CAUSED_BY' });
    }
  }

  // Synthetic edges: CoherenceVerdict → NCR (via sourceEventId)
  for (const v of data.verdicts ?? []) {
    const vId = v.id || '';
    const ncrId = eventIdToNcr.get(v.sourceEventId);
    if (vId && ncrId && seen.has(vId)) {
      edges.push({ source: vId, target: ncrId, label: 'ASSESSES' });
    }
  }

  // Filter: only show nodes that have at least one edge (remove floating orphans)
  const connectedIds = new Set<string>();
  for (const e of edges) {
    connectedIds.add(e.source);
    connectedIds.add(e.target);
  }
  // Always keep the serial number node even if orphaned
  connectedIds.add(data.serialNumber);
  const connectedNodes = nodes.filter((n) => connectedIds.has(n.id));

  return { nodes: connectedNodes, edges };
}

export function DigitalThreadPage() {
  const [serialNumber, setSerialNumber] = useState('SN-0047');
  const [activeDomain, setActiveDomain] = useState<DomainName>('All');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threadData, setThreadData] = useState<any>(null);
  const [nodes, setNodes] = useState<ThreadNode[]>([]);
  const [edges, setEdges] = useState<ThreadEdge[]>([]);

  const filteredNodes = useMemo(() =>
    nodes.filter((n) => isNodeVisible(n.type, activeDomain)),
    [nodes, activeDomain]
  );
  const visibleIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);
  const filteredEdges = useMemo(() =>
    edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [edges, visibleIds]
  );

  const handleLoad = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await queryNeptune('get_thread_state', { serialNumber });
      if (!data || data.error) {
        setError(data?.error ?? 'No data returned');
        setNodes([]);
        setEdges([]);
        setThreadData(null);
      } else {
        setThreadData(data);
        const { nodes: n, edges: e } = mapNodesToGraph(data);
        setNodes(n);
        setEdges(e);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <h2 className="text-xl font-bold text-text-primary tracking-tight mb-1">Digital Thread</h2>
          <p className="text-[13px] text-text-tertiary">Cross-domain lifecycle traceability and certification readiness</p>
        </div>
        <DomainTabs active={activeDomain} onChange={setActiveDomain} />
      </div>

      {/* Search */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 flex items-center gap-2 bg-surface-primary border border-border rounded-lg px-3 py-2">
          <Search size={14} className="text-text-muted" />
          <input type="text" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)}
            className="flex-1 bg-transparent text-[13px] font-mono text-text-primary outline-none placeholder-text-muted"
            placeholder="Serial number (e.g. SN-0047)" />
        </div>
        <button onClick={handleLoad} disabled={loading}
          className="px-4 py-2 text-[12px] font-bold text-white bg-accent rounded-lg hover:bg-accent-hover transition-colors uppercase tracking-wide disabled:opacity-50">
          {loading ? <Loader2 size={14} className="animate-spin" /> : 'Load Thread'}
        </button>
      </div>

      {error && (
        <div className="bg-status-error-subtle border border-status-error/20 rounded-xl p-4 mb-5 text-center">
          <p className="text-[13px] text-status-error-text">{error}</p>
        </div>
      )}

      {!threadData && !loading && !error ? (
        <div className="bg-surface-primary border border-border rounded-xl p-16 text-center">
          <GitBranch size={32} className="text-text-muted mx-auto mb-3" />
          <p className="text-[13px] text-text-tertiary">Enter a serial number and click Load to view the digital thread</p>
        </div>
      ) : threadData ? (
        <ThreadView data={threadData} nodes={filteredNodes} edges={filteredEdges} allNodes={nodes} allEdges={edges} serialNumber={serialNumber} activeDomain={activeDomain} />
      ) : null}
    </div>
  );
}

function ThreadView({ data, nodes, edges, allNodes, allEdges, serialNumber, activeDomain }: {
  data: any; nodes: ThreadNode[]; edges: ThreadEdge[]; allNodes: ThreadNode[]; allEdges: ThreadEdge[]; serialNumber: string; activeDomain: DomainName;
}) {
  // Node ids the navigator lit up — drives the additive amber highlight on the graph.
  const [navHighlight, setNavHighlight] = useState<string[]>([]);
  const filteredGaps = activeDomain === 'All' || activeDomain === 'Quality'
    ? (data.gaps ?? [])
    : [];
  const gapCount = filteredGaps.length;
  const verdictCount = data.verdicts?.length ?? 0;
  const completeness = data.asBuilt?.completenessScore ?? 50;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-surface-primary border border-border rounded-xl p-4 text-center">
          <CompletenessGauge score={typeof completeness === 'number' ? completeness : parseInt(completeness) || 50} label="Thread Score" />
        </div>
        <StatCard label="Nodes" value={String(data.nodeCount ?? nodes.length)} />
        <StatCard label="Open Gaps" value={String(gapCount)} color={gapCount > 0 ? 'text-status-warning' : 'text-text-primary'} />
        <StatCard label="Verdicts" value={String(verdictCount)} color="text-status-info" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 bg-surface-primary border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">Thread Graph — {serialNumber}</h3>
            <ThreadGraphLegend activeDomain={activeDomain} />
          </div>
          <ThreadGraph nodes={nodes} edges={edges} width={800} height={400} activeDomain={activeDomain} highlightIds={navHighlight} />
        </div>

        <div className="bg-surface-primary border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <AlertTriangle size={14} className="text-status-warning" />
            <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">Thread Gaps</h3>
          </div>
          <div className="p-4 space-y-3 max-h-[560px] overflow-y-auto">
            {gapCount === 0 ? (
              <p className="text-[12px] text-text-muted font-mono text-center py-4">No gaps</p>
            ) : (
              groupGaps(filteredGaps).map((group) => (
                <GapGroup key={group.type} group={group} />
              ))
            )}
          </div>
        </div>
      </div>

      <AskThreadNavigator onHighlight={setNavHighlight} nodes={allNodes} edges={allEdges} />
    </div>
  );
}

function StatCard({ label, value, color = 'text-text-primary' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface-primary border border-border rounded-xl p-4 text-center">
      <span className={`text-3xl font-bold font-mono ${color}`}>{value}</span>
      <p className="text-[10px] font-mono text-text-muted mt-1 uppercase">{label}</p>
    </div>
  );
}

// --- Gap triage (issue #3): group by type, count, worst-first, action per group ---

type Gap = { gapType?: string; description?: string; sourceEventId?: string; severity?: string };
type GapGroupData = {
  type: string; gaps: Gap[]; rank: number;
  label: string; action: string; tone: 'error' | 'warning' | 'info';
};

// Per gap-type: triage label, the action that closes it, severity tone, and sort rank.
const GAP_META: Record<string, { label: string; action: string; tone: 'error' | 'warning' | 'info'; rank: number }> = {
  OPEN_NCR:         { label: 'Blocks release', action: 'Resolve', tone: 'error',   rank: 0 },
  MISSING_EVIDENCE: { label: 'Needs evidence', action: 'Attach',  tone: 'warning', rank: 1 },
  INCOMPLETE_TEST:  { label: 'Review',         action: 'Review',  tone: 'info',    rank: 2 },
};
const GAP_FALLBACK = { label: 'Review', action: 'Review', tone: 'info' as const, rank: 3 };

function groupGaps(gaps: Gap[]): GapGroupData[] {
  const byType = new Map<string, Gap[]>();
  for (const g of gaps) {
    const t = g.gapType ?? 'UNKNOWN';
    (byType.get(t) ?? byType.set(t, []).get(t)!).push(g);
  }
  return Array.from(byType.entries())
    .map(([type, list]) => {
      const meta = GAP_META[type] ?? GAP_FALLBACK;
      return { type, gaps: list, ...meta };
    })
    // worst-first: known rank, then largest group first
    .sort((a, b) => a.rank - b.rank || b.gaps.length - a.gaps.length);
}

const TONE_CLASS = {
  error:   { border: 'border-status-error/25',   head: 'bg-status-error-subtle',   pill: 'text-status-error-text',   count: 'text-status-error-text' },
  warning: { border: 'border-status-warning/25', head: 'bg-status-warning-subtle', pill: 'text-status-warning-text', count: 'text-status-warning-text' },
  info:    { border: 'border-status-info/25',    head: 'bg-status-info-subtle',    pill: 'text-status-info-text',    count: 'text-status-info-text' },
} as const;

const GAP_PREVIEW = 2;

function GapGroup({ group }: { group: GapGroupData }) {
  const [expanded, setExpanded] = useState(false);
  const tone = TONE_CLASS[group.tone];
  const shown = expanded ? group.gaps : group.gaps.slice(0, GAP_PREVIEW);
  const remaining = group.gaps.length - shown.length;

  return (
    <div className={`border ${tone.border} rounded-lg overflow-hidden`}>
      <div className={`flex items-center gap-2 px-3 py-2 ${tone.head}`}>
        <span className={`text-[10px] font-mono font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-white/60 ${tone.pill}`}>
          {group.label}
        </span>
        <span className="text-[11px] font-mono font-semibold text-text-secondary">{group.type}</span>
        <span className={`ml-auto text-[13px] font-mono font-bold ${tone.count}`}>{group.gaps.length}</span>
      </div>
      <div className="p-2 space-y-2">
        {shown.map((gap, i) => (
          <GapItem key={i} gap={gap} action={group.action} />
        ))}
        {remaining > 0 && (
          <button onClick={() => setExpanded(true)}
            className="w-full text-[11px] font-medium text-accent hover:underline py-1">
            {remaining} more {remaining === 1 ? 'gap' : 'gaps'}
          </button>
        )}
        {expanded && group.gaps.length > GAP_PREVIEW && (
          <button onClick={() => setExpanded(false)}
            className="w-full text-[11px] font-medium text-text-muted hover:underline py-1">
            Show fewer
          </button>
        )}
      </div>
    </div>
  );
}

function GapItem({ gap, action }: { gap: Gap; action: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md bg-surface-secondary px-3 py-2">
      <div className="flex-1 min-w-0">
        <Markdown>{gap.description ?? ''}</Markdown>
        {gap.sourceEventId && (
          <span className="text-[10px] font-mono text-text-muted">Source: {gap.sourceEventId.slice(0, 20)}…</span>
        )}
      </div>
      <button className="shrink-0 text-[11px] font-semibold text-accent border border-border rounded-md px-2.5 py-1 hover:bg-surface-tertiary transition-colors">
        {action}
      </button>
    </div>
  );
}
