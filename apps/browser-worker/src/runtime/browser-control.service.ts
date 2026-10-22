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
  private lastProfileRecoveryAt = 0;
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
    await this.recoverInterruptedTaskRuns();
    this.timer = setInterval(() => {
      if (!this.pollFlight) this.pollFlight = this.poll().catch(error => this.logger.error(String(error))).finally(() => { this.pollFlight = undefined; });
    }, 1000);
    this.timer.unref();
  }

  async poll() {
    await this.recoverStaleProfileStates();
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
        try {
          if (session.forceCloseRequestedAt) await this.runtime.forceCloseProfile(session.profileId, session.id);
          else await this.runtime.closeProfile(session.profileId, session.id);
          // Do not leave the API/UI polling CLOSING forever when the owning
          // activity has already stopped or the browser disappeared first.
          // A live activity may still write AUTHENTICATED later; this
          // conditional update only closes rows that are still CLOSING.
          await this.prisma.browserSession.updateMany({
            where: { id: session.id, status: 'CLOSING' },
            data: { status: 'CLOSED', closedAt: new Date() },
          });
          await this.releaseProfileAfterSessionClose(session.profileId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`Browser close failed: ${message}`);
          // A failed cleanup must still be terminal from the API's point of
          // view. The process marker is retained for the next recovery pass.
          await this.prisma.browserSession.updateMany({
            where: { id: session.id, status: 'CLOSING' },
            data: { status: 'CRASHED', closedAt: new Date(), lastError: message },
          }).catch(() => undefined);
          await this.releaseProfileAfterSessionClose(session.profileId).catch(() => undefined);
        }
      })().finally(() => { this.busy.delete(key); this.jobs.delete(job); });
      this.jobs.add(job);
    }
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.pollFlight;
    await this.runtime.closeAll();
    await Promise.allSettled(this.jobs);
  }

  private async recoverStaleProfileStates(): Promise<void> {
    // Avoid an extra pair of profile queries on every one-second control tick.
    const now = Date.now();
    if (now - this.lastProfileRecoveryAt < 15_000) return;
    this.lastProfileRecoveryAt = now;

    // A normal task/login keeps a non-terminal BrowserSession row while its
    // profile is LEASED. If the worker/browser died before the activity's
    // finally block ran, no active session remains and this state is safe to
    // reclaim after a short grace period.
    await this.prisma.browserProfile.updateMany({
      where: {
        status: 'LEASED',
        updatedAt: { lt: new Date(now - 2 * 60_000) },
        sessions: { none: { status: { in: ['STARTING', 'RUNNING', 'IDLE', 'CLOSING'] } } },
      },
      data: { status: 'AVAILABLE' },
    });

    // Snapshotting can legitimately take longer than a lease, so use a
    // larger threshold. It is still bounded so a killed worker cannot leave
    // the API rejecting every future login forever.
    await this.prisma.browserProfile.updateMany({
      where: {
        status: 'SNAPSHOTTING',
        updatedAt: { lt: new Date(now - 10 * 60_000) },
        sessions: { none: { status: { in: ['STARTING', 'RUNNING', 'IDLE', 'CLOSING'] } } },
      },
      data: { status: 'ERROR' },
    });
  }

  private async recoverInterruptedTaskRuns(): Promise<void> {
    const runs = await this.prisma.taskRun.findMany({
      where: { workerId: this.registry.workerId, status: 'RUNNING' },
      include: {
        task: { select: { id: true, accountId: true, status: true, pausedAt: true, cancelledAt: true } },
      },
    });
    for (const run of runs) {
      const result = run.result && typeof run.result === 'object' && !Array.isArray(run.result)
        ? run.result as Record<string, unknown>
        : {};
      const cancelled = run.task.status === 'CANCELLED' || Boolean(run.task.cancelledAt);
      const paused = !cancelled && (run.task.status === 'PAUSED' || Boolean(run.task.pausedAt));
      const sideEffectStarted = result.sideEffectStarted === true;
      const status = cancelled ? 'CANCELLED' : paused ? 'PAUSED' : sideEffectStarted ? 'REQUIRES_ACTION' : 'FAILED';
      const message = cancelled || paused
        ? null
        : sideEffectStarted
          ? 'Worker đã khởi động lại sau khi hành động bắt đầu; kiểm tra TikTok trước khi chạy lại để tránh gửi trùng.'
          : 'Worker đã khởi động lại trước khi gửi; campaign đã được giải phóng và có thể chạy lại.';
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.task.updateMany({
          where: { id: run.task.id, status: { in: ['RUNNING', 'PAUSED', 'CANCELLED'] } },
          data: { status, lastError: message },
        }),
        this.prisma.taskRun.updateMany({
          where: { id: run.id, status: 'RUNNING' },
          data: {
            status: cancelled || paused ? 'CANCELLED' : 'FAILED',
            finishedAt: now,
            errorCode: cancelled ? 'TASK_CANCELLED' : paused ? 'TASK_PAUSED' : 'WORKER_RESTARTED',
            error: message,
          },
        }),
        this.prisma.platformAccount.updateMany({
          where: { id: run.task.accountId, status: 'RUNNING' },
          data: { status: 'READY' },
        }),
      ]);
    }
  }

  private async releaseProfileAfterSessionClose(profileId: string): Promise<void> {
    const active = await this.prisma.browserSession.count({
      where: { profileId, status: { in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'] } },
    });
    if (active > 0) return;
    const profile = await this.prisma.browserProfile.findUnique({ where: { id: profileId }, select: { accountId: true } });
    if (!profile) return;
    await this.prisma.$transaction([
      this.prisma.browserProfile.updateMany({
        where: { id: profileId, status: { in: ['LEASED', 'SNAPSHOTTING'] } },
        data: { status: 'AVAILABLE' },
      }),
      this.prisma.platformAccount.updateMany({
        where: { id: profile.accountId, status: 'RUNNING', tasks: { none: { status: 'RUNNING' } } },
        data: { status: 'READY' },
      }),
    ]);
  }
}
