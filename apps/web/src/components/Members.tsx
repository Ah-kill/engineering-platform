import { useState, type FormEvent } from 'react';
import { api, type GrantRow, type Role } from '../api';
import { useAction, useResource } from '../hooks';

const ROLE_LABEL: Record<Role, string> = {
  viewer: 'Viewer',
  developer: 'Developer',
  app_admin: 'App admin',
  app_creator: 'App creator',
};

interface Props {
  scopeType: 'client' | 'application' | 'environment';
  scopeId: string;
  canManage: boolean;
  /** Environments the user can grant on, shown as extra targets (application scope only). */
  environments?: { id: string; name: string; protected: boolean }[];
  allowCreatorRole?: boolean;
  /** Only org admins may grant on protected environments. */
  isOrgAdmin?: boolean;
}

export function Members({ scopeType, scopeId, canManage, environments = [], allowCreatorRole, isOrgAdmin }: Props) {
  const grants = useResource<GrantRow[]>(`/grants?scopeType=${scopeType}&scopeId=${scopeId}`);
  const envName = (id: string) => environments.find((e) => e.id === id)?.name;

  const revoke = useAction(async (id: string) => {
    await api('DELETE', `/grants/${id}`);
    await grants.reload();
  });

  const scopeLabel = (g: GrantRow) => {
    if (g.scopeType === scopeType) return <span className="muted">this {scopeType}</span>;
    if (g.scopeType === 'environment') return <span className="badge">{envName(g.scopeId) ?? 'environment'}</span>;
    return <span className="muted">from {g.scopeType}</span>;
  };

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Access</h2>
      {grants.error && <div className="error">{grants.error.message}</div>}
      {grants.data?.length === 0 && <p className="muted" style={{ margin: 0 }}>Nobody has been granted access here yet.</p>}
      {grants.data && grants.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Developer</th><th>Role</th><th>Where</th><th /></tr></thead>
            <tbody>
              {grants.data.map((g) => (
                <tr key={g.id}>
                  <td>{g.displayName} <span className="muted">{g.email}</span></td>
                  <td>{ROLE_LABEL[g.role]}</td>
                  <td>{scopeLabel(g)}{g.expiresAt && <span className="muted"> · until {new Date(g.expiresAt).toLocaleDateString()}</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    {canManage && !g.inherited && (
                      <button className="small danger" disabled={revoke.pending} onClick={() => void revoke.run(g.id)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revoke.error && <div className="error">{revoke.error}</div>}
      {canManage && (
        <AddGrant
          scopeType={scopeType}
          scopeId={scopeId}
          environments={environments.filter((e) => !e.protected || isOrgAdmin)}
          allowCreatorRole={allowCreatorRole}
          onAdded={grants.reload}
        />
      )}
    </div>
  );
}

function AddGrant(props: {
  scopeType: Props['scopeType'];
  scopeId: string;
  environments: { id: string; name: string }[];
  allowCreatorRole?: boolean;
  onAdded(): Promise<void>;
}) {
  const directory = useResource<{ id: string; email: string; displayName: string }[]>('/users/directory');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<Role>('developer');
  const [target, setTarget] = useState(`${props.scopeType}:${props.scopeId}`);

  const action = useAction(async () => {
    const [scopeType, scopeId] = target.split(':');
    await api('POST', '/grants', { userId, role, scopeType, scopeId });
    setUserId('');
    await props.onAdded();
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run();
  };

  const roles: Role[] = ['viewer', 'developer', 'app_admin', ...(props.allowCreatorRole ? (['app_creator'] as Role[]) : [])];

  return (
    <form className="form" onSubmit={submit}>
      <div className="form-row">
        <label>
          Developer
          <select required value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose…</option>
            {directory.data?.map((u) => <option key={u.id} value={u.id}>{u.displayName} ({u.email})</option>)}
          </select>
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        {props.environments.length > 0 && (
          <label>
            On
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value={`${props.scopeType}:${props.scopeId}`}>Whole {props.scopeType}</option>
              {props.environments.map((env) => <option key={env.id} value={`environment:${env.id}`}>{env.name} only</option>)}
            </select>
          </label>
        )}
        <button className="primary" disabled={action.pending}>Grant access</button>
      </div>
      {action.error && <div className="error">{action.error}</div>}
    </form>
  );
}
