import { useEffect, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import '../../monaco';

export interface OpenFile {
  path: string;
  /** Last saved content. */
  saved: string;
  /** Current content in the editor. */
  value: string;
  binary: boolean;
  view: 'edit' | 'diff';
  /** Content at HEAD, for the diff view. */
  original?: string;
}

function useDarkMode() {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setDark(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return dark;
}

export function EditorPane(props: {
  files: OpenFile[];
  active?: string;
  compact: boolean;
  onSelect(path: string): void;
  onClose(path: string): void;
  onChange(path: string, value: string): void;
  onSave(path: string): void;
  onToggleView(path: string): void;
  readOnly: boolean;
}) {
  const dark = useDarkMode();
  const file = props.files.find((f) => f.path === props.active);
  const options = {
    fontSize: props.compact ? 13 : 13.5,
    minimap: { enabled: !props.compact },
    wordWrap: props.compact ? ('on' as const) : ('off' as const),
    scrollBeyondLastLine: false,
    automaticLayout: true,
    readOnly: props.readOnly,
    renderWhitespace: 'selection' as const,
    tabSize: 2,
  };

  return (
    <div className="editor-pane">
      <div className="tabs" role="tablist">
        {props.files.map((f) => {
          const dirty = f.value !== f.saved;
          return (
            <div key={f.path} className={`tab${f.path === props.active ? ' active' : ''}`} role="tab" aria-selected={f.path === props.active}>
              <button className="tab-label" onClick={() => props.onSelect(f.path)} title={f.path}>
                {f.path.split('/').pop()}
                {dirty && <span className="dot" aria-label="unsaved">●</span>}
              </button>
              <button className="tab-close" aria-label={`Close ${f.path}`} onClick={() => props.onClose(f.path)}>×</button>
            </div>
          );
        })}
      </div>

      {!file && <div className="editor-empty muted">Open a file from the explorer, or ask Claude to make a change.</div>}

      {file && (
        <>
          <div className="editor-bar">
            <span className="mono muted editor-path">{file.path}</span>
            <span style={{ flex: 1 }} />
            {file.original !== undefined && (
              <button className="small" onClick={() => props.onToggleView(file.path)}>{file.view === 'diff' ? 'Edit' : 'Show changes'}</button>
            )}
            <button className="small primary" disabled={file.value === file.saved || props.readOnly} onClick={() => props.onSave(file.path)}>Save</button>
          </div>
          <div className="editor-host">
            {file.binary ? (
              <div className="editor-empty muted">Binary or very large file, not shown.</div>
            ) : file.view === 'diff' ? (
              <DiffEditor
                key={`diff:${file.path}`}
                original={file.original ?? ''}
                modified={file.value}
                originalModelPath={`head://${file.path}`}
                modifiedModelPath={`diff://${file.path}`}
                theme={dark ? 'vs-dark' : 'vs'}
                options={{ ...options, readOnly: true, renderSideBySide: !props.compact, originalEditable: false }}
              />
            ) : (
              <Editor
                key={`edit:${file.path}`}
                path={file.path}
                value={file.value}
                theme={dark ? 'vs-dark' : 'vs'}
                options={options}
                onChange={(v) => props.onChange(file.path, v ?? '')}
                onMount={(editor, monaco) => {
                  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => props.onSave(file.path));
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
