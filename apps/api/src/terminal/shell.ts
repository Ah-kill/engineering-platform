import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DockerRuntime } from '../workspaces/runtime.js';

/**
 * An interactive shell inside a workspace container, for the browser terminal.
 *
 * `docker exec -i` only gives pipes, so the shell runs under a small PTY bridge baked into
 * the image (apps/runtime/pty-bridge.py). Everything we write to it is framed: one type
 * byte, a 4-byte big-endian length, then the payload. Input bytes always travel inside a
 * frame, so nothing typed or pasted can be read as a control message. Output is raw.
 */

const BRIDGE = '/opt/platform/pty-bridge.py';
const CONTAINER_REPO = '/ws/repo';

/** Variables that describe the host machine; a project variable must never replace them in the docker client. */
const HOST_ONLY_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'LANG', 'TERM',
]);

/** Platform secrets and the developer's credentials: kept out of the docker client's environment entirely. */
const NEVER_FORWARD = ['DATABASE_URL', 'VAULT_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  return { cols: Math.min(1000, Math.max(2, Math.floor(cols))), rows: Math.min(500, Math.max(1, Math.floor(rows))) };
}

function frame(kind: 'd' | 'r', payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'latin1');
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export function inputFrame(data: string): Buffer {
  return frame('d', Buffer.from(data, 'utf8'));
}

export function resizeFrame(cols: number, rows: number): Buffer {
  const size = clampSize(cols, rows);
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(size.cols, 0);
  payload.writeUInt16BE(size.rows, 2);
  return frame('r', payload);
}

export interface ShellOptions {
  workspaceId: string;
  /** The environment's variables (names validated by the variables module). */
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export class ContainerShell {
  private readonly child: ChildProcessWithoutNullStreams;
  private exited = false;

  constructor(opts: ShellOptions) {
    // Values reach the container through the docker client's environment (`-e NAME` with no
    // value), so they never appear on a command line. The client gets nothing else secret.
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.env)) {
      if (!HOST_ONLY_ENV.has(k.toUpperCase()) && !NEVER_FORWARD.includes(k.toUpperCase())) vars[k] = v;
    }
    const clientEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of NEVER_FORWARD) delete clientEnv[k];
    Object.assign(clientEnv, vars);

    const size = clampSize(opts.cols, opts.rows);
    this.child = spawn(
      'docker',
      [
        'exec', '-i',
        '--user', '1000:1000',
        '-w', CONTAINER_REPO,
        ...Object.keys(vars).flatMap((k) => ['-e', k]),
        '-e', 'HOME=/home/agent',
        '-e', 'TERM=xterm-256color',
        '-e', 'COLORTERM=truecolor',
        '-e', 'LANG=C.UTF-8',
        DockerRuntime.containerName(opts.workspaceId),
        'python3', BRIDGE, String(size.cols), String(size.rows),
      ],
      { env: clientEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.child.stdin.on('error', () => undefined); // EPIPE after the shell exits
    this.child.on('exit', () => {
      this.exited = true;
    });
  }

  get stdout() {
    return this.child.stdout;
  }

  get stderr() {
    return this.child.stderr;
  }

  onExit(fn: (code: number | null) => void) {
    this.child.on('close', (code) => fn(code));
    this.child.on('error', () => fn(null));
  }

  write(data: string) {
    if (!this.exited && this.child.stdin.writable) this.child.stdin.write(inputFrame(data));
  }

  resize(cols: number, rows: number) {
    if (!this.exited && this.child.stdin.writable) this.child.stdin.write(resizeFrame(cols, rows));
  }

  /**
   * Ends the shell: closing stdin makes the bridge hang up the shell's session. Killing the
   * docker client is the fallback; the daemon then closes the bridge's stdin as well.
   */
  close() {
    if (this.exited) return;
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill();
    }, 5_000);
    timer.unref();
  }
}
