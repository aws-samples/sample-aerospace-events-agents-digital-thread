import { useState, useCallback, useEffect, useRef } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Search, Loader2, Sparkles, Database, RotateCcw, CornerDownRight } from 'lucide-react';
import { useAgUiStream } from '../../hooks/useAgUiStream';
import { AgentBlock } from './AgentWidgets';
import { WidgetErrorBoundary } from '../ui/WidgetErrorBoundary';

const EXAMPLES = [
  'Top parts by defect count',
  'Event volume by domain over the last 30 days',
  'Share of NCRs by supplier',
  'How many open NCRs are there?',
  'Earned-value trend for ARES-1',
];

/**
 * Ask the datalake — the AG-UI analytics agent. Questions stream back over the
 * AG-UI protocol as the widgets the agent chose (charts / table / prose), each
 * painted with the app's native components. It is a CONVERSATION: follow-up
 * questions build on the previous answer (e.g. "of those, just the 44821
 * family") — every turn stays on screen until you start a new conversation.
 * Chat layout: the thread reads top-to-bottom and the composer sits at the
 * bottom, beneath the latest answer. Beyond text-to-SQL: the agent runs Athena
 * over Iceberg itself and composes the answer.
 */
export function AskDatalakeAgent() {
  const [question, setQuestion] = useState('');
  const { turns, running, error, ask, reset } = useAgUiStream();
  const started = turns.length > 0;

  // Chat autoscroll. The page (window) is the scroll container. A sentinel at
  // the end of the card is kept in view as turns/blocks stream in — but only
  // while the user is near the bottom, so scrolling up to read a prior turn is
  // never yanked back down.
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      const el = document.scrollingElement || document.documentElement;
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Fires on every turn/blocks update (immutable updates change `turns`), so it
  // tracks the growing answer as it streams, not just the turn start.
  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const run = useCallback(async (q: string) => {
    const text = q.trim();
    if (!text || running) return;
    setQuestion('');
    stickRef.current = true; // a new question re-pins the view to the bottom
    let token: string | undefined;
    try {
      token = (await fetchAuthSession()).tokens?.idToken?.toString();
    } catch {
      /* local dev: agent may accept unauthenticated */
    }
    ask(text, token);
  }, [running, ask]);

  const lastTurn = turns[turns.length - 1];
  const awaitingFirstWidget = running && lastTurn && lastTurn.blocks.length === 0;

  return (
    <div className="bg-surface-primary border border-border rounded-xl p-5">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-accent" />
            <h3 className="text-[15px] font-bold text-text-primary">Ask the datalake</h3>
            <span className="text-[9px] font-mono text-text-muted uppercase tracking-wide border border-border rounded px-1.5 py-0.5">
              AG-UI · generative
            </span>
          </div>
          <p className="text-[12px] text-text-tertiary mt-0.5">
            Ask in plain language, then follow up — the analytics agent keeps the thread, queries Athena over Iceberg and composes each answer as charts, tables and prose.
          </p>
        </div>
        {started && (
          <button onClick={reset} disabled={running}
            className="shrink-0 flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary hover:text-text-primary border border-border rounded-lg px-2.5 py-1.5 transition-colors disabled:opacity-50">
            <RotateCcw size={12} /> New conversation
          </button>
        )}
      </div>

      {error && (
        <div className="bg-status-error-subtle border border-status-error/20 rounded-lg p-3 mb-3">
          <p className="text-[12px] text-status-error-text">{error}</p>
        </div>
      )}

      {/* Conversation thread — each turn: the question, then the widgets the
          agent chose for it. Prior turns stay so follow-ups read in context.
          Reads top-to-bottom; the composer is beneath it. */}
      {started && (
        <div className="space-y-5 mb-4">
          {turns.map((turn) => (
            <div key={turn.id} className="space-y-3">
              <div className="flex items-center gap-2">
                <CornerDownRight size={13} className="text-accent shrink-0" />
                <p className="text-[13px] font-semibold text-text-primary">{turn.question}</p>
              </div>
              {turn.blocks.map((b) => (
                <div key={b.id} className="bg-surface-secondary border border-border rounded-lg p-4">
                  <WidgetErrorBoundary label={`${b.kind} widget`}>
                    <AgentBlock block={b} />
                  </WidgetErrorBoundary>
                </div>
              ))}
            </div>
          ))}

          {awaitingFirstWidget && (
            <div className="flex items-center gap-2 py-6 justify-center text-[12px] font-mono text-text-muted">
              <Loader2 size={14} className="animate-spin text-accent" />
              <Database size={11} className="inline" /> the agent is querying Athena over Iceberg…
            </div>
          )}

          <p className="text-[9px] font-mono text-text-muted text-right">
            Composed live by the analytics agent · Athena over Iceberg
          </p>
        </div>
      )}

      {/* Composer — at the bottom, beneath the latest answer (chat convention) */}
      <div className="flex items-center gap-3">
        <div className="flex-1 flex items-center gap-2 bg-surface-secondary border border-border rounded-lg px-3 py-2">
          <Search size={14} className="text-text-muted" />
          <input
            type="text" value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(question); }}
            className="flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder-text-muted"
            placeholder={started ? 'Ask a follow-up… e.g. "of those, just the 44821 family"' : 'e.g. Which suppliers had the most critical defects last month?'}
          />
        </div>
        <button onClick={() => run(question)} disabled={running}
          className="px-4 py-2 text-[12px] font-bold text-white bg-accent rounded-lg hover:bg-accent-hover transition-colors uppercase tracking-wide disabled:opacity-50 min-w-[64px] flex items-center justify-center">
          {running ? <Loader2 size={14} className="animate-spin" /> : started ? 'Send' : 'Ask'}
        </button>
      </div>

      {/* Example chips — starters, and quick follow-ups mid-conversation */}
      <div className="flex flex-wrap gap-2 mt-3">
        {EXAMPLES.map((q) => (
          <button key={q} onClick={() => run(q)} disabled={running}
            className="text-[11px] px-2.5 py-1 rounded-full bg-surface-secondary text-text-tertiary border border-border hover:text-text-primary hover:border-border-strong transition-colors disabled:opacity-50">
            {q}
          </button>
        ))}
      </div>

      {/* Autoscroll sentinel — kept in view as the answer streams (see effects) */}
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}
