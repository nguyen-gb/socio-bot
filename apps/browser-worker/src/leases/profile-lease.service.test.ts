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
