import assert from 'node:assert/strict';
import test from 'node:test';
import { TasksService } from './tasks.service';

test('publish requests remain draft and are never dispatched before approval', async () => {
  let temporalStarted = false;
  const created = {
    id: '00000000-0000-4000-8000-000000000099',
    action: 'PUBLISH_POST',
    status: 'DRAFT',
    approvalStatus: 'PENDING',
  };
  const prisma = {
    platformAccount: { findFirst: async () => ({ id: 'account' }) },
    mediaAsset: { count: async () => 1 },
    task: {
      create: async (input: { data: { status: string; approvalStatus: string } }) => {
        assert.equal(input.data.status, 'DRAFT');
        assert.equal(input.data.approvalStatus, 'PENDING');
        return created;
      },
    },
  };
  const temporal = {
    startTask: async () => { temporalStarted = true; },
  };
  const service = new TasksService(prisma as never, temporal as never);
  const result = await service.create(
    '00000000-0000-4000-8000-000000000001',
    {
      idempotencyKey: 'publish-test-key',
      action: {
        platform: 'FACEBOOK',
        accountId: '00000000-0000-4000-8000-000000000010',
        action: 'PUBLISH_POST',
        payload: {
          text: 'Approved content candidate',
          mediaAssetIds: ['00000000-0000-4000-8000-000000000020'],
        },
      },
      priority: 50,
      maxAttempts: 3,
    },
  );
  assert.equal(result.status, 'DRAFT');
  assert.equal(temporalStarted, false);
});

