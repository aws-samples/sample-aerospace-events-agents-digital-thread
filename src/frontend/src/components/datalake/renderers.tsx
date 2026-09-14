/**
 * Small, dependency-light renderers for datalake query rows. Each takes the raw Athena
 * rows (arrays of string-valued objects) and returns JSX. Kept generic so panels stay thin.
 */
import { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

// Payload keys that are plumbing, not signal — shown last / hidden behind expand.
const NOISE_KEYS = new Set(['lastModifiedBy', 'correlationId', 'createdBy', 'schemaVersion', 'eventVersion']);

function looksJson(v: string): boolean {
  const t = v.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

function shortDate(iso: string): string {
  // 2026-07-20T07:03:36.000Z -> 2026-07-20 (drop the time for compactness)
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(iso);
  return m ? m[1] : iso;
}

/** One JSON value rendered with type-aware styling — the meaning is in the shape:
 *  numbers accent + tabular, ISO timestamps shortened + muted, booleans status-coloured,
 *  UPPER_SNAKE enums in a subtle pill, plain strings plain, long strings truncated. */
function JsonValue({ value }: { value: any }) {
  if (value === null || value === undefined) return <span className="text-text-muted/50">—</span>;
  if (typeof value === 'boolean')
    return <span className={value ? 'text-status-success' : 'text-status-error-text'}>{String(value)}</span>;
  if (typeof value === 'number')
    return <span className="text-accent tabular-nums">{value.toLocaleString(undefined, { maximumFractionDigits: 3 })}</span>;
  if (typeof value === 'object')
    return <span className="text-text-muted" title={JSON.stringify(value)}>{Array.isArray(value) ? `[${value.length}]` : '{…}'}</span>;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s))
    return <span className="text-text-muted" title={s}>{shortDate(s)}</span>;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(s))  // enum-like: BORE_DIAMETER_OOT, RELEASED
    return <span className="px-1.5 py-0.5 rounded bg-accent-subtle text-accent text-[10px]">{s}</span>;
  const disp = s.length > 32 ? s.slice(0, 30) + '…' : s;
  return <span className="text-text-secondary" title={s.length > 32 ? s : undefined}>{disp}</span>;
}

/** A JSON payload cell rendered as a scannable field strip: key›value micro-chips,
 *  signal keys first, plumbing hidden behind a "+N" / expand toggle. */
