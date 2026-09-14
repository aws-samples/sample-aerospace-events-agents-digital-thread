/**
 * Purpose-built, business-first renderers for the datalake panels a program office reads.
 * Unlike the generic ResultTable (good for ad-hoc exploration), these parse the event
 * payload and surface the DECISION metric — CPI/SPI vs the 1.0 baseline, milestone
 * confidence and slip — not the storage envelope (PK/SK/createdAt).
 */
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';
import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react';
import { InfoDot } from '../ui/Term';

const n = (v: any) => { const x = Number(v); return isNaN(x) ? null : x; };
const parse = (r: any) => { try { return JSON.parse(r.payload); } catch { return {}; } };

/** Earned Value: CPI (cost) + SPI (schedule) trend against the 1.0 baseline.
 *  Below 1.0 = over budget / behind schedule. This is the chart a PM actually reads. */
export function ProgramEvPanel({ rows }: { rows: any[] }) {
  // One point per reporting period (keep the latest record for each) so the x-axis
  // reads as a clean monthly EV trend, not repeated period labels.
  const byPeriod = new Map<string, { period: string; cpi: number | null; spi: number | null; _d: string }>();
  for (const r of rows) {
    const p = parse(r);
    const period = String(p.period ?? r.date);
    const stamp = String(p.updatedAt ?? p.createdAt ?? r.date);
    const prev = byPeriod.get(period);
    if (!prev || stamp > prev._d) byPeriod.set(period, { period, cpi: n(p.cpi), spi: n(p.spi), _d: stamp });
  }
  const series = [...byPeriod.values()]
    .filter((d) => d.cpi != null || d.spi != null)
    .sort((a, b) => a.period.localeCompare(b.period));

  if (!series.length) return <p className="text-[12px] text-text-muted font-mono py-8 text-center">No earned-value data</p>;
  const latest = series[series.length - 1];
  const health = (v: number | null) => v == null ? 'text-text-muted' : v >= 1 ? 'text-status-success' : v >= 0.95 ? 'text-status-warning' : 'text-status-error';

  return (
    <div>
      <div className="flex gap-6 mb-3">
        <Kpi label="CPI · cost" term="CPI" value={latest.cpi} />
        <Kpi label="SPI · schedule" term="SPI" value={latest.spi} />
        <div className="flex-1" />
        <div className="text-right self-center">
          <p className="text-[10px] font-mono text-text-muted uppercase">latest · {latest.period}</p>
          <p className={`text-[11px] font-mono ${health(latest.cpi)}`}>
            {(latest.cpi ?? 1) < 1 || (latest.spi ?? 1) < 1 ? 'under plan' : 'on plan'}
          </p>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={series} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis dataKey="period" tick={{ fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace', fill: 'var(--color-text-muted)' }} />
          <YAxis domain={[0.7, 1.15]} tick={{ fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace', fill: 'var(--color-text-muted)' }} />
          <ReferenceLine y={1.0} stroke="var(--color-text-muted)" strokeDasharray="4 4"
            label={{ value: 'plan', position: 'right', fontSize: 9, fill: 'var(--color-text-muted)' }} />
          <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface-primary)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12, fontFamily: 'Amazon Ember Mono, ui-monospace' }} />
          <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace' }} />
          <Line type="monotone" dataKey="cpi" name="CPI (cost)" stroke="#4f46e5" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="spi" name="SPI (schedule)" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Kpi({ label, value, term }: { label: string; value: number | null; term?: string }) {
  const under = value != null && value < 1;
  const color = value == null ? 'text-text-primary' : value >= 1 ? 'text-status-success' : value >= 0.95 ? 'text-status-warning' : 'text-status-error';
  const Icon = under ? TrendingDown : TrendingUp;
  return (
    <div>
      <p className="text-[10px] font-mono text-text-muted uppercase">{label}{term && <InfoDot term={term} />}</p>
      <p className={`text-2xl font-bold font-mono flex items-center gap-1.5 ${color}`}>
        {value == null ? '—' : value.toFixed(2)}
        {value != null && <Icon size={15} />}
      </p>
    </div>
  );
}

/** Milestones at risk: name + confidence % + status, as scannable cards.
 *  The decision metric (confidence, status) is the headline, not the SK hash. */
export function MilestoneRiskPanel({ rows }: { rows: any[] }) {
  // latest record per milestone
  const byMilestone = new Map<string, any>();
  for (const r of rows) {
    const p = parse(r);
    const key = p.milestoneName ?? p.milestoneId ?? r.milestone ?? r.entity_id;
    const prev = byMilestone.get(key);
    if (!prev || String(p.updatedAt ?? r.date) > String(prev._d)) {
      byMilestone.set(key, { name: key, confidence: n(p.confidence), status: p.status ?? 'AT_RISK', date: r.date, _d: p.updatedAt ?? r.date });
    }
  }
  const items = [...byMilestone.values()].sort((a, b) => (a.confidence ?? 100) - (b.confidence ?? 100));
  if (!items.length) return <p className="text-[12px] text-text-muted font-mono py-8 text-center">No milestones flagged</p>;

  const confColor = (c: number | null) => c == null ? 'var(--color-text-muted)' : c < 50 ? 'var(--color-status-error)' : c < 75 ? 'var(--color-status-warning)' : 'var(--color-status-success)';

  return (
    <div className="space-y-2">
      {items.map((m) => (
        <div key={m.name} className="px-3 py-2.5 rounded-lg border border-border bg-surface-secondary/40">
          <div className="flex items-center gap-2.5 mb-2">
            <AlertTriangle size={15} className="text-status-warning shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[12px] font-semibold text-text-primary truncate">{m.name}</p>
              <p className="text-[10px] font-mono text-text-muted">flagged {m.date}</p>
            </div>
            {m.confidence != null && (
              <span className="text-lg font-bold font-mono shrink-0" style={{ color: confColor(m.confidence) }}>{m.confidence}%</span>
            )}
            <span className="text-[9px] font-mono px-2 py-0.5 rounded bg-status-error-subtle text-status-error-text shrink-0">{m.status}</span>
          </div>
          {m.confidence != null && (
            <div className="h-1.5 rounded-full bg-border overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${m.confidence}%`, backgroundColor: confColor(m.confidence) }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
