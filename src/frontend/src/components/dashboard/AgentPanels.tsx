/**
 * Reusable Agent Activity + HITL Pending Actions panels for all dashboards.
 * Each dashboard passes its domain to filter findings/questions by domain.
 */

import { useState, useEffect } from 'react';
import { useAgentFindings, type AgentFinding } from '../../hooks/useAgentFindings';
import { useHITLQuestions, type HITLQuestion } from '../../hooks/useHITLQuestions';
import { TraceDrawer } from './TraceDrawer';
import { Markdown } from '../ui/Markdown';
import { Bot, Clock, CheckCircle, GitBranch } from 'lucide-react';

/**
 * Trace drawer state synced to the URL hash query (`#/path?trace=<correlationId>`),
 * so a cascade trace is shareable/deep-linkable (open via link, not just a click).
 */
function useTraceParam(): [string | null, (id: string | null) => void] {
  const read = () => new URLSearchParams(window.location.hash.split('?')[1] || '').get('trace');
  const [traceId, setTraceId] = useState<string | null>(read);
  useEffect(() => {
    const onHash = () => setTraceId(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const set = (id: string | null) => {
    const [path, query] = window.location.hash.replace(/^#/, '').split('?');
    const params = new URLSearchParams(query || '');
    if (id) params.set('trace', id); else params.delete('trace');
    const qs = params.toString();
    window.location.hash = qs ? `${path}?${qs}` : path;
    setTraceId(id);
  };
  return [traceId, set];
}

function FindingCard({ finding, onClick }: { finding: AgentFinding; onClick?: () => void }) {
  const time = new Date(finding.createdAt).toLocaleTimeString();
  const action = (finding.action || '').toUpperCase();

  const isHumanAuthorized = action === 'ACTED'
    || /human.*(authorized|confirmed|approved|operator)/i.test(finding.summary)
    || /CLOSED TO|HOLD.*by human|MRB CONVENED/i.test(finding.summary);

  const actionConfig = isHumanAuthorized
    ? { label: 'HUMAN DECISION', color: 'text-status-success', bg: 'bg-status-success-subtle', Icon: CheckCircle }
    : action === 'ESCALATE'
    ? { label: 'ESCALATED', color: 'text-status-error', bg: 'bg-status-error-subtle', Icon: Bot }
    : action === 'MONITOR'
    ? { label: 'MONITORING', color: 'text-text-muted', bg: 'bg-surface-tertiary', Icon: Bot }
    : { label: action || 'FINDING', color: 'text-status-purple', bg: 'bg-accent-subtle', Icon: Bot };

  return (
    <div className={`px-4 py-3 border-b border-border/60 ${isHumanAuthorized ? 'bg-status-success-subtle/30' : ''} ${onClick ? 'cursor-pointer hover:bg-surface-secondary transition-colors' : ''}`} onClick={onClick}>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <actionConfig.Icon size={12} className={actionConfig.color} />
          <span className={`text-[11px] font-semibold ${isHumanAuthorized ? 'text-status-success' : 'text-status-purple-text'}`}>
            {finding.agentName}
          </span>
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${actionConfig.bg} ${actionConfig.color}`}>
            {actionConfig.label}
          </span>
        </div>
        <span className="text-[10px] font-mono text-text-muted">{time}</span>
      </div>
      <Markdown>{finding.summary}</Markdown>
    </div>
  );
}

// Consequence each disposition verb carries — the thing the choice actually turns on.
// Keyed on the disposition vocabulary (finite, known), NOT fabricated per-NCR numbers:
// we surface the *kind* of consequence, not an invented cost. (issue #2)
const CONSEQUENCE: { match: RegExp; note: string }[] = [
  { match: /\bREWORK\b/i,             note: 'Retains the lot · adds schedule risk' },
  { match: /\bSCRAP\b/i,              note: 'Clean disposition · highest material cost' },
  { match: /\bUSE[_ ]?AS[_ ]?IS\b/i,  note: 'Requires engineering deviation / DER sign-off' },
  { match: /\bRETURN[_ ]?TO[_ ]?SUPPLIER\b/i, note: 'Re-source from alternate · longest lead time' },
  { match: /\bHOLD\b/i,               note: 'Pauses downstream · pending MRB review' },
  { match: /\b(PARTIAL[_ ]?)?RELEASE\b/i, note: 'Resumes flow · accepts current state' },
  { match: /\bESCALATE\b/i,           note: 'Raises to a higher authority to decide' },
  { match: /\bSCAR\b/i,               note: 'Supplier corrective action raised' },
  { match: /\b(APPROVE|AUTHORI[SZ]E)\b/i, note: 'Proceeds under your authority' },
  { match: /\bMONITOR\b/i,            note: 'No action now · re-evaluate next cycle' },
  { match: /\bAUDIT\b/i,              note: 'On-site supplier audit · holds new POs' },
];

function consequenceFor(option: string): string | null {
  return CONSEQUENCE.find((c) => c.match.test(option))?.note ?? null;
}

function QuestionCard({ question, onAnswer, onTrace }: { question: HITLQuestion; onAnswer: (taskId: string, answer: string) => void; onTrace?: () => void }) {
  return (
    <div className="px-4 py-3 border-b border-border/60">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono font-semibold text-accent">{question.agentName}</span>
          {onTrace && (
            <button onClick={onTrace} className="text-text-muted hover:text-accent transition-colors" title="View trace">
              <GitBranch size={11} />
            </button>
          )}
        </div>
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${
          question.priority === 'CRITICAL' ? 'bg-status-error-subtle text-status-error-text' :
          question.priority === 'HIGH' ? 'bg-status-warning-subtle text-status-warning-text' :
          'bg-surface-tertiary text-text-muted'
        }`}>{question.priority}</span>
      </div>
      <div className="mb-2"><Markdown>{question.question}</Markdown></div>
      {question.evidence && (
        <p className="text-[10px] text-text-muted mb-2 italic">{question.evidence.slice(0, 150)}...</p>
      )}
      {/* Options as full-width decision rows: the disposition + the consequence it carries,
          not truncated pills (fixes the clipped-mid-word defect). */}
      <div className="flex flex-col gap-1.5">
        {question.options.map((opt, i) => {
          const note = consequenceFor(opt);
          return (
            <button
              key={i}
              onClick={() => onAnswer(question.taskId, opt)}
              className="group w-full text-left px-3 py-2 rounded-md bg-accent-subtle
                border border-accent/15 hover:border-accent/40 hover:bg-accent/5 transition-colors"
            >
              <span className="block text-[11px] font-semibold text-accent leading-snug">{opt}</span>
              {note && (
                <span className="block text-[10px] text-text-muted mt-0.5">{note}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Panel({ title, icon, count, children }: {
  title: string; icon: React.ReactNode; count: number; children: React.ReactNode;
}) {
  return (
    <div className="bg-surface-primary border border-border rounded-xl overflow-hidden shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">{title}</h3>
        </div>
        <span className="text-[10px] font-mono text-text-muted">{count} items</span>
      </div>
      <div className="max-h-[400px] overflow-y-auto">{children}</div>
    </div>
  );
}

export function AgentActivityPanel({ domain }: { domain: string }) {
  const { findings } = useAgentFindings(domain);
  const [traceCorrelationId, setTraceCorrelationId] = useTraceParam();

  return (
    <>
      <Panel title="Agent Activity" icon={<Bot size={14} className="text-status-purple" />} count={findings.length}>
        {findings.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-[12px] text-text-muted font-mono">No agent activity yet</p>
          </div>
        ) : (
          findings.map((f) => (
            <FindingCard
              key={f.findingId}
              finding={f}
              onClick={() => setTraceCorrelationId(f.correlationId || f.findingId)}
            />
          ))
        )}
      </Panel>
      {traceCorrelationId && (
        <TraceDrawer correlationId={traceCorrelationId} onClose={() => setTraceCorrelationId(null)} />
      )}
    </>
  );
}

export function HITLPanel({ domainId }: { domainId?: string }) {
  const { questions, answerQuestion } = useHITLQuestions(domainId);
  const [traceCorrelationId, setTraceCorrelationId] = useState<string | null>(null);

  return (
    <>
      <Panel title="Pending Actions" icon={<Clock size={14} className="text-status-info" />} count={questions.length}>
        {questions.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-[12px] text-text-muted font-mono">No pending actions</p>
          </div>
        ) : (
          questions.map((q) => (
            <QuestionCard
              key={q.taskId}
              question={q}
              onAnswer={answerQuestion}
              onTrace={() => setTraceCorrelationId(q.correlationId || q.taskId)}
            />
          ))
        )}
      </Panel>
      {traceCorrelationId && (
        <TraceDrawer correlationId={traceCorrelationId} onClose={() => setTraceCorrelationId(null)} />
      )}
    </>
  );
}
