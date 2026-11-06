import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { useResource } from '../hooks';

interface RecentItem {
  id: string;
  branch: string;
  state: string;
  lastActiveAt: string;
  applicationId: string;
  applicationName: string;
  clientName: string;
  environmentName: string;
  sessionId: string | null;
  sessionTitle: string | null;
  sessionUpdatedAt: string | null;
  sessionCount: number;
  running: boolean;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function HomePage() {
  const { me } = useAuth();
  const recent = useResource<RecentItem[]>('/me/recent');
  const first = me?.user.displayName.split(' ')[0];

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Welcome back{first ? `, ${first}` : ''}</h1>
        <Link to="/clients" className="btn">All clients</Link>
      </div>

      <section className="stack" aria-labelledby="continue">
        <h2 id="continue" style={{ margin: 0 }}>Continue where you left off</h2>
        {recent.loading && !recent.data && <p className="muted">Loading…</p>}
        {recent.error && <p className="error">{recent.error.message}</p>}
        {recent.data?.length === 0 && (
          <div className="card muted">
            No workspaces yet. Open a <Link to="/clients">client</Link>, pick an application and create a workspace to start working with Claude.
          </div>
        )}
        <div className="recent-grid">
          {recent.data?.map((r) => (
            <Link key={r.id} to={`/workspaces/${r.id}${r.sessionId ? `?session=${r.sessionId}` : ''}`} className="card recent-card">
              <div className="muted recent-crumbs">{r.clientName} / {r.applicationName}</div>
              <div className="recent-branch">
                <code>{r.branch}</code> <span className="badge">{r.environmentName}</span>
                {r.running && <span className="badge ok">Claude working</span>}
                {r.state !== 'ready' && <span className="badge warn">{r.state}</span>}
              </div>
              <div className="recent-session">
                {r.sessionTitle ? <>“{r.sessionTitle}”</> : <span className="muted">No conversations yet</span>}
              </div>
              <div className="muted recent-meta">
                {ago(r.sessionUpdatedAt ?? r.lastActiveAt)}
                {r.sessionCount > 1 && <> · {r.sessionCount} conversations</>}
                <span className="recent-cta">Resume →</span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
