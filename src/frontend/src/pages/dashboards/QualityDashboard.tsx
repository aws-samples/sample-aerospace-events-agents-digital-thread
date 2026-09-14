import { useState } from 'react';
import { useDashboardEvents, type DashboardEvent } from '../../hooks/useDashboardEvents';
import { AgentActivityPanel, HITLPanel } from '../../components/dashboard/AgentPanels';
import { TraceDrawer } from '../../components/dashboard/TraceDrawer';
import { Badge } from '../../components/ui/Badge';
import { NcrTrendChart } from '../../components/dashboard/NcrTrendChart';
import { Radio, AlertTriangle, BarChart3 } from 'lucide-react';

function EventCard({ event, onClick }: { event: DashboardEvent; onClick?: () => void }) {
  const payload = event.payload ?? {};
  const time = new Date(event.occurredAt).toLocaleTimeString();

  return (
    <div className={`px-4 py-3 border-b border-border/60 hover:bg-surface-secondary transition-colors ${onClick ? 'cursor-pointer' : ''}`}
      style={{ animation: 'fade-in 0.2s ease-out' }} onClick={onClick}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-semibold text-accent">
            {event.eventType.replace(/_/g, ' ')}
          </span>
          {payload.severity && <Badge value={payload.severity} map="severity" />}
        </div>
        <span className="text-[10px] font-mono text-text-muted">{time}</span>
      </div>
      <div className="flex items-center gap-4 text-[12px] text-text-secondary">
        <span className="font-mono">{event.entityId}</span>
        {payload.partNumber && <span>P/N {payload.partNumber}</span>}
        {payload.defectCode && <span className="text-text-tertiary">{payload.defectCode}</span>}
        {payload.supplierId && <span className="text-text-tertiary">{payload.supplierId}</span>}
      </div>
    </div>
  );
}

function Panel({ title, icon, count, children }: {
  title: string;
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface-primary border border-border rounded-xl overflow-hidden
      shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">
            {title}
          </h3>
        </div>
        <span className="text-[10px] font-mono text-text-muted">{count} items</span>
      </div>
      <div className="max-h-[400px] overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

export function QualityDashboard() {
  const { domainEvents, connected } = useDashboardEvents('quality');
  const [ncrMode, setNcrMode] = useState<'live' | 'historical'>('live');
  const [traceCorrelationId, setTraceCorrelationId] = useState<string | null>(null);

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xl font-bold text-text-primary tracking-tight">
              Quality Dashboard
            </h2>
            <div className={`flex items-center gap-1.5 ${connected ? 'opacity-100' : 'opacity-40'}`}>
              <Radio size={12} className={connected ? 'text-status-success animate-[pulse-glow_2s_ease-in-out_infinite]' : 'text-text-muted'} />
              <span className="text-[10px] font-mono font-semibold text-status-success uppercase">
                {connected ? 'Live' : 'Connecting'}
              </span>
            </div>
          </div>
          <p className="text-[13px] text-text-tertiary">
            Non-conformances, corrective actions, agent findings
          </p>
        </div>
      </div>

      {/* Panels grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* NCR Feed — Live / Historical toggle */}
        <div className="bg-surface-primary border border-border rounded-xl overflow-hidden
          shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle size={14} className="text-status-warning" />
              <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">
                NCR {ncrMode === 'live' ? 'Live Feed' : 'Trend'}
              </h3>
            </div>
            <div className="flex items-center gap-1 bg-surface-tertiary rounded-lg p-0.5">
              <button
                onClick={() => setNcrMode('live')}
                className={`px-2 py-1 text-[10px] font-mono font-semibold rounded uppercase transition-colors ${
                  ncrMode === 'live'
                    ? 'bg-surface-primary text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                Live
              </button>
              <button
                onClick={() => setNcrMode('historical')}
                className={`px-2 py-1 text-[10px] font-mono font-semibold rounded uppercase transition-colors flex items-center gap-1 ${
                  ncrMode === 'historical'
                    ? 'bg-surface-primary text-text-primary shadow-sm'
                    : 'text-text-muted hover:text-text-secondary'
                }`}
              >
                <BarChart3 size={10} />
                Historical
              </button>
            </div>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {ncrMode === 'historical' ? (
              <div className="p-4">
                <NcrTrendChart days={7} />
              </div>
            ) : domainEvents.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-[12px] text-text-muted font-mono">Awaiting events...</p>
              </div>
            ) : (
              domainEvents.map((e) => (
                <EventCard key={e.eventId} event={e}
                  onClick={() => setTraceCorrelationId(e.payload?.correlationId || e.eventId)} />
              ))
            )}
          </div>
        </div>

        <AgentActivityPanel domain="quality" />
        <HITLPanel domainId="quality" />
      </div>

      {traceCorrelationId && (
        <TraceDrawer correlationId={traceCorrelationId} onClose={() => setTraceCorrelationId(null)} />
      )}
    </div>
  );
}
