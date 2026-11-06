import { execFile, spawn } from 'node:child_process';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { HttpError } from '../http/errors.js';

/**
 * Where Claude Code runs for a workspace.
 *
 * - `docker` (default): one container per workspace. It sees only the checkout
 *   (read-write), the git directory (read-only) and its own home folder; it runs as an
 *   unprivileged user with no capabilities, resource limits and no host credentials.
 *   Claude Code itself runs inside it, so every command it executes stays inside.
 * - `local`: runs on the host. For tests and machines without Docker only.
 */
export interface WorkspaceRuntime {
  readonly kind: 'docker' | 'local';
  /** The checkout's path as Claude sees it. */
  readonly repoPathForAgent: (hostRepo: string) => string;
  /** Creates or starts the workspace's container. */
  ensure(ws: WorkspaceDirs): Promise<void>;
  /** Kills every process the agent left behind (between runs). */
  recycle(workspaceId: string): Promise<void>;
  remove(workspaceId: string): Promise<void>;
  /** Spawns Claude Code inside the workspace, or undefined to spawn on the host. */
  spawnClaude?(workspaceId: string, options: SpawnOptions): SpawnedProcess;
}

export interface WorkspaceDirs {
  id: string;
  root: string;
  repo: string;
  gitDir: string;
  home: string;
}

export const localRuntime: WorkspaceRuntime = {
  kind: 'local',
  repoPathForAgent: (hostRepo) => hostRepo,
  ensure: async () => undefined,
  recycle: async () => undefined,
  remove: async () => undefined,
};

/**
 * Moves the repository's .git directory next to the checkout and links it with a
 * relative gitfile, so the container can mount it read-only. Idempotent.
 */
export async function separateGitDir(ws: WorkspaceDirs): Promise<void> {
  const dotGit = path.join(ws.repo, '.git');
  const info = await stat(dotGit).catch(() => null);
  if (info?.isDirectory()) {
    await rename(dotGit, ws.gitDir);
  }
  const expected = 'gitdir: ../git\n';
  const current = await readFile(dotGit, 'utf8').catch(() => '');
  if (current !== expected) {
    // git marks the gitfile hidden on Windows, and hidden files cannot be overwritten in place.
    await rm(dotGit, { force: true });
    await writeFile(dotGit, expected);
  }
}

const CONTAINER_REPO = '/ws/repo';
const RUNTIME_DIR = fileURLToPath(new URL('../../../runtime/', import.meta.url));

function run(args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: opts.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: opts.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args[0]} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else resolve(stdout);
    });
  });
}

/** Environment for the docker CLI itself: the server's, minus platform secrets. */
function dockerClientEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['DATABASE_URL', 'VAULT_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN']) delete env[k];
  return { ...env, ...extra };
}

export interface DockerRuntimeOptions {
  image: string;
  /** Claude Code version installed in the image when it has to be built. */
  claudeCodeVersion: string;
  cpus: string;
  memory: string;
  pidsLimit: number;
}

export class DockerRuntime implements WorkspaceRuntime {
  readonly kind = 'docker' as const;
  readonly repoPathForAgent = () => CONTAINER_REPO;
  private imageReady: Promise<void> | undefined;

  constructor(private readonly opts: DockerRuntimeOptions) {}

  static containerName(workspaceId: string) {
    return `ep-ws-${workspaceId}`;
  }

  /** Confirms the Docker daemon answers; used at startup and before creating containers. */
  static async available(): Promise<boolean> {
    return run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 }).then(() => true, () => false);
  }

  private ensureImage(): Promise<void> {
    this.imageReady ??= (async () => {
      const exists = await run(['image', 'inspect', this.opts.image]).then(() => true, () => false);
      if (!exists) {
        await run(['build', '--build-arg', `CLAUDE_CODE_VERSION=${this.opts.claudeCodeVersion}`, '-t', this.opts.image, RUNTIME_DIR], {
          timeoutMs: 30 * 60_000,
        });
      }
    })().catch((err) => {
      this.imageReady = undefined;
      throw err;
    });
    return this.imageReady;
  }

  async ensure(ws: WorkspaceDirs): Promise<void> {
    if (!(await DockerRuntime.available())) {
      throw new HttpError(503, 'runtime_unavailable', 'Docker is not running. Start Docker Desktop and try again.');
    }
    await separateGitDir(ws);
    const name = DockerRuntime.containerName(ws.id);
    const state = await run(['container', 'inspect', '--format', '{{.State.Status}}', name]).then((s) => s.trim(), () => null);
    if (state === 'running') return;
    if (state) {
      await run(['start', name]);
      return;
    }
    await this.ensureImage();
    await run([
      'run', '-d',
      '--name', name,
      '--label', 'engineering-platform.workspace=' + ws.id,
      '--init',
      '--user', '1000:1000',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', String(this.opts.pidsLimit),
      '--cpus', this.opts.cpus,
      '--memory', this.opts.memory,
      '--read-only',
      '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
      '--mount', `type=bind,src=${ws.repo},dst=${CONTAINER_REPO}`,
      '--mount', `type=bind,src=${ws.gitDir},dst=/ws/git,readonly`,
      '--mount', `type=bind,src=${ws.home},dst=/home/agent`,
      // Point the Docker Desktop host aliases at the container itself, so code in the
      // workspace cannot casually reach services on the developer's machine.
      '--add-host', 'host.docker.internal=127.0.0.1',
      '--add-host', 'host.docker.internal=::1',
      '--add-host', 'gateway.docker.internal=127.0.0.1',
      '--add-host', 'gateway.docker.internal=::1',
      '--workdir', CONTAINER_REPO,
      this.opts.image,
    ]);
  }

  async recycle(workspaceId: string): Promise<void> {
    // Restarting ends every process inside (including anything left in the background)
    // while keeping the files.
    await run(['restart', '-t', '2', DockerRuntime.containerName(workspaceId)]).catch(() => undefined);
  }

  async remove(workspaceId: string): Promise<void> {
    await run(['rm', '-f', DockerRuntime.containerName(workspaceId)]).catch(() => undefined);
  }

  spawnClaude(workspaceId: string, options: SpawnOptions): SpawnedProcess {
    // Forward only what Claude Code needs: its own CLAUDE_*/ANTHROPIC_* settings and the
    // developer's credential. Values travel via the docker client's environment
    // (`-e NAME` with no value), so they never appear on a command line.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env)) {
      if (v === undefined) continue;
      if (/^(ANTHROPIC_|CLAUDE_|DISABLE_|MCP_)/.test(k) && k !== 'CLAUDE_CONFIG_DIR') env[k] = v;
    }
    // The SDK may hand us "<runtime> <script> ...flags"; inside the container `claude` is on PATH.
    const base = path.basename(options.command).toLowerCase().replace(/\.exe$/, '');
    const args = ['node', 'bun', 'deno'].includes(base) ? options.args.slice(1) : options.args;

    const child = spawn(
      'docker',
      [
        'exec', '-i', '-w', CONTAINER_REPO,
        ...Object.keys(env).flatMap((k) => ['-e', k]),
        '-e', 'HOME=/home/agent',
        '-e', 'CLAUDE_CONFIG_DIR=/home/agent/.claude',
        DockerRuntime.containerName(workspaceId),
        'claude', ...args,
      ],
      { env: dockerClientEnv(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    options.signal.addEventListener('abort', () => {
      child.kill();
      void this.recycle(workspaceId);
    });
    return child as unknown as SpawnedProcess;
  }
}
