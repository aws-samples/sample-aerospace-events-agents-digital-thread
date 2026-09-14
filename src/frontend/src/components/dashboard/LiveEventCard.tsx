/**
 * Shared live event card — clickable to open TraceDrawer.
 * Used across all dashboard event feeds.
 */

import type { DashboardEvent } from '../../hooks/useDashboardEvents';

export function LiveEventCard({ event, onClick }: { event: DashboardEvent; onClick?: () => void }) {
  const payload = event.payload ?? {};
  const time = new Date(event.occurredAt).toLocaleTimeString();

  return (
    <div
      className={`px-4 py-2.5 border-b border-border/40 hover:bg-surface-secondary transition-colors ${onClick ? 'cursor-pointer' : ''}`}
      style={{ animation: 'fade-in 0.2s ease-out' }}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[11px] font-mono font-semibold text-accent">
          {event.eventType.replace(/_/g, ' ')}
        </span>
        <span className="text-[10px] font-mono text-text-muted">{time}</span>
      </div>
      <div className="flex items-center gap-3 text-[11px] text-text-secondary">
        <span className="font-mono">{event.entityId}</span>
        {payload.partNumber && <span>P/N {payload.partNumber}</span>}
        {payload.severity && <span className="text-text-tertiary">{payload.severity}</span>}
        {payload.supplierId && <span className="text-text-tertiary">{payload.supplierId}</span>}
        {payload.machineId && <span className="text-text-tertiary">{payload.machineId}</span>}
      </div>
    </div>
  );
}
