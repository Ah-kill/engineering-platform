import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, ApiError } from '../../api';

/**
 * A shell inside the workspace's container (see apps/api/src/terminal). Connects the first
 * time it becomes active and keeps its scrollback across reconnects.
 *
 * Browser to server: JSON {type:'input',data} and {type:'resize',cols,rows}.
 * Server to browser: raw terminal output.
 */

type State = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; message: string } | { kind: 'error'; message: string };

/** The server limits a message to 64 KB; keep each input chunk well under that. */
const INPUT_CHUNK = 8000;

const LIGHT_ANSI: ITheme = {
  black: '#1f2328', red: '#c4312b', green: '#1d7a3a', yellow: '#8a6100', blue: '#2f5bea', magenta: '#8e3fbf', cyan: '#127a87', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#d9473f', brightGreen: '#23914a', brightYellow: '#9e7200', brightBlue: '#4a71f0', brightMagenta: '#a452d6', brightCyan: '#16909f', brightWhite: '#8c959f',
};
const DARK_ANSI: ITheme = {
  black: '#3a3f47', red: '#ff6b63', green: '#7fd89a', yellow: '#ffcc7a', blue: '#7d9cff', magenta: '#d69cff', cyan: '#6fd6e0', white: '#d0d5db',
  brightBlack: '#6b737e', brightRed: '#ff8a83', brightGreen: '#9be6b1', brightYellow: '#ffd999', brightBlue: '#9fb6ff', brightMagenta: '#e3b8ff', brightCyan: '#94e3ea', brightWhite: '#ffffff',
};

/** Builds the xterm theme from the app's CSS variables, so it follows light and dark mode. */
function themeFromCss(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const accent = v('--accent', '#2f5bea');
  return {
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
    background: v('--surface', dark ? '#181b1f' : '#ffffff'),
    foreground: v('--text', dark ? '#e7eaee' : '#17191c'),
    cursor: accent,
    cursorAccent: v('--surface', '#ffffff'),
    selectionBackground: /^#[0-9a-f]{6}$/i.test(accent) ? `${accent}55` : 'rgba(47, 91, 234, 0.33)',
  };
}

