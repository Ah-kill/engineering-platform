import { execFile } from 'node:child_process';
import { HttpError } from '../http/errors.js';

/**
 * Thin wrapper over the git CLI. Arguments are passed as an array (no shell), and a
 * token, when given, is injected as an HTTP header through GIT_CONFIG_* environment
 * variables for that one command. It is never written to .git/config or the remote URL.
 */
export interface GitOptions {
  cwd: string;
  token?: string;
  timeoutMs?: number;
  author?: { name: string; email: string };
  /** Allow local-path remotes (used by tests and the e2e stack). Network remotes are https only. */
  allowLocalRemote?: boolean;
}

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

/** Only these variables from the server's environment reach git. */
const PASS_ENV = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG'];

export function runGit(args: string[], opts: GitOptions): Promise<string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) if (process.env[k]) env[k] = process.env[k]!;
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    // Ignore the server user's global/system git config (credential helpers, hooks paths).
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  });
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  // Command-line-level config outranks the repository's own .git/config, which Claude can
  // write to. These switch off every setting that makes git run a program or change where
  // it connects. assertSafeRepoConfig() additionally gates token-bearing commands.
  const extra: [string, string][] = [
    ['credential.helper', ''],
    ['core.hooksPath', devNull],
    ['core.fsmonitor', 'false'],
    ['core.sshCommand', 'false'],
    ['core.pager', 'cat'],
    ['core.editor', 'false'],
    ['core.askPass', ''],
    ['diff.external', ''],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ['protocol.file.allow', opts.allowLocalRemote ? 'always' : 'never'],
    // No proxies or disabled TLS checks that could expose the Authorization header.
    ['http.proxy', ''],
    ['http.https://github.com/.proxy', ''],
    ['http.sslVerify', 'true'],
    ['http.https://github.com/.sslVerify', 'true'],
    ['http.sslCAInfo', ''],
    // Never descend into submodules, whose own configs are not checked.
    ['submodule.recurse', 'false'],
    ['fetch.recurseSubmodules', 'false'],
    ['push.recurseSubmodules', 'no'],
  ];
  if (opts.token) {
    const basic = Buffer.from(`x-access-token:${opts.token}`).toString('base64');
    extra.push(['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${basic}`]);
  }
  if (opts.author) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = opts.author.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = opts.author.email;
  }
  env.GIT_CONFIG_COUNT = String(extra.length);
  extra.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const clean = redactToken(String(stderr || err.message), opts.token);
          reject(new GitError(`git ${args[0]} failed: ${clean.trim().split('\n').slice(-3).join(' ')}`, clean));
        } else resolve(stdout);
      },
    );
  });
}

function redactToken(text: string, token?: string): string {
  return token ? text.split(token).join('***') : text;
}

/**
 * Keys the platform's own git usage produces in a clone's .git/config. Anything else
 * (url.*.insteadOf, filter.*, include.path, alias.*, core.fsmonitor, http.*, ...) means
 * the config was edited, possibly by a prompt-injected agent, and no command carrying
 * the developer's token may run until it is reset.
 */
const SAFE_CONFIG_KEYS: RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|symlinks|ignorecase|precomposeunicode|autocrlf)$/,
  /^remote\.origin\.(url|fetch|tagopt)$/,
  /^branch\.[^\s]+\.(remote|merge)$/,
  /^extensions\.objectformat$/,
  /^user\.(name|email)$/,
];

export async function assertSafeRepoConfig(cwd: string, expectedRemote: string): Promise<void> {
  const out = await runGit(['config', '--local', '--list', '--null'], { cwd });
  const entries = out.split('\0').filter(Boolean).map((e) => {
    const nl = e.indexOf('\n');
    return nl === -1 ? { key: e.toLowerCase(), value: '' } : { key: e.slice(0, nl).toLowerCase(), value: e.slice(nl + 1) };
  });
  const bad = entries.filter((e) => !SAFE_CONFIG_KEYS.some((re) => re.test(e.key))).map((e) => e.key);
  const tagopt = entries.find((e) => e.key === 'remote.origin.tagopt');
  if (tagopt && !['--no-tags', '--tags'].includes(tagopt.value)) bad.push('remote.origin.tagopt');
  const url = entries.find((e) => e.key === 'remote.origin.url')?.value;
  if (url !== expectedRemote) bad.push('remote.origin.url');
  const branchRemotes = entries.filter((e) => /^branch\..+\.remote$/.test(e.key) && e.value !== 'origin');
  bad.push(...branchRemotes.map((e) => e.key));
  if (bad.length) {
    throw HttpError.forbidden(
      `This workspace's git configuration was changed (${[...new Set(bad)].slice(0, 5).join(', ')}), so the platform will not use your GitHub token with it. Recreate the workspace.`,
    );
  }
}

/** Branch names: conservative subset of git's rules. */
export const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/;

export function assertBranch(name: string): string {
  if (!BRANCH.test(name) || name.startsWith('-')) throw HttpError.badRequest(`Invalid branch name "${name}"`);
  return name;
}

export interface FileStatus {
  path: string;
  /** Two-letter porcelain code, e.g. " M", "A ", "??". */
  code: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
}

export async function status(cwd: string): Promise<{ branch: string; ahead: number; behind: number; files: FileStatus[] }> {
  const out = await runGit(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], { cwd });
  const parts = out.split('\0').filter(Boolean);
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files: FileStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.startsWith('## ')) {
      const m = /^## ([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/.exec(entry);
      branch = m?.[1] ?? '';
      ahead = Number(m?.[2] ?? 0);
      behind = Number(m?.[3] ?? 0);
      continue;
    }
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === 'R') i++; // rename: next entry is the original path
    const s: FileStatus['status'] =
      code === '??' ? 'untracked' : code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : code.includes('R') ? 'renamed' : 'modified';
    files.push({ path, code, status: s });
  }
  return { branch, ahead, behind, files };
}

export async function branches(cwd: string): Promise<{ current: string; local: string[]; remote: string[] }> {
  const out = await runGit(['branch', '-a', '--format=%(HEAD)%09%(refname)'], { cwd });
  let current = '';
  const local: string[] = [];
  const remote: string[] = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [head, ref] = line.split('\t');
    if (!ref) continue;
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length);
      local.push(name);
      if (head === '*') current = name;
    } else if (ref.startsWith('refs/remotes/origin/') && !ref.endsWith('/HEAD')) {
      remote.push(ref.slice('refs/remotes/origin/'.length));
    }
  }
  return { current, local, remote };
}

export async function log(cwd: string, limit = 30) {
  const out = await runGit(['log', `-${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s'], { cwd }).catch(() => '');
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, author, date, subject] = l.split('\x1f');
      return { sha: sha!, author: author!, date: date!, subject: subject ?? '' };
    });
}

/** Content of a file at HEAD, or '' if it does not exist there (new file). */
export async function showHead(cwd: string, relPath: string): Promise<string> {
  return runGit(['show', `HEAD:${relPath}`], { cwd }).catch(() => '');
}
