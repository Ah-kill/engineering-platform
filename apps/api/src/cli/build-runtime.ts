/** Builds the workspace container image for the installed Claude Code version. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSdkPackage } from '../agents/version.js';
import { defaultImage } from '../workspaces/runtime.js';

const sdk = await readSdkPackage();
const version = sdk.claudeCodeVersion ?? 'latest';
const image = defaultImage(version);
const dir = fileURLToPath(new URL('../../../runtime/', import.meta.url));
console.log(`Building ${image} (Claude Code ${version})`);
execFileSync('docker', ['build', '--build-arg', `CLAUDE_CODE_VERSION=${version}`, '-t', image, dir], { stdio: 'inherit' });
