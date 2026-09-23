import assert from 'node:assert/strict';
import test from 'node:test';
import { distributePostTargets, FacebookService, retrySafety } from './facebook.service';

const account = (id: string) => ({ id, username: id, browserProfile: { sessions: [] }, proxyBinding: null });
function setup(ids = ['a', 'b']) {
  let data: any;
  const starts: any[] = [];
  const prisma = {
    platformAccount: { findMany: async (input: any) => { assert.equal(input.where.organizationId, 'org'); assert.equal(input.where.platform, 'FACEBOOK'); return ids.map(account); } },
    facebookGroupMembership: { findMany: async (input: any) => {
      assert.equal(input.where.organizationId, 'org');
      const selectedIds = input.where.accountId?.in ?? [input.where.accountId];
      const urls = input.where.groupUrl?.in ?? ['1', '2', '3'].map(id => `https://www.facebook.com/groups/${id}/`);
      return selectedIds.flatMap((accountId: string) => urls.map((groupUrl: string) => ({ accountId, groupUrl })));
    } },
    facebookCampaign: { findUnique: async () => null, create: async (input: any) => { data = input.data; return { ...data, id: 'campaign' }; } },
  };
  const temporal = { startTask: async (...args: any[]) => { starts.push(args); } };
  return { service: new FacebookService(prisma as never, {} as never, temporal as never), prisma, starts, data: () => data };
}
test('join snapshots every account/link pair as un-dispatched draft with no retries', async () => {
  const context = setup();
  await context.service.join('org', { name: 'Join', idempotencyKey: 'test-key', accountIds: [], groupUrls: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'], intervalSeconds: 60 });
  const jobs = context.data().tasks.create;
  assert.equal(jobs.length, 4);
  for (const job of jobs) { assert.equal(job.status, 'DRAFT'); assert.equal(job.approvalStatus, 'PENDING'); assert.equal(job.maxAttempts, 1); }
  assert.equal(context.starts.length, 0);
});
test('post distributes unique groups round-robin with an independent per-account maximum', async () => {
  const context = setup();
  await context.service.post('org', { name: 'Post', idempotencyKey: 'test-key', accountIds: [], selection: 'ALL', maxGroupsPerAccount: 2, text: 'Frozen post', intervalSeconds: 60 });
  const jobs = context.data().tasks.create;
  assert.deepEqual(jobs.map((job: any) => [job.accountId, job.payload.groupUrl]), [
    ['a', 'https://www.facebook.com/groups/1/'],
    ['b', 'https://www.facebook.com/groups/2/'],
    ['a', 'https://www.facebook.com/groups/3/'],
  ]);
  assert.ok(jobs.every((job: any) => job.payload.text === 'Frozen post')); assert.equal(context.starts.length, 0);
  assert.equal(context.data().payload.maxGroupsPerAccount, 2);
});
test('post ALL includes all joined groups for selected account', async () => {
  const context = setup(['a']);
  await context.service.post('org', { name: 'Post', idempotencyKey: 'test-key', accountIds: ['a'], selection: 'ALL', maxGroupsPerAccount: 5, text: 'Post', intervalSeconds: 60 });
  assert.equal(context.data().tasks.create.length, 3);
});

test('post CUSTOM uses inventory mapping without imposing a membership-status gate', async () => {
  const context = setup(['a', 'b', 'c']);
  const urls = ['https://www.facebook.com/groups/a-only/', 'https://www.facebook.com/groups/b-only/', 'https://www.facebook.com/groups/shared/'];
  context.prisma.facebookGroupMembership.findMany = async (input: any) => {
    assert.equal(input.where.organizationId, 'org'); assert.equal(input.where.status, undefined);
    assert.deepEqual(input.where.accountId.in, ['a', 'b', 'c']);
    assert.deepEqual(input.where.groupUrl.in, urls);
    return [{ accountId: 'a', groupUrl: urls[0]! }, { accountId: 'a', groupUrl: urls[2]! },
      { accountId: 'b', groupUrl: urls[1]! }, { accountId: 'b', groupUrl: urls[2]! }];
  };
  await context.service.post('org', { name: 'Custom', idempotencyKey: 'custom-key', accountIds: ['a', 'b', 'c'], selection: 'CUSTOM', groupUrls: [...urls, urls[0]!], maxGroupsPerAccount: 2, text: 'Explicit post', intervalSeconds: 60 });
  const jobs = context.data().tasks.create;
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.filter((job: any) => job.accountId === 'a').map((job: any) => job.payload.groupUrl), [urls[0], urls[2]]);
  assert.deepEqual(jobs.filter((job: any) => job.accountId === 'b').map((job: any) => job.payload.groupUrl), [urls[1]]);
  assert.equal(jobs.filter((job: any) => job.accountId === 'c').length, 0);
  assert.ok(jobs.every((job: any) => job.status === 'DRAFT' && job.approvalStatus === 'PENDING' && job.action === 'POST_FACEBOOK_GROUP' && job.payload.text === 'Explicit post'));
  assert.deepEqual(context.data().payload.groupUrls, urls);
  assert.equal(context.data().payload.selection, 'CUSTOM');
  assert.equal(context.starts.length, 0);
});
test('CUSTOM rejects missing groups and insufficient per-account capacity before writes', async () => {
  const context = setup();
  const base = { name: 'Custom', idempotencyKey: 'custom-key', accountIds: [], selection: 'CUSTOM' as const, maxGroupsPerAccount: 2, text: 'Post', intervalSeconds: 60 };
  await assert.rejects(context.service.post('org', base), /ít nhất một nhóm/);
  const big = setup(['a', 'b']);
  await assert.rejects(big.service.post('org', { ...base, groupUrls: Array.from({ length: 5 }, (_, i) => `https://www.facebook.com/groups/${i}/`) }), /Không thể phân phối đủ 5 nhóm/);
  assert.equal(context.data(), undefined);
  assert.equal(big.data(), undefined);
});
test('CUSTOM rejects groups absent from selected profiles inventory without writes', async () => {
  const context = setup(['a']);
  context.prisma.facebookGroupMembership.findMany = async () => [];
  await assert.rejects(context.service.post('org', { name: 'Custom', idempotencyKey: 'custom-key', accountIds: ['a'], selection: 'CUSTOM', groupUrls: ['https://www.facebook.com/groups/not-joined/'], maxGroupsPerAccount: 2, text: 'Post', intervalSeconds: 60 }), /không có trong danh sách/);
  assert.equal(context.data(), undefined);
});

test('round-robin distribution is deterministic, balanced and respects group eligibility', () => {
  const accounts = ['a', 'b', 'c', 'd'];
  const groups = Array.from({ length: 10 }, (_, index) => `g${index + 1}`);
  const memberships = groups.flatMap(groupUrl => accounts.map(accountId => ({ accountId, groupUrl })));
  const first = distributePostTargets(accounts, groups, memberships, 3);
  const second = distributePostTargets(accounts, groups, memberships, 3);
  assert.deepEqual(first, second);
  assert.deepEqual(first.targets.map(target => target.accountId), ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', 'a', 'b']);
  assert.deepEqual(Object.fromEntries(accounts.map(id => [id, first.targets.filter(target => target.accountId === id).length])), { a: 3, b: 3, c: 2, d: 2 });
  assert.deepEqual(first.unassigned, []);

  const constrained = distributePostTargets(['a', 'b'], ['shared', 'only-b'], [
    { accountId: 'b', groupUrl: 'only-b' }, { accountId: 'a', groupUrl: 'shared' }, { accountId: 'b', groupUrl: 'shared' },
  ], 1);
  assert.deepEqual(constrained.targets, [{ accountId: 'a', groupUrl: 'shared' }, { accountId: 'b', groupUrl: 'only-b' }]);
});
test('reject unavailable explicit accounts and oversized campaigns without writes', async () => {
  const context = setup(['a']);
  await assert.rejects(() => context.service.join('org', { name: 'Join', idempotencyKey: 'test-key', accountIds: ['a', 'missing'], groupUrls: ['https://www.facebook.com/groups/1/'], intervalSeconds: 60 }), /READY/);
  const big = setup(Array.from({ length: 6 }, (_, index) => `a${index}`));
  await assert.rejects(() => big.service.join('org', { name: 'Join', idempotencyKey: 'test-key', accountIds: [], groupUrls: Array.from({ length: 100 }, (_, index) => `https://www.facebook.com/groups/${index}/`), intervalSeconds: 60 }), /500/);
  assert.equal(big.data(), undefined);
});

test('approval schedules spacing independently for each account and dispatches only after transaction', async () => {
  const writes: any[] = []; const starts: any[] = []; let committed = false;
  const jobs = ['a', 'a', 'b', 'b'].map((accountId, index) => ({ id: `job${index}`, workflowId: `task/job${index}`, accountId, approvalStatus: 'PENDING' }));
  const campaign = { id: 'campaign', approvedAt: null, payload: { intervalSeconds: 60 }, tasks: jobs };
  const tx = { $executeRaw: async () => 0, platformAccount: { findMany: async () => ['a', 'b'].map(account) }, facebookCampaign: { updateMany: async () => ({ count: 1 }) }, task: { count: async () => 0, updateMany: async (input: any) => { writes.push(input); return { count: 1 }; } } };
  const prisma = {
    facebookCampaign: { findFirst: async (input: any) => { assert.equal(input.where.organizationId, 'org'); return campaign; }, findUniqueOrThrow: async () => campaign },
    task: { count: async () => 0 }, platformAccount: { findMany: async () => ['a', 'b'].map(account) },
    $transaction: async (callback: any) => { const value = await callback(tx); committed = true; return value; },
  };
  const service = new FacebookService(prisma as never, {} as never, { startTask: async (...args: any[]) => { assert.equal(committed, true); starts.push(args); } } as never);
  await service.approve('org', 'campaign', 'admin');
  assert.equal(starts.length, 4); assert.equal(writes[0].data.status, 'SCHEDULED'); assert.equal(writes[0].data.approvalStatus, 'APPROVED');
  assert.equal(starts[1][2].getTime() - starts[0][2].getTime(), 60000);
  assert.equal(starts[2][2].getTime(), starts[0][2].getTime());
  assert.equal(starts[3][2].getTime() - starts[2][2].getTime(), 60000);
});
test('cancel only touches not-started tasks in the workspace', async () => {
  let where: any;
  const prisma: any = { $executeRaw: async () => 0, facebookCampaign: { findFirst: async () => ({ id: 'campaign' }), update: async () => ({}) }, task: { updateMany: async (input: any) => { where = input.where; return { count: 2 }; } }, $transaction: async (callback: any) => callback(prisma) };
  const service = new FacebookService(prisma as never, {} as never, {} as never);
  assert.equal((await service.cancel('org', 'campaign')).cancelled, 2);
  assert.equal(where.organizationId, 'org'); assert.equal(where.campaignId, 'campaign'); assert.ok(!where.status.in.includes('RUNNING'));
});

function controls(statuses: string[]) {
  const jobs = statuses.map((status, index) => ({ id: `job-${index}`, organizationId: 'org', campaignId: 'campaign', accountId: 'a', workflowId: `old-${index}`, status, approvalStatus: 'APPROVED', attemptCount: status === 'REQUIRES_ACTION' ? 1 : 0, runs: [{ result: { sideEffectStarted: false } }] }));
  const campaign: any = { id: 'campaign', organizationId: 'org', approvedAt: new Date(), pausedAt: null, cancelledAt: null, payload: { intervalSeconds: 60 }, tasks: jobs };
  const starts: any[] = [], writes: any[] = [];
  const tx: any = {
    $executeRaw: async () => 0,
    facebookCampaign: { findFirst: async (input: any) => input.where.organizationId === 'org' && input.where.id === 'campaign' ? campaign : null, update: async (input: any) => Object.assign(campaign, input.data) },
    platformAccount: { findMany: async () => [account('a')] },
    task: {
      count: async () => jobs.filter(job => ['QUEUED', 'SCHEDULED', 'RUNNING'].includes(job.status)).length,
      updateMany: async (input: any) => { writes.push(input); const rows = jobs.filter(job => (!input.where.id || input.where.id === job.id) && (typeof input.where.status === 'string' ? input.where.status === job.status : input.where.status.in.includes(job.status))); rows.forEach(job => Object.assign(job, input.data)); return { count: rows.length }; },
    },
    $transaction: async (callback: any) => callback(tx),
  };
  return { service: new FacebookService(tx as never, {} as never, { startTask: async (...args: any[]) => starts.push(args) } as never), campaign, jobs, starts, writes, tx };
}

test('pause freezes pending work but does not interrupt a running Facebook write', async () => {
  const context = controls(['RUNNING', 'SCHEDULED', 'QUEUED', 'SUCCEEDED']);
  assert.equal((await context.service.pause('org', 'campaign')).paused, 2);
  assert.deepEqual(context.jobs.map(job => job.status), ['RUNNING', 'PAUSED', 'PAUSED', 'SUCCEEDED']);
  assert.ok(context.campaign.pausedAt);
  assert.equal(context.starts.length, 0);
  await assert.rejects(() => context.service.resume('org', 'campaign'), /đang chạy/);
});

test('resume dispatches only paused tasks with new workflow IDs and per-account spacing', async () => {
  const context = controls(['SCHEDULED', 'QUEUED', 'SUCCEEDED']);
  await context.service.pause('org', 'campaign');
  assert.equal((await context.service.resume('org', 'campaign')).resumed, 2);
  assert.equal(context.campaign.pausedAt, null);
  assert.equal(context.starts.length, 2);
  assert.notEqual(context.starts[0][1], 'old-0');
  assert.equal(context.starts[1][2].getTime() - context.starts[0][2].getTime(), 60000);
  assert.equal(context.jobs[2].status, 'SUCCEEDED');
  await assert.rejects(() => context.service.resume('org', 'campaign'), /tạm dừng/);
});

test('retry preserves success/history, resets only the selected stopped task and cannot be repeated', async () => {
  const context = controls(['REQUIRES_ACTION', 'SUCCEEDED']);
  const history = context.jobs[0].runs;
  assert.equal((await context.service.retry('org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: [] })).retried, 1);
  assert.equal(context.jobs[0].attemptCount, 0);
  assert.equal(context.jobs[0].status, 'SCHEDULED');
  assert.notEqual(context.jobs[0].workflowId, 'old-0');
  assert.equal(context.jobs[0].runs, history);
  assert.equal(context.jobs[1].status, 'SUCCEEDED');
  await assert.rejects(() => context.service.retry('org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: [] }), /Chỉ chạy lại/);
  assert.equal(context.starts.length, 1);
});

test('ambiguous Facebook send requires explicit confirmation and workspace ownership', async () => {
  const context = controls(['REQUIRES_ACTION']);
  context.jobs[0].runs[0].result.sideEffectStarted = true;
  await assert.rejects(() => context.service.retry('org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: [] }), /chưa rõ/);
  await assert.rejects(() => context.service.retry('other-org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: ['job-0'] }), /not found/);
  await assert.rejects(() => context.service.retry('org', 'campaign', { taskIds: ['other-task'], verifiedUnsentTaskIds: [] }), /không thuộc/);
  assert.equal(context.starts.length, 0);
  assert.equal((await context.service.retry('org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: ['job-0'] })).retried, 1);
});

test('cancel is permanent; includes paused/manual tasks and preserves running/completed work', async () => {
  const context = controls(['PAUSED', 'REQUIRES_ACTION', 'RUNNING', 'SUCCEEDED']);
  assert.equal((await context.service.cancel('org', 'campaign')).cancelled, 2);
  assert.ok(context.campaign.cancelledAt);
  assert.deepEqual(context.jobs.map(job => job.status), ['CANCELLED', 'CANCELLED', 'RUNNING', 'SUCCEEDED']);
  await assert.rejects(() => context.service.pause('org', 'campaign'), /chưa hủy/);
  await assert.rejects(() => context.service.retry('org', 'campaign', { taskIds: ['job-1'], verifiedUnsentTaskIds: [] }), /đã hủy/);
});

test('missing evidence and legacy login failure are not assumed safe to resend', () => {
  assert.equal(retrySafety({ status: 'REQUIRES_ACTION', attemptCount: 1, runs: [{ errorCode: 'LOGIN_REQUIRED' }] }), 'VERIFY');
  assert.equal(retrySafety({ status: 'REQUIRES_ACTION', attemptCount: 1, runs: [{ result: { sideEffectStarted: false } }] }), 'SAFE');
  assert.equal(retrySafety({ status: 'SUCCEEDED', attemptCount: 1, runs: [] }), 'BLOCKED');
});
