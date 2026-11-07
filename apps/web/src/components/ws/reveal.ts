import { monaco } from '../../monaco';

/**
 * Moves the cursor of the editor showing `path` to `line` and scrolls it into view. The
 * editor mounts asynchronously after a file is opened, so this retries for a few seconds.
 */
export function revealLine(path: string, line: number, timeoutMs = 4000): void {
  const started = Date.now();
  // Where focus was when the result was clicked. If the developer has since moved on (for
  // example typed a new search), the editor must not steal focus: keys would edit the file.
  const focusedAtClick = document.activeElement;
  const attempt = () => {
    const editor = monaco.editor.getEditors().find((e) => {
      const uri = e.getModel()?.uri;
      if (!uri || uri.scheme === 'head' || uri.scheme.startsWith('review')) return false;
      const node = e.getDomNode();
      return !!node?.isConnected && decodeURIComponent(uri.toString()).endsWith('/' + path);
    });
    if (editor) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      const now = document.activeElement;
      if (now === focusedAtClick || now === document.body || now === null) editor.focus();
    } else if (Date.now() - started < timeoutMs) {
      setTimeout(attempt, 80);
    }
  };
  attempt();
}
