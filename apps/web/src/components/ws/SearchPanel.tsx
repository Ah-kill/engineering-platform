import { useMemo, useState, type FormEvent } from 'react';
import { api, type SearchHit, type SearchResult } from '../../api';
import { useAction } from '../../hooks';

/** Code search across the workspace (git grep). Clicking a match opens the file at that line. */
export function SearchPanel({ wsId, onOpen }: { wsId: string; onOpen(path: string, line: number): void }) {
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<SearchResult & { query: string }>();
  const search = useAction(async () => {
    const q = query.trim();
    if (!q) return;
    const params = new URLSearchParams({ q, ...(regex ? { regex: 'true' } : {}) });
    setResult({ ...(await api<SearchResult>('GET', `/workspaces/${wsId}/search?${params}`)), query: q });
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void search.run();
  };
  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const h of result?.hits ?? []) map.set(h.path, [...(map.get(h.path) ?? []), h]);
    return [...map.entries()];
  }, [result]);

  return (
    <div className="side-section search-panel">
      <form className="search-form" onSubmit={submit} role="search">
        <input type="search" aria-label="Search code" placeholder="Search code (Enter)" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} />
        <div className="search-options">
          <label className="checkbox"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> Regular expression</label>
          <button className="small" disabled={search.pending || !query.trim()}>{search.pending ? 'Searching…' : 'Search'}</button>
        </div>
      </form>
      <div className="side-scroll">
        {search.error && <div className="error panel-pad">{search.error}</div>}
        {result && !search.error && (
          <div className="muted search-summary">
            {result.hits.length ? `${result.hits.length}${result.truncated ? '+' : ''} matches in ${groups.length} files` : `No matches for “${result.query}”`}
            {result.truncated && ' (first 200 shown)'}
          </div>
        )}
        <ul className="tree search-results" aria-label="Search results">
          {groups.map(([path, hits]) => (
            <li key={path}>
              <div className="search-file mono" title={path}>{path}</div>
              <ul className="tree">
                {hits.map((h) => (
                  <li key={`${h.line}`}>
                    <button className="tree-row search-hit" onClick={() => onOpen(h.path, h.line)} title={`${h.path}:${h.line}`}>
                      <span className="search-line muted">{h.line}</span>
                      <span className="tree-name mono">{h.text.trim() || ' '}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
