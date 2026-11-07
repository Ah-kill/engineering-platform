import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSdkDriver, type AgentEvent } from '../src/agents/driver.js';
import { readSdkPackage } from '../src/agents/version.js';
import { runGit } from '../src/git/git.js';
import { defaultImage, DockerRuntime, separateGitDir, type WorkspaceDirs } from '../src/workspaces/runtime.js';
import { registerTerminalCounter } from '../src/workspaces/terminal-registry.js';

/**
 * Proves the container boundary with the real Docker engine and the real Claude Code
 * binary inside the image. Skipped when Docker is not running.
 */
const dockerUp = await DockerRuntime.available();

function exec(container: string, script: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('docker', ['exec', container, 'sh', '-c', script], { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() });
    });
  });
}

describe.skipIf(!dockerUp)('Docker workspace runtime', () => {
  let tmp: string;
  let dirs: WorkspaceDirs;
  let runtime: DockerRuntime;
  let name: string;

  beforeAll(async () => {
    const sdk = await readSdkPackage();
    runtime = new DockerRuntime({ image: defaultImage(sdk.claudeCodeVersion!), claudeCodeVersion: sdk.claudeCodeVersion!, cpus: '1', memory: '1g', pidsLimit: 256 });
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ep-docker-'));
    const bare = path.join(tmp, 'origin.git');
    await runGit(['init', '--bare', '-b', 'main', bare], { cwd: tmp });
    const seed = path.join(tmp, 'seed');
    await runGit(['clone', bare, seed], { cwd: tmp, allowLocalRemote: true });
    await writeFile(path.join(seed, 'README.md'), '# hello\n');
    await runGit(['add', '-A'], { cwd: seed });
    await runGit(['commit', '-m', 'init'], { cwd: seed, author: { name: 't', email: 't@t' } });
    await runGit(['push', 'origin', 'HEAD:main'], { cwd: seed, allowLocalRemote: true });

    const id = randomUUID();
    const root = path.join(tmp, id);
    dirs = { id, root, repo: path.join(root, 'repo'), gitDir: path.join(root, 'git'), home: path.join(root, 'home') };
    await mkdir(dirs.home, { recursive: true });
    await runGit(['clone', '--separate-git-dir', dirs.gitDir, bare, dirs.repo], { cwd: tmp, allowLocalRemote: true });
    await separateGitDir(dirs);
    await runtime.ensure(dirs);
    name = DockerRuntime.containerName(id);
  }, 600_000);

  afterAll(async () => {
    if (runtime && dirs) await runtime.remove(dirs.id);
    if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  });

  it('runs as an unprivileged user with no capabilities', async () => {
    expect((await exec(name, 'id -u')).out).toBe('1000');
    expect((await exec(name, "grep CapEff /proc/self/status | awk '{print $2}'")).out).toBe('0000000000000000');
    expect((await exec(name, 'touch /usr/local/x')).code).not.toBe(0); // read-only root filesystem
  });

  it('sees the checkout read-write, shared with the host', async () => {
    expect((await exec(name, 'echo from-container > /ws/repo/created.txt')).code).toBe(0);
    expect(await readFile(path.join(dirs.repo, 'created.txt'), 'utf8')).toContain('from-container');
    expect((await exec(name, 'cat README.md')).out).toContain('# hello');
  });

  it('can read git history but cannot change git config or hooks', async () => {
    expect((await exec(name, 'git log --oneline -1')).out).toContain('init');
    expect((await exec(name, 'git status --short')).out).toContain('created.txt');
    expect((await exec(name, 'git config core.fsmonitor "steal"')).code).not.toBe(0);
    expect((await exec(name, 'echo x >> /ws/git/config')).code).not.toBe(0);
    expect((await exec(name, 'echo x > /ws/git/hooks/pre-commit')).code).not.toBe(0);
    expect(await readFile(path.join(dirs.gitDir, 'config'), 'utf8')).not.toContain('fsmonitor');
  });

  it('cannot see host files, the Docker socket or host aliases', async () => {
    expect((await exec(name, 'ls /var/run/docker.sock')).code).not.toBe(0);
    expect((await exec(name, 'ls /mnt/c /c /host 2>/dev/null | head -1')).out).toBe('');
    const lookup = async (family: string) => (await exec(name, `getent ${family} host.docker.internal | awk '{print $1}' | sort -u`)).out;
    expect(await lookup('ahostsv4')).toBe('127.0.0.1');
    expect(await lookup('ahostsv6')).toMatch(/^(::1)?$/); // loopback or not resolvable at all
    expect((await exec(name, 'env')).out).not.toMatch(/DATABASE_URL|VAULT_KEY/);
  });

  it('recycling ends processes left running in the background', async () => {
    const sleepers = async () => (await exec(name, 'pgrep -c -x sleep || true')).out;
    const before = Number(await sleepers()); // the container's own keep-alive `sleep infinity`
    await exec(name, 'nohup sleep 600 >/dev/null 2>&1 &');
    expect(Number(await sleepers())).toBe(before + 1);
    await runtime.recycle(dirs.id);
    expect(Number(await sleepers())).toBe(before);
    expect(await readFile(path.join(dirs.repo, 'created.txt'), 'utf8')).toContain('from-container'); // files survive
  }, 60_000);

  const bridges = async () => Number((await exec(name, 'pgrep -c -f "/opt/platform/[p]ty-bridge.py" || true')).out);
  async function waitForBridges(n: number) {
    for (let i = 0; i < 40 && (await bridges()) !== n; i++) await new Promise((r) => setTimeout(r, 250));
    return bridges();
  }

  it('cleanup keeps the real terminal shell and kills imitations started inside the container', async () => {
    // A real terminal: started from the host with docker exec (its parent is outside the container).
    const real = spawn('docker', ['exec', '-i', name, 'python3', '/opt/platform/pty-bridge.py', '80', '24'], { stdio: ['pipe', 'ignore', 'ignore'] });
    expect(await waitForBridges(1)).toBe(1);
    // Imitations started from inside, the way a hijacked agent could: once their starter exits
    // they are adopted by the container's init (parent 1), which cannot be disguised.
    await exec(name, 'nohup python3 /opt/platform/pty-bridge.py 80 24 </dev/null >/dev/null 2>&1 & exec -a "sleep" sleep 1000 >/dev/null 2>&1 &');
    expect(await waitForBridges(2)).toBe(2);

    registerTerminalCounter(() => 1);
    await runtime.recycle(dirs.id);
    registerTerminalCounter(() => 0);
    expect(await bridges()).toBe(1); // the real one
    expect((await exec(name, 'pgrep -c -f "[s]leep 1000" || true')).out).toBe('0');
    real.stdin?.end();
    expect(await waitForBridges(0)).toBe(0); // the bridge ends when its terminal closes
  }, 60_000);

  it('more terminal shells than the platform opened restarts the container', async () => {
    const real = spawn('docker', ['exec', '-i', name, 'python3', '/opt/platform/pty-bridge.py', '80', '24'], { stdio: ['pipe', 'ignore', 'ignore'] });
    expect(await waitForBridges(1)).toBe(1);
    registerTerminalCounter(() => 0); // the platform knows of none
    await runtime.recycle(dirs.id);
    expect(await waitForBridges(0)).toBe(0);
    real.kill();
  }, 60_000);

  describe('network policy', () => {
    const code = (url: string, extra = '') => exec(name, `curl -sS ${extra} -o /dev/null -m 20 -w '%{http_code}' ${url}`);

    it('restricted (default): built-in hosts work through the filter, everything else is blocked', async () => {
      const anthropic = await code('https://api.anthropic.com/');
      expect(anthropic.code, anthropic.out).toBe(0);
      expect(anthropic.out).toMatch(/^\d{3}$/);

      const other = await code('https://example.com/');
      expect(other.code).not.toBe(0);
      expect(other.out).toMatch(/403/);
      expect((await exec(name, 'curl -sS -m 20 http://example.com/')).out).toContain('Blocked by workspace network policy');

      // Bypassing the proxy goes nowhere: the workspace network has no route out.
      expect((await code('https://api.anthropic.com/', "--noproxy '*'")).code).not.toBe(0);
    }, 120_000);

    it('allowing a host takes effect (container rebuilt, files kept)', async () => {
      await runtime.ensure(dirs, { mode: 'restricted', hosts: ['example.com'] });
      const r = await code('https://example.com/');
      expect(r.code, r.out).toBe(0);
      expect(r.out).toBe('200');
      expect((await code('https://www.iana.org/')).code).not.toBe(0); // still not listed
      expect(await readFile(path.join(dirs.repo, 'created.txt'), 'utf8')).toContain('from-container');
    }, 180_000);

    it('open mode: unrestricted, no proxy', async () => {
      await runtime.ensure(dirs, { mode: 'open', hosts: [] });
      expect((await exec(name, 'echo "${HTTPS_PROXY:-none}"')).out).toBe('none');
      const r = await code('https://example.com/');
      expect(r.out).toBe('200');
      await runtime.ensure(dirs, { mode: 'restricted', hosts: [] }); // back to default for the next test
    }, 180_000);
  });

  it('runs Claude Code itself inside the container', async () => {
    const events: AgentEvent[] = [];
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), 120_000);
    try {
      for await (const ev of new ClaudeSdkDriver().run({
        prompt: 'Say hi',
        cwd: dirs.repo,
        env: { ANTHROPIC_API_KEY: `sk-ant-api03-${'x'.repeat(90)}`, CLAUDE_AGENT_SDK_CLIENT_APP: 'engineering-platform-test' },
        model: 'haiku',
        mode: 'plan',
        abortController,
        canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
        appendSystemPrompt: 'test',
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        spawnClaudeCodeProcess: (o) => runtime.spawnClaude(dirs.id, o),
      })) events.push(ev);
    } catch {
      // The SDK throws after the error result; the events are what matter.
    } finally {
      clearTimeout(timer);
    }
    const session = events.find((e) => e.kind === 'session');
    expect(session).toBeTruthy();
    // The fake key reached Claude Code inside the container and was rejected by Anthropic.
    expect(JSON.stringify(events)).toMatch(/Invalid API key/i);
  }, 180_000);
});
