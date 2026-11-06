import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, type AgentSettings, type GitStatus, type TreeEntry, type Workspace } from '../api';
import { useResource } from '../hooks';
import { FileTree } from '../components/ws/FileTree';
import { EditorPane, type OpenFile } from '../components/ws/EditorPane';
import { ChangesPanel } from '../components/ws/ChangesPanel';
import { ChatPanel } from '../components/ws/ChatPanel';
import { TerminalPanel } from '../components/ws/TerminalPanel';

type MobileTab = 'files' | 'code' | 'claude' | 'changes' | 'terminal';
type SideTab = 'files' | 'changes';
type BottomTab = 'output' | 'terminal';

function useIsCompact() {
  const query = '(max-width: 900px)';
  const [compact, setCompact] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setCompact(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return compact;
}

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const wsId = id!;
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const compact = useIsCompact();
  const [ws, setWs] = useState<Workspace>();
  const [wsError, setWsError] = useState<string>();
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [status, setStatus] = useState<GitStatus>();
  const [files, setFiles] = useState<OpenFile[]>([]);
  const [active, setActive] = useState<string>();
  const [filter, setFilter] = useState('');
  const [mobileTab, setMobileTab] = useState<MobileTab>('claude');
  const [sideTab, setSideTab] = useState<SideTab>('files');
  const [bottomTab, setBottomTab] = useState<BottomTab>('output');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const settings = useResource<AgentSettings>('/me/settings');
  const filesRef = useRef(files);
  filesRef.current = files;

  const log = useCallback((line: string) => setLogLines((l) => [...l.slice(-49), `${new Date().toLocaleTimeString()}  ${line}`]), []);

  // Load the workspace; poll while it is being cloned.
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const w = await api<Workspace>('GET', `/workspaces/${wsId}`);
        if (stop) return;
        setWs(w);
        if (w.state === 'creating') setTimeout(load, 1500);
      } catch (err) {
        if (!stop) setWsError(err instanceof ApiError ? err.message : 'Could not load workspace');
      }
    };
    void load();
    return () => { stop = true; };
  }, [wsId]);

  const refreshTree = useCallback(async () => {
    const r = await api<{ entries: TreeEntry[] }>('GET', `/workspaces/${wsId}/tree`);
    setTree(r.entries);
  }, [wsId]);

  const refreshStatus = useCallback(async () => {
    setStatus(await api<GitStatus>('GET', `/workspaces/${wsId}/git/status`));
  }, [wsId]);

  /** Re-reads open files that have no unsaved edits (Claude may have changed them). */
  const refreshOpenFiles = useCallback(async () => {
    const current = filesRef.current;
    const updated = await Promise.all(
      current.map(async (f) => {
        if (f.value !== f.saved) return f;
        try {
          const r = await api<{ content: string; binary: boolean }>('GET', `/workspaces/${wsId}/file?path=${encodeURIComponent(f.path)}`);
          const diff = f.original !== undefined ? await api<{ original: string }>('GET', `/workspaces/${wsId}/git/diff?path=${encodeURIComponent(f.path)}`) : undefined;
          return { ...f, saved: r.content, value: r.content, binary: r.binary, original: diff?.original ?? f.original };
        } catch {
          return null; // deleted
        }
      }),
    );
    setFiles(updated.filter((f): f is OpenFile => f !== null));
  }, [wsId]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshTree(), refreshStatus(), refreshOpenFiles()]).catch((e: Error) => log(`Refresh failed: ${e.message}`));
  }, [refreshTree, refreshStatus, refreshOpenFiles, log]);

  useEffect(() => {
    if (ws?.state === 'ready') void Promise.all([refreshTree(), refreshStatus()]);
  }, [ws?.state, refreshTree, refreshStatus]);

  const openFile = useCallback(async (path: string, view: 'edit' | 'diff' = 'edit') => {
    const existing = filesRef.current.find((f) => f.path === path);
    if (existing && (view === 'edit' || existing.original !== undefined)) {
      if (view === 'diff') setFiles((fs) => fs.map((f) => (f.path === path ? { ...f, view } : f)));
      setActive(path);
      if (compact) setMobileTab('code');
      return;
    }
    try {
      if (view === 'diff') {
        const d = await api<{ original: string; modified: string; binary: boolean }>('GET', `/workspaces/${wsId}/git/diff?path=${encodeURIComponent(path)}`);
        setFiles((fs) => [
          ...fs.filter((f) => f.path !== path),
          { path, saved: existing?.saved ?? d.modified, value: existing?.value ?? d.modified, binary: d.binary, view: 'diff', original: d.original },
        ]);
      } else {
        const r = await api<{ content: string; binary: boolean }>('GET', `/workspaces/${wsId}/file?path=${encodeURIComponent(path)}`);
        setFiles((fs) => [...fs, { path, saved: r.content, value: r.content, binary: r.binary, view: 'edit' }]);
      }
      setActive(path);
      if (compact) setMobileTab('code');
    } catch (err) {
      log(`Could not open ${path}: ${(err as Error).message}`);
    }
  }, [wsId, compact, log]);

  const saveFile = useCallback(async (path: string) => {
    const f = filesRef.current.find((x) => x.path === path);
    if (!f || f.value === f.saved) return;
    try {
      await api('PUT', `/workspaces/${wsId}/file`, { path, content: f.value });
      setFiles((fs) => fs.map((x) => (x.path === path ? { ...x, saved: f.value } : x)));
      log(`Saved ${path}`);
      void refreshStatus();
    } catch (err) {
      log(`Save failed: ${(err as Error).message}`);
    }
  }, [wsId, log, refreshStatus]);

  const closeFile = (path: string) => {
    const f = files.find((x) => x.path === path);
    if (f && f.value !== f.saved && !confirm(`Discard unsaved changes to ${path}?`)) return;
    const rest = files.filter((x) => x.path !== path);
    setFiles(rest);
    if (active === path) setActive(rest.at(-1)?.path);
  };

  const toggleView = async (path: string) => {
    const f = files.find((x) => x.path === path);
    if (!f) return;
    if (f.view === 'edit') await openFile(path, 'diff');
    else setFiles((fs) => fs.map((x) => (x.path === path ? { ...x, view: 'edit' } : x)));
  };

  const onRunFinished = useCallback(() => {
    setAgentBusy(false);
    void refreshAll();
  }, [refreshAll]);

  const deleteWorkspace = async () => {
    if (!confirm('Delete this workspace? Unpushed work is lost.')) return;
    await api('DELETE', `/workspaces/${wsId}`);
    navigate(ws ? `/applications/${ws.applicationId}` : '/clients');
  };

  if (wsError) return <div className="center"><div className="card"><p className="error">{wsError}</p><Link to="/clients">Back</Link></div></div>;
  if (!ws) return <div className="center muted">Loading workspace…</div>;
  if (ws.state !== 'ready') {
    return (
      <div className="center">
        <div className="card stack" style={{ maxWidth: 480 }}>
          <h2 style={{ margin: 0 }}>{ws.state === 'creating' ? 'Setting up workspace…' : 'Workspace failed'}</h2>
          {ws.state === 'creating' && <p className="muted">Cloning {ws.repoOwner}/{ws.repoName} and checking out <code>{ws.branch}</code>.</p>}
          {ws.error && <pre className="code-block">{ws.error}</pre>}
          {ws.state === 'failed' && (
            <div className="form-row">
              <button className="danger" onClick={() => void deleteWorkspace()}>Delete</button>
              <Link to={`/applications/${ws.applicationId}`}>Back to application</Link>
            </div>
          )}
        </div>
      </div>
    );
  }

  const changeCount = status?.files.length ?? 0;

  const explorer = (
    <div className="side-section">
      <input className="file-filter" placeholder="Search files" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search files" />
      <div className="side-scroll">
        <FileTree entries={tree} changes={status?.files ?? []} activePath={active} onOpen={(p) => void openFile(p)} filter={filter} />
      </div>
    </div>
  );
  const changes = (
    <div className="side-scroll">
      <ChangesPanel wsId={wsId} status={status} busy={agentBusy} log={log} onChanged={refreshAll} onOpenDiff={(p) => void openFile(p, 'diff')} />
    </div>
  );
  const editor = (
    <EditorPane
      files={files} active={active} compact={compact} readOnly={agentBusy}
      onSelect={setActive} onClose={closeFile} onSave={(p) => void saveFile(p)} onToggleView={(p) => void toggleView(p)}
      onChange={(p, v) => setFiles((fs) => fs.map((f) => (f.path === p ? { ...f, value: v } : f)))}
    />
  );
  // The terminal mounts (and connects) only once its tab is opened, then stays mounted.
  const terminalShown = compact ? mobileTab === 'terminal' : bottomTab === 'terminal';
  const terminal = <TerminalPanel key={compact ? 'phone' : 'desktop'} wsId={wsId} active={terminalShown} compact={compact} />;
  const chat = (
    <ChatPanel wsId={wsId} initialSessionId={search.get('session')} defaultModel={settings.data?.defaultModel ?? 'default'} onRunFinished={onRunFinished} onRunningChange={setAgentBusy} />
  );

  return (
    <div className={`ide${compact ? ' compact' : ''}`}>
      <header className="ide-top">
        <Link to={`/applications/${ws.applicationId}`} className="ide-back" aria-label="Back to application">‹</Link>
        <div className="ide-title">
          <div className="ide-crumbs muted">{ws.clientName} / {ws.applicationName}</div>
          <div className="ide-branch"><code>{status?.branch ?? ws.branch}</code> <span className={`badge${ws.environmentKind === 'production' ? ' warn' : ''}`}>{ws.environmentName}</span></div>
        </div>
        <span style={{ flex: 1 }} />
        {!compact && <button className="small" onClick={() => void refreshAll()}>Refresh</button>}
        <button className="small danger" onClick={() => void deleteWorkspace()}>Delete</button>
      </header>

      {compact ? (
        <>
          <div className="ide-mobile-body">
            <div hidden={mobileTab !== 'files'} className="fill">{explorer}</div>
            <div hidden={mobileTab !== 'code'} className="fill">{editor}</div>
            <div hidden={mobileTab !== 'claude'} className="fill">{chat}</div>
            <div hidden={mobileTab !== 'changes'} className="fill">{changes}</div>
            <div hidden={mobileTab !== 'terminal'} className="fill">{terminal}</div>
          </div>
          <nav className="ide-tabbar" aria-label="Workspace">
            {(['files', 'code', 'claude', 'changes', 'terminal'] as MobileTab[]).map((t) => (
              <button key={t} className={mobileTab === t ? 'on' : ''} onClick={() => setMobileTab(t)} aria-current={mobileTab === t}>
                {t === 'files' ? 'Files' : t === 'code' ? 'Code' : t === 'claude' ? 'Claude' : t === 'terminal' ? 'Terminal' : `Changes${changeCount ? ` (${changeCount})` : ''}`}
              </button>
            ))}
          </nav>
        </>
      ) : (
        <div className="ide-body">
          <aside className="ide-side">
            <div className="side-tabs" role="tablist">
              <button role="tab" aria-selected={sideTab === 'files'} className={sideTab === 'files' ? 'on' : ''} onClick={() => setSideTab('files')}>Files</button>
              <button role="tab" aria-selected={sideTab === 'changes'} className={sideTab === 'changes' ? 'on' : ''} onClick={() => setSideTab('changes')}>
                Changes{changeCount ? ` (${changeCount})` : ''}
              </button>
            </div>
            {sideTab === 'files' ? explorer : changes}
          </aside>
          <main className="ide-main">
            {editor}
            <div className={`ide-bottom${bottomTab === 'terminal' ? ' terminal' : ''}`}>
              <div className="bottom-tabs" role="tablist" aria-label="Bottom panel">
                <button role="tab" aria-selected={bottomTab === 'output'} className={bottomTab === 'output' ? 'on' : ''} onClick={() => setBottomTab('output')}>Output</button>
                <button role="tab" aria-selected={bottomTab === 'terminal'} className={bottomTab === 'terminal' ? 'on' : ''} onClick={() => setBottomTab('terminal')}>Terminal</button>
              </div>
              <div className="ide-log mono" aria-label="Output" hidden={bottomTab !== 'output'}>
                {logLines.length ? logLines.map((l, i) => <div key={i}>{l}</div>) : <div className="muted">Git and file output appears here.</div>}
              </div>
              <div className="ide-term" hidden={bottomTab !== 'terminal'}>{terminal}</div>
            </div>
          </main>
          <section className="ide-chat">{chat}</section>
        </div>
      )}
    </div>
  );
}
