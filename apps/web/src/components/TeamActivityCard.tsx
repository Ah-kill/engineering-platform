import { useState } from 'react';
import { useResource } from '../hooks';

interface TeamSession {
  id: string; title: string; model: string; costUsd: number; inputTokens: number; outputTokens: number;
  createdAt: string; updatedAt: string; userId: string; userName: string; userEmail: string;
  workspaceId: string; branch: string; workspaceState: string; environmentName: string; environmentKind: string; running: boolean;
}

interface TranscriptEvent { id: string; kind: string; data: Record<string, any>; createdAt: string }
interface Transcript {
  session: { id: string; title: string; model: string; userName: string; branch: string; environmentName: string; costUsd: number };
  events: TranscriptEvent[];
  truncated: boolean;
}

const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const tokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());

/**
 * Team activity for app admins and org admins: every Claude conversation in this
 * application's workspaces, with a read-only transcript viewer.
 */
export function TeamActivityCard({ appId }: { appId: string }) {
  const list = useResource<{ sessions: TeamSession[] }>(`/applications/${appId}/agent/sessions`);
  const [open, setOpen] = useState<string | null>(null);

  if (list.error) return null; // not an admin of this application
  if (!list.data) return null;
  const sessions = list.data.sessions;

  return (
    <div className="card table-wrap" aria-label="Team activity">
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <h2 style={{ margin: 0 }}>Team activity</h2>
          <div className="muted" style={{ fontSize: 13 }}>Claude conversations in every workspace of this application. Transcripts are read-only; secrets were removed when they were recorded.</div>
        </div>
        <button className="small" onClick={() => void list.reload()} disabled={list.loading}>Refresh</button>
      </div>
      {sessions.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>No conversations yet.</p>
      ) : (
        <table>
          <thead><tr><th>Who</th><th>Workspace</th><th>Conversation</th><th>Model</th><th>Cost</th><th>Tokens</th><th>Updated</th><th /></tr></thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td title={s.userEmail}>{s.userName}</td>
                <td><span className="mono">{s.branch}</span> <span className="muted">· {s.environmentName}</span>{s.workspaceState === 'deleted' && <span className="badge"> deleted</span>}</td>
                <td>{s.title || 'Untitled'} {s.running && <span className="badge ok">running</span>}</td>
                <td className="mono muted">{s.model}</td>
                <td>{money(s.costUsd)}</td>
                <td className="muted" title={`${s.inputTokens} in / ${s.outputTokens} out`}>{tokens(s.inputTokens)} / {tokens(s.outputTokens)}</td>
                <td className="muted">{new Date(s.updatedAt).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="small" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                    {open === s.id ? 'Hide' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {open && <TranscriptView sessionId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function TranscriptView({ sessionId, onClose }: { sessionId: string; onClose(): void }) {
  const t = useResource<Transcript>(`/agent/sessions/${sessionId}/transcript`);
  return (
    <section className="stack transcript" aria-label="Transcript" style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div className="page-head">
        <div>
          <h3 style={{ margin: 0 }}>{t.data?.session.title || 'Transcript'}</h3>
          {t.data && (
            <div className="muted" style={{ fontSize: 13 }}>
              {t.data.session.userName} · <span className="mono">{t.data.session.branch}</span> · {t.data.session.environmentName} · {t.data.session.model} · {money(t.data.session.costUsd)}
            </div>
          )}
        </div>
        <button className="small" onClick={onClose}>Close</button>
      </div>
      {t.error && <div className="error">{t.error.message}</div>}
      {!t.data && !t.error && <p className="muted">Loading…</p>}
      {t.data && (
        <div className="stack" style={{ gap: 8 }}>
          {t.data.events.map((ev) => <ReadOnlyEvent key={ev.id} ev={ev} />)}
          {t.data.truncated && <div className="note">Only the first part of this conversation is shown.</div>}
        </div>
      )}
    </section>
  );
}

function toolSummary(name: string, input: Record<string, any>): string {
  if (name === 'Bash' || name === 'PowerShell') return String(input.command ?? '');
  if (input.file_path) return String(input.file_path).replace(/^.*?[\\/]repo[\\/]/, '');
  if (input.pattern) return String(input.pattern);
  return JSON.stringify(input).slice(0, 140);
}

/** A compact, read-only rendering of one stored event (no approve or reply buttons). */
function ReadOnlyEvent({ ev }: { ev: TranscriptEvent }) {
  const d = ev.data;
  switch (ev.kind) {
    case 'user':
      return <div className="msg user"><div className="msg-meta">{d.mode === 'plan' ? 'Plan' : 'Execute'} · {d.model}</div><div className="rich">{d.prompt}</div></div>;
    case 'text':
      return <div className="msg assistant"><div className="rich">{d.text}</div></div>;
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
      return <div className="msg plan"><div className="msg-meta">Proposed plan</div><div className="rich">{d.plan}</div></div>;
    case 'approval_request':
      return (
        <div className="msg approval">
          <div className="msg-meta">Approval asked: {d.reason}</div>
          <pre className="code-block">{d.tool === 'Bash' || d.tool === 'PowerShell' ? d.input?.command : JSON.stringify(d.input, null, 2)}</pre>
        </div>
      );
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
