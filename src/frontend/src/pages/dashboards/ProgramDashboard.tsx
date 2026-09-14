import { useState } from 'react';
import { useDashboardEvents } from '../../hooks/useDashboardEvents';
import { AgentActivityPanel, HITLPanel } from '../../components/dashboard/AgentPanels';
import { LiveEventCard } from '../../components/dashboard/LiveEventCard';
import { TraceDrawer } from '../../components/dashboard/TraceDrawer';
import { Radio, Target } from 'lucide-react';
import { DatalakePanel } from '../../components/datalake/DatalakePanel';
import { ProgramEvPanel, MilestoneRiskPanel } from '../../components/datalake/businessPanels';

export function ProgramDashboard() {
  const { domainEvents, connected } = useDashboardEvents('program');
  const [traceCorrelationId, setTraceCorrelationId] = useState<string | null>(null);

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <h2 className="text-xl font-bold text-text-primary tracking-tight">Program Dashboard</h2>
        <div className={`flex items-center gap-1.5 ${connected ? 'opacity-100' : 'opacity-40'}`}>
          <Radio size={12} className={connected ? 'text-status-success animate-[pulse-glow_2s_ease-in-out_infinite]' : 'text-text-muted'} />
          <span className="text-[10px] font-mono text-status-success uppercase">{connected ? 'Live' : 'Connecting'}</span>
        </div>
      </div>
      <p className="text-[13px] text-text-tertiary mb-5">Milestones, schedule, cost variance, delivery risk</p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="bg-surface-primary border border-border rounded-xl overflow-hidden shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Target size={14} className="text-status-info" />
              <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">Program Events</h3>
            </div>
            <span className="text-[10px] font-mono text-text-muted">{domainEvents.length} items</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {domainEvents.length === 0 ? (
              <div className="px-4 py-8 text-center"><p className="text-[12px] text-text-muted font-mono">Awaiting program events...</p></div>
            ) : domainEvents.map((e) => (
              <LiveEventCard key={e.eventId} event={e}
                onClick={() => setTraceCorrelationId(e.payload?.correlationId || e.eventId)} />
            ))}
          </div>
        </div>

        <AgentActivityPanel domain="program" />
        <HITLPanel domainId="program" />
      </div>

      {/* Historical — datalake (Athena over Iceberg, 90 days) */}
      <div className="mt-5">
        <p className="text-[11px] font-mono text-text-muted uppercase tracking-wide mb-2">Historical · datalake</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <DatalakePanel title="Earned value (90d)" query="programEV" days={90}
            render={(rows) => <ProgramEvPanel rows={rows} />} />
          <DatalakePanel title="Milestones at risk (90d)" query="milestoneHistory" days={90}
            render={(rows) => <MilestoneRiskPanel rows={rows} />} />
        </div>
      </div>

      {traceCorrelationId && (
        <TraceDrawer correlationId={traceCorrelationId} onClose={() => setTraceCorrelationId(null)} />
      )}
    </div>
  );
}
