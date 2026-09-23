import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript')), 'tsc.js');
const compileArgs = [tsc, '-p', 'tsconfig.build.json'];

const initialBuild = spawnSync(process.execPath, compileArgs, {
  cwd: process.cwd(),
  stdio: 'inherit',
});
if (initialBuild.status !== 0) {
  process.exit(initialBuild.status ?? 1);
}

const compiler = spawn(
  process.execPath,
  [...compileArgs, '--watch', '--preserveWatchOutput'],
  { cwd: process.cwd(), stdio: 'inherit' },
);
// --watch-path disables Node's automatic dependency watching. Include built
// workspace packages so adapter/runtime fixes are actually loaded in dev.
const packagesRoot = resolve(process.cwd(), '../../packages');
const watchedPackages = existsSync(packagesRoot)
  ? readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, 'package.json')))
    .map(entry => ({ path: join(packagesRoot, entry.name), manifest: JSON.parse(readFileSync(join(packagesRoot, entry.name, 'package.json'), 'utf8')) }))
    .filter(entry => entry.manifest.name?.startsWith('@socio/') && existsSync(join(entry.path, 'dist')))
    .map(entry => `--watch-path=${join(entry.path, 'dist')}`)
  : [];
const application = spawn(
  process.execPath,
  ['--watch-path=dist', ...watchedPackages, '--enable-source-maps', 'dist/main.js'],
  { cwd: process.cwd(), stdio: 'inherit' },
);

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  compiler.kill();
  application.kill();
  process.exitCode = exitCode;
}

compiler.on('exit', (code) => {
  if (!stopping) stop(code ?? 1);
});
application.on('exit', (code) => {
  if (!stopping) stop(code ?? 1);
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