test('TikTok approval appends a campaign behind active work for the same profile', async () => {
  const activeStartedAt = new Date(Date.now() + 5_000);
  let updateData: Record<string, unknown> | undefined;
  let startedAt: Date | undefined;
  const pending = {
    id: '00000000-0000-4000-8000-000000000101',
    accountId: '00000000-0000-4000-8000-000000000010',
    platform: 'TIKTOK',
    action: 'COMMENT_TIKTOK_VIDEOS',
    payload: { videoUrls: ['https://www.tiktok.com/@creator/video/1'], text: 'Xin chào', intervalSeconds: 120, maxVideos: 1 },
    approvalStatus: 'PENDING',
    status: 'DRAFT',
    campaignId: null,
    workflowId: 'task/pending',
  };
  const approved = { ...pending, approvalStatus: 'APPROVED', status: 'SCHEDULED', scheduledAt: activeStartedAt };
  const tx = {
    $executeRaw: async () => 1,
    task: {
      findFirst: async () => pending,
      findMany: async () => [{ scheduledAt: activeStartedAt, payload: { videoUrls: ['active'], intervalSeconds: 120, maxVideos: 1 } }],
      updateMany: async (input: { data: Record<string, unknown> }) => { updateData = input.data; return { count: 1 }; },
    },
  };
  const prisma = {
    task: {
      findFirst: async () => pending,
      findUniqueOrThrow: async () => approved,
      update: async () => approved,
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const temporal = {
    startTask: async (_id: string, _workflowId: string, scheduledAt?: Date) => { startedAt = scheduledAt; },
  };
  const service = new TasksService(prisma as never, temporal as never);
  const result = await service.approve('00000000-0000-4000-8000-000000000001', pending.id, '00000000-0000-4000-8000-000000000002');

  assert.equal(result.status, 'SCHEDULED');
  assert.equal(updateData?.status, 'SCHEDULED');
  assert.ok((updateData?.scheduledAt as Date).getTime() >= activeStartedAt.getTime() + 120_000);
  assert.equal(startedAt?.getTime(), (updateData?.scheduledAt as Date).getTime());
});

test('TikTok Search retry reuses the same campaign after the profile is READY', async () => {
  let temporalStarted = false;
  const failed = {
    id: '00000000-0000-4000-8000-000000000102',
    accountId: '00000000-0000-4000-8000-000000000010',
    platform: 'TIKTOK',
    action: 'SEARCH_TIKTOK_VIDEOS',
    payload: { name: 'Search áo khoác', query: 'áo khoác', maxVideos: 5 },
    status: 'REQUIRES_ACTION',
    account: { status: 'READY' },
    idempotencyKey: 'search-original',
    priority: 50,
    maxAttempts: 3,
    attemptCount: 1,
    runs: [{ result: { sideEffectStarted: false } }],
  };
  let updateData: Record<string, unknown> | undefined;
  const retried = { ...failed, status: 'QUEUED', workflowId: 'task/retry' };
  const tx = {
    $executeRaw: async () => 1,
    task: {
      findFirst: async () => failed,
      findMany: async () => [],
      updateMany: async (input: { data: Record<string, unknown> }) => { updateData = input.data; return { count: 1 }; },
    },
  };
  const prisma = {
    task: {
      findFirst: async () => failed,
      findUniqueOrThrow: async () => retried,
    },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const temporal = { startTask: async () => { temporalStarted = true; } };
  const service = new TasksService(prisma as never, temporal as never);

  const result = await service.retry('00000000-0000-4000-8000-000000000001', failed.id);

  assert.equal(result.id, failed.id);
  assert.equal(updateData?.status, 'QUEUED');
  assert.notEqual(updateData?.workflowId, undefined);
  assert.equal(updateData?.attemptCount, 0);
  assert.equal(temporalStarted, true);
});

test('TikTok cancel persists a request while a running task finishes safely', async () => {
  const running = { id: 'tiktok-running', organizationId: 'org', platform: 'TIKTOK', status: 'RUNNING', approvalStatus: 'NOT_REQUIRED', cancelledAt: null, pausedAt: null };
  let updateInput: any;
  const tx = {
    $executeRaw: async () => 1,
    task: {
      findFirst: async () => running,
      updateMany: async (input: any) => { updateInput = input; return { count: 1 }; },
    },
  };
  const prisma = { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) };
  const service = new TasksService(prisma as never, {} as never);

  const result = await service.cancel('org', running.id);
  assert.equal(result.cancelRequested, true);
  assert.equal(updateInput.where.status, 'RUNNING');
  assert.ok(updateInput.data.cancelledAt instanceof Date);
});

test('TikTok pause queues safely and resume dispatches a new workflow', async () => {
  const paused = { id: 'tiktok-paused', organizationId: 'org', accountId: 'account', platform: 'TIKTOK', action: 'SEARCH_TIKTOK_VIDEOS', status: 'QUEUED', approvalStatus: 'NOT_REQUIRED', attemptCount: 0, cancelledAt: null, pausedAt: null, workflowId: 'old-workflow', payload: { query: 'áo khoác', maxVideos: 2 } };
  let current: any = { ...paused };
  let updateInput: any;
  let started: any[] | undefined;
  const tx = {
    $executeRaw: async () => 1,
    task: {
      findFirst: async () => ({ ...current, runs: [] }),
      findMany: async () => [],
      updateMany: async (input: any) => { updateInput = input; current = { ...current, ...input.data }; return { count: 1 }; },
    },
  };
  const prisma = {
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    task: { findUniqueOrThrow: async () => current },
  };
  const temporal = { startTask: async (...args: any[]) => { started = args; } };
  const service = new TasksService(prisma as never, temporal as never);

  const pauseResult = await service.pause('org', paused.id);
  assert.equal(pauseResult.paused, 1);
  assert.equal(updateInput.data.status, 'PAUSED');
  assert.ok(updateInput.data.pausedAt instanceof Date);

  const resumeResult = await service.resume('org', paused.id);
  assert.equal(resumeResult.status, 'QUEUED');
  assert.equal(updateInput.data.pausedAt, null);
  assert.equal(updateInput.data.attemptCount, 0);
  assert.ok(started?.[1].includes('/resume/'));
});