function JsonCell({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);
  let obj: Record<string, any>;
  try { obj = JSON.parse(raw); } catch { return <span className="text-text-secondary">{raw.slice(0, 60)}</span>; }

  const entries = Object.entries(obj);
  const signal = entries.filter(([k]) => !NOISE_KEYS.has(k));
  const noise = entries.filter(([k]) => NOISE_KEYS.has(k));
  const ordered = [...signal, ...noise];
  const COLLAPSED = 4;
  const visible = open ? ordered : signal.slice(0, COLLAPSED);
  const hidden = ordered.length - visible.length;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-0.5">
      {visible.map(([k, v]) => (
        <span key={k} className="inline-flex items-baseline gap-1 whitespace-nowrap">
          <span className="text-text-muted">{k}</span>
          <span className="text-border">›</span>
          <JsonValue value={v} />
        </span>
      ))}
      {hidden > 0 && (
        <button onClick={() => setOpen((o) => !o)}
          className="text-[10px] text-accent hover:text-accent-hover font-semibold">
          {open ? '− less' : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

/** Generic table: columns from the first row's keys. JSON payload columns are exploded
 *  into readable field strips (JsonCell); numeric cells right-aligned; long text truncated. */
export function ResultTable({ rows, max = 50 }: { rows: any[]; max?: number }) {
  const cols = Object.keys(rows[0] ?? {});
  const shown = rows.slice(0, max);
  return (
    <div className="overflow-auto max-h-[360px] rounded-lg border border-border/60">
      <table className="w-full text-[11px] font-mono border-collapse">
        <thead className="sticky top-0 z-10 bg-surface-secondary">
          <tr>{cols.map((c) => (
            <th key={c} className="text-left px-2.5 py-2 text-text-muted font-semibold uppercase tracking-wide border-b border-border">{c}</th>
          ))}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="border-t border-border/40 hover:bg-surface-secondary/40 align-top">
              {cols.map((c) => {
                const v = r[c] == null ? '' : String(r[c]);
                if (looksJson(v)) return <td key={c} className="px-2.5 py-1.5 min-w-[280px]"><JsonCell raw={v} /></td>;
                const isNum = v !== '' && !isNaN(Number(v));
                const disp = v.length > 60 ? v.slice(0, 57) + '…' : v;
                return (
                  <td key={c} className={`px-2.5 py-1.5 text-text-secondary whitespace-nowrap ${isNum ? 'text-right tabular-nums text-accent' : ''}`}
                    title={v.length > 60 ? v : undefined}>{disp}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <p className="text-[10px] font-mono text-text-muted mt-1 text-center">showing {max} of {rows.length} rows</p>}
    </div>
  );
}

/** Horizontal bar chart of {label, value} — for top-N style results. */
export function TopBars({ data, color = '#6366f1' }: { data: { label: string; value: number }[]; color?: string }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, data.length * 26)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace', fill: 'var(--color-text-muted)' }} allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={150} tick={{ fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace', fill: 'var(--color-text-muted)' }} />
        <Tooltip contentStyle={{ backgroundColor: 'var(--color-surface-primary)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12, fontFamily: 'Amazon Ember Mono, ui-monospace' }} />
        <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Event volume by domain, as ranked bars (issue #4). The domain × event_type matrix
 *  was ~90 cells with ~15 populated and rotated/clipped column labels — a sparse matrix
 *  is the wrong form. Collapsing to per-domain totals says "one lake, every system" in a
 *  single read. Each bar's dominant event type is surfaced in the tooltip. */
export function DomainHeatmap({ rows }: { rows: any[] }) {
  // Sum counts per domain, and remember the top event type per domain for the tooltip.
  const totals = new Map<string, number>();
  const topType = new Map<string, { type: string; cnt: number }>();
  for (const r of rows) {
    const d = r.domain ?? '—';
    const c = num(r.cnt);
    totals.set(d, (totals.get(d) ?? 0) + c);
    const cur = topType.get(d);
    if (!cur || c > cur.cnt) topType.set(d, { type: r.event_type ?? '', cnt: c });
  }
  const data = [...totals.entries()]
    .map(([label, value]) => ({ label, value, top: topType.get(label)?.type ?? '' }))
    .sort((a, b) => b.value - a.value);
  const max = data.reduce((m, d) => Math.max(m, d.value), 0) || 1;

  return (
    <div className="space-y-2 py-1">
      {data.map((d) => (
        <div key={d.label} className="grid grid-cols-[110px_1fr_56px] items-center gap-3 text-[12px]"
          title={`${d.label}: ${d.value.toLocaleString()} events · top ${d.top}`}>
          <span className="font-mono text-[11px] text-text-secondary truncate">{d.label}</span>
          <span className="h-3.5 rounded-sm bg-surface-tertiary overflow-hidden">
            <span className="block h-full rounded-sm bg-brand-blue" style={{ width: `${Math.max(2, (d.value / max) * 100)}%` }} />
          </span>
          <span className="font-mono tabular-nums text-right text-text-primary">{d.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

/** Reduce rows to top-N {label,value} by summing `valueKey` grouped by `labelKey`. */
export function topN(rows: any[], labelKey: string, valueKey: string, n = 10): { label: string; value: number }[] {
  const agg = new Map<string, number>();
  for (const r of rows) {
    const k = r[labelKey] ?? '—';
    agg.set(k, (agg.get(k) ?? 0) + num(r[valueKey]));
  }
  return [...agg.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, n);
}

// re-export for panels that colour bars per-cell if needed
export { Cell };
