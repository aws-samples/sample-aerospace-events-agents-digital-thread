import { useMemo, useCallback } from 'react';
import { useEventContext } from '../context/EventProvider';

export type HITLQuestion = {
  taskId: string;
  sessionId: string;
  agentName: string;
  domainId: string;
  question: string;
  options: string[];
  evidence: string;
  priority: string;
  status: string;
  answer?: string;
  correlationId?: string;
  sourceEventId?: string;
  createdAt: number;
  answeredAt?: number;
};

/**
 * Read HITL questions from the global EventProvider, optionally filtered by domain.
 * Subscriptions persist across page navigation — no questions lost.
 */
export function useHITLQuestions(domainId?: string) {
  const { hitlAll, answerQuestion: ctxAnswer } = useEventContext();

  const questions = useMemo(
    () => domainId ? hitlAll.filter((q) => q.domainId === domainId) : hitlAll,
    [hitlAll, domainId],
  );

  const answerQuestion = useCallback(
    (taskId: string, answer: string) => ctxAnswer(taskId, answer),
    [ctxAnswer],
  );

  return { questions, loading: false, answerQuestion };
}
