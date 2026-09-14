/**
 * Trace Drawer — shows the full agent cascade timeline for a correlationId.
 * Multi-agent traces render as swim lanes (one column per agent).
 * Single-agent traces render as a flat vertical timeline.
 */

import { useState, useEffect, useMemo } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { X, Loader2, Zap, Bot, MessageSquare, ArrowRight, Send } from 'lucide-react';
import { Markdown } from '../ui/Markdown';

const API_URL = import.meta.env.VITE_API_GATEWAY_URL || '';

type TraceRecord = {
  correlationId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  action: string;
  source?: string;
  sourceEventId?: string;
  sourceEventType?: string;
  entityId?: string;
  parentSessionId?: string;
  detail?: string;
  timestamp: string;
};

const ACTION_CONFIG: Record<string, { icon: typeof Zap; color: string; label: string }> = {
  invoked:         { icon: Zap,            color: 'text-status-warning',  label: 'Agent Invoked' },
  ask_human:       { icon: MessageSquare,  color: 'text-accent',          label: 'Asked Human' },
  hitl_resume:     { icon: MessageSquare,  color: 'text-status-success',  label: 'Human Answered' },
  publish_finding: { icon: Send,           color: 'text-status-info',     label: 'Finding Published' },
  call_agent:      { icon: ArrowRight,     color: 'text-[#7c3aed]',      label: 'Called Agent' },
  stop_session:    { icon: X,              color: 'text-text-muted',      label: 'Session Stopped' },
};

const AGENT_COLORS = [
  'bg-status-warning/10 border-status-warning/30 text-status-warning',
  'bg-accent/10 border-accent/30 text-accent',
  'bg-status-info/10 border-status-info/30 text-status-info',
  'bg-status-error/10 border-status-error/30 text-status-error',
  'bg-status-success/10 border-status-success/30 text-status-success',
  'bg-[#7c3aed]/10 border-[#7c3aed]/30 text-[#7c3aed]',
];

function TraceCard({ record }: { record: TraceRecord }) {
  const cfg = ACTION_CONFIG[record.action] ?? ACTION_CONFIG.invoked;
  const Icon = cfg.icon;
  let detail: Record<string, any> = {};
  if (record.detail) {
    try { detail = JSON.parse(record.detail); } catch {}
  }

  // A2A handoff (call_agent) is drawn as a dashed card in the caller's lane so the
  // cascade is visible without reading parent-session ids (issue #5).
  const isHandoff = record.action === 'call_agent';

  return (
    <div className={`rounded-lg p-2.5 text-[10px] ${isHandoff
      ? 'bg-[#7c3aed]/5 border border-dashed border-[#7c3aed]/40'
      : 'bg-surface-primary border border-border'}`}>
      <div className="flex items-center justify-between mb-0.5">
        <span className={`font-mono font-bold uppercase ${cfg.color}`}>
          <Icon size={9} className="inline mr-1" />{cfg.label}
        </span>
        <span className="font-mono text-text-muted">
          {new Date(record.timestamp).toLocaleTimeString()}
        </span>
      </div>

      <p className="font-mono text-text-muted text-[9px]">
        session: {record.sessionId?.slice(0, 8)}
      </p>

      {record.action === 'invoked' && (
        <div className="text-text-secondary mt-1">
          <span className="font-semibold">{record.sourceEventType}</span> · {record.entityId}
          {record.source && <span className="text-text-muted ml-1">via {record.source}</span>}
        </div>
      )}

      {record.action === 'ask_human' && detail.question && (
        <div className="mt-1 p-1.5 bg-accent-subtle rounded">
          <span className="font-semibold text-accent text-[9px]">Q:</span>
          <Markdown size="xs">{detail.question?.slice(0, 150)}</Markdown>
        </div>
      )}

      {record.action === 'hitl_resume' && detail.answer && (
        <div className="mt-1 p-1.5 bg-status-success-subtle rounded">
          <span className="font-semibold text-status-success text-[9px]">A:</span>
          <Markdown size="xs">{detail.answer}</Markdown>
        </div>
      )}

      {record.action === 'call_agent' && detail.targetAgent && (
        <div className="text-[#7c3aed] mt-1 font-semibold">
          <ArrowRight size={9} className="inline mr-0.5" />calls {detail.targetAgent}
        </div>
      )}

      {record.action === 'publish_finding' && detail.summary && (
        <div className="mt-1">
          <span className={`font-mono font-bold uppercase text-[9px] ${detail.action === 'ESCALATE' ? 'text-status-error' : detail.action === 'RECOMMEND' ? 'text-status-success' : 'text-status-info'}`}>
            {detail.action}
          </span>
          <Markdown size="xs">{detail.summary?.slice(0, 120)}</Markdown>
        </div>
      )}

      {record.parentSessionId && (
        <p className="text-[8px] text-text-muted mt-1">parent: {record.parentSessionId.slice(0, 12)}</p>
      )}
    </div>
  );
}

