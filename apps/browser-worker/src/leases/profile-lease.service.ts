import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { WorkerEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

const REFRESH_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const STALE_LEASE_GRACE_MS = 90_000;

type LeaseOptions = {
  waitTimeoutMs?: number;
  onWait?: () => void;
  /**
   * Override the DB liveness probe when the Redis lease key represents a
   * derived runtime profile (for example the shared anonymous TikTok profile).
   */
  isActive?: () => Promise<boolean>;
};

type StoredLease = {
  token: string;
  acquiredAt: number;
};

@Injectable()
export class ProfileLeaseService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly ttlMs: number;

  constructor(
    config: ConfigService<WorkerEnvironment, true>,
    private readonly prisma: PrismaService,
  ) {
    this.redis = new Redis(config.get('redisUrl', { infer: true }), {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.ttlMs = config.get('profileLeaseTtlMs', { infer: true });
  }

  async withLease<T>(profileId: string, callback: () => Promise<T>, options: LeaseOptions = {}): Promise<T> {
    const key = `profile-lease:${profileId}`;
    const token = randomUUID();
    const leaseValue = JSON.stringify({ token, acquiredAt: Date.now() } satisfies StoredLease);
    const deadline = Date.now() + (options.waitTimeoutMs ?? 0);
    const isActive = options.isActive ?? (() => this.hasLiveProfileSession(profileId));
    const waitStartedAt = Date.now();

    while (await this.redis.set(key, leaseValue, 'PX', this.ttlMs, 'NX') !== 'OK') {
      await this.recoverStaleLease(key, waitStartedAt, isActive);
      if (Date.now() >= deadline) throw new Error(`Browser profile ${profileId} is already leased`);
      options.onWait?.();
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(1000, deadline - Date.now()))));
    }

    const refresh = setInterval(() => {
      void this.redis.eval(
        REFRESH_SCRIPT,
        1,
        key,
        leaseValue,
        this.ttlMs.toString(),
      ).catch(() => undefined);
    }, Math.max(5_000, Math.floor(this.ttlMs / 3)));
    refresh.unref();

    try {
      return await callback();
    } finally {
      clearInterval(refresh);
      // Cleanup must never mask the activity result. If Redis is temporarily
      // unavailable, the bounded TTL and the stale-owner probe below provide
      // recovery instead of turning a successful browser action into a lease
      // error.
      await this.release(key, leaseValue);
    }
  }

  /**
   * A Redis TTL alone is too coarse for browser ownership: a worker can die
   * while the 20-minute lease is still valid. Reclaim only after the lease has
   * been old for the grace period and the DB proves that no live browser
   * session/worker owns the profile. The compare-and-delete script makes this
   * safe against a new owner winning the race while the DB query is running.
   */
  private async recoverStaleLease(
    key: string,
    waitStartedAt: number,
    isActive: () => Promise<boolean>,
  ): Promise<void> {
    let value: string | null;
    try {
      value = await this.redis.get(key);
    } catch {
      return;
    }
    if (!value) return;

    const stored = parseLease(value);
    let ageMs = stored
      ? Date.now() - stored.acquiredAt
      : Date.now() - waitStartedAt;
    if (!stored) {
      // Older deployments stored only the token. Redis PTTL lets us recover
      // old locks immediately when they are demonstrably near the end of
      // their original TTL, while still giving a newly-created legacy lock a
      // grace period before probing the DB.
      try {
        const remaining = await this.redis.pttl(key);
        if (remaining >= 0) ageMs = Math.max(ageMs, this.ttlMs - remaining);
      } catch {
        // The wait-start age remains a safe fallback.
      }
    }
    if (ageMs < STALE_LEASE_GRACE_MS) return;

    let active: boolean;
    try {
      active = await isActive();
    } catch {
      // Fail closed on a DB outage. A transient database failure must not
      // cause two workers to open the same persistent Chromium profile.
      return;
    }
    if (active) return;

    try {
      await this.redis.eval(RELEASE_SCRIPT, 1, key, value);
    } catch {
      // The next waiter or the TTL will retry recovery.
    }
  }

  private async release(key: string, leaseValue: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.redis.eval(RELEASE_SCRIPT, 1, key, leaseValue);
        return;
      } catch {
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  async hasLiveProfileSession(profileId: string): Promise<boolean> {
    if (!this.prisma) return true;
    const now = Date.now();
    const sessions = await this.prisma.browserSession.findMany({
      where: {
        profileId,
        status: { in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'] },
      },
      select: { workerId: true, expiresAt: true, lastActiveAt: true },
    });
    if (sessions.length === 0) return false;

    const workerIds = [...new Set(sessions.map((session) => session.workerId).filter((id): id is string => Boolean(id)))];
    if (workerIds.length === 0) return false;
    const workers = await this.prisma.workerNode.findMany({
      where: { id: { in: workerIds } },
      select: { id: true, status: true, lastHeartbeat: true },
    });
    const byId = new Map(workers.map((worker) => [worker.id, worker]));
    const staleAt = now - STALE_LEASE_GRACE_MS;

    return sessions.some((session) => {
      if (!session.workerId || session.expiresAt.getTime() <= now || session.lastActiveAt.getTime() <= staleAt) return false;
      const worker = byId.get(session.workerId);
      return Boolean(worker && worker.status !== 'OFFLINE' && worker.lastHeartbeat && worker.lastHeartbeat.getTime() > staleAt);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}

function parseLease(value: string): StoredLease | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<StoredLease>;
    if (typeof parsed.token === 'string' && typeof parsed.acquiredAt === 'number' && Number.isFinite(parsed.acquiredAt)) {
      return { token: parsed.token, acquiredAt: parsed.acquiredAt };
    }
  } catch {
    // Legacy locks stored the raw UUID token.
  }
  return undefined;
}
