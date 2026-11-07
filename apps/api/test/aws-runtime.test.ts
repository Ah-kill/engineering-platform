import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSdkPackage } from '../src/agents/version.js';
import { defaultImage, DockerRuntime } from '../src/workspaces/runtime.js';

/**
 * The workspace image ships AWS CLI v2, so the short-lived AWS_* credentials the platform
 * injects are usable from Claude runs and terminals. Runs the CLI with the same hardening as a
 * workspace container (unprivileged, no capabilities, read-only root). Skipped without Docker.
 * Builds the image first when it is missing (like `npm run runtime:build`).
 */
const dockerUp = await DockerRuntime.available();

const RUNTIME_DIR = fileURLToPath(new URL('../../runtime/', import.meta.url));

function docker(args: string[], timeout = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() });
    });
  });
}

describe.skipIf(!dockerUp)('AWS CLI in the workspace image', () => {
  it('runs `aws --version` (v2) as the unprivileged workspace user', async () => {
    const sdk = await readSdkPackage();
    const image = defaultImage(sdk.claudeCodeVersion!);
    if ((await docker(['image', 'inspect', '--format', '{{.Id}}', image])).code !== 0) {
      // Same build as DockerRuntime and `npm run runtime:build`.
      const built = await docker(['build', '--build-arg', `CLAUDE_CODE_VERSION=${sdk.claudeCodeVersion}`, '-t', image, RUNTIME_DIR], 30 * 60_000);
      expect(built.code, built.out.split('\n').slice(-5).join('\n')).toBe(0);
    }

    const r = await docker([
      'run', '--rm', '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--read-only', image, 'aws', '--version',
    ]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/^aws-cli\/2\.\d+\.\d+ /);
  }, 35 * 60_000);
});
