import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@temporalio/activity';
import { BrowserTaskActivities } from './browser-task.activities';

const id = '00000000-0000-4000-8000-000000000001';
const task = (override: Record<string, unknown> = {}) => ({ id, accountId: id, action: 'JOIN_FACEBOOK_GROUP', platform: 'FACEBOOK', payload: { groupUrl: 'https://www.facebook.com/groups/123/' }, status: 'QUEUED', approvalStatus: 'APPROVED', attemptCount: 0, maxAttempts: 1, account: { status: 'READY', browserProfile: { id: 'profile', sessions: [] } }, ...override });
async function scenario(row: any, attempt = 1, claim = 0, workflowId?: string) {
  const updates: any[] = []; let opened = false; let leased = false;
  const original = Context.current;
  Context.current = () => ({ heartbeat: () => {}, info: { attempt } }) as unknown as Context;
  try {
    const prisma = {
      task: { findUnique: async () => row, findUniqueOrThrow: async () => row, update: async (input: any) => { updates.push(input); }, updateMany: async (input: any) => { updates.push(input); return { count: claim }; } },
      platformAccount: { updateMany: async () => ({ count: 0 }) }, browserProfile: { updateMany: async () => ({ count: 0 }) },
      $transaction: async (callback: any) => callback(prisma),
    };
    const leases = { withLease: async (_: string, callback: any) => { leased = true; return callback(); } };
    const runtime = { withProfile: async () => { opened = true; throw new Error('Must not open browser'); } };
    const service = new BrowserTaskActivities(prisma as never, leases as never, {} as never, {} as never, {} as never, {} as never, {} as never, runtime as never);
    const result = await service.executeBrowserTask({ taskId: id, workflowId });
    return { result, opened, updates, leased };
  } finally { Context.current = original; }
}
test('unapproved Facebook write never acquires lease or opens browser', async () => {
  const context = await scenario(task({ approvalStatus: 'PENDING', status: 'DRAFT' }));
  assert.equal(context.result.data?.requiresAction, true); assert.equal(context.opened, false); assert.equal(context.leased, false);
});

test('paused campaigns and tasks do not start browser or claim work', async () => {
  for (const row of [task({ status: 'PAUSED' }), task({ campaign: { pausedAt: new Date() } }), task({ campaign: { cancelledAt: new Date() } })]) {
    const context = await scenario(row);
    assert.equal(context.result.data?.paused, true); assert.equal(context.opened, false); assert.equal(context.leased, false); assert.equal(context.updates.length, 0);
  }
});

test('old scheduled workflows cannot send a task resumed or retried with a new workflow ID', async () => {
  const context = await scenario(task({ workflowId: 'new-generation' }), 1, 1, 'old-generation');
  assert.equal(context.result.data?.reason, 'stale_workflow'); assert.equal(context.opened, false); assert.equal(context.leased, false); assert.equal(context.updates.length, 0);
});
test('cancelled or succeeded tasks are not sent again', async () => {
  assert.equal((await scenario(task({ status: 'CANCELLED' }))).result.data?.cancelled, true);
  assert.equal((await scenario(task({ status: 'SUCCEEDED', attemptCount: 1 }))).result.data?.alreadyCompleted, true);
});
test('retry or durable prior attempt requires manual verification without sending', async () => {
  for (const context of [await scenario(task({ attemptCount: 1 }), 2), await scenario(task({ attemptCount: 1, status: 'RUNNING' }))]) {
    assert.equal(context.result.data?.requiresAction, true); assert.equal(context.opened, false); assert.equal(context.updates[0].data.status, 'REQUIRES_ACTION'); assert.equal(context.leased, true);
  }
});

test('a Temporal delivery retry before the task was claimed is not mistaken for a previous send', async () => {
  const context = await scenario(task(), 2);
  assert.equal(context.leased, true);
  assert.equal(context.updates[0].data.status, 'RUNNING');
  assert.equal(context.result.data?.requiresAction, undefined);
});
test('challenged accounts stop following group tasks', async () => {
  const context = await scenario(task({ account: { status: 'CHALLENGED', browserProfile: { id: 'profile' } } }));
  assert.equal(context.result.data?.requiresAction, true); assert.equal(context.updates[0].data.status, 'REQUIRES_ACTION'); assert.equal(context.opened, false);
});
test('atomic claim failure after cancellation never opens browser', async () => {
  const context = await scenario(task());
  assert.equal(context.result.data?.cancelled, true); assert.equal(context.opened, false);
  assert.equal(context.updates[0].where.approvalStatus, 'APPROVED'); assert.equal(context.updates[0].where.attemptCount, 0);
});
test('proxy or interactive browser changed after approval stops before sending', async () => {
  for (const account of [
    { status: 'READY', browserProfile: { id: 'profile', sessions: [{ status: 'RUNNING' }] } },
    { status: 'READY', browserProfile: { id: 'profile', sessions: [] }, proxyBinding: { proxy: { status: 'UNHEALTHY' } } },
  ]) {
    const context = await scenario(task({ account }));
    assert.equal(context.opened, false); assert.equal(context.result.data?.requiresAction, true);
  }
});

