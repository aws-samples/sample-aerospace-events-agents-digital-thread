import { useState } from 'react';
import { useDashboardEvents } from '../../hooks/useDashboardEvents';
import { AgentActivityPanel, HITLPanel } from '../../components/dashboard/AgentPanels';
import { LiveEventCard } from '../../components/dashboard/LiveEventCard';
import { TraceDrawer } from '../../components/dashboard/TraceDrawer';
import { Radio, Plane } from 'lucide-react';

export function InServiceDashboard() {
  const { domainEvents, connected } = useDashboardEvents('in-service');
  const [traceCorrelationId, setTraceCorrelationId] = useState<string | null>(null);

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-xl font-bold text-text-primary tracking-tight">Fleet Dashboard</h2>
        <div className={`flex items-center gap-1.5 ${connected ? 'opacity-100' : 'opacity-40'}`}>
          <Radio size={12} className={connected ? 'text-status-success animate-[pulse-glow_2s_ease-in-out_infinite]' : 'text-text-muted'} />
          <span className="text-[10px] font-mono text-status-success uppercase">{connected ? 'Live' : 'Connecting'}</span>
        </div>
      </div>
      <p className="text-[13px] text-text-tertiary mb-5">Fleet anomalies, service bulletins, maintenance advisories</p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="bg-surface-primary border border-border rounded-xl overflow-hidden shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Plane size={14} className="text-status-info" />
              <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">Fleet Events</h3>
            </div>
            <span className="text-[10px] font-mono text-text-muted">{domainEvents.length} items</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {domainEvents.length === 0 ? (
              <div className="px-4 py-8 text-center"><p className="text-[12px] text-text-muted font-mono">Awaiting fleet events...</p></div>
            ) : domainEvents.map((e) => (
              <LiveEventCard key={e.eventId} event={e}
                onClick={() => setTraceCorrelationId(e.payload?.correlationId || e.eventId)} />
            ))}
          </div>
        </div>

        <AgentActivityPanel domain="in-service" />
        <HITLPanel domainId="in-service" />
      </div>

      {traceCorrelationId && (
        <TraceDrawer correlationId={traceCorrelationId} onClose={() => setTraceCorrelationId(null)} />
      )}
    </div>
  );
}
