import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
export interface BrowserProcessRecord { token: string; pid?: number; started?: string; profileId: string; ownerId?: string }
interface ProcessIdentity { pid: number; parent: number; started: string; command: string }

/**
 * Some managed Windows environments deny child-process inspection entirely
 * (Node receives EPERM when it tries to start PowerShell).  Browser sessions
 * can still be owned and closed through Playwright in that case; keep the
 * distinction explicit so we do not mistake an inspection failure for a
 * browser collision.
 */
class ProcessInspectionUnavailable extends Error {}

async function processes(): Promise<ProcessIdentity[]> {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='headless_shell.exe' OR Name='chrome-headless-shell.exe' OR Name='chromium.exe'\" -ErrorAction Stop | ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToString('O');command=$_.CommandLine} }) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
      return JSON.parse(stdout || '[]') as ProcessIdentity[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') throw new ProcessInspectionUnavailable('Windows process inspection is unavailable');
      throw error;
    }
  }
  if (process.platform !== 'linux') throw new Error('Browser process recovery supports Windows and Linux');
  const rows = await Promise.all((await readdir('/proc')).filter(id => /^\d+$/.test(id)).map(async id => {
    try {
      const command = (await readFile(`/proc/${id}/cmdline`, 'utf8')).replace(/\0/g, ' ');
      const stat = await readFile(`/proc/${id}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid: Number(id), parent: Number(fields[1]), started: fields[19]!, command };
    } catch { return undefined; }
  }));
  return rows.filter((row): row is ProcessIdentity => !!row);
}

// A PID alone is unsafe after a worker restart: OSes reuse them. Validate both
// creation time and an unguessable launch marker before terminating a process.
export class BrowserProcessRegistry {
  private readonly absoluteRoot: string;

  constructor(private readonly root: string) {
    this.absoluteRoot = resolve(root);
  }
  private file(profileId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) throw new Error('Invalid browser profile id');
    return join(this.root, '.processes', `${profileId}.json`);
  }
  async begin(profileId: string, ownerId?: string): Promise<BrowserProcessRecord> {
    await this.recover(profileId);
    const record = { profileId, ownerId, token: randomUUID() };
    await this.save(record);
    return record;
  }
  async identify(record: BrowserProcessRecord): Promise<void> {
    let rows: ProcessIdentity[];
    try { rows = await processes(); }
    catch (error) {
      if (error instanceof ProcessInspectionUnavailable) {
        await this.save(record);
        return;
      }
      throw error;
    }
    const match = rows.find(p => p.command?.includes(`--socio-session-token=${record.token}`) && !p.command.includes('--type='));
    if (!match) throw new Error('Cannot identify the managed Chromium process');
    record.pid = match.pid; record.started = match.started;
    await this.save(record);
  }

  /** Return false when the exact managed browser tree has disappeared. */
  async isAlive(record: BrowserProcessRecord): Promise<boolean | undefined> {
    let rows: ProcessIdentity[];
    try { rows = await processes(); }
    catch (error) {
      if (error instanceof ProcessInspectionUnavailable) return undefined;
      throw error;
    }
    return rows.some(p => p.command?.includes(`--socio-session-token=${record.token}`));
  }
  async terminate(record: BrowserProcessRecord): Promise<void> {
    let all: ProcessIdentity[];
    try { all = await processes(); }
    catch (error) {
      if (error instanceof ProcessInspectionUnavailable) {
        // A record without a verified PID was created before browser launch
        // (or after a failed launch).  It is safe to clear that stale marker;
        // a live process with a PID still fails closed for manual recovery.
        if (record.pid) throw error;
        await this.forget(record);
        return;
      }
      throw error;
    }
    const owned = all.filter(p => p.command?.includes(`--socio-session-token=${record.token}`));
    const root = owned.find(p => !p.command.includes('--type='));
    if (root) {
      if (record.pid && (root.pid !== record.pid || root.started !== record.started)) throw new Error('Browser process identity changed; refusing termination');
      if (process.platform === 'win32') {
        await execute('taskkill.exe', ['/PID', String(root.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
      } else {
        const descendants = (parent: number): number[] => all.filter(p => p.parent === parent).flatMap(p => [...descendants(p.pid), p.pid]);
        for (const pid of [...descendants(root.pid), root.pid]) {
          try { process.kill(pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
      }
    } else if (process.platform === 'win32') {
      // A crashed Chrome root can disappear while a child still owns the
      // profile. Kill only descendants carrying this launch's unguessable
      // session token; never fall back to taskkill /IM chrome.exe.
      for (const process of owned) {
        await execute('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }).catch(() => undefined);
      }
    }
    if ((await processes()).some(p => p.command?.includes(`--socio-session-token=${record.token}`))) throw new Error('Chromium process is still running');
    await this.forget(record);
  }
  async recover(profileId: string, ownerId?: string): Promise<void> {
    let record: BrowserProcessRecord | undefined;
    try { record = JSON.parse(await readFile(this.file(profileId), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (record) {
      if (record.profileId !== profileId || !/^[0-9a-f-]{36}$/.test(record.token)) throw new Error('Invalid browser process record');
      if (ownerId && record.ownerId !== ownerId) return;
      await this.terminate(record);
    }
    await this.removeStaleProfileLocks(profileId);
  }

  /**
   * Chrome leaves Singleton* files behind after a hard worker/Chrome crash.
   * They are safe to remove only after process inspection proves that no
   * browser currently owns this exact profile directory. Never touch locks
   * when inspection is unavailable: a user's normal Chrome must win over
   * recovery rather than being accidentally interrupted.
   */
  private async removeStaleProfileLocks(profileId: string): Promise<void> {
    let rows: ProcessIdentity[];
    try { rows = await processes(); }
    catch (error) {
      if (error instanceof ProcessInspectionUnavailable) return;
      throw error;
    }

    const profilePath = resolve(this.absoluteRoot, profileId);
    const normalizedProfilePath = profilePath.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    const ownsProfile = rows.some((process) => {
      const command = (process.command ?? '').replace(/["']/g, '').replace(/[\\/]+/g, '/').toLowerCase();
      return command.includes(`--user-data-dir=${normalizedProfilePath}`)
        || command.includes(`--user-data-dir=${normalizedProfilePath} `);
    });
    if (ownsProfile) throw new Error(`Browser profile is still in use: ${profileId}`);

    for (const lockName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await rm(join(profilePath, lockName), { force: true });
    }
  }
  async forget(record: BrowserProcessRecord): Promise<void> {
    // A late close event must never remove a newer browser's record.
    try {
      const saved = JSON.parse(await readFile(this.file(record.profileId), 'utf8')) as BrowserProcessRecord;
      if (saved.token === record.token) await rm(this.file(record.profileId), { force: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private async save(record: BrowserProcessRecord) {
    await mkdir(join(this.root, '.processes'), { recursive: true });
    const temporary = `${this.file(record.profileId)}.${record.token}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, this.file(record.profileId));
  }
}
