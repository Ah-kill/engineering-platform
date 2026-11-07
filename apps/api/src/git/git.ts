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
  /** Exit codes other than 0 that are not errors (e.g. 1 from `git grep` when nothing matched). */
  okExitCodes?: number[];
}

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly timedOut = false) {
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
    // Backstop only: system/global config is ignored above, and assertSafeRepoConfig()
    // refuses any http.* or include.* key in the repository's own config before a
    // token-bearing command runs. These keep the common proxy/TLS knobs pinned regardless.
    ['http.proxy', ''],
    ['http.https://github.com/.proxy', ''],
    ['http.sslVerify', 'true'],
    ['http.https://github.com/.sslVerify', 'true'],
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
        const code = (err as { code?: unknown } | null)?.code;
        if (err && typeof code === 'number' && opts.okExitCodes?.includes(code)) resolve(stdout);
        else if (err) {
          const clean = redactToken(String(stderr || err.message), opts.token);
          const timedOut = (err as { killed?: boolean }).killed === true;
          reject(new GitError(`git ${args[0]} failed: ${clean.trim().split('\n').slice(-3).join(' ')}`, clean, timedOut));
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
      // A branch without commits yet (new, empty repository): "## No commits yet on <branch>".
      const unborn = /^## (?:No commits yet|Initial commit) on (\S+)/.exec(entry);
      if (unborn) {
        branch = unborn[1]!.split('...')[0]!;
        continue;
      }
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

/** Commit ids as accepted from clients: 7 to 40 hex characters (abbreviated or full SHA-1). */
export const SHA = /^[0-9a-f]{7,40}$/;

export function assertSha(sha: string): string {
  if (!SHA.test(sha)) throw HttpError.badRequest('Invalid commit id');
  return sha;
}

/** Resolves a validated revision (sha or branch name) to a full commit id, or undefined if there is none. */
export async function resolveCommit(cwd: string, rev: string): Promise<string | undefined> {
  const out = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`], { cwd, okExitCodes: [1] }).catch(() => '');
  return out.trim() || undefined;
}

export interface ChangedFile {
  path: string;
  /** Original path, for renames and copies. */
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
}

const NAME_STATUS: Record<string, ChangedFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange' };

/** Parses `--name-status -z` output: "<code>\0<path>\0", or "<R|C><score>\0<old>\0<new>\0". */
function parseNameStatus(out: string): ChangedFile[] {
  const parts = out.split('\0');
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!.trim();
    if (!code) continue;
    const status = NAME_STATUS[code[0]!] ?? 'modified';
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = parts[i + 1];
      const path = parts[i + 2];
      if (path) files.push({ oldPath, path, status });
      i += 2;
    } else {
      const path = parts[i + 1];
      if (path) files.push({ path, status });
      i += 1;
    }
  }
  return files;
}

const MAX_DIFF_FILES = 100;
const MAX_CONTENT_FILES = 40;
const MAX_CONTENT_BYTES = 1024 * 1024;

export interface FileVersions extends ChangedFile {
  original: string;
  modified: string;
  binary: boolean;
  /** Contents were left out (too many files or too large). */
  omitted?: boolean;
}

/** A file's contents at a commit, as text; '' when it does not exist there. */
async function blobAt(cwd: string, rev: string | undefined, path: string | undefined): Promise<{ text: string; binary: boolean; tooLarge: boolean }> {
  if (!rev || !path) return { text: '', binary: false, tooLarge: false };
  const size = Number((await runGit(['cat-file', '-s', `${rev}:${path}`], { cwd }).catch(() => '0')).trim());
  if (size > MAX_CONTENT_BYTES) return { text: '', binary: false, tooLarge: true };
  const text = await runGit(['show', `${rev}:${path}`], { cwd }).catch(() => '');
  const binary = text.slice(0, 8000).includes('\0');
  return { text: binary ? '' : text, binary, tooLarge: false };
}

/** Before/after contents for changed files between two commits, capped in count and size. */
async function withContents(cwd: string, from: string | undefined, to: string, files: ChangedFile[]): Promise<{ files: FileVersions[]; truncated: boolean }> {
  const truncated = files.length > MAX_DIFF_FILES;
  const out: FileVersions[] = [];
  for (const [i, f] of files.slice(0, MAX_DIFF_FILES).entries()) {
    if (i >= MAX_CONTENT_FILES) {
      out.push({ ...f, original: '', modified: '', binary: false, omitted: true });
      continue;
    }
    const before = f.status === 'added' ? undefined : (f.oldPath ?? f.path);
    const after = f.status === 'deleted' ? undefined : f.path;
    const [a, b] = await Promise.all([blobAt(cwd, from, before), blobAt(cwd, to, after)]);
    out.push({ ...f, original: a.text, modified: b.text, binary: a.binary || b.binary, ...(a.tooLarge || b.tooLarge ? { omitted: true } : {}) });
  }
  return { files: out, truncated };
}

export interface CommitDetail {
  sha: string;
  parent: string | null;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
  files: FileVersions[];
  truncated: boolean;
}

/** One commit: metadata and each changed file before and after (compared with its first parent). */
export async function commitDetail(cwd: string, sha: string): Promise<CommitDetail | undefined> {
  const full = await resolveCommit(cwd, assertSha(sha));
  if (!full) return undefined;
  const meta = await runGit(['log', '-1', '--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b', full], { cwd });
  const [, parents, author, email, date, subject, body] = meta.replace(/\n+$/, '').split('\x1f');
  const parent = parents?.split(' ').filter(Boolean)[0] ?? null;
  const raw = parent
    ? await runGit(['diff', '--name-status', '-z', '-M', '--no-color', parent, full], { cwd })
    : await runGit(['diff-tree', '--root', '-r', '--no-commit-id', '--name-status', '-z', '-M', full], { cwd });
  const changed = await withContents(cwd, parent ?? undefined, full, parseNameStatus(raw));
  return { sha: full, parent, author: author ?? '', email: email ?? '', date: date ?? '', subject: subject ?? '', body: (body ?? '').trim(), ...changed };
}

export interface Comparison {
  base: string;
  head: string;
  mergeBase: string | null;
  commits: { sha: string; author: string; date: string; subject: string }[];
  files: FileVersions[];
  truncated: boolean;
}

/**
 * What `head` changes since it forked from `base` (`git diff base...head`), and the commits
 * on head that base lacks. Both are branch names (local, or origin/<name>).
 */
export async function compare(cwd: string, base: string, head: string): Promise<Comparison> {
  const baseSha = await resolveCommit(cwd, assertBranch(base));
  const headSha = await resolveCommit(cwd, assertBranch(head));
  if (!baseSha) throw HttpError.badRequest(`Branch "${base}" not found`);
  if (!headSha) throw HttpError.badRequest(`Branch "${head}" not found`);
  const mergeBase = (await runGit(['merge-base', baseSha, headSha], { cwd, okExitCodes: [1] }).catch(() => '')).trim() || null;
  const raw = await runGit(['diff', '--name-status', '-z', '-M', '--no-color', `${baseSha}...${headSha}`], { cwd }).catch((e: GitError) => {
    throw HttpError.badRequest(e.message);
  });
  const commitsOut = await runGit(['log', '-100', '--format=%H%x1f%an%x1f%aI%x1f%s', `${baseSha}..${headSha}`], { cwd });
  const commits = commitsOut
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, author, date, subject] = l.split('\x1f');
      return { sha: sha!, author: author!, date: date!, subject: subject ?? '' };
    });
  const changed = await withContents(cwd, mergeBase ?? undefined, headSha, parseNameStatus(raw));
  return { base, head, mergeBase, commits, ...changed };
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export const MAX_SEARCH_RESULTS = 200;

/**
 * Searches tracked and untracked (not ignored) text files with `git grep`, case-insensitively.
 * The query is a fixed string unless `regex` (POSIX extended) and always follows `-e`, so it
 * can never be read as an option.
 */
export async function grep(cwd: string, query: string, opts: { regex?: boolean; timeoutMs?: number } = {}): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const args = ['grep', '-n', '-I', '-i', '-z', '--untracked', '--no-color', '--full-name', '--max-count=50', opts.regex ? '-E' : '-F', '-e', query, '--', '.'];
  const out = await runGit(args, { cwd, okExitCodes: [1], timeoutMs: opts.timeoutMs ?? 10_000 }).catch((e: GitError) => {
    if (e.timedOut) throw HttpError.badRequest('The search took too long. Try a more specific query.');
    throw HttpError.badRequest(`Invalid search: ${e.stderr.trim().split('\n').at(-1) ?? e.message}`);
  });
  const hits: SearchHit[] = [];
  let truncated = false;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [path, lineNo, ...rest] = line.split('\0');
    if (!path || !lineNo || !/^\d+$/.test(lineNo)) continue;
    if (hits.length >= MAX_SEARCH_RESULTS) {
      truncated = true;
      break;
    }
    const text = rest.join('\0');
    hits.push({ path, line: Number(lineNo), text: text.length > 300 ? `${text.slice(0, 300)}…` : text });
  }
  return { hits, truncated };
}