test('worker restores the current snapshot and seeds legacy cookies before checking joined membership', async () => {
  const original = Context.current;
  Context.current = () => ({ heartbeat: () => {}, info: { attempt: 1 } }) as unknown as Context;
  try {
    const row = task();
    const current = task({ account: { status: 'READY', browserProfile: { id: 'profile', sessions: [], metadata: { credentialsRef: 'fixture-reference' }, snapshotVersion: 12 } } });
    const events: string[] = [];
    const updates: any[] = [];
    let cookies: any[] = [];
    let url = 'about:blank';
    const context = { cookies: async () => cookies, addCookies: async (input: any[]) => { events.push('import-cookies'); cookies = input; }, tracing: { start: async () => {}, stop: async () => {} } };
    const roleLocator = (visible = false): any => ({
      filter: () => roleLocator(visible), and: () => roleLocator(visible), first: () => roleLocator(visible),
      waitFor: async () => {}, count: async () => visible ? 1 : 0, isVisible: async () => visible,
      getByRole: (role: string, options: any) => roleLocator(role === 'button' && !!options?.name?.test('Joined')),
      getByText: () => roleLocator(false),
      locator: () => roleLocator(false), evaluateAll: async () => [],
    });
    const page = {
      url: () => url, title: async () => 'Fixture group', context: () => context,
      goto: async (target: string) => { events.push(target.includes('/groups/') ? 'navigate-group' : 'navigate-home'); url = target; },
      on: () => {}, off: () => {},
      locator: (selector: string): any => ({ first() { return this; }, filter() { return this; }, waitFor: async () => {}, count: async () => 0, isVisible: async () => selector.includes('navigation') && cookies.some(c => c.name === 'c_user') }),
      getByRole: (role: string) => roleLocator(role === 'main'), getByText: () => roleLocator(false),
    };
    const prisma = {
      task: { findUnique: async () => row, findUniqueOrThrow: async () => current, updateMany: async () => ({ count: 1 }), update: async (input: any) => { updates.push(input); } },
      platformAccount: { update: async () => ({}) }, browserProfile: { update: async () => ({}) },
      taskRun: { create: async () => ({ id: 'run' }), update: async () => ({}) }, facebookGroupMembership: { upsert: async () => ({}) },
      browserSession: { create: async () => ({ id: 'browser-session' }), update: async () => ({}), updateMany: async () => ({ count: 1 }) },
      $transaction: async (input: any) => typeof input === 'function' ? input(prisma) : Promise.all(input),
    };
    const service = new BrowserTaskActivities(
      prisma as never,
      { withLease: async (_: string, callback: any) => callback() } as never,
      { workerId: 'worker' } as never,
      { restore: async (profile: any) => { assert.equal(profile.snapshotVersion, 12); events.push('restore-current-snapshot'); }, capture: async () => { events.push('snapshot'); } } as never,
      { temporaryPath: async () => 'fixture.har', captureScreenshot: async () => {}, captureFailure: async () => {}, captureConsoleLog: async () => {}, captureHar: async () => {} } as never,
      { profileCredentials: async (reference: string) => { assert.equal(reference, 'fixture-reference'); return { cookies: 'c_user=fixture-valid; xs=fixture-valid' }; } } as never,
      { get: () => true } as never,
      { withProfile: async (_: any, callback: any) => { const result = await callback({ page, context, profileId: 'profile', slot: 0 }); events.push('close'); return result; } } as never,
    );
    const result = await service.executeBrowserTask({ taskId: id });
    assert.equal(result.ok, true);
    assert.equal(result.data?.alreadyJoined, true);
    assert.equal(updates.at(-1).data.status, 'SUCCEEDED');
    assert.deepEqual(events, ['restore-current-snapshot', 'import-cookies', 'navigate-home', 'navigate-group', 'close', 'snapshot']);
  } finally { Context.current = original; }
});
