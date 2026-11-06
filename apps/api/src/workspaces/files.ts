import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../http/errors.js';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_TREE_ENTRIES = 8000;
/** Shown in the tree but not expanded, to keep listings fast. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', 'coverage']);

const within = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
const sameOrWithin = (child: string, parent: string) =>
  process.platform === 'win32' ? within(child.toLowerCase(), parent.toLowerCase()) : within(child, parent);

/**
 * Resolves a user-supplied path inside the repository root. Rejects absolute paths,
 * `..` traversal, anything resolving into `.git` (including Windows aliases such as
 * `.git.`, `.git ` or `GIT~1`), symlinks that lead outside the root, and, for writes,
 * any symlink on the path at all (a dangling link would otherwise be followed on write).
 */
export async function resolveInRepo(
  repoRoot: string,
  rel: string,
  opts: { mustExist?: boolean; forWrite?: boolean } = {},
): Promise<string> {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 1024 || rel.includes('\0')) {
    throw HttpError.badRequest('Invalid path');
  }
  const normalised = rel.replace(/\\/g, '/');
  if (path.isAbsolute(normalised) || /^[A-Za-z]:/.test(normalised)) throw HttpError.badRequest('Path must be relative');
  const segments = normalised.split('/').filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) throw HttpError.badRequest('Path may not contain ..');
  // Names Windows silently rewrites or treats specially: trailing dots/spaces, alternate
  // data streams (name:stream) and 8.3 short names (GIT~1).
  if (segments.some((s) => /[. ]$/.test(s) || s.includes(':') || /^[^~.]{1,6}~\d+(\.|$)/.test(s))) {
    throw HttpError.badRequest('Unsupported file name');
  }
  if (segments[0]?.toLowerCase() === '.git') throw HttpError.forbidden('The .git directory is managed by the platform');

  const root = await realpath(repoRoot);
  const gitDir = await realpath(path.join(root, '.git')).catch(() => null);
  const target = path.join(root, ...segments);

  // Walk from the root down; every component that exists must not be a symlink leading
  // outside (or, for writes, a symlink at all) and must not resolve into .git.
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (opts.mustExist) throw HttpError.notFound('File not found');
      break; // the rest of the path does not exist yet
    }
    if (info.isSymbolicLink() && opts.forWrite) throw HttpError.forbidden('Writing through a symbolic link is not allowed');
    const real = await realpath(current).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw HttpError.forbidden('Broken symbolic link');
      throw err;
    });
    if (!sameOrWithin(real, root)) throw HttpError.forbidden('Path escapes the workspace');
    if (gitDir && sameOrWithin(real, gitDir)) throw HttpError.forbidden('The .git directory is managed by the platform');
  }
  return target;
}

export interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
  skipped?: boolean;
}

export async function listTree(repoRoot: string): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const entries: TreeEntry[] = [];
  let truncated = false;
  async function walk(dir: string, prefix: string) {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) {
        entries.push({ path: rel, type: 'file' });
      } else if (item.isDirectory()) {
        if (item.name === '.git') continue;
        const skipped = SKIP_DIRS.has(item.name);
        entries.push({ path: rel, type: 'dir', ...(skipped ? { skipped } : {}) });
        if (!skipped) await walk(path.join(dir, item.name), rel);
      } else if (item.isFile()) {
        entries.push({ path: rel, type: 'file' });
      }
    }
  }
  await walk(repoRoot, '');
  return { entries, truncated };
}

export async function readRepoFile(repoRoot: string, rel: string): Promise<{ content: string; binary: boolean; size: number }> {
  const file = await resolveInRepo(repoRoot, rel, { mustExist: true });
  const info = await lstat(file);
  if (!info.isFile()) throw HttpError.badRequest('Not a file');
  if (info.size > MAX_READ_BYTES) return { content: '', binary: true, size: info.size };
  const buf = await readFile(file);
  const binary = buf.subarray(0, 8000).includes(0);
  return { content: binary ? '' : buf.toString('utf8'), binary, size: info.size };
}

export async function writeRepoFile(repoRoot: string, rel: string, content: string): Promise<void> {
  const file = await resolveInRepo(repoRoot, rel, { forWrite: true });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

export async function deleteRepoPath(repoRoot: string, rel: string): Promise<void> {
  const file = await resolveInRepo(repoRoot, rel, { mustExist: true, forWrite: true });
  await rm(file, { recursive: true, force: true });
}
