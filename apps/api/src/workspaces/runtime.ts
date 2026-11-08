import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { HttpError } from '../http/errors.js';
import { openTerminals } from './terminal-registry.js';

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
  /**
   * Creates or starts the workspace's container with the application's network policy.
   * A changed policy recreates the container (files live on the mounts and are kept).
   */
  ensure(ws: WorkspaceDirs, network?: NetworkPolicy): Promise<void>;
  /** Kills every process the agent left behind (between runs). */
  recycle(workspaceId: string): Promise<void>;
  /** Stops the workspace's container (and proxy) to free memory; files are kept and `ensure` starts it again. */
  stop(workspaceId: string): Promise<void>;
  /**
   * Stops the container only if `isIdle()` still holds once no other container operation for the
   * workspace is in flight, deciding and stopping as one step (the idle reaper uses it, so a run
   * or terminal starting meanwhile is never cut off). Resolves true when it stopped. Runtimes
   * without it are stopped with `stop` after an `isIdle()` check.
   */
  stopIfIdle?(workspaceId: string, isIdle: () => boolean): Promise<boolean>;
  remove(workspaceId: string): Promise<void>;
  /** Spawns Claude Code inside the workspace, or undefined to spawn on the host. */
  spawnClaude?(workspaceId: string, options: SpawnOptions): SpawnedProcess;
}

export interface NetworkPolicy {
  /** restricted: only built-in and listed hosts. open: unrestricted internet. */
  mode: 'restricted' | 'open';
  hosts: string[];
}

/** Always reachable in restricted mode: Claude itself, GitHub and the main package registries. */
export const BUILTIN_HOSTS = [
  'api.anthropic.com',
  'github.com',
  'codeload.github.com',
  '*.githubusercontent.com',
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
];

/** host, *.host or host:port; lowercase DNS names only (no IPs, no URLs). */
export const HOST_RULE = /^(\*\.)?(?=.{1,253}(:|$))([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?$/;

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
  stop: async () => undefined,
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

/**
 * Runs inside the container: kills every process except PID 1 (init), the keep-alive
 * `sleep infinity`, terminal bridges and their descendants, and itself.
 */
const SWEEP_SCRIPT = `
import os, signal, sys
allowed_bridges = int(sys.argv[1])
me = os.getpid()
procs = {}
for pid in os.listdir('/proc'):
    if not pid.isdigit():
        continue
    try:
        with open('/proc/%s/stat' % pid) as f:
            ppid = int(f.read().rsplit(')', 1)[1].split()[1])
        with open('/proc/%s/cmdline' % pid, 'rb') as f:
            argv = [a.decode(errors='replace') for a in f.read().split(b'\\0') if a]
        exe = os.readlink('/proc/%s/exe' % pid)
        procs[int(pid)] = (ppid, argv, exe)
    except Exception:
        pass
bridges = [p for p, (pp, a, e) in procs.items()
           if pp == 0 and a[1:2] == ['/opt/platform/pty-bridge.py'] and e.startswith('/usr/bin/python3')]
# More terminal shells than the platform opened: something imitates one. Signal the caller
# to restart the container instead (ends every process, keeps the files).
if len(bridges) > allowed_bridges:
    sys.exit(3)
sleepers = sorted(p for p, (pp, a, e) in procs.items() if pp == 1 and a == ['sleep', 'infinity'] and e == '/usr/bin/sleep')
roots = set(bridges) | set(sleepers[:1]) | {1, me}
def keep(pid, depth=0):
    if pid in roots:
        return True
    if pid not in procs or depth > 64:
        return False
    ppid = procs[pid][0]
    return ppid not in (0, 1) and keep(ppid, depth + 1)
for pid in list(procs):
    if not keep(pid):
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
`;

/** Variables that describe the host machine and must not be copied into a container. */
const HOST_ONLY_ENV = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'LANG', 'TERM',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH',
]);

/** Bump when apps/runtime changes, so a fresh image is built instead of reusing an old one. */
export const RUNTIME_REVISION = 'r5';

