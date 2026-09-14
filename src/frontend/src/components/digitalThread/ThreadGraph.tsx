import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import { X, Search } from 'lucide-react';
import { type DomainName, getDomain, DOMAIN_COLORS, isNodeVisible } from './domainMap';
import { DrawingViewer } from '../system/DrawingViewer';

export type ThreadNode = {
  id: string;
  label: string;
  type: string;
  properties?: Record<string, any>;
};

export type ThreadEdge = {
  source: string;
  target: string;
  label: string;
};

// ISA-95:2018 vocabulary. MaterialSublot and OperationsPerformance carry a
// `subtype` property that disambiguates collapsed concepts — handled below.
const NODE_COLORS: Record<string, string> = {
  MaterialSublot: '#4f46e5',
  OperationsPerformance: '#ef4444',
  JobResponse: '#f59e0b',
  JobOrder: '#fbbf24',
  ProcessSegment: '#d97706',
  MaterialDefinition: '#3b82f6',
  Supplier: '#8b5cf6',
  AsBuiltRecord: '#10b981',
  ThreadGap: '#f97316',
  CoherenceVerdict: '#06b6d4',
  Equipment: '#64748b',
  ProductDefinitionDocument: '#60a5fa',
  ECO: '#818cf8',
  MaterialLot: '#a78bfa',
  PurchaseOrder: '#7c3aed',
  Milestone: '#22d3ee',
  DigitalTwin: '#10b981',
  FleetAnomaly: '#f43f5e',
  // ISA-95 L2 — Hierarchy (cyan family)
  Enterprise: '#0e7490',
  Site: '#0891b2',
  Area: '#06b6d4',
  WorkCenter: '#22d3ee',
  WorkUnit: '#67e8f9',
  // ISA-95 L2 — Personnel (pink family)
  Person: '#ec4899',
  PersonnelClass: '#f9a8d4',
};

// Subtype overrides — applied when a node's properties.subtype is set.
// Keeps Kit visually distinct from serialized sublots, and the three
// OperationsPerformance subtypes (NCR / Cert / Test) visually distinct.
const SUBTYPE_COLORS: Record<string, string> = {
  Kit: '#c084fc',
  Certificate: '#34d399',
  Test: '#2dd4bf',
};

function colorFor(node: { type: string; properties?: Record<string, any> }): string {
  const subtype = node.properties?.subtype;
  if (subtype && SUBTYPE_COLORS[subtype]) return SUBTYPE_COLORS[subtype];
  return NODE_COLORS[node.type] ?? '#94a3b8';
}

type ThreadGraphProps = {
  nodes: ThreadNode[];
  edges: ThreadEdge[];
  width?: number;
  height?: number;
  activeDomain?: DomainName;
  /** Externally-driven node ids to light up (the thread navigator's path). Additive:
   *  a distinct amber layer on top of the click/search selection, which is untouched. */
  highlightIds?: string[];
};

