import assert from 'node:assert/strict';
import test from 'node:test';
import { SlotPool } from './slot-pool';

test('SlotPool limits concurrency and hands released slots to waiters', async () => {
  const pool = new SlotPool(1);
  const first = await pool.acquire();

  let secondResolved = false;
  const secondPromise = pool.acquire(1_000).then((lease) => {
    secondResolved = true;
    return lease;
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondResolved, false);
  assert.equal(pool.activeCount, 1);

  first.release();
  const second = await secondPromise;
  assert.equal(second.slot, first.slot);
  assert.equal(pool.activeCount, 1);

  second.release();
  assert.equal(pool.activeCount, 0);
});

test('SlotPool times out when all slots stay occupied', async () => {
  const pool = new SlotPool(1);
  const lease = await pool.acquire();
  await assert.rejects(() => pool.acquire(5), /Timed out waiting/);
  lease.release();
});
