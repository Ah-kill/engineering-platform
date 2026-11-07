import { useEffect, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import '../../monaco';
import type { CommitSummary, FileVersions } from '../../api';

const LETTER: Record<FileVersions['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T' };
const STATUS_CLASS: Record<FileVersions['status'], string> = {
  added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed', copied: 'added', typechange: 'modified',
};

function useDark() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setDark(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return dark;
}

/**
 * Read-only review of a set of changed files (a commit, or a branch comparison): a file list
 * and Monaco's diff view. Full screen on phones, a large dialog on desktop.
 */
export function DiffReview(props: {
  title: string;
  subtitle?: React.ReactNode;
  files: FileVersions[];
  truncated?: boolean;
  commits?: CommitSummary[];
  compact: boolean;
  onOpenCommit?(sha: string): void;
  onClose(): void;
}) {
  const dark = useDark();
  const [index, setIndex] = useState(0);
  const file = props.files[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div className="review-backdrop" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className={`review${props.compact ? ' compact' : ''}`}>
        <header className="review-head">
          <div className="review-title">
            <b>{props.title}</b>
            {props.subtitle && <div className="muted review-sub">{props.subtitle}</div>}
          </div>
          <button className="small" onClick={props.onClose} aria-label="Close review">Close</button>
        </header>
        <div className="review-body">
          <aside className="review-side">
            {props.commits && props.commits.length > 0 && (
              <details className="review-commits" open={!props.compact}>
                <summary>{props.commits.length} commit{props.commits.length === 1 ? '' : 's'}</summary>
                <ul className="change-list">
                  {props.commits.map((c) => (
                    <li key={c.sha}>
                      <button className="change-row" onClick={() => props.onOpenCommit?.(c.sha)} title={`${c.author}, ${new Date(c.date).toLocaleString()}`}>
                        <code className="muted">{c.sha.slice(0, 7)}</code>
                        <span className="tree-name">{c.subject}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {props.compact ? (
              <label className="review-file-select">
                File
                <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
                  {props.files.map((f, i) => <option key={f.path} value={i}>{LETTER[f.status]}  {f.path}</option>)}
                </select>
              </label>
            ) : (
              <ul className="change-list" aria-label="Changed files">
                {props.files.map((f, i) => (
                  <li key={f.path}>
                    <button className={`change-row st-${STATUS_CLASS[f.status]}${i === index ? ' on' : ''}`} onClick={() => setIndex(i)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                      <span className="tree-status">{LETTER[f.status]}</span>
                      <span className="tree-name">{f.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!props.files.length && <div className="muted panel-pad">No file changes.</div>}
            {props.truncated && <div className="muted panel-pad" style={{ fontSize: 12.5 }}>Only the first 100 files are listed.</div>}
          </aside>
          <div className="review-diff">
            {file && (
              <>
                <div className="editor-bar">
                  <span className="mono muted editor-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                </div>
                {file.binary || file.omitted ? (
                  <div className="editor-empty muted">{file.binary ? 'Binary file, not shown.' : 'Too large or too many files to show here.'}</div>
                ) : (
                  <div className="editor-host">
                    <DiffEditor
                      key={`${props.title}:${file.path}`}
                      original={file.original}
                      modified={file.modified}
                      originalModelPath={`review-a://${index}/${file.path}`}
                      modifiedModelPath={`review-b://${index}/${file.path}`}
                      theme={dark ? 'vs-dark' : 'vs'}
                      options={{
                        readOnly: true, originalEditable: false, renderSideBySide: !props.compact, automaticLayout: true,
                        minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, wordWrap: props.compact ? 'on' : 'off',
                      }}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
