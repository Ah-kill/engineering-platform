import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claude Code ships inside @anthropic-ai/claude-agent-sdk. Updating the platform's
 * Claude Code = updating that package (`npm run update:claude`), which also brings
 * support for newly released models. This reports installed vs latest so admins see
 * when an update is available. Updates are applied deliberately (and tested), not
 * silently in the middle of developers' sessions.
 */

let latestCache: { at: number; version: string | null } | undefined;

export async function claudeCodeVersions(): Promise<{
  sdk: string;
  claudeCode: string;
  latestSdk: string | null;
  updateAvailable: boolean;
}> {
  const pkg = await readSdkPackage();

  if (!latestCache || Date.now() - latestCache.at > 6 * 3600_000) {
    const version = await fetch('https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest', { signal: AbortSignal.timeout(8000) })
      .then(async (r) => (r.ok ? ((await r.json()) as { version: string }).version : null))
      .catch(() => null);
    latestCache = { at: Date.now(), version };
  }
  const latest = latestCache.version;
  return {
    sdk: pkg.version,
    claudeCode: pkg.claudeCodeVersion ?? 'unknown',
    latestSdk: latest,
    updateAvailable: !!latest && latest !== pkg.version && newer(latest, pkg.version),
  };
}

/** The SDK's exports map hides package.json, so walk up from its entry point. */
export async function readSdkPackage(): Promise<{ version: string; claudeCodeVersion?: string }> {
  let dir = path.dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version: string; claudeCodeVersion?: string };
      if (pkg.name === '@anthropic-ai/claude-agent-sdk') return pkg;
    } catch {
      // keep walking up
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not find the Claude Agent SDK package');
}

function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}
