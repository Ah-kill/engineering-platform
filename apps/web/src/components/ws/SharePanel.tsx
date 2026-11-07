import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ShareCandidate, type WorkspaceMembers } from '../../api';
import { useAction, useResource } from '../../hooks';

/**
 * Who has access to a workspace. The owner adds and removes people (they must have working
 * access to the environment); members see the list and can leave. Each person's own Claude
 * and GitHub credentials are used for what they do.
 */
export function SharePanel({ wsId, userId, applicationId, onClose }: { wsId: string; userId: string; applicationId: string; onClose(): void }) {
  const navigate = useNavigate();
  const members = useResource<WorkspaceMembers>(`/workspaces/${wsId}/members`);
  const canManage = !!members.data?.canManage;
  const candidates = useResource<ShareCandidate[]>(canManage ? `/workspaces/${wsId}/members/candidates` : null);
  const [who, setWho] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (candidates.data && !candidates.data.some((c) => c.id === who)) setWho(candidates.data[0]?.id ?? '');
  }, [candidates.data, who]);

  const reload = async () => {
    await members.reload();
    if (canManage) await candidates.reload();
  };
  const add = useAction(async () => {
    await api('PUT', `/workspaces/${wsId}/members/${who}`, { role });
    await reload();
  });
  const change = useAction(async (memberId: string, newRole: 'viewer' | 'editor') => {
    await api('PUT', `/workspaces/${wsId}/members/${memberId}`, { role: newRole });
    await reload();
  });
  const remove = useAction(async (memberId: string) => {
    await api('DELETE', `/workspaces/${wsId}/members/${memberId}`);
    if (memberId === userId) navigate(`/applications/${applicationId}`);
    else await reload();
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (who) void add.run();
  };
  const error = add.error ?? change.error ?? remove.error ?? members.error?.message;

  return (
    <div className="review-backdrop" role="dialog" aria-modal="true" aria-label="Share workspace" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card share-dialog stack">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <h2 style={{ margin: 0 }}>Share workspace</h2>
          <button className="small" onClick={onClose}>Close</button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          <b>Viewers</b> read files, history and diffs. <b>Editors</b> can also edit, commit, push and work with Claude, using their own credentials.
          Only you can delete the workspace or change who has access.
        </p>
        {members.data && (
          <ul className="share-list">
            <li>
              <span className="share-name"><b>{members.data.owner.displayName}</b> <span className="muted">{members.data.owner.email}</span></span>
              <span className="badge ok">owner</span>
            </li>
            {members.data.members.map((m) => (
              <li key={m.userId}>
                <span className="share-name"><b>{m.displayName}</b> <span className="muted">{m.email}</span></span>
                {canManage ? (
                  <select aria-label={`Access for ${m.displayName}`} value={m.role} disabled={change.pending}
                    onChange={(e) => void change.run(m.userId, e.target.value as 'viewer' | 'editor')}>
                    <option value="viewer">Can view</option>
                    <option value="editor">Can edit</option>
                  </select>
                ) : (
                  <span className="badge">{m.role === 'viewer' ? 'can view' : 'can edit'}</span>
                )}
                {(canManage || m.userId === userId) && (
                  <button className="small danger" disabled={remove.pending}
                    onClick={() => { if (confirm(m.userId === userId ? 'Leave this workspace?' : `Remove ${m.displayName}?`)) void remove.run(m.userId); }}>
                    {m.userId === userId ? 'Leave' : 'Remove'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && candidates.data && (
          candidates.data.length ? (
            <form className="form-row" onSubmit={submit}>
              <label style={{ flex: '2 1 200px' }}>
                Person
                <select value={who} onChange={(e) => setWho(e.target.value)}>
                  {candidates.data.map((c) => <option key={c.id} value={c.id}>{c.displayName} ({c.email})</option>)}
                </select>
              </label>
              <label style={{ flex: '1 1 120px' }}>
                Access
                <select value={role} onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}>
                  <option value="viewer">Can view</option>
                  <option value="editor">Can edit</option>
                </select>
              </label>
              <button className="primary" disabled={add.pending || !who}>Share</button>
            </form>
          ) : (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>Nobody else has working access to this environment yet. An app admin can grant it.</p>
          )
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
