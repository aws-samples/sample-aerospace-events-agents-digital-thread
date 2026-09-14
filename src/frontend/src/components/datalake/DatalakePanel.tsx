import { useEffect } from 'react';
import { useDatalake } from '../../hooks/useDatalake';

/**
 * A self-contained datalake panel: runs one named Athena query on mount (and when
 * `days` changes) and renders whatever the `render` prop returns from the rows.
 * Technical panels carry the live "Athena over Iceberg · {ms}" badge so the datalake
 * stays tangible. Business panels (KPIs a programme reads) set `showLatency={false}`
 * — millisecond query timing is dev telemetry, not a business number (issue #4).
 */
export function DatalakePanel({
  title, query, params, days, render, minHeight = 220, showLatency = true,
}: {
  title: string;
  query: string;
  params?: Record<string, any>;
  days?: number;
  render: (rows: any[]) => React.ReactNode;
  minHeight?: number;
  showLatency?: boolean;
}) {
  const { rows, loading, error, executionMs, run } = useDatalake();

  useEffect(() => {
    run(query, { days, ...params });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, days, JSON.stringify(params)]);

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="py-12 text-center">
        <div className="inline-block w-4 h-4 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
        <p className="text-[11px] font-mono text-text-muted mt-2">Querying Athena…</p>
      </div>
    );
  } else if (error) {
    body = <div className="py-8 text-center"><p className="text-[12px] text-status-error-text">{error}</p></div>;
  } else if (!rows.length) {
    body = <div className="py-8 text-center"><p className="text-[12px] text-text-muted font-mono">No data for this period</p></div>;
  } else {
    body = render(rows);
  }

  return (
    <div className="bg-surface-primary border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">{title}</h3>
        <span className="text-[9px] font-mono text-text-muted/60">Live query</span>
      </div>
      <div style={{ minHeight }}>{body}</div>
      {showLatency && executionMs != null && !error && (
        <p className="text-[9px] font-mono text-text-muted text-right mt-2">
          Athena over Iceberg · {executionMs}ms
        </p>
      )}
    </div>
  );
}