function socketUrl(wsId: string, cols: number, rows: number) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/workspaces/${wsId}/terminal?cols=${cols}&rows=${rows}`;
}

/** Keys a phone keyboard does not have. */
const MOBILE_KEYS: { label: string; title: string; data: string }[] = [
  { label: 'Esc', title: 'Escape', data: '\x1b' },
  { label: 'Tab', title: 'Tab', data: '\t' },
  { label: '^C', title: 'Ctrl+C (interrupt)', data: '\x03' },
  { label: '^D', title: 'Ctrl+D (end of input)', data: '\x04' },
  { label: '↑', title: 'Up', data: '\x1b[A' },
  { label: '↓', title: 'Down', data: '\x1b[B' },
  { label: '←', title: 'Left', data: '\x1b[D' },
  { label: '→', title: 'Right', data: '\x1b[C' },
];

export function TerminalPanel({ wsId, active, compact = false }: { wsId: string; active: boolean; compact?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [note, setNote] = useState<string>();

  const send = useCallback((msg: object) => {
    const s = socketRef.current;
    if (s?.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
  }, []);

  const sendInput = useCallback((data: string) => {
    for (let i = 0; i < data.length; i += INPUT_CHUNK) send({ type: 'input', data: data.slice(i, i + INPUT_CHUNK) });
  }, [send]);

  const flash = useCallback((text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((n) => (n === text ? undefined : n)), 2000);
  }, []);

  const copy = useCallback(async () => {
    const text = termRef.current?.getSelection();
    if (!text) return flash('Select text to copy');
    try {
      await navigator.clipboard.writeText(text);
      flash('Copied');
    } catch {
      flash('Copy is blocked by the browser');
    }
  }, [flash]);

  const paste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) termRef.current?.paste(text); // paste() applies bracketed paste; onData sends it
    } catch {
      flash('Paste is blocked by the browser; use Ctrl+V');
    }
    termRef.current?.focus();
  }, [flash]);

  const fit = useCallback(() => {
    const host = hostRef.current;
    if (!host || !host.offsetWidth || !host.offsetHeight) return; // hidden
    try {
      fitRef.current?.fit();
    } catch {
      // xterm throws if measured before its renderer is ready; the next resize fixes it.
    }
  }, []);

  const connect = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    socketRef.current?.close();
    socketRef.current = null;
    setState({ kind: 'connecting' });
    // A plain request first: a refused WebSocket tells the browser nothing, this explains why.
    try {
      await api('GET', `/workspaces/${wsId}/terminal`);
    } catch (err) {
      if (termRef.current === term) setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'Could not reach the server' });
      return;
    }
    if (termRef.current !== term) return; // unmounted meanwhile
    fit();
    const socket = new WebSocket(socketUrl(wsId, term.cols, term.rows));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      setState({ kind: 'open' });
      term.focus();
    };
    socket.onmessage = (e) => {
      if (socketRef.current === socket) term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
    };
    socket.onclose = (e) => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setState({ kind: 'closed', message: e.reason || (e.code === 1006 ? 'Connection lost' : 'Disconnected') });
    };
  }, [wsId, fit]);

  // Connect lazily: nothing happens until the panel is first shown.
  const [started, setStarted] = useState(active);
  useEffect(() => {
    if (active) setStarted(true);
  }, [active]);

  // The terminal and its connection live from first show until unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!started || !host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() || 'monospace',
      fontSize: compact ? 13 : 12.5,
      scrollback: 5000,
      theme: themeFromCss(),
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    termRef.current = term;
    fitRef.current = fitAddon;

    // Ctrl+Shift+C / Ctrl+Shift+V everywhere, and Ctrl+C copies when text is selected
    // (otherwise it interrupts, as usual). Cmd+C / Cmd+V work natively on macOS.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true;
      const key = e.key.toLowerCase();
      if (key === 'c' && (e.shiftKey || term.hasSelection())) {
        void copy();
        term.clearSelection();
        e.preventDefault();
        return false;
      }
      if (key === 'v' && e.shiftKey) {
        void paste();
        e.preventDefault();
        return false;
      }
      // Plain Ctrl+V: let the browser fire its paste event, which xterm handles.
      return key !== 'v';
    });
    const data = term.onData(sendInput);
    const resize = term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));

    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => { term.options.theme = themeFromCss(); };
    scheme.addEventListener('change', onScheme);
    const observer = new ResizeObserver(() => fit());
    observer.observe(host);

    fit();
    void connect();
    return () => {
      observer.disconnect();
      scheme.removeEventListener('change', onScheme);
      data.dispose();
      resize.dispose();
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(); // ends the shell
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // The terminal is created once; `compact` only sets its initial font size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, wsId]);

  // Refit and focus whenever the panel becomes visible again.
  useEffect(() => {
    if (!active || !termRef.current) return;
    const t = window.setTimeout(() => {
      fit();
      termRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [active, fit]);

  const reconnect = () => {
    termRef.current?.write('\r\n\x1b[2m[reconnecting…]\x1b[0m\r\n');
    void connect();
  };

  const status =
    state.kind === 'open' ? 'Connected' :
    state.kind === 'connecting' ? 'Connecting…' :
    state.kind === 'closed' ? state.message :
    state.kind === 'error' ? state.message : '';

  return (
    <div className="term">
      <div className="term-bar">
        <span className={`term-dot ${state.kind}`} aria-hidden="true" />
        <span className={`term-status${state.kind === 'error' ? ' error' : ''}`} role="status" title={status}>{note ?? status}</span>
        <span style={{ flex: 1 }} />
        <button className="small" onClick={() => void copy()} title="Copy selection (Ctrl+Shift+C)">Copy</button>
        <button className="small" onClick={() => void paste()} title="Paste (Ctrl+Shift+V)">Paste</button>
        {(state.kind === 'closed' || state.kind === 'error') && <button className="small primary" onClick={reconnect}>Reconnect</button>}
      </div>
      <div className="term-host" ref={hostRef} />
      {compact && (
        <div className="term-keys" aria-label="Terminal keys">
          {MOBILE_KEYS.map((k) => (
            <button key={k.label} title={k.title} aria-label={k.title} onMouseDown={(e) => e.preventDefault()} onClick={() => { sendInput(k.data); termRef.current?.focus(); }}>
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
