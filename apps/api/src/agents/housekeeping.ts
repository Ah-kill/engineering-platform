import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../db/db.js';
import { openTerminals } from '../workspaces/terminal-registry.js';
import type { WorkspaceRuntime } from '../workspaces/runtime.js';

/**
 * Container and disk hygiene around agent runs:
 * - `folderSize`: a bounded walk of a workspace folder, for the disk guard before a run.
 * - `reapIdleWorkspaces` / `startIdleReaper`: stop the containers of idle workspaces.
 * - a registry of "is Claude running here?" checks, so the reaper (started in main.ts,
 *   outside the app) never stops a container in the middle of a run.
 */

export interface FolderSize {
  bytes: number;
  /** False when the walk stopped early (time limit, or already above `stopAboveBytes`). */
  complete: boolean;
}

/**
 * Adds up the size of every file under `root`, including dot folders, node_modules and the
 * git directory. Links are counted as links and never followed, so a link cannot make the
 * walk leave the folder or loop. The walk stops at `timeLimitMs` or as soon as the total
 * exceeds `stopAboveBytes`.
 */
export async function folderSize(root: string, opts: { timeLimitMs?: number; stopAboveBytes?: number } = {}): Promise<FolderSize> {
  const deadline = Date.now() + (opts.timeLimitMs ?? 5_000);
  const stopAbove = opts.stopAboveBytes ?? Infinity;
  let bytes = 0;
  const dirs = [root];
  while (dirs.length) {
    if (Date.now() > deadline || bytes > stopAbove) return { bytes, complete: false };
    const dir = dirs.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // removed meanwhile, or unreadable
    }
    const files: string[] = [];
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) dirs.push(p);
      else files.push(p);
    }
    for (let i = 0; i < files.length; i += 64) {
      const sizes = await Promise.all(files.slice(i, i + 64).map((f) => lstat(f).then((s) => s.size, () => 0)));
      for (const s of sizes) bytes += s;
      if (Date.now() > deadline) return { bytes, complete: false };
    }
  }
  return { bytes, complete: true };
}

// ---- which workspaces have Claude running -------------------------------------------

const runChecks = new Set<(workspaceId: string) => boolean>();

/** Registers an agent manager's `isRunning`; returns the function that unregisters it. */
export function registerRunCheck(fn: (workspaceId: string) => boolean): () => void {
  runChecks.add(fn);
  return () => runChecks.delete(fn);
}

export function agentRunning(workspaceId: string): boolean {
  for (const fn of runChecks) if (fn(workspaceId)) return true;
  return false;
}

// ---- idle reaper ----------------------------------------------------------------------

export interface ReaperOptions {
  idleMinutes: number;
  isRunning?: (workspaceId: string) => boolean;
  /** Workspaces stopped earlier, with the activity time they had; skipped until they are used again. */
  stopped?: Map<string, string>;
}

/**
 * Stops the container (and egress proxy) of every ready workspace whose last activity is
 * older than `idleMinutes`, unless Claude is running in it or a browser terminal is open.
 * Files stay on disk; the next request that needs the container starts it again.
 * Runs across organizations, so it uses the system connection and reads ids only.
 */
export async function reapIdleWorkspaces(db: Database, runtime: WorkspaceRuntime, opts: ReaperOptions): Promise<string[]> {
  const isRunning = opts.isRunning ?? agentRunning;
  const rows = await db.system((q) =>
    q.query<{ id: string; last: string }>(
      `SELECT id, last_active_at::text AS last FROM workspaces
        WHERE state = 'ready' AND last_active_at < now() - ($1::double precision * interval '1 minute')
        ORDER BY last_active_at`,
      [opts.idleMinutes],
    ),
  );
  const stoppedNow: string[] = [];
  for (const r of rows) {
    if (opts.stopped?.get(r.id) === r.last) continue;
    if (isRunning(r.id) || openTerminals(r.id) > 0) continue;
    await runtime.stop(r.id).catch(() => undefined);
    opts.stopped?.set(r.id, r.last);
    stoppedNow.push(r.id);
  }
  return stoppedNow;
}

export const REAPER_INTERVAL_MS = 5 * 60_000;

/** Runs the reaper every five minutes. The timer is unref'd so it never keeps the process alive. */
export function startIdleReaper(
  db: Database,
  runtime: WorkspaceRuntime,
  opts: { idleMinutes: number; intervalMs?: number; log?: { info(o: object, m: string): void; warn(o: object, m: string): void } },
): () => void {
  const stopped = new Map<string, string>();
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const ids = await reapIdleWorkspaces(db, runtime, { idleMinutes: opts.idleMinutes, stopped });
      if (ids.length) opts.log?.info({ workspaces: ids }, 'stopped idle workspace containers');
    } catch (err) {
      opts.log?.warn({ err: (err as Error).message }, 'idle reaper failed');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? REAPER_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
