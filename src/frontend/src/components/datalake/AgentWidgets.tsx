/**
 * Renders one AG-UI stream block (prose / table / chart) with the app's own
 * components. Prose -> Markdown, table -> ResultTable, and each chart `kind`
 * maps to a Recharts chart (or TopBars) styled with the brand CSS vars. This is
 * how the analytics agent's chosen widgets read as native Analytics-page cards.
 */
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import { Markdown } from '../ui/Markdown';
import { ResultTable, TopBars } from './renderers';
import type { Block } from '../../hooks/useAgUiStream';

// Categorical series colours — the app's brand palette (index.css), cycled.
const SERIES_VARS = [
  '--color-brand-blue', '--color-brand-green', '--color-brand-pink',
  '--color-brand-purple', '--color-brand-orange', '--color-brand-yellow',
];
const seriesColor = (i: number) => `var(${SERIES_VARS[i % SERIES_VARS.length]})`;

const AXIS_TICK = {
  fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace', fill: 'var(--color-text-muted)',
} as const;
const TOOLTIP_STYLE = {
  backgroundColor: 'var(--color-surface-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 8, fontSize: 12, fontFamily: 'Amazon Ember Mono, ui-monospace',
} as const;
const LEGEND_STYLE = { fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace' } as const;

const num = (v: any) => { const n = Number(v); return isNaN(n) ? 0 : n; };

// Agent tool-call args are external input: a list may arrive as a {label: value}
// map or a scalar. Coerce to an array so a shape slip degrades, never throws.
const arr = (v: any): any[] =>
  Array.isArray(v) ? v : v == null ? [] : typeof v === 'object' ? Object.values(v) : [v];
// Categories fall back to the keys of a map-shaped `values`.
const cats = (args: any): string[] => {
  const c = arr(args?.categories).map(String);
  const v = args?.values;
  return c.length || Array.isArray(v) || !v || typeof v !== 'object' ? c : Object.keys(v);
};

function WidgetTitle({ title }: { title?: string }) {
  if (!title) return null;
  return <div className="text-[13px] font-semibold text-text-primary mb-2">{title}</div>;
}

// Normalise args into an ordered set of named series (single series wraps `values`).
function toSeries(args: any): { name: string; values: number[] }[] {
  const series = arr(args?.series);
  if (series.length)
    return series.map((s: any) => ({ name: String(s?.name ?? ''), values: arr(s?.values).map(num) }));
  return [{ name: args?.series_label ?? 'value', values: arr(args?.values).map(num) }];
}

// Row-per-category shape Recharts wants for line/area, keyed by series name.
function trendData(args: any) {
  const series = toSeries(args);
  return cats(args).map((c, i) => {
    const row: Record<string, any> = { label: c };
    for (const s of series) row[s.name] = s.values[i] ?? 0;
    return row;
  });
}

function categoryData(args: any) {
  const vals = arr(args?.values);
  return cats(args).map((label, i) => ({ label, value: num(vals[i]) }));
}

function BarWidget({ args }: { args: any }) {
  const data = categoryData(args);
  const rotate = data.length > 6;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="label" tick={AXIS_TICK} interval={0}
          angle={rotate ? -20 : 0} textAnchor={rotate ? 'end' : 'middle'} height={rotate ? 48 : 30} />
        <YAxis tick={AXIS_TICK} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--color-accent-subtle)' }} />
        <Bar dataKey="value" name={args?.series_label ?? 'value'}
          fill="var(--color-brand-blue)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function TrendWidget({ args, area }: { args: any; area?: boolean }) {
  const data = trendData(args);
  const series = toSeries(args);
  const multi = series.length > 1;
  const Chart = area ? AreaChart : LineChart;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <Chart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis dataKey="label" tick={AXIS_TICK} />
        <YAxis tick={AXIS_TICK} allowDecimals={false} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        {multi && <Legend wrapperStyle={LEGEND_STYLE} />}
        {series.map((s, i) => area ? (
          <Area key={s.name} type="monotone" dataKey={s.name} name={s.name}
            stroke={seriesColor(i)} fill={seriesColor(i)} fillOpacity={0.22} strokeWidth={2}
            stackId={multi ? 'a' : undefined} isAnimationActive={false} />
        ) : (
          <Line key={s.name} type="monotone" dataKey={s.name} name={s.name}
            stroke={seriesColor(i)} strokeWidth={2} dot={false} isAnimationActive={false} />
        ))}
      </Chart>
    </ResponsiveContainer>
  );
}

function PieWidget({ args, donut }: { args: any; donut?: boolean }) {
  const data = categoryData(args).map((d) => ({ name: d.label, value: d.value }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%"
          innerRadius={donut ? 55 : 0} outerRadius={92} paddingAngle={1} isAnimationActive={false}>
          {data.map((_, i) => <Cell key={i} fill={seriesColor(i)} stroke="var(--color-surface-primary)" />)}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={LEGEND_STYLE} />
      </PieChart>
    </ResponsiveContainer>
  );
}

function StatWidget({ args }: { args: any }) {
  const v = args?.value;
  const disp = typeof v === 'number' ? v.toLocaleString() : String(v ?? '—');
  return (
    <div className="text-center py-5">
      <span className="text-4xl font-bold font-mono text-text-primary tabular-nums">{disp}</span>
      {args?.unit && <span className="text-2xl font-mono text-text-muted ml-1">{args.unit}</span>}
      <p className="text-[11px] font-mono text-text-muted mt-2 uppercase tracking-wide">
        {args?.label ?? args?.title}
      </p>
    </div>
  );
}

function ChartWidget({ args }: { args: any }) {
  switch (String(args?.kind ?? 'bar').toLowerCase()) {
    case 'hbar':  return <TopBars data={categoryData(args)} color="var(--color-brand-blue)" />;
    case 'line':  return <TrendWidget args={args} />;
    case 'area':  return <TrendWidget args={args} area />;
    case 'pie':   return <PieWidget args={args} />;
    case 'donut': return <PieWidget args={args} donut />;
    case 'stat':  return <StatWidget args={args} />;
    default:      return <BarWidget args={args} />;
  }
}

function TableWidget({ args }: { args: any }) {
  const columns: string[] = arr(args?.columns).map(String);
  const rowsIn: any[] = arr(args?.rows);
  const rows = rowsIn.map((r) =>
    Object.fromEntries(columns.map((c, i) => [c, Array.isArray(r) ? r[i] : (r as any)?.[c]])),
  );
  return rows.length
    ? <ResultTable rows={rows} max={50} />
    : <p className="text-[12px] text-text-muted font-mono py-4 text-center">No rows.</p>;
}

/** Render a single AG-UI block's inner content (the caller wraps it in a card). */
export function AgentBlock({ block }: { block: Block }) {
  if (block.kind === 'prose') return <Markdown size="sm">{block.text}</Markdown>;
  if (block.kind === 'table')
    return <><WidgetTitle title={block.args?.title} /><TableWidget args={block.args} /></>;
  const isStat = String(block.args?.kind).toLowerCase() === 'stat'; // stat shows its own label
  return <>{!isStat && <WidgetTitle title={block.args?.title} />}<ChartWidget args={block.args} /></>;
}
