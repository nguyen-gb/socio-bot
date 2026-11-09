import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs';
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
// Include built workspace packages so adapter/runtime fixes are loaded in dev.
const packagesRoot = resolve(process.cwd(), '../../packages');
const watchedPackages = existsSync(packagesRoot)
  ? readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, 'package.json')))
    .map(entry => ({ path: join(packagesRoot, entry.name), manifest: JSON.parse(readFileSync(join(packagesRoot, entry.name, 'package.json'), 'utf8')) }))
    .filter(entry => entry.manifest.name?.startsWith('@socio/') && existsSync(join(entry.path, 'dist')))
    .map(entry => join(entry.path, 'dist'))
  : [];

let stopping = false;
let restarting = false;
let restartTimer;
let application;
const watchers = [];

function startApplication() {
  const child = spawn(
    process.execPath,
    ['--enable-source-maps', 'dist/main.js'],
    { cwd: process.cwd(), stdio: 'inherit' },
  );
  application = child;
  child.on('exit', (code) => {
    if (stopping || child !== application) return;
    if (restarting) {
      restarting = false;
      application = undefined;
      startApplication();
      return;
    }
    stop(code ?? 1);
  });
}

function scheduleRestart() {
  if (stopping) return;
  clearTimeout(restartTimer);
  // TypeScript emits several files for one source change. Restart only after
  // the whole output batch has settled so API/worker do not enter a loop.
  restartTimer = setTimeout(() => {
    if (stopping || restarting || !application) return;
    restarting = true;
    console.log('Restarting application after compiled output changed.');
    const previous = application;
    previous.kill();
    // Some Windows processes release their port but delay the ChildProcess
    // exit event while native handles are closing. Do not leave dev stopped.
    setTimeout(() => {
      if (stopping || !restarting || application !== previous) return;
      restarting = false;
      application = undefined;
      startApplication();
    }, 1_500);
  }, 500);
}

startApplication();
for (const directory of [resolve(process.cwd(), 'dist'), ...watchedPackages]) {
  if (!existsSync(directory)) continue;
  watchers.push(watch(directory, { recursive: true }, scheduleRestart));
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  for (const watcher of watchers) watcher.close();
  compiler.kill();
  application?.kill();
  process.exitCode = exitCode;
}

compiler.on('exit', (code) => {
  if (!stopping) stop(code ?? 1);
});
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
