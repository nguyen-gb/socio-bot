import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserControlService } from './browser-control.service';

test('worker restart immediately releases profiles left by terminal sessions', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const service = Object.assign(Object.create(BrowserControlService.prototype), {
    registry: { workerId: 'stable-worker-id' },
    prisma: {
      browserProfile: {
        updateMany: async (input: Record<string, unknown>) => {
          updates.push(input);
          return { count: 1 };
        },
      },
    },
  }) as BrowserControlService;

  await (service as unknown as { recoverProfilesInterruptedByWorkerRestart(): Promise<void> })
    .recoverProfilesInterruptedByWorkerRestart();

  assert.equal(updates.length, 2);
  assert.equal((updates[0].where as { status: string }).status, 'LEASED');
  assert.deepEqual(updates[0].data, { status: 'AVAILABLE' });
  assert.equal((updates[1].where as { status: string }).status, 'SNAPSHOTTING');
  assert.deepEqual(updates[1].data, { status: 'ERROR' });
  for (const update of updates) {
    const filters = (update.where as { AND: Array<{ sessions: { some?: { workerId: string }; none?: unknown } }> }).AND;
    assert.ok(filters.some((filter) => filter.sessions.none));
    assert.ok(filters.some((filter) => filter.sessions.some?.workerId === 'stable-worker-id'));
  }
});
