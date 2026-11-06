import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api, type AgentEventRow, type AgentSession, type ModelOption } from '../../api';
import { useAction, useResource } from '../../hooks';

interface SessionsResponse { sessions: AgentSession[]; running: boolean; activeSessionId: string | null }

const APPROVE_PLAN = 'The plan is approved. Implement it now, then run the relevant tests and summarise the result.';

export function ChatPanel({ wsId, initialSessionId, defaultModel, onRunFinished, onRunningChange }: {
  wsId: string;
  /** Conversation to open first (from a "Resume" link); otherwise the running or most recent one. */
  initialSessionId?: string | null;
  defaultModel: string;
  onRunFinished(): void;
  onRunningChange(running: boolean): void;
}) {
  const sessions = useResource<SessionsResponse>(`/workspaces/${wsId}/agent/sessions`);
  const models = useResource<{ models: ModelOption[] }>('/models');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<AgentEventRow[]>([]);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'plan' | 'execute'>('plan');
  const [model, setModel] = useState(defaultModel);
  const scroller = useRef<HTMLDivElement>(null);
  const finished = useRef(onRunFinished);
  finished.current = onRunFinished;

  useEffect(() => setModel(defaultModel), [defaultModel]);

  // Pick the running (or most recent) conversation once, on first load. After that,
  // "no conversation selected" means the developer chose to start a new one.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (!autoPicked.current && sessions.data) {
      autoPicked.current = true;
      const requested = sessions.data.sessions.find((x) => x.id === initialSessionId)?.id;
      setSessionId(sessions.data.activeSessionId ?? requested ?? sessions.data.sessions[0]?.id ?? null);
    }
  }, [sessions.data]);

  // Live stream for the selected conversation.
  useEffect(() => {
    setEvents([]);
    if (!sessionId) return;
    let last = 0;
    const es = new EventSource(`/api/agent/sessions/${sessionId}/events?after=0`);
    es.addEventListener('agent', (msg) => {
      const ev = JSON.parse((msg as MessageEvent).data) as AgentEventRow;
      if (Number(ev.id) <= last) return;
      last = Number(ev.id);
      setEvents((prev) => [...prev, ev]);
      if (ev.kind === 'status' && ev.data.state === 'idle') {
        finished.current();
        void sessions.reload();
      }
    });
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 240) el.scrollTop = el.scrollHeight;
  }, [events]);

  const running = useMemo(() => {
    const statuses = events.filter((e) => e.kind === 'status');
    return statuses.at(-1)?.data.state === 'running';
  }, [events]);

  useEffect(() => onRunningChange(running), [running, onRunningChange]);

  const pendingApprovals = useMemo(() => {
    const decided = new Set(events.filter((e) => e.kind === 'approval_decision').map((e) => e.data.approvalId));
    return new Set(events.filter((e) => e.kind === 'approval_request' && !decided.has(e.data.approvalId)).map((e) => e.data.approvalId as string));
  }, [events]);

  const send = useAction(async (text: string, runMode: 'plan' | 'execute', newConversation = false) => {
    const r = await api<{ sessionId: string }>('POST', `/workspaces/${wsId}/agent/run`, {
      prompt: text, mode: runMode, model, sessionId: newConversation ? undefined : sessionId ?? undefined,
    });
    setPrompt('');
    if (r.sessionId !== sessionId) setSessionId(r.sessionId);
    void sessions.reload();
  });
  const stop = useAction(() => api('POST', `/workspaces/${wsId}/agent/cancel`));
  const remove = useAction(async (id: string) => {
    await api('DELETE', `/agent/sessions/${id}`);
    setSessionId(null);
    setEvents([]);
    await sessions.reload();
  });
  const decide = useAction((approvalId: string, allow: boolean) => api('POST', `/workspaces/${wsId}/agent/approvals/${approvalId}`, { allow }));

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (prompt.trim() && !running) void send.run(prompt.trim(), mode);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
  };

  const current = sessions.data?.sessions.find((s) => s.id === sessionId);

  return (
    <div className="chat">
      <div className="chat-head">
        <select aria-label="Conversation" value={sessionId ?? ''} onChange={(e) => setSessionId(e.target.value || null)} disabled={running}>
          <option value="">New conversation</option>
          {sessions.data?.sessions.map((s) => <option key={s.id} value={s.id}>{s.title || 'Untitled'}</option>)}
        </select>
        {current && (
          <span className="muted chat-cost" title={`${current.inputTokens} in / ${current.outputTokens} out tokens`}>
            ${current.costUsd.toFixed(current.costUsd < 1 ? 3 : 2)}
          </span>
        )}
        {current && !running && (
          <button type="button" className="small danger" aria-label="Delete conversation" title="Delete conversation" disabled={remove.pending}
            onClick={() => { if (confirm(`Delete the conversation “${current.title || 'Untitled'}”? This cannot be undone.`)) void remove.run(current.id); }}>
            Delete
          </button>
        )}
      </div>

      <div className="chat-log" ref={scroller} aria-live="polite">
        {!sessionId && (
          <div className="chat-intro muted">
            <p><b>Plan</b>: Claude reads the code and proposes a plan without changing anything.</p>
            <p><b>Execute</b>: Claude edits files and runs commands in this workspace. Risky commands wait for your approval, and nothing is pushed until you do it from Changes.</p>
          </div>
        )}
        {events.map((ev) => (
          <EventView key={ev.id} ev={ev} pending={pendingApprovals} busy={decide.pending || send.pending}
            onDecide={(id, allow) => void decide.run(id, allow)}
            onApprovePlan={() => void send.run(APPROVE_PLAN, 'execute')} running={running} />
        ))}
        {running && <div className="chat-working"><span className="spinner" aria-hidden /> Claude is working…</div>}
      </div>

      <form className="chat-input" onSubmit={submit}>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onKey}
          rows={3}
          placeholder={mode === 'plan' ? 'Describe what you want. Claude will plan first.' : 'Tell Claude what to change.'}
          disabled={running}
        />
        <div className="chat-controls">
          <div className="segmented small" role="radiogroup" aria-label="Mode">
            <button type="button" role="radio" aria-checked={mode === 'plan'} className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>Plan</button>
            <button type="button" role="radio" aria-checked={mode === 'execute'} className={mode === 'execute' ? 'on' : ''} onClick={() => setMode('execute')}>Execute</button>
          </div>
          <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} className="model-select">
            {!models.data?.models.some((m) => m.id === model) && <option value={model}>{model}</option>}
            {models.data?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <span style={{ flex: 1 }} />
          {sessionId && !running && (
            <button type="button" className="small" onClick={() => { setSessionId(null); setEvents([]); }}>New</button>
          )}
          {running ? (
            <button type="button" className="danger" onClick={() => void stop.run()} disabled={stop.pending}>Stop</button>
          ) : (
            <button className="primary" disabled={!prompt.trim() || send.pending}>Send</button>
          )}
        </div>
        {(send.error || stop.error || decide.error || remove.error) && <div className="error">{send.error ?? stop.error ?? decide.error ?? remove.error}</div>}
      </form>
    </div>
  );
}

