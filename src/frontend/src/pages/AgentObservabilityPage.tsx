import { useState, useEffect, useMemo, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Activity, Search, Bot, CheckCircle2, Clock, Loader2, AlertTriangle, ArrowRight } from 'lucide-react';
import { TraceDrawer } from '../components/dashboard/TraceDrawer';

const API_URL = import.meta.env.VITE_API_GATEWAY_URL || '';

async function callHitl(operation: string, parameters: Record<string, any> = {}) {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  const resp = await fetch(`${API_URL}hitl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation, parameters }),
  });
  const data = await resp.json();
  return typeof data.body === 'string' ? JSON.parse(data.body) : data;
}

type Run = {
  correlationId: string; entryAgent: string; agentCount: number; actionCount: number;
  escalated: boolean; sourceEntity: string; sourceEventType: string;
  startedAt: string; durationMs: number | null; status: string;
};

// status → label, badge classes, icon, filter-chip classes (app status tokens)
const STATUS = {
  completed:      { label: 'Completed',      badge: 'bg-status-success-subtle text-status-success-text', chip: 'bg-status-success-subtle text-status-success-text border-status-success', dot: 'bg-status-success', Icon: CheckCircle2 },
  awaiting_human: { label: 'Awaiting human', badge: 'bg-status-warning-subtle text-status-warning-text', chip: 'bg-status-warning-subtle text-status-warning-text border-status-warning', dot: 'bg-status-warning', Icon: Clock },
  in_flight:      { label: 'In-flight',      badge: 'bg-status-info-subtle text-status-info-text',       chip: 'bg-status-info-subtle text-status-info-text border-status-info',       dot: 'bg-status-info', Icon: Loader2 },
  stalled:        { label: 'Stalled',        badge: 'bg-status-error-subtle text-status-error-text',     chip: 'bg-status-error-subtle text-status-error-text border-status-error',     dot: 'bg-status-error', Icon: AlertTriangle },
} as const;
type StatusKey = keyof typeof STATUS;
const ORDER: StatusKey[] = ['completed', 'awaiting_human', 'in_flight', 'stalled'];

function fmtDur(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

export function AgentObservabilityPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<Set<StatusKey>>(new Set(ORDER)); // all on
  const [trace, setTrace] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    callHitl('list-runs')
      .then((b) => { setRuns(b.runs ?? []); setCounts(b.counts ?? {}); setTotal(b.total ?? 0); setError(null); })
      .catch((e) => setError(e.message ?? 'Failed to load runs'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return runs.filter((r) => {
      if (!active.has(r.status as StatusKey)) return false;
      if (!needle) return true;
      return [r.correlationId, r.sourceEntity, r.entryAgent, r.sourceEventType]
        .some((v) => String(v || '').toLowerCase().includes(needle));
    });
  }, [runs, q, active]);

  const pct = total ? Math.round(((counts.completed ?? 0) / total) * 100) : 0;
  const avgAgents = runs.length ? (runs.reduce((s, r) => s + r.agentCount, 0) / runs.length).toFixed(1) : '0';

  const toggle = (k: StatusKey) => setActive((prev) => {
    const n = new Set(prev);
    n.has(k) ? n.delete(k) : n.add(k);
    return n.size ? n : new Set(ORDER); // never empty
  });

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-accent" />
          <h1 className="text-xl font-bold text-text-primary">Agent Observability</h1>
        </div>
        <button onClick={load} className="text-[11px] font-mono text-text-muted hover:text-text-primary">↻ refresh</button>
      </div>
      <p className="text-[12px] text-text-tertiary mb-5">
        Every agent run across the fleet — completed or not. Search all correlation IDs, open any run's trace.
      </p>

      {/* Stat row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-5">
        <Stat value={String(total)} label="total runs" />
        <Stat value={`${pct}%`} label="completed" color="text-status-success" />
        <Stat value={String(counts.awaiting_human ?? 0)} label="awaiting human" color="text-status-warning" />
        <Stat value={String(counts.stalled ?? 0)} label="stalled" color="text-status-error" />
        <Stat value={avgAgents} label="avg agents / run" />
      </div>

      {/* Search + status chips */}
      <div className="flex flex-col gap-3 mb-4">
        <div className="flex items-center gap-2 bg-surface-primary border border-border rounded-lg px-3 py-2">
          <Search size={14} className="text-text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            className="flex-1 bg-transparent text-[13px] font-mono text-text-primary outline-none placeholder-text-muted"
            placeholder="Search all runs — correlationId, entity (NCR-…, SN-0047), or agent…" />
          {q && <button onClick={() => setQ('')} className="text-text-muted hover:text-text-primary text-xs">clear</button>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ORDER.map((k) => {
            const s = STATUS[k]; const on = active.has(k);
            return (
              <button key={k} onClick={() => toggle(k)}
                className={`text-[11px] font-mono px-2.5 py-1 rounded-full border flex items-center gap-1.5 transition-colors ${
                  on ? s.chip : 'bg-surface-secondary text-text-muted border-border'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
                {s.label} <span className="opacity-70">{counts[k] ?? 0}</span>
              </button>
            );
          })}
          <span className="flex-1" />
          <span className="text-[11px] font-mono text-text-muted">{filtered.length} shown · newest first</span>
        </div>
      </div>

      {/* Runs table */}
      <div className="bg-surface-primary border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="py-16 text-center"><Loader2 size={18} className="animate-spin text-text-muted inline" /><p className="text-[11px] font-mono text-text-muted mt-2">Loading runs…</p></div>
        ) : error ? (
          <div className="py-12 text-center"><p className="text-[12px] text-status-error-text">{error}</p></div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center"><p className="text-[12px] font-mono text-text-muted">No runs match</p></div>
        ) : (
          <table className="w-full text-[12px]">
            <thead className="bg-surface-secondary">
              <tr className="text-left font-mono text-[9.5px] uppercase tracking-wide text-text-muted">
                <th className="px-3 py-2.5 w-[130px]">Status</th>
                <th className="px-3 py-2.5">Run · trigger</th>
                <th className="px-3 py-2.5 w-[170px]">Entry agent</th>
                <th className="px-3 py-2.5 w-[64px] text-center">Agents</th>
                <th className="px-3 py-2.5 w-[70px] text-center">Actions</th>
                <th className="px-3 py-2.5 w-[90px] text-center">Escalated</th>
                <th className="px-3 py-2.5 w-[170px]">Started · duration</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const s = STATUS[r.status as StatusKey] ?? STATUS.stalled;
                return (
                  <tr key={r.correlationId} onClick={() => setTrace(r.correlationId)}
                    className="border-t border-border/50 hover:bg-surface-secondary cursor-pointer align-middle">
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex items-center gap-1.5 font-mono text-[10px] font-semibold px-2 py-1 rounded ${s.badge}`}>
                        <s.Icon size={11} className={r.status === 'in_flight' ? 'animate-spin' : ''} />{s.label}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-[11px] text-text-secondary">{r.correlationId.slice(0, 8)}…</div>
                      {r.sourceEntity && <div className="font-mono text-[11px] text-accent">{r.sourceEntity}{r.sourceEventType ? ` · ${r.sourceEventType}` : ''}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="w-[18px] h-[18px] rounded bg-accent-subtle text-accent flex items-center justify-center shrink-0"><Bot size={11} /></span>
                        <span className="text-text-primary truncate">{r.entryAgent}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center font-mono">{r.agentCount}</td>
                    <td className="px-3 py-2.5 text-center font-mono">{r.actionCount}</td>
                    <td className="px-3 py-2.5 text-center font-mono text-[10px]">
                      {r.escalated ? <span className="text-status-error font-bold">ESCALATE</span> : <span className="text-text-muted">—</span>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px] text-text-tertiary">{fmtTime(r.startedAt)} · {fmtDur(r.durationMs)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Row click → the EXISTING trace drawer, unchanged */}
      {trace && <TraceDrawer correlationId={trace} onClose={() => setTrace(null)} />}
    </div>
  );
}

function Stat({ value, label, color = 'text-text-primary' }: { value: string; label: string; color?: string }) {
  return (
    <div className="bg-surface-primary border border-border rounded-xl p-4 text-center">
      <span className={`text-3xl font-bold font-mono ${color}`}>{value}</span>
      <p className="text-[10px] font-mono text-text-muted mt-1 uppercase">{label}</p>
    </div>
  );
}
