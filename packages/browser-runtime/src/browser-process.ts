import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
export interface BrowserProcessRecord { token: string; pid?: number; started?: string; profileId: string; ownerId?: string }
interface ProcessIdentity { pid: number; parent: number; started: string; command: string }

async function processes(): Promise<ProcessIdentity[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='headless_shell.exe' OR Name='chrome-headless-shell.exe' OR Name='chromium.exe'\" -ErrorAction Stop | ForEach-Object { @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().ToString('O');command=$_.CommandLine} }) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout || '[]') as ProcessIdentity[];
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
  constructor(private readonly root: string) {}
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
    const match = (await processes()).find(p => p.command?.includes(`--socio-session-token=${record.token}`) && !p.command.includes('--type='));
    if (!match) throw new Error('Cannot identify the managed Chromium process');
    record.pid = match.pid; record.started = match.started;
    await this.save(record);
  }
  async terminate(record: BrowserProcessRecord): Promise<void> {
    const all = await processes();
    const root = all.find(p => p.command?.includes(`--socio-session-token=${record.token}`) && !p.command.includes('--type='));
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
    }
    if ((await processes()).some(p => p.command?.includes(`--socio-session-token=${record.token}`) && !p.command.includes('--type='))) throw new Error('Chromium process is still running');
    await this.forget(record);
  }
  async recover(profileId: string, ownerId?: string): Promise<void> {
    let record: BrowserProcessRecord;
    try { record = JSON.parse(await readFile(this.file(profileId), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (record.profileId !== profileId || !/^[0-9a-f-]{36}$/.test(record.token)) throw new Error('Invalid browser process record');
    if (ownerId && record.ownerId !== ownerId) return;
    await this.terminate(record);
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
