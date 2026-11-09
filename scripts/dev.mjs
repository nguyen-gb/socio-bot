import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const command = isWindows ? 'powershell.exe' : 'corepack';
const args = isWindows
  ? [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL('./start-local.ps1', import.meta.url)),
    ]
  : ['pnpm', 'dev:apps'];

const child = spawn(command, args, { stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
