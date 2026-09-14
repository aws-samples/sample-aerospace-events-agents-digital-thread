import { useState } from 'react';
import { useShopFloorTelemetry, type MachineState } from '../../hooks/useShopFloorTelemetry';
import { useDashboardEvents } from '../../hooks/useDashboardEvents';
import { AgentActivityPanel, HITLPanel } from '../../components/dashboard/AgentPanels';
import { LiveEventCard } from '../../components/dashboard/LiveEventCard';
import { TraceDrawer } from '../../components/dashboard/TraceDrawer';
import { Radio, Cpu, Activity, Gauge } from 'lucide-react';

function MachineCard({ machine }: { machine: MachineState }) {
  const oeeColor = !machine.oee ? 'text-text-muted'
    : machine.oee >= 85 ? 'text-status-success'
    : machine.oee >= 75 ? 'text-status-warning'
    : 'text-status-error';

  const statusColor = machine.status === 'RUNNING' ? 'bg-status-success'
    : machine.status === 'FAULT' ? 'bg-status-error'
    : 'bg-text-muted';

  return (
    <div className="bg-surface-primary border border-border rounded-lg p-4
      shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Cpu size={14} className="text-text-tertiary" />
          <span className="text-[13px] font-bold text-text-primary">{machine.machineId}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${statusColor}`} />
          <span className="text-[10px] font-mono text-text-muted uppercase">{machine.status}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="text-[10px] font-mono text-text-muted uppercase block mb-1 cursor-help decoration-dotted underline underline-offset-2 decoration-text-muted/40"
            title="Overall Equipment Effectiveness — % of ideal machine output actually achieved.">OEE</span>
          <span className={`text-2xl font-bold font-mono ${oeeColor}`}>
            {machine.oee != null ? `${machine.oee.toFixed(1)}%` : '—'}
          </span>
        </div>
        {machine.lastVibration != null && (
          <div>
            <span className="text-[10px] font-mono text-text-muted uppercase block mb-1">Vibration</span>
            <span className={`text-2xl font-bold font-mono ${
              machine.lastVibration > 1.8 ? 'text-status-error' : 'text-text-primary'
            }`}>
              {machine.lastVibration.toFixed(2)}
            </span>
            <span className="text-[10px] text-text-muted ml-1">mm/s</span>
          </div>
        )}
      </div>

      <div className="mt-2 text-[10px] font-mono text-text-muted">
        {machine.cellId} · {new Date(machine.lastUpdate).toLocaleTimeString()}
      </div>
    </div>
  );
}

export function ShopFloorDashboard() {
  const { machines, readings, connected: mqttConnected } = useShopFloorTelemetry();
  const { domainEvents, connected: eventsConnected } = useDashboardEvents('shop-floor');
  const [traceCorrelationId, setTraceCorrelationId] = useState<string | null>(null);

  const machineList = Array.from(machines.values());

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xl font-bold text-text-primary tracking-tight">
              Shop Floor Dashboard
            </h2>
            <div className="flex items-center gap-3">
              <div className={`flex items-center gap-1.5 ${mqttConnected ? 'opacity-100' : 'opacity-40'}`}>
                <Radio size={10} className={mqttConnected ? 'text-status-success animate-[pulse-glow_2s_ease-in-out_infinite]' : 'text-text-muted'} />
                <span className="text-[9px] font-mono text-text-muted uppercase">MQTT</span>
              </div>
              <div className={`flex items-center gap-1.5 ${eventsConnected ? 'opacity-100' : 'opacity-40'}`}>
                <Radio size={10} className={eventsConnected ? 'text-status-success' : 'text-text-muted'} />
                <span className="text-[9px] font-mono text-text-muted uppercase">Events</span>
              </div>
            </div>
          </div>
          <p className="text-[13px] text-text-tertiary">
            Live machine telemetry, work orders, holds
          </p>
        </div>
      </div>

      {/* Cell Health Map */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <Gauge size={14} className="text-text-tertiary" />
          <h3 className="text-[12px] font-bold text-text-primary uppercase tracking-wide">
            Cell Health Map
          </h3>
          <span className="text-[10px] font-mono text-text-muted">{machineList.length} machines</span>
        </div>
        {machineList.length === 0 ? (
          <div className="bg-surface-primary border border-border rounded-xl p-8 text-center
            shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
            <p className="text-[12px] text-text-muted font-mono">
              {mqttConnected ? 'Waiting for telemetry...' : 'Connecting to IoT Core...'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {machineList.map((m) => <MachineCard key={m.machineId} machine={m} />)}
          </div>
        )}
      </div>

      {/* Telemetry Feed + Work Orders + Agent panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        {/* Telemetry Feed */}
        <div className="bg-surface-primary border border-border rounded-xl overflow-hidden
          shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Activity size={14} className="text-status-info" />
            <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">
              Telemetry Feed
            </h3>
            <span className="text-[10px] font-mono text-text-muted ml-auto">{readings.length} readings</span>
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {readings.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-[12px] text-text-muted font-mono">Awaiting telemetry...</p>
              </div>
            ) : (
              readings.slice(0, 20).map((r, i) => (
                <div key={i} className="px-4 py-1.5 border-b border-border/40 flex items-center gap-3 text-[11px] font-mono">
                  <span className="text-text-muted w-16 shrink-0">{r.machineId}</span>
                  <span className="text-text-tertiary w-32 shrink-0">{r.metric}</span>
                  <span className={`font-semibold ${
                    r.status === 'ANOMALY' ? 'text-status-error' : 'text-text-primary'
                  }`}>
                    {typeof r.value === 'number' ? r.value.toFixed(2) : r.value}
                  </span>
                  <span className="text-text-muted">{r.unit}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Work Order Stream */}
        <div className="bg-surface-primary border border-border rounded-xl overflow-hidden
          shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Activity size={14} className="text-status-warning" />
            <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">
              Work Order Stream
            </h3>
            <span className="text-[10px] font-mono text-text-muted ml-auto">{domainEvents.length} events</span>
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {domainEvents.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-[12px] text-text-muted font-mono">Awaiting work order events...</p>
              </div>
            ) : (
              domainEvents.map((e) => (
                <LiveEventCard key={e.eventId} event={e}
                  onClick={() => setTraceCorrelationId(e.payload?.correlationId || e.eventId)} />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Agent Activity + HITL */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <AgentActivityPanel domain="shop-floor" />
        <HITLPanel domainId="shop-floor" />
      </div>

      {traceCorrelationId && (
        <TraceDrawer correlationId={traceCorrelationId} onClose={() => setTraceCorrelationId(null)} />
      )}
    </div>
  );
}
