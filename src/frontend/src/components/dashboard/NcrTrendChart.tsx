import { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useHistoricalData } from '../../hooks/useHistoricalData';

const COLORS = {
  MINOR: '#f59e0b',
  MAJOR: '#f97316',
  CRITICAL: '#ef4444',
};

const WINDOWS = [7, 30, 90];

export function NcrTrendChart({ days = 7 }: { days?: number }) {
  const { data, loading, error, executionMs, fetchNcrTrend } = useHistoricalData();
  // Window selector — the datalake holds 90 days of history (Athena over Iceberg),
  // so the operator can widen the lens from a week to the full quarter.
  const [window, setWindow] = useState<number>(days);

  useEffect(() => {
    fetchNcrTrend(window);
  }, [window, fetchNcrTrend]);

  const windowPicker = (
    <div className="flex items-center gap-1">
      {WINDOWS.map((w) => (
        <button
          key={w}
          onClick={() => setWindow(w)}
          className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
            window === w
              ? 'bg-accent text-white'
              : 'bg-surface-secondary text-text-muted hover:text-text-primary'
          }`}
        >
          {w}d
        </button>
      ))}
    </div>
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="py-12 text-center">
        <div className="inline-block w-4 h-4 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
        <p className="text-[11px] font-mono text-text-muted mt-2">Querying Athena...</p>
      </div>
    );
  } else if (error) {
    body = (
      <div className="py-8 text-center">
        <p className="text-[12px] text-status-error-text">{error}</p>
      </div>
    );
  } else if (data.length === 0) {
    body = (
      <div className="py-8 text-center">
        <p className="text-[12px] text-text-muted font-mono">No data for selected period</p>
      </div>
    );
  } else {
    body = (
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace', fill: 'var(--color-text-muted)' }}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            tick={{ fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace', fill: 'var(--color-text-muted)' }}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'var(--color-surface-primary)',
              border: '1px solid var(--color-border)',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: 'Amazon Ember Mono, ui-monospace',
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 10, fontFamily: 'Amazon Ember Mono, ui-monospace' }}
          />
          <Bar dataKey="MINOR" stackId="a" fill={COLORS.MINOR} radius={[0, 0, 0, 0]} />
          <Bar dataKey="MAJOR" stackId="a" fill={COLORS.MAJOR} radius={[0, 0, 0, 0]} />
          <Bar dataKey="CRITICAL" stackId="a" fill={COLORS.CRITICAL} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-mono text-text-muted">
          NCRs by severity · last {window} days
        </span>
        {windowPicker}
      </div>
      {body}
      {executionMs != null && (
        <p className="text-[9px] font-mono text-text-muted text-right mt-1">
          Athena over Iceberg · {executionMs}ms
        </p>
      )}
    </div>
  );
}
