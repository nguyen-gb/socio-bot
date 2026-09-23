import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { BrowserRuntime } from '@socio/browser-runtime';
import { PrismaService } from '../database/prisma.service';
import { WorkerRegistryService } from '../worker-registry/worker-registry.service';
import { BROWSER_RUNTIME } from './runtime.providers';

@Injectable()
export class BrowserControlService implements OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly busy = new Set<string>();
  private pollFlight?: Promise<void>;
  private readonly jobs = new Set<Promise<void>>();
  private readonly logger = new Logger(BrowserControlService.name);
  constructor(private readonly prisma: PrismaService, private readonly registry: WorkerRegistryService,
    @Inject(BROWSER_RUNTIME) private readonly runtime: BrowserRuntime) {}

  async start() {
    // Worker names are stable. Recover only sessions assigned to this worker.
    const stale = await this.prisma.browserSession.findMany({ where: { workerId: this.registry.workerId, status: { in: ['STARTING', 'RUNNING', 'CLOSING', 'IDLE'] } } });
    for (const session of stale) {
      await this.runtime.forceCloseProfile(session.profileId);
      await this.prisma.browserSession.update({ where: { id: session.id }, data: { status: 'CRASHED', closedAt: new Date(), lastError: 'Worker đã khởi động lại; phiên browser cũ đã được thu hồi.' } });
      await this.prisma.browserProfile.update({ where: { id: session.profileId }, data: { status: 'AVAILABLE' } });
    }
    this.timer = setInterval(() => {
      if (!this.pollFlight) this.pollFlight = this.poll().catch(error => this.logger.error(String(error))).finally(() => { this.pollFlight = undefined; });
    }, 1000);
    this.timer.unref();
  }

  async poll() {
    // Requests that never reached a worker have no process to kill. Claiming a
    // session and cancelling it both use conditional updates to avoid a race.
    await this.prisma.browserSession.updateMany({ where: { workerId: null, mode: 'LOGIN', OR: [
      { status: 'CLOSING' }, { status: 'STARTING', expiresAt: { lte: new Date() } },
    ] }, data: { status: 'CLOSED', closedAt: new Date() } });
    const sessions = await this.prisma.browserSession.findMany({ where: { workerId: this.registry.workerId, OR: [{ status: 'CLOSING' }, { status: { in: ['RUNNING', 'STARTING'] }, expiresAt: { lte: new Date() } }] } });
    for (const session of sessions) {
      // Force requests can interrupt a graceful close that is still pending.
      const key = `${session.id}/${session.forceCloseRequestedAt ? 'force' : 'close'}`;
      if (this.busy.has(key)) continue;
      this.busy.add(key);
      const job = (async () => {
        if (session.forceCloseRequestedAt) await this.runtime.forceCloseProfile(session.profileId, session.id);
        else await this.runtime.closeProfile(session.profileId, session.id);
        // The owning activity releases leases and persists its outcome in finally.
      })().catch(error => this.logger.error(`Browser close failed: ${String(error)}`)).finally(() => { this.busy.delete(key); this.jobs.delete(job); });
      this.jobs.add(job);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.pollFlight;
    await this.runtime.closeAll();
    await Promise.allSettled(this.jobs);
  }
}
