// Starts the API and the web app together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

// Fixed command strings (no user input), so running them through the shell is safe
// and works for npm.cmd on Windows.
const children = ['apps/api', 'apps/web'].map((ws) =>
  spawn(`npm run dev --workspace ${ws}`, { stdio: 'inherit', shell: true }),
);

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { if (code) stop(); });
