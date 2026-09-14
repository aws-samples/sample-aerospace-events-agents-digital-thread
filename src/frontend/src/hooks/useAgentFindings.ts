import { useMemo } from 'react';
import { useEventContext } from '../context/EventProvider';

export type AgentFinding = {
  findingId: string;
  agentName: string;
  domain: string;
  entityId: string;
  summary: string;
  action: string;
  evidence: string;
  sessionId?: string;
  correlationId?: string;
  sourceEventId?: string;
  createdAt: string;
};

/**
 * Read agent findings for a domain from the global EventProvider.
 * Subscriptions persist across page navigation — no findings lost.
 */
export function useAgentFindings(domain: string) {
  const { findingsAll } = useEventContext();

  const findings = useMemo(
    () => findingsAll.filter((f) => f.domain === domain),
    [findingsAll, domain],
  );

  return { findings, loading: false };
}