function toolSummary(name: string, input: Record<string, any>): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return String(input.command ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return String(input.file_path ?? '').replace(/^.*?[\\/]repo[\\/]/, '');
    case 'Grep':
      return `${input.pattern ?? ''}${input.path ? ` in ${input.path}` : ''}`;
    case 'Glob':
      return String(input.pattern ?? '');
    case 'TodoWrite':
      return `${(input.todos as unknown[] | undefined)?.length ?? 0} tasks`;
    case 'WebFetch':
    case 'WebSearch':
      return String(input.url ?? input.query ?? '');
    default:
      return JSON.stringify(input).slice(0, 140);
  }
}

/** Renders text with ``` fenced blocks as code. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```[a-zA-Z0-9-]*\n?/);
  return (
    <div className="rich">
      {parts.map((p, i) => (i % 2 ? <pre key={i} className="code-block">{p.replace(/\n$/, '')}</pre> : <span key={i}>{p}</span>))}
    </div>
  );
}

function EventView({ ev, pending, busy, onDecide, onApprovePlan, running }: {
  ev: AgentEventRow;
  pending: Set<string>;
  busy: boolean;
  running: boolean;
  onDecide(id: string, allow: boolean): void;
  onApprovePlan(): void;
}) {
  const d = ev.data;
  switch (ev.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="msg-meta">{d.mode === 'plan' ? 'Plan' : 'Execute'} · {d.model}</div>
          <RichText text={d.prompt} />
        </div>
      );
    case 'text':
      return <div className="msg assistant"><RichText text={d.text} /></div>;
    case 'tool_use':
      return (
        <details className="tool">
          <summary><span className="tool-name">{d.name}</span> <span className="mono tool-arg">{toolSummary(d.name, d.input ?? {})}</span></summary>
          <pre className="code-block">{JSON.stringify(d.input, null, 2)}</pre>
        </details>
      );
    case 'tool_result':
      return d.isError || d.output ? (
        <details className={`tool result${d.isError ? ' err' : ''}`}>
          <summary>{d.isError ? 'Error output' : 'Output'} <span className="muted">({String(d.output).split('\n').length} lines)</span></summary>
          <pre className="code-block">{d.output}</pre>
        </details>
      ) : null;
    case 'plan':
      return (
        <div className="msg plan">
          <div className="msg-meta">Proposed plan</div>
          <RichText text={d.plan} />
          <div className="form-row" style={{ marginTop: 8 }}>
            <button className="primary" disabled={busy || running} onClick={onApprovePlan}>Approve and execute</button>
            <span className="muted" style={{ fontSize: 12.5 }}>or reply below to change the plan</span>
          </div>
        </div>
      );
    case 'approval_request': {
      const open = pending.has(d.approvalId);
      return (
        <div className="msg approval">
          <div className="msg-meta">Approval needed: {d.reason}</div>
          <pre className="code-block">{d.tool === 'Bash' || d.tool === 'PowerShell' ? d.input?.command : JSON.stringify(d.input, null, 2)}</pre>
          {open && (
            <div className="form-row">
              <button className="primary" disabled={busy} onClick={() => onDecide(d.approvalId, true)}>Allow</button>
              <button className="danger" disabled={busy} onClick={() => onDecide(d.approvalId, false)}>Reject</button>
            </div>
          )}
        </div>
      );
    }
    case 'approval_decision':
      return <div className="note">{d.allow ? 'Allowed' : 'Rejected'}</div>;
    case 'policy_denied':
      return <div className="note warn">Blocked: {d.reason} <code>{toolSummary(d.tool, d.input ?? {})}</code></div>;
    case 'result':
      return (
        <div className={`note${d.isError ? ' warn' : ''}`}>
          {d.isError ? (d.text ? `Stopped: ${d.text}` : `Stopped (${d.subtype})`) : 'Done'} · ${Number(d.costUsd).toFixed(3)} · {Math.round(Number(d.durationMs) / 1000)}s
        </div>
      );
    case 'error':
      return <div className="note warn">{d.message}</div>;
    case 'cancelled':
      return <div className="note">{d.message}</div>;
    default:
      return null;
  }
}