export function defaultImage(claudeCodeVersion: string): string {
  return `engineering-platform-workspace:${claudeCodeVersion}-${RUNTIME_REVISION}`;
}
const RUNTIME_DIR = fileURLToPath(new URL('../../../runtime/', import.meta.url));

/** Runs the docker CLI and resolves its stdout. Replaceable in DockerRuntime for tests. */
export type DockerCli = (args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<string>;

const run: DockerCli = (args, opts = {}) => {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: opts.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: opts.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`docker ${args[0]} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else resolve(stdout);
    });
  });
};

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
  /**
   * The tail of each workspace's chain of container operations. ensure, recycle, stop and remove
   * for one workspace run one after another, never interleaved: otherwise a terminal opening while
   * a run starts could race `docker rm -f` of the proxy against `docker run --name`, or a stop
   * could land in the middle of an ensure.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly opts: DockerRuntimeOptions,
    private readonly docker: DockerCli = run,
  ) {}

  /** Runs `fn` after every container operation already queued for the workspace has settled. */
  private serial<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(workspaceId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(workspaceId, next);
    next
      .finally(() => {
        if (this.chains.get(workspaceId) === next) this.chains.delete(workspaceId);
      })
      .catch(() => undefined);
    return next;
  }

  static containerName(workspaceId: string) {
    return `ep-ws-${workspaceId}`;
  }

  /** Confirms the Docker daemon answers; used at startup and before creating containers. */
  static async available(): Promise<boolean> {
    return run(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 }).then(() => true, () => false);
  }

  private ensureImage(): Promise<void> {
    this.imageReady ??= (async () => {
      const exists = await this.docker(['image', 'inspect', this.opts.image]).then(() => true, () => false);
      if (!exists) {
        await this.docker(['build', '--build-arg', `CLAUDE_CODE_VERSION=${this.opts.claudeCodeVersion}`, '-t', this.opts.image, RUNTIME_DIR], {
          timeoutMs: 30 * 60_000,
        });
      }
    })().catch((err) => {
      this.imageReady = undefined;
      throw err;
    });
    return this.imageReady;
  }

  static proxyName(workspaceId: string) {
    return `ep-px-${workspaceId}`;
  }

  static networkName(workspaceId: string) {
    return `ep-net-${workspaceId}`;
  }

  private static policyHash(policy: NetworkPolicy): string {
    const hosts = policy.mode === 'restricted' ? [...BUILTIN_HOSTS, ...policy.hosts].map((h) => h.toLowerCase()).sort() : [];
    return createHash('sha256').update(`${policy.mode}|${hosts.join(',')}|${RUNTIME_REVISION}`).digest('hex').slice(0, 16);
  }

  ensure(ws: WorkspaceDirs, network: NetworkPolicy = { mode: 'restricted', hosts: [] }): Promise<void> {
    return this.serial(ws.id, () => this.ensureNow(ws, network));
  }

  private async ensureNow(ws: WorkspaceDirs, network: NetworkPolicy): Promise<void> {
    const available = await this.docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 }).then(() => true, () => false);
    if (!available) {
      throw new HttpError(503, 'runtime_unavailable', 'Docker is not running. Start Docker Desktop and try again.');
    }
    await separateGitDir(ws);
    const name = DockerRuntime.containerName(ws.id);
    const proxy = DockerRuntime.proxyName(ws.id);
    const hash = DockerRuntime.policyHash(network);

    const inspect = await this.docker(['container', 'inspect', '--format', '{{.State.Status}} {{index .Config.Labels "engineering-platform.policy"}}', name])
      .then((s) => s.trim().split(' '), () => null);
    if (inspect && inspect[1] !== hash) {
      // Policy changed: rebuild the container and its network setup around the same files.
      await this.removeNow(ws.id);
    } else if (inspect) {
      if (network.mode === 'restricted') await this.docker(['start', proxy]).catch(() => undefined);
      if (inspect[0] !== 'running') await this.docker(['start', name]);
      return;
    }

    await this.ensureImage();
    const netArgs: string[] = [];
    if (network.mode === 'restricted') {
      const net = DockerRuntime.networkName(ws.id);
      // --internal: no route to the outside world; the proxy is the only exit.
      await this.docker(['network', 'create', '--internal', '--label', `engineering-platform.workspace=${ws.id}`, net]).catch(() => undefined);
      await this.docker(['rm', '-f', proxy]).catch(() => undefined);
      await this.docker([
        'run', '-d',
        '--name', proxy,
        '--label', `engineering-platform.workspace=${ws.id}`,
        '--restart', 'unless-stopped',
        '--user', '1000:1000',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--read-only',
        '--memory', '256m',
        '--pids-limit', '64',
        '-e', `ALLOW_HOSTS=${[...BUILTIN_HOSTS, ...network.hosts].join(',')}`,
        '-e', 'PORT=3128',
        this.opts.image,
        'node', '/opt/platform/egress-proxy.mjs',
      ]);
      await this.docker(['network', 'connect', net, proxy]);
      const proxyUrl = `http://${proxy}:3128`;
      netArgs.push('--network', net);
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) netArgs.push('-e', `${k}=${proxyUrl}`);
      netArgs.push('-e', 'NO_PROXY=localhost,127.0.0.1', '-e', 'no_proxy=localhost,127.0.0.1', '-e', 'NODE_USE_ENV_PROXY=1');
    }

    await this.docker([
      'run', '-d',
      '--name', name,
      '--label', 'engineering-platform.workspace=' + ws.id,
      '--label', 'engineering-platform.policy=' + hash,
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
      ...netArgs,
      '--workdir', CONTAINER_REPO,
      this.opts.image,
    ]);
  }

  recycle(workspaceId: string): Promise<void> {
    return this.serial(workspaceId, () => this.recycleNow(workspaceId));
  }

  private async recycleNow(workspaceId: string): Promise<void> {
    // End everything the agent left behind (including background processes) but keep the
    // container's init, its keep-alive process and the developer's terminal shells. Shells are
    // recognised as started by docker exec and counted against the terminals the platform has
    // open; any surplus, or any failure, restarts the container (ends every process, keeps files).
    const name = DockerRuntime.containerName(workspaceId);
    const swept = await this.docker(['exec', '-e', 'PATH=/usr/bin:/bin', name, '/usr/bin/python3', '-I', '-c', SWEEP_SCRIPT, String(openTerminals(workspaceId))], { timeoutMs: 20_000 }).then(() => true, () => false);
    if (!swept) await this.docker(['restart', '-t', '2', name]).catch(() => undefined);
  }

  stop(workspaceId: string): Promise<void> {
    return this.serial(workspaceId, () => this.stopNow(workspaceId));
  }

  stopIfIdle(workspaceId: string, isIdle: () => boolean): Promise<boolean> {
    return this.serial(workspaceId, async () => {
      if (!isIdle()) return false;
      await this.stopNow(workspaceId);
      return true;
    });
  }

  private async stopNow(workspaceId: string): Promise<void> {
    // One call per container: `docker stop a b` fails as a whole when one of them does not exist.
    await this.docker(['stop', '-t', '5', DockerRuntime.containerName(workspaceId)], { timeoutMs: 60_000 }).catch(() => undefined);
    await this.docker(['stop', '-t', '2', DockerRuntime.proxyName(workspaceId)], { timeoutMs: 60_000 }).catch(() => undefined);
  }

  remove(workspaceId: string): Promise<void> {
    return this.serial(workspaceId, () => this.removeNow(workspaceId));
  }

  private async removeNow(workspaceId: string): Promise<void> {
    await this.docker(['rm', '-f', DockerRuntime.containerName(workspaceId), DockerRuntime.proxyName(workspaceId)]).catch(() => undefined);
    await this.docker(['network', 'rm', DockerRuntime.networkName(workspaceId)]).catch(() => undefined);
  }

  spawnClaude(workspaceId: string, options: SpawnOptions): SpawnedProcess {
    // Forward Claude Code's own settings, the developer's credential and the environment's
    // variables, but nothing describing the host. Values travel via the docker client's
    // environment (`-e NAME` with no value), so they never appear on a command line.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env)) {
      if (v === undefined || HOST_ONLY_ENV.has(k.toUpperCase())) continue;
      env[k] = v;
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
