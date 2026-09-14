import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Search, Loader2, Compass, GitBranch, RotateCcw, CornerDownRight } from 'lucide-react';
import { useAgUiStream, type Block } from '../../hooks/useAgUiStream';
import { AgentBlock } from '../datalake/AgentWidgets';
import { DrawingViewer } from '../system/DrawingViewer';
import { WidgetErrorBoundary } from '../ui/WidgetErrorBoundary';
import { ThreadGraph, type ThreadNode, type ThreadEdge } from './ThreadGraph';

const AGUI_THREAD_URL =
  (import.meta as any).env?.VITE_AGUI_THREAD_URL || 'http://localhost:8080/invocations';

const EXAMPLES = [
  'Trace the bore defect on SN-0047 across domains',
  'Which supplier and PO are linked to the OOT bore fitting?',
  'Show the design → build → fleet path for SN-0047',
  'Measurement history behind the bore defect',
];

/** The traced subgraph, rendered as an interactive force-graph (same as the full
 *  thread graph above) — node labels + click a node for its detail panel. Built by
 *  intersecting the agent's node_ids with the loaded thread's nodes/edges. */
function GraphBlock({ args, nodes, edges }: { args: any; nodes: ThreadNode[]; edges: ThreadEdge[] }) {
  const idset = useMemo(() => new Set<string>(args?.node_ids ?? []), [args]);
  const subNodes = useMemo(() => nodes.filter((n) => idset.has(n.id)), [nodes, idset]);
  const subEdges = useMemo(
    () => edges.filter((e) => idset.has(e.source) && idset.has(e.target)),
    [edges, idset],
  );
  const present = new Set(subNodes.map((n) => n.id));
  const missing = [...idset].filter((id) => !present.has(id));

  // ForceGraph2D needs an explicit width — track the card width so it fills.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(760);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div>
      {args?.caption && <p className="text-[12px] text-text-tertiary mb-2">{args.caption}</p>}
      <div ref={wrapRef} className="rounded-lg border border-border overflow-hidden bg-surface-primary">
        {subNodes.length > 0 ? (
          <ThreadGraph nodes={subNodes} edges={subEdges} width={w} height={360} />
        ) : (
          <p className="text-[12px] text-text-muted font-mono py-10 text-center">Path nodes not in the loaded thread.</p>
        )}
      </div>
      {missing.length > 0 && (
        <p className="text-[10px] font-mono text-text-muted mt-2">also referenced: {missing.join(' · ')}</p>
      )}
      <p className="text-[10px] font-mono text-text-muted mt-2">↑ the same path is highlighted on the full thread graph above · click a node for details</p>
    </div>
  );
}

/** One AG-UI block — graph highlight + PLM drawing are navigator-specific; the rest reuse AgentBlock. */
function NavBlock({ block, nodes, edges }: { block: Block; nodes: ThreadNode[]; edges: ThreadEdge[] }) {
  if (block.kind === 'graph')
    return (
      <>
        <div className="text-[13px] font-semibold text-text-primary mb-2">{(block.args as any)?.title}</div>
        <GraphBlock args={block.args} nodes={nodes} edges={edges} />
      </>
    );
  if (block.kind === 'drawing') {
    const a = block.args as any;
    return (
      <>
        <div className="text-[13px] font-semibold text-text-primary mb-2">{a?.title}</div>
        {a?.caption && <p className="text-[12px] text-text-tertiary mb-2">{a.caption}</p>}
        {a?.s3_key && <DrawingViewer s3Key={String(a.s3_key)} height={340} />}
      </>
    );
  }
  return <AgentBlock block={block} />;
}

/**
 * Navigate the thread — the Digital Thread Navigator agent. It NAVIGATES the Neptune
 * graph across domains (lighting the path up on the canvas above via `onHighlight`),
 * then DIVES into the Athena/Iceberg lake for the detail behind a node — all as a
 * conversation, streamed over AG-UI as graph-highlight + chart + table + prose widgets.
 */
