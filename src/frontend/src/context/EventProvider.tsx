/**
 * Global event subscription provider — subscribes to ALL AppSync channels once,
 * persists events across page navigation. Hooks read from this context.
 */

import { createContext, useContext, useEffect, useRef, useCallback, useState, type ReactNode } from 'react';
import { generateClient } from 'aws-amplify/api';
import {
  onDashboardEvent,
  listAgentFindings,
  onCreateAgentFinding,
  listHITLQuestions,
  answerHITLQuestion as answerMutation,
  onCreateHITLQuestion,
  onAnswerHITLQuestion,
} from '../lib/graphql/operations';
import type { DashboardEvent } from '../hooks/useDashboardEvents';
import type { AgentFinding } from '../hooks/useAgentFindings';
import type { HITLQuestion } from '../hooks/useHITLQuestions';

const MAX_EVENTS = 50;
const CHANNELS = ['quality', 'shop-floor', 'supply-chain', 'program', 'in-service'];

let _client: ReturnType<typeof generateClient> | null = null;
function getClient() {
  if (!_client) _client = generateClient();
  return _client;
}

type EventContextValue = {
  eventsMap: Record<string, DashboardEvent[]>;
  findingsAll: AgentFinding[];
  hitlAll: HITLQuestion[];
  answerQuestion: (taskId: string, answer: string) => Promise<void>;
  clearAll: () => void;
  connected: boolean;
};

const EventContext = createContext<EventContextValue>({
  eventsMap: {},
  findingsAll: [],
  hitlAll: [],
  answerQuestion: async () => {},
  clearAll: () => {},
  connected: false,
});

export function useEventContext() {
  return useContext(EventContext);
}

export function EventProvider({ children }: { children: ReactNode }) {
  const [eventsMap, setEventsMap] = useState<Record<string, DashboardEvent[]>>({});
  const [findingsAll, setFindingsAll] = useState<AgentFinding[]>([]);
  const [hitlAll, setHitlAll] = useState<HITLQuestion[]>([]);
  const [connected, setConnected] = useState(false);
  const subsRef = useRef<any[]>([]);

  // --- Dashboard event subscriptions (5 channels) ---
  useEffect(() => {
    const client = getClient();
    const subs: any[] = [];

    for (const channel of CHANNELS) {
      const sub = (client.graphql({
        query: onDashboardEvent,
        variables: { channel },
      }) as any).subscribe({
        next: ({ data }: any) => {
          const event = data?.onDashboardEvent;
          if (!event) return;

          let payload = event.payload;
          if (typeof payload === 'string') {
            try { payload = JSON.parse(payload); } catch {}
          }

          const parsed: DashboardEvent = { ...event, payload };
          setEventsMap((prev) => ({
            ...prev,
            [channel]: [parsed, ...(prev[channel] ?? [])].slice(0, MAX_EVENTS),
          }));
        },
        error: (err: any) => console.error(`[EventProvider] Dashboard sub error (${channel}):`, err),
      });
      subs.push(sub);
    }

    setConnected(true);
    subsRef.current.push(...subs);
    return () => subs.forEach((s) => s.unsubscribe());
  }, []);

  // --- Agent findings: initial query + subscription ---
  useEffect(() => {
    const client = getClient();

    // Initial load (all domains)
    (async () => {
      try {
        const result = await client.graphql({
          query: listAgentFindings,
          variables: { limit: MAX_EVENTS },
        });
        const items = (result as any).data?.listAgentFindings?.items ?? [];
        items.sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        setFindingsAll(items);
      } catch (err) {
        console.error('[EventProvider] Agent findings query error:', err);
      }
    })();

    // Subscribe (no domain filter — receive all)
    const sub = (client.graphql({
      query: onCreateAgentFinding,
    }) as any).subscribe({
      next: ({ data }: any) => {
        const finding = data?.onCreateAgentFinding;
        if (!finding) return;
        setFindingsAll((prev) => [finding, ...prev].slice(0, MAX_EVENTS));
      },
      error: (err: any) => console.error('[EventProvider] Agent findings sub error:', err),
    });

    subsRef.current.push(sub);
    return () => sub.unsubscribe();
  }, []);

  // --- HITL questions: initial query + create/answer subscriptions ---
  useEffect(() => {
    const client = getClient();

    // Initial load (all domains, PENDING only)
    (async () => {
      try {
        const result = await client.graphql({
          query: listHITLQuestions,
          variables: { status: 'PENDING', limit: MAX_EVENTS },
        });
        const items = (result as any).data?.listHITLQuestions?.items ?? [];
        items.sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
        setHitlAll(items);
      } catch (err) {
        console.error('[EventProvider] HITL query error:', err);
      }
    })();

    const createSub = (client.graphql({
      query: onCreateHITLQuestion,
    }) as any).subscribe({
      next: ({ data }: any) => {
        const q = data?.onCreateHITLQuestion;
        if (!q || q.status !== 'PENDING') return;
        setHitlAll((prev) => [q, ...prev].slice(0, MAX_EVENTS));
      },
      error: (err: any) => console.error('[EventProvider] HITL create sub error:', err),
    });

    const answerSub = (client.graphql({
      query: onAnswerHITLQuestion,
    }) as any).subscribe({
      next: ({ data }: any) => {
        const q = data?.onAnswerHITLQuestion;
        if (!q) return;
        setHitlAll((prev) => prev.filter((item) => item.taskId !== q.taskId));
      },
      error: (err: any) => console.error('[EventProvider] HITL answer sub error:', err),
    });

    subsRef.current.push(createSub, answerSub);
    return () => {
      createSub.unsubscribe();
      answerSub.unsubscribe();
    };
  }, []);

  // --- Clear all state (after demo reset) ---
  const clearAll = useCallback(() => {
    setEventsMap({});
    setFindingsAll([]);
    setHitlAll([]);
  }, []);

  // --- Answer mutation ---
  const answerQuestion = useCallback(async (taskId: string, answer: string) => {
    const client = getClient();
    try {
      await client.graphql({
        query: answerMutation,
        variables: {
          input: { taskId, answer, status: 'ANSWERED', answeredAt: Math.floor(Date.now() / 1000) },
        },
      });
      // Optimistic removal
      setHitlAll((prev) => prev.filter((q) => q.taskId !== taskId));
    } catch (err) {
      console.error('[EventProvider] Answer error:', err);
    }
  }, []);

  return (
    <EventContext.Provider value={{ eventsMap, findingsAll, hitlAll, answerQuestion, clearAll, connected }}>
      {children}
    </EventContext.Provider>
  );
}
