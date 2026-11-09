import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileLeaseService } from './profile-lease.service';

test('queued task waits for profile ownership then releases only its token', async () => {
  let attempts = 0; let waits = 0; let called = false; let released = false;
  const service = Object.assign(Object.create(ProfileLeaseService.prototype), {
    ttlMs: 60000,
    redis: { set: async () => ++attempts === 1 ? null : 'OK', eval: async (_script: string, _count: number, key: string, token: string) => { assert.equal(called, true); assert.equal(key, 'profile-lease:fixture'); assert.ok(token); released = true; return 1; } },
  }) as ProfileLeaseService;
  const result = await service.withLease('fixture', async () => { called = true; assert.equal(released, false); return 'done'; }, { waitTimeoutMs: 20, onWait: () => { waits++; } });
  assert.equal(result, 'done'); assert.equal(attempts, 2); assert.equal(waits, 1); assert.equal(released, true);
});
test('busy profile deadline never runs callback or releases another owner', async () => {
  let called = false; let released = false;
  const service = Object.assign(Object.create(ProfileLeaseService.prototype), { ttlMs: 60000, redis: { set: async () => null, eval: async () => { released = true; } } }) as ProfileLeaseService;
  await assert.rejects(() => service.withLease('fixture', async () => { called = true; }, { waitTimeoutMs: 5 }), /already leased/);
  assert.equal(called, false); assert.equal(released, false);
});

test('stale lease is reclaimed only after the DB says no browser session is alive', async () => {
  let attempts = 0;
  let recoveries = 0;
  const staleValue = JSON.stringify({ token: 'old-owner', acquiredAt: Date.now() - 120_000 });
  const service = Object.assign(Object.create(ProfileLeaseService.prototype), {
    ttlMs: 60000,
    redis: {
      set: async () => ++attempts === 1 ? null : 'OK',
      get: async () => staleValue,
      pttl: async () => 1,
      eval: async (_script: string, _count: number, key: string, value: string) => {
        assert.equal(key, 'profile-lease:fixture');
        assert.ok(value === staleValue || value.includes('token'));
        recoveries++;
        return 1;
      },
    },
  }) as ProfileLeaseService;
  const result = await service.withLease('fixture', async () => 'recovered', {
    waitTimeoutMs: 100,
    isActive: async () => false,
  });
  assert.equal(result, 'recovered');
  assert.equal(attempts, 2);
  assert.equal(recoveries, 2, 'stale recovery and normal release both use compare-and-delete');
});

test('stale lease is never reclaimed while the DB reports a live session', async () => {
  let released = false;
  const staleValue = JSON.stringify({ token: 'live-owner', acquiredAt: Date.now() - 120_000 });
  const service = Object.assign(Object.create(ProfileLeaseService.prototype), {
    ttlMs: 60000,
    redis: {
      set: async () => null,
      get: async () => staleValue,
      pttl: async () => 1,
      eval: async () => { released = true; },
    },
  }) as ProfileLeaseService;
  await assert.rejects(() => service.withLease('fixture', async () => undefined, {
    waitTimeoutMs: 5,
    isActive: async () => true,
  }), /already leased/);
  assert.equal(released, false);
});