export function AskThreadNavigator({ onHighlight, nodes, edges }: { onHighlight: (ids: string[]) => void; nodes: ThreadNode[]; edges: ThreadEdge[] }) {
  const [question, setQuestion] = useState('');
  const { turns, running, error, ask, reset } = useAgUiStream({
    url: AGUI_THREAD_URL,
    sessionPrefix: 'thread-nav',
  });
  const started = turns.length > 0;

  // Drive the on-canvas highlight from the most recent render_graph block.
  const latestGraphIds = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      for (let j = turns[i].blocks.length - 1; j >= 0; j--) {
        const b = turns[i].blocks[j];
        if (b.kind === 'graph') return ((b.args as any)?.node_ids ?? []) as string[];
      }
    }
    return [] as string[];
  }, [turns]);

  useEffect(() => { onHighlight(latestGraphIds); }, [latestGraphIds, onHighlight]);

  // Chat autoscroll — the window is the scroll container; keep the sentinel in view
  // while the user is near the bottom (never yank them back if they scrolled up).
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      const el = document.scrollingElement || document.documentElement;
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const run = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || running) return;
    setQuestion('');
    stickRef.current = true;
    let token: string | undefined;
    try {
      token = (await fetchAuthSession()).tokens?.idToken?.toString();
    } catch {
      /* local dev: agent may accept unauthenticated */
    }
    ask(text, token);
  }, [running, ask]);

  const onReset = useCallback(() => { reset(); onHighlight([]); }, [reset, onHighlight]);

  const lastTurn = turns[turns.length - 1];
  const awaitingFirstWidget = running && lastTurn && lastTurn.blocks.length === 0;

  return (
    <div className="bg-surface-primary border border-border rounded-xl p-5">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Compass size={16} className="text-accent" />
            <h3 className="text-[15px] font-bold text-text-primary">Navigate the thread</h3>
            <span className="text-[9px] font-mono text-text-muted uppercase tracking-wide border border-border rounded px-1.5 py-0.5">
              AG-UI · graph + lake
            </span>
          </div>
          <p className="text-[12px] text-text-tertiary mt-0.5">
            Ask in plain language — the navigator traverses the knowledge graph across domains, lights the path up above, then dives into the lake for the detail behind a node.
          </p>
        </div>
        {started && (
          <button onClick={onReset} disabled={running}
            className="shrink-0 flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary hover:text-text-primary border border-border rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-50">
            <RotateCcw size={12} /> New conversation
          </button>
        )}
      </div>

      {error && (
        <div className="bg-status-error-subtle border border-status-error/20 rounded-lg p-3 mb-3">
          <p className="text-[12px] text-status-error-text">{error}</p>
        </div>
      )}

      {/* Conversation thread — question, then the widgets the agent chose for it. */}
      {started && (
        <div className="space-y-5 mb-4">
          {turns.map((turn) => (
            <div key={turn.id} className="space-y-3">
              <div className="flex items-center gap-2">
                <CornerDownRight size={13} className="text-accent shrink-0" />
                <p className="text-[13px] font-semibold text-text-primary">{turn.question}</p>
              </div>
              {turn.blocks.map((b) => (
                <div key={b.id} className="bg-surface-secondary border border-border rounded-lg p-4">
                  <WidgetErrorBoundary label={`${b.kind} widget`}>
                    <NavBlock block={b} nodes={nodes} edges={edges} />
                  </WidgetErrorBoundary>
                </div>
              ))}
            </div>
          ))}

          {awaitingFirstWidget && (
            <div className="flex items-center gap-2 py-6 justify-center text-[12px] font-mono text-text-muted">
              <Loader2 size={14} className="animate-spin text-accent" />
              <GitBranch size={11} className="inline" /> the navigator is traversing the graph…
            </div>
          )}

          <p className="text-[9px] font-mono text-text-muted text-right">
            Composed live by the navigator · Neptune graph + Athena over Iceberg
          </p>
        </div>
      )}

      {/* Composer */}
      <div className="flex items-center gap-3">
        <div className="flex-1 flex items-center gap-2 bg-surface-secondary border border-border rounded-lg px-3 py-2">
          <Search size={14} className="text-text-muted" />
          <input
            type="text" value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(question); }}
            className="flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder-text-muted"
            placeholder={started ? 'Ask a follow-up… e.g. "now show its measurement history"' : 'e.g. Trace the bore defect on SN-0047 across domains'}
          />
        </div>
        <button onClick={() => run(question)} disabled={running}
          className="px-4 py-2 text-[12px] font-bold text-white bg-accent rounded-lg hover:bg-accent-hover transition-colors uppercase tracking-wide disabled:opacity-50 min-w-[64px] flex items-center justify-center">
          {running ? <Loader2 size={14} className="animate-spin" /> : started ? 'Send' : 'Ask'}
        </button>
      </div>

      {/* Example chips */}
      <div className="flex flex-wrap gap-2 mt-3">
        {EXAMPLES.map((q) => (
          <button key={q} onClick={() => run(q)} disabled={running}
            className="text-[11px] px-2.5 py-1 rounded-full bg-surface-secondary text-text-tertiary border border-border hover:text-text-primary hover:border-border-strong transition-colors disabled:opacity-50">
            {q}
          </button>
        ))}
      </div>

      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
