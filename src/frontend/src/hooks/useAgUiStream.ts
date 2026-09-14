// AG-UI stream hook: POST -> SSE against the analytics AG-UI agent, keeping a
// single conversation so questions can build on each other (follow-ups). One
// HttpAgent is reused across asks — it holds the AG-UI thread id and the running
// message history that @ag-ui/client serialises into each RunAgentInput, so the
// agent sees the whole conversation, not a fresh prompt each time. Each ask adds
// a new "turn" (the question + the widgets the agent chose for it); prior turns
// stay on screen. Prose streams as TEXT_MESSAGE_*; render_chart / render_table
// tool calls become widget blocks.
import { useCallback, useRef, useState } from 'react';
import { HttpAgent, type AgentSubscriber } from '@ag-ui/client';

export type Block =
  | { kind: 'prose'; id: string; text: string }
  | { kind: 'chart'; id: string; args: any }
  | { kind: 'table'; id: string; args: any }
  | { kind: 'graph'; id: string; args: any }
  | { kind: 'drawing'; id: string; args: any };

/** One question and the widgets the agent streamed back for it. */
export type Turn = { id: string; question: string; blocks: Block[] };

const AGUI_URL =
  (import.meta as any).env?.VITE_AGUI_URL || 'http://localhost:8080/invocations';

// Keep only the conversational transcript between turns: user questions and the
// agent's PROSE replies. The render_chart / render_table tool calls are frontend
// widgets with no tool-result message, so replaying them leaves an unpaired
// toolUse that Bedrock drops — and it muddies the history. The agent re-queries
// Athena every turn regardless, so the prose transcript is all it needs to
// resolve a follow-up like "of those, just the 44821 family".
function conversationalHistory(messages: any[]): any[] {
  return messages.filter((m) =>
    m.role === 'user'
      ? !m.toolCallId
      : m.role === 'assistant' &&
        !(m.toolCalls && m.toolCalls.length) &&
        !!m.content &&
        String(m.content).trim().length > 0,
  );
}

// Defaults to the analytics runtime; a second console (the thread navigator)
// passes its own runtime URL + session prefix so the two share the transport
// but not the conversation/session.
export function useAgUiStream(opts?: { url?: string; sessionPrefix?: string }) {
  const url = opts?.url || AGUI_URL;
  const sessionPrefix = opts?.sessionPrefix ?? 'agui-analytics';
  const [turns, setTurns] = useState<Turn[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentRef = useRef<HttpAgent | null>(null);
  const seq = useRef(0);

  // Update the blocks of a specific turn (identified by id) immutably.
  const patchTurn = (id: string, fn: (blocks: Block[]) => Block[]) =>
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, blocks: fn(t.blocks) } : t)));

  /** Clear the conversation and start a fresh session on the next ask. */
  const reset = useCallback(() => {
    agentRef.current = null;
    seq.current = 0;
    setTurns([]);
    setError(null);
  }, []);

  const ask = useCallback(async (prompt: string, token?: string) => {
    const text = prompt.trim();
    if (!text || running) return;
    setError(null);
    setRunning(true);

    const turnId = `turn-${seq.current++}`;
    setTurns((prev) => [...prev, { id: turnId, question: text, blocks: [] }]);

    // One agent per conversation. When the endpoint is an AgentCore Runtime,
    // InvokeAgentRuntime requires a session-id header (33+ chars); a stable id
    // for the whole conversation keeps the turns on one server-side session.
    if (!agentRef.current) {
      const headers: Record<string, string> = {
        'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': `${sessionPrefix}-${crypto.randomUUID()}`,
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      agentRef.current = new HttpAgent({ url, headers });
    } else if (token) {
      // Refresh the (rotating) auth token on the existing agent.
      agentRef.current.headers = {
        ...agentRef.current.headers,
        Authorization: `Bearer ${token}`,
      };
    }
    const agent = agentRef.current;

    // Drop prior tool plumbing, keep the prose transcript, then add this question.
    agent.setMessages(conversationalHistory(agent.messages));
    agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: text });

    // Prose is keyed by the AG-UI messageId so multiple assistant messages stay
    // as separate, ordered blocks within this turn; each content event replaces
    // the running buffer for that message.
    const proseIdFor = (messageId: string) => `prose:${turnId}:${messageId}`;

    const subscriber: AgentSubscriber = {
      onTextMessageContentEvent: ({ event, textMessageBuffer }) => {
        const id = proseIdFor(event.messageId);
        patchTurn(turnId, (blocks) => {
          const i = blocks.findIndex((x) => x.id === id);
          if (i >= 0) {
            const next = [...blocks];
            next[i] = { kind: 'prose', id, text: textMessageBuffer };
            return next;
          }
          return [...blocks, { kind: 'prose', id, text: textMessageBuffer }];
        });
      },
      // toolCallArgs is the fully-buffered, JSON-parsed argument object.
      onToolCallEndEvent: ({ toolCallName, toolCallArgs }) => {
        const id = `w-${turnId}-${seq.current++}`;
        if (toolCallName === 'render_chart') {
          patchTurn(turnId, (blocks) => [...blocks, { kind: 'chart', id, args: toolCallArgs }]);
        } else if (toolCallName === 'render_table') {
          patchTurn(turnId, (blocks) => [...blocks, { kind: 'table', id, args: toolCallArgs }]);
        } else if (toolCallName === 'render_graph') {
          patchTurn(turnId, (blocks) => [...blocks, { kind: 'graph', id, args: toolCallArgs }]);
        } else if (toolCallName === 'render_drawing') {
          patchTurn(turnId, (blocks) => [...blocks, { kind: 'drawing', id, args: toolCallArgs }]);
        }
      },
      onRunErrorEvent: ({ event }) => {
        setError(event.message || 'Agent run error');
        setRunning(false);
      },
      onRunFinishedEvent: () => setRunning(false),
    };

    try {
      await agent.runAgent(undefined, subscriber);
    } catch (e: any) {
      setError(e?.message || String(e));
      setRunning(false);
    }
  }, [running, url, sessionPrefix]);

  return { turns, running, error, ask, reset };
}
