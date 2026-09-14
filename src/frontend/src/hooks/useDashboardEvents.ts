import { useMemo } from 'react';
import { useEventContext } from '../context/EventProvider';

export type DashboardEvent = {
  eventId: string;
  eventType: string;
  domain: string;
  entityId: string;
  occurredAt: string;
  channel: string;
  payload: Record<string, any>;
};

/**
 * Read dashboard events for a channel from the global EventProvider.
 * Subscriptions persist across page navigation — no events lost.
 */
export function useDashboardEvents(channel: string) {
  const { eventsMap, connected } = useEventContext();
  const all = eventsMap[channel] ?? [];

  const domainEvents = useMemo(
    () => all.filter((e) => e.eventType !== 'AGENT_FINDING'),
    [all],
  );

  const agentFindings = useMemo(
    () => all.filter((e) => e.eventType === 'AGENT_FINDING'),
    [all],
  );

  return { domainEvents, agentFindings, connected };
}
