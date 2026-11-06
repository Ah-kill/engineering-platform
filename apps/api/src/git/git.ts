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
  const extra: [string, string][] = [
    ['credential.helper', ''],
    ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
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