function SwimLaneView({ records }: { records: TraceRecord[] }) {
  // Group by agent (preserve order of first appearance)
  const agents = useMemo(() => {
    const seen = new Map<string, TraceRecord[]>();
    for (const r of records) {
      const name = r.agentName || r.agentId;
      if (!seen.has(name)) seen.set(name, []);
      seen.get(name)!.push(r);
    }
    return Array.from(seen.entries());
  }, [records]);

  // Build time slots (group records into ~3s buckets for alignment)
  const timeSlots = useMemo(() => {
    if (records.length === 0) return [];
    const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const slots: TraceRecord[][] = [];
    let currentSlot: TraceRecord[] = [];
    let slotStart = new Date(sorted[0].timestamp).getTime();

    for (const r of sorted) {
      const t = new Date(r.timestamp).getTime();
      if (t - slotStart > 3000 && currentSlot.length > 0) {
        slots.push(currentSlot);
        currentSlot = [];
        slotStart = t;
      }
      currentSlot.push(r);
    }
    if (currentSlot.length > 0) slots.push(currentSlot);
    return slots;
  }, [records]);

  const agentNames = agents.map(([name]) => name);
  const colCount = agentNames.length;

  // Time is an explicit left-hand axis (issue #5): each slot row is labelled with the
  // clock time of its earliest record, so vertical position reads as time.
  const slotTime = (slot: TraceRecord[]) => {
    const first = [...slot].sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
    return first ? new Date(first.timestamp).toLocaleTimeString() : '';
  };
  const gridCols = `64px repeat(${colCount}, minmax(160px, 1fr))`;

  return (
    <div className="overflow-x-auto">
      {/* Column headers — time axis + one lane per agent */}
      <div className="grid gap-2 mb-3 sticky top-0 bg-surface-app z-10 pb-2 border-b border-border"
        style={{ gridTemplateColumns: gridCols }}>
        <div className="text-[9px] font-mono text-text-muted uppercase self-center pl-1">Time</div>
        {agents.map(([name], i) => (
          <div key={name}
            className={`px-2 py-1.5 rounded-lg border text-center ${AGENT_COLORS[i % AGENT_COLORS.length]}`}>
            <div className="flex items-center justify-center gap-1">
              <Bot size={10} />
              <span className="text-[10px] font-bold truncate">{name}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Time slot rows */}
      {timeSlots.map((slot, si) => (
        <div key={si} className="grid gap-2 mb-2"
          style={{ gridTemplateColumns: gridCols }}>
          <div className="text-[9px] font-mono text-text-muted pt-1 tabular-nums whitespace-nowrap">
            {slotTime(slot)}
          </div>
          {agentNames.map((agentName) => {
            const agentRecords = slot.filter(r => (r.agentName || r.agentId) === agentName);
            return (
              <div key={agentName} className="min-h-[20px]">
                {agentRecords.map((r, ri) => (
                  <div key={ri} className={ri > 0 ? 'mt-1' : ''}>
                    <TraceCard record={r} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function FlatTimelineView({ records }: { records: TraceRecord[] }) {
  return (
    <div className="relative">
      <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />
      <div className="space-y-0">
        {records.map((r, i) => {
          const cfg = ACTION_CONFIG[r.action] ?? ACTION_CONFIG.invoked;
          const Icon = cfg.icon;
          return (
            <div key={i} className="relative pl-8 pb-4">
              <div className="absolute left-0 top-1 w-[22px] h-[22px] rounded-full bg-surface-primary border-2 border-border flex items-center justify-center">
                <Icon size={10} className={cfg.color} />
              </div>
              <div className="flex items-center gap-1.5 mb-0.5">
                <Bot size={10} className="text-text-muted" />
                <span className="text-[11px] font-semibold text-text-primary">{r.agentName || r.agentId}</span>
              </div>
              <TraceCard record={r} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TraceDrawer({ correlationId, onClose }: { correlationId: string; onClose: () => void }) {
  const [records, setRecords] = useState<TraceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!correlationId) return;
    (async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        const resp = await fetch(`${API_URL}hitl`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ operation: 'query-trace', parameters: { correlationId } }),
        });
        const data = await resp.json();
        const body = typeof data.body === 'string' ? JSON.parse(data.body) : data;
        setRecords(body.items ?? []);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [correlationId]);

  // Determine layout: swim lanes if >1 agent, flat timeline if single
  const uniqueAgents = useMemo(() => {
    const agents = new Set(records.map(r => r.agentName || r.agentId));
    return agents.size;
  }, [records]);

  const drawerWidth = uniqueAgents > 1 ? Math.max(480, uniqueAgents * 200) : 480;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      <div className="relative bg-surface-app border-l border-border shadow-2xl overflow-y-auto animate-[slide-in-right_0.2s_ease-out]"
        style={{ width: `min(${drawerWidth}px, 90vw)` }}>
        <div className="sticky top-0 bg-surface-app border-b border-border px-5 py-4 flex items-center justify-between z-20">
          <div>
            <h3 className="text-[14px] font-bold text-text-primary">Agent Trace</h3>
            <span className="text-[10px] font-mono text-text-muted">
              corr: {correlationId.slice(0, 12)}... · {records.length} records · {uniqueAgents} agent{uniqueAgents !== 1 ? 's' : ''}
            </span>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={16} /></button>
        </div>

        <div className="px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-text-muted" />
            </div>
          )}

          {error && <p className="text-[12px] text-status-error text-center py-4">{error}</p>}

          {!loading && records.length === 0 && (
            <p className="text-[12px] text-text-muted text-center py-8">No trace records found</p>
          )}

          {!loading && records.length > 0 && uniqueAgents > 1 && (
            <SwimLaneView records={records} />
          )}

          {!loading && records.length > 0 && uniqueAgents <= 1 && (
            <FlatTimelineView records={records} />
          )}
        </div>
      </div>
    </div>
  );
}
