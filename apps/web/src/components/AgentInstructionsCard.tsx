import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAction, useResource } from '../hooks';

const MAX_CHARS = 20_000;

/**
 * Project instructions for Claude, per application. App admins edit them; everyone else who
 * can see the application reads them. They are added to Claude's system prompt below the
 * platform's own rules, which always win, and files in the repository cannot override them.
 */
export function AgentInstructionsCard({ appId, canEdit }: { appId: string; canEdit: boolean }) {
  const app = useResource<{ agentInstructions?: string }>(`/applications/${appId}`);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (app.data) setText(app.data.agentInstructions ?? '');
  }, [app.data]);

  const save = useAction(async () => {
    await api('PATCH', `/applications/${appId}`, { agentInstructions: text });
    setSaved(true);
    await app.reload();
  });

  if (!app.data) return null;
  const current = app.data.agentInstructions ?? '';
  const dirty = text.trim() !== current;

  return (
    <form className="card stack" aria-label="Project instructions for Claude" onSubmit={(e) => { e.preventDefault(); setSaved(false); void save.run(); }}>
      <div>
        <h2 style={{ margin: 0 }}>Project instructions for Claude</h2>
        <div className="muted" style={{ fontSize: 13 }}>
          Added to every Claude run in this application, below the platform's own rules (which always take precedence).
          Files in the repository, such as CLAUDE.md, cannot override them.
        </div>
      </div>
      {canEdit ? (
        <label>
          Instructions
          <textarea
            rows={8}
            spellCheck
            maxLength={MAX_CHARS}
            value={text}
            onChange={(e) => { setText(e.target.value); setSaved(false); }}
            placeholder={'Use pnpm, not npm.\nMoney amounts are integers in cents.\nRun `pnpm test` before you finish.'}
          />
        </label>
      ) : current ? (
        <pre className="code-block" style={{ margin: 0 }}>{current}</pre>
      ) : (
        <p className="muted" style={{ margin: 0 }}>No project instructions yet. An app admin can add them.</p>
      )}
      {canEdit && (
        <div className="form-row" style={{ alignItems: 'center' }}>
          <button className="primary" disabled={save.pending || !dirty}>Save instructions</button>
          <span className="muted" style={{ fontSize: 12.5 }}>{text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters</span>
          {saved && !save.error && !dirty && <span className="badge ok">Saved. Applies from the next Claude run.</span>}
        </div>
      )}
      {save.error && <div className="error">{save.error}</div>}
    </form>
  );
}
