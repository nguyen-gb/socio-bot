import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { WorkerEnvironment } from '../config/environment';

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

@Injectable()
export class ProfileLeaseService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly ttlMs: number;

  constructor(config: ConfigService<WorkerEnvironment, true>) {
    this.redis = new Redis(config.get('redisUrl', { infer: true }), {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    this.ttlMs = config.get('profileLeaseTtlMs', { infer: true });
  }

  async withLease<T>(profileId: string, callback: () => Promise<T>, options: { waitTimeoutMs?: number; onWait?: () => void } = {}): Promise<T> {
    const key = `profile-lease:${profileId}`;
    const token = randomUUID();
    const deadline = Date.now() + (options.waitTimeoutMs ?? 0);
    while (await this.redis.set(key, token, 'PX', this.ttlMs, 'NX') !== 'OK') {
      if (Date.now() >= deadline) throw new Error(`Browser profile ${profileId} is already leased`);
      options.onWait?.();
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    }

    const refresh = setInterval(() => {
      void this.redis.eval(
        REFRESH_SCRIPT,
        1,
        key,
        token,
        this.ttlMs.toString(),
      );
    }, Math.max(5_000, Math.floor(this.ttlMs / 3)));
    refresh.unref();

    try {
      return await callback();
    } finally {
      clearInterval(refresh);
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
