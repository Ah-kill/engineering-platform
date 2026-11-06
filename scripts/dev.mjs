// Starts the API and the web app together; Ctrl+C stops both.
import { spawn, spawnSync } from 'node:child_process';

// Fixed command strings (no user input), so running them through the shell is safe
// and works for npm.cmd on Windows.
const children = ['apps/api', 'apps/web'].map((ws) =>
  spawn(`npm run dev --workspace ${ws}`, { stdio: 'inherit', shell: true }),
);

// On Windows, killing the shell leaves npm/node grandchildren holding the ports,
// so kill each whole process tree.
const killTree = (child) => {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
};

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) killTree(c);
  process.exit(code);
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const c of children) c.on('exit', (code) => { if (code) stop(code); });