export function ThreadGraph({ nodes, edges, width = 600, height = 400, activeDomain, highlightIds }: ThreadGraphProps) {
  const graphRef = useRef<ForceGraphMethods>();
  const [selectedNode, setSelectedNode] = useState<ThreadNode | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Use refs for hover to avoid re-renders that restart the simulation
  const hoveredRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  // Keep selectedRef in sync
  useEffect(() => { selectedRef.current = selectedNode?.id ?? null; }, [selectedNode]);

  // Memoize graph data so it doesn't recreate on every render
  const graphData = useMemo(() => ({
    nodes: nodes.map((n) => ({ ...n, color: colorFor(n) })),
    links: edges.map((e) => ({ source: e.source, target: e.target, label: e.label })),
  }), [nodes, edges]);

  // Agent-path highlight — a set of node ids the navigator lit up. Painted as a
  // separate amber layer; the click/search `selectedNode` flow is unaffected.
  const highlightSet = useMemo(() => new Set(highlightIds ?? []), [highlightIds]);

  const selectedEdges = selectedNode
    ? edges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id)
    : [];

  // Zoom to fit and freeze after settling
  useEffect(() => {
    if (graphRef.current) {
      setTimeout(() => {
        graphRef.current?.zoomToFit(300, 40);
      }, 800);
    }
  }, [nodes]);

  // When the navigator highlights a path, frame just those nodes.
  useEffect(() => {
    if (!highlightSet.size || !graphRef.current) return;
    const t = setTimeout(() => {
      graphRef.current?.zoomToFit(600, 60, (n: any) => highlightSet.has(n.id));
    }, 250);
    return () => clearTimeout(t);
  }, [highlightSet]);

  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D) => {
    const sel = selectedRef.current;
    const hov = hoveredRef.current;
    const isSelected = sel === node.id;
    const isHovered = hov === node.id;
    const isConnected = sel && edges.some(
      (e) => (e.source === sel && e.target === node.id) ||
             (e.target === sel && e.source === node.id)
    );
    const isPath = highlightSet.has(node.id);
    const isDimmed = sel && !isSelected && !isConnected && !isPath;

    const r = isSelected ? 8 : isHovered ? 7 : 6;

    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
      ctx.fillStyle = node.color + '30';
      ctx.fill();
    }

    // Agent-path highlight — amber ring, distinct from the click-selection halo.
    if (isPath) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + 5, 0, 2 * Math.PI);
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    if (activeDomain && activeDomain !== 'All') {
      const domain = getDomain(node.type);
      if (domain && DOMAIN_COLORS[domain]) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 2, 0, 2 * Math.PI);
        ctx.strokeStyle = DOMAIN_COLORS[domain];
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = isDimmed ? node.color + '40' : node.color;
    ctx.fill();

    if (isSelected || isHovered) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.font = `${isSelected ? 'bold ' : ''}3px Amazon Ember Mono, ui-monospace, monospace`;
    ctx.fillStyle = isDimmed ? '#9ca3af80' : '#374151';
    ctx.textAlign = 'center';
    ctx.fillText(node.label, node.x, node.y + r + 4);
  }, [edges, activeDomain, highlightSet]);

  const handleNodeClick = useCallback((node: any) => {
    const threadNode = nodes.find((n) => n.id === node.id);
    setSelectedNode((prev) => prev?.id === node.id ? null : threadNode ?? null);
  }, [nodes]);

  const handleNodeHover = useCallback((node: any) => {
    hoveredRef.current = node?.id ?? null;
  }, []);

  // Search: find a node by id / label / type, select it, and center the camera on it.
  const runSearch = useCallback((q: string) => {
    const query = q.trim().toLowerCase();
    if (!query) return;
    const gNode: any = (graphData.nodes as any[]).find((n) =>
      String(n.id).toLowerCase().includes(query) ||
      String(n.label ?? '').toLowerCase().includes(query) ||
      String(n.type ?? '').toLowerCase().includes(query));
    if (!gNode) { setSelectedNode(null); return; }
    setSelectedNode(nodes.find((n) => n.id === gNode.id) ?? null);
    if (graphRef.current && typeof gNode.x === 'number') {
      graphRef.current.centerAt(gNode.x, gNode.y, 600);
      graphRef.current.zoom(6, 600);
    }
  }, [graphData, nodes]);

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ width, height }}>
        <p className="text-[12px] text-text-muted font-mono">No graph data</p>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Node search — find a node by id/label/type, select + center on it */}
      <div className="absolute top-3 left-3 z-10">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(searchQuery); }}
            placeholder="Find node (e.g. DWG-44821-003 or GoodsReceipt)…"
            className="w-[280px] pl-7 pr-7 py-1.5 text-[11px] font-mono bg-surface-primary/95 border border-border rounded-lg
              text-text-primary placeholder-text-muted shadow-sm
              focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          />
          {searchQuery && (
            <button onClick={() => { setSearchQuery(''); setSelectedNode(null); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary">
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        width={width}
        height={height}
        backgroundColor="transparent"
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(node: any, color, ctx) => {
          ctx.beginPath();
          ctx.arc(node.x, node.y, 10, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        onNodeClick={handleNodeClick}
        onNodeHover={handleNodeHover}
        enableNodeDrag={false}
        linkColor={(link: any) => {
          const sel = selectedRef.current;
          const src = typeof link.source === 'object' ? link.source.id : link.source;
          const tgt = typeof link.target === 'object' ? link.target.id : link.target;
          if (highlightSet.size && highlightSet.has(src) && highlightSet.has(tgt)) return '#f59e0b';
          if (!sel) return '#d1d5db';
          if (src === sel || tgt === sel) return '#6366f1';
          return '#d1d5db40';
        }}
        linkWidth={(link: any) => {
          const sel = selectedRef.current;
          const src = typeof link.source === 'object' ? link.source.id : link.source;
          const tgt = typeof link.target === 'object' ? link.target.id : link.target;
          if (highlightSet.size && highlightSet.has(src) && highlightSet.has(tgt)) return 2.5;
          if (!sel) return 1;
          if (src === sel || tgt === sel) return 2;
          return 0.5;
        }}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={0.9}
        cooldownTicks={30}
        d3AlphaDecay={0.05}
        d3VelocityDecay={0.4}
      />

      {/* Node detail panel */}
      {selectedNode && (
        <div className="absolute top-3 right-3 w-72 max-h-[92%] overflow-y-auto bg-surface-primary border border-border rounded-lg shadow-lg"
          style={{ animation: 'slide-up 0.15s ease-out' }}>
          <div className="px-3 py-2 border-b border-border flex items-center justify-between sticky top-0 bg-surface-primary"
            style={{ backgroundColor: colorFor(selectedNode) + '10' }}>
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: colorFor(selectedNode) }} />
              <span className="text-[11px] font-mono font-bold text-text-primary">
                {selectedNode.type}
                {selectedNode.properties?.subtype ? ` (${selectedNode.properties.subtype})` : ''}
              </span>
            </div>
            <button onClick={() => setSelectedNode(null)} className="text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          </div>
          <div className="px-3 py-2 space-y-2">
            {/* Drawing first — the unstructured artifact, shown immediately when present */}
            {selectedNode.properties?.drawingS3Key && (
              <div>
                <span className="text-[9px] font-mono text-text-muted uppercase">Drawing</span>
                <DrawingViewer s3Key={String(selectedNode.properties.drawingS3Key)} height={180} />
              </div>
            )}
            <div>
              <span className="text-[9px] font-mono text-text-muted uppercase">ID</span>
              <p className="text-[12px] font-mono text-text-primary">{selectedNode.id}</p>
            </div>
            <div>
              <span className="text-[9px] font-mono text-text-muted uppercase">Label</span>
              <p className="text-[12px] text-text-primary">{selectedNode.label}</p>
            </div>
            {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 && (
              <div>
                <span className="text-[9px] font-mono text-text-muted uppercase">Properties</span>
                {Object.entries(selectedNode.properties).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between py-0.5">
                    <span className="text-[10px] font-mono text-text-tertiary">{k}</span>
                    <span className="text-[10px] font-mono font-semibold text-text-primary truncate max-w-[140px]" title={String(v)}>{String(v)}</span>
                  </div>
                ))}
              </div>
            )}
            {selectedEdges.length > 0 && (
              <div>
                <span className="text-[9px] font-mono text-text-muted uppercase">Connections ({selectedEdges.length})</span>
                {selectedEdges.map((e, i) => (
                  <div key={i} className="flex items-center gap-1 py-0.5 text-[10px] font-mono">
                    <span className="text-accent">{e.label}</span>
                    <span className="text-text-muted">→</span>
                    <span className="text-text-secondary">
                      {e.source === selectedNode.id ? e.target : e.source}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ThreadGraphLegend({ activeDomain }: { activeDomain?: DomainName }) {
  // Base entries from node-type → color map
  const baseEntries: Array<{ key: string; label: string; color: string }> = Object.entries(NODE_COLORS)
    .filter(([type]) => {
      if (!activeDomain || activeDomain === 'All') return true;
      if (type === 'MaterialSublot') return true;
      return isNodeVisible(type, activeDomain);
    })
    .map(([type, color]) => ({ key: type, label: type, color }));

  // Subtype entries — only show ones whose parent type is visible
  const visibleParents = new Set(baseEntries.map((e) => e.key));
  const subtypeEntries: Array<{ key: string; label: string; color: string }> = [];
  if (visibleParents.has('MaterialSublot')) {
    subtypeEntries.push({ key: 'subtype:Kit', label: 'MaterialSublot · Kit', color: SUBTYPE_COLORS.Kit });
  }
  if (visibleParents.has('OperationsPerformance')) {
    subtypeEntries.push({ key: 'subtype:Certificate', label: 'OperationsPerformance · Certificate', color: SUBTYPE_COLORS.Certificate });
    subtypeEntries.push({ key: 'subtype:Test', label: 'OperationsPerformance · Test', color: SUBTYPE_COLORS.Test });
  }

  const entries = [...baseEntries, ...subtypeEntries];

  return (
    <div className="flex flex-wrap gap-3">
      {entries.map(({ key, label, color }) => (
        <div key={key} className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
          <span className="text-[10px] font-mono text-text-muted">{label}</span>
        </div>
      ))}
    </div>
  );
}
