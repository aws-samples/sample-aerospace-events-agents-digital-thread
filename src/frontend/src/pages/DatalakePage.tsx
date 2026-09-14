import { useState, useEffect } from 'react';
import { Database } from 'lucide-react';
import { useDatalake } from '../hooks/useDatalake';
import { DatalakePanel } from '../components/datalake/DatalakePanel';
import { DomainHeatmap, TopBars, ResultTable, topN } from '../components/datalake/renderers';
import { ProgramEvPanel, MilestoneRiskPanel } from '../components/datalake/businessPanels';
import { AskDatalakeAgent } from '../components/datalake/AskDatalakeAgent';

const WINDOWS = [7, 30, 90];

/**
 * Datalake Analytics — the frontend's window onto S3 + Iceberg history, queried live
 * with Athena. Counterpart to the Digital Thread page (which surfaces Neptune): every
 * panel here is a real Athena query over 90 days of the event backbone, with the live
 * execution time shown so the datalake stays tangible.
 */
export function DatalakePage() {
  const [days, setDays] = useState(90);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Database size={18} className="text-accent" />
          <h1 className="text-xl font-bold text-text-primary">Datalake Analytics</h1>
        </div>
        <div className="flex items-center gap-1">
          {WINDOWS.map((w) => (
            <button key={w} onClick={() => setDays(w)}
              className={`text-[11px] font-mono px-2.5 py-1 rounded transition-colors ${
                days === w ? 'bg-accent text-white' : 'bg-surface-secondary text-text-muted hover:text-text-primary'
              }`}>{w}d</button>
          ))}
        </div>
      </div>
      <p className="text-[12px] text-text-tertiary mb-5">
        90 days of every system's events — S3 + Iceberg, queried live with Athena. Each panel is a real query.
      </p>

      {/* KPI row */}
      <KpiRow days={days} />

      {/* Cross-domain heatmap — the "one lake, every system" view */}
      <div className="mb-5">
        <DatalakePanel title="Event volume by domain" query="domainEventCounts" days={days} minHeight={260}
          render={(rows) => <DomainHeatmap rows={rows} />} />
      </div>

      {/* Program + supply chain */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
        <DatalakePanel title="Program earned value" query="programEV" days={days} showLatency={false}
          render={(rows) => <ProgramEvPanel rows={rows} />} />
        <DatalakePanel title="Milestones at risk" query="milestoneHistory" days={days} showLatency={false}
          render={(rows) => <MilestoneRiskPanel rows={rows} />} />
        <DatalakePanel title="Top suppliers by non-conformance (NCR)" query="ncrBySupplier" days={days}
          render={(rows) => <TopBars data={topN(rows, 'supplier_id', 'cnt', 10)} color="#ef4444" />} />
        <DatalakePanel title="Holds & kit shortages" query="holdImpact" days={days}
          render={(rows) => <ResultTable rows={rows} />} />
      </div>

      {/* Generative NL console — the AG-UI analytics agent runs Athena over Iceberg
          and streams back the widgets it chose (charts / table / prose). */}
      <div className="mt-5">
        <AskDatalakeAgent />
      </div>

      {/* One page-level provenance line — per-panel query latency lives here, not on
          every business KPI card (issue #4). */}
      <p className="text-[10px] font-mono text-text-muted text-center mt-6">
        Live over S3 + Iceberg via Athena · {days}-day window
      </p>
    </div>
  );
}

function KpiRow({ days }: { days: number }) {
  const { rows } = useDatalakeQuery('domainEventCounts', { days });
  const total = rows.reduce((s, r) => s + (Number(r.cnt) || 0), 0);
  const domains = new Set(rows.map((r) => r.domain)).size;
  const types = new Set(rows.map((r) => r.event_type)).size;
  return (
    <div className="grid grid-cols-3 gap-4 mb-5">
      <Kpi label={`events · last ${days}d`} value={total.toLocaleString()} />
      <Kpi label="domains" value={String(domains)} />
      <Kpi label="event types" value={String(types)} />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-primary border border-border rounded-xl p-4 text-center">
      <span className="text-3xl font-bold font-mono text-text-primary">{value}</span>
      <p className="text-[10px] font-mono text-text-muted mt-1 uppercase">{label}</p>
    </div>
  );
}

// tiny wrapper so KpiRow can read rows without a full panel
function useDatalakeQuery(query: string, params: Record<string, any>) {
  const dl = useDatalake();
  const paramKey = JSON.stringify(params);
  useEffect(() => { dl.run(query, params); }, [query, paramKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return dl;
}
