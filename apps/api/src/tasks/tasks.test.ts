import assert from 'node:assert/strict';
import test from 'node:test';
import { TasksService } from './tasks.service';

test('partial TikTok checkpoints remain resumable and exclude completed inbox targets', () => {
  const service = new TasksService({} as never, {} as never);
  const internal = service as unknown as {
    canContinueFromCheckpoint: (action: string, result: unknown) => boolean;
    continuationPayload: (task: unknown) => Record<string, unknown> | undefined;
    isLegacyIncompleteTikTokSuccess: (task: unknown) => boolean;
  };
  const result = {
    sideEffectStarted: true,
    report: {
      entries: [
        { action: 'MESSAGE', status: 'SENT', username: '@done' },
        { action: 'MESSAGE', status: 'FAILED', username: '@retry', reason: 'HTTP 403' },
      ],
    },
  };
  assert.equal(internal.canContinueFromCheckpoint('MESSAGE_TIKTOK_FOLLOWERS', result), true);
  assert.equal(internal.isLegacyIncompleteTikTokSuccess({
    action: 'MESSAGE_TIKTOK_FOLLOWERS',
    status: 'SUCCEEDED',
    runs: [{ result: { ...result, totalSent: 1, totalRequested: 2 } }],
  }), true);
  const payload = internal.continuationPayload({
    action: 'MESSAGE_TIKTOK_FOLLOWERS',
    payload: { username: '@channel', text: 'Hi', maxFollowers: 2 },
    runs: [{ result }],
  });
  assert.deepEqual(payload?.excludeUsernames, ['@done']);
  assert.equal(payload?.resumeCompletedCount, 1);
});

test('partial TikTok reply checkpoints retain completed counts per video', () => {
  const service = new TasksService({} as never, {} as never);
  const internal = service as unknown as {
    canContinueFromCheckpoint: (action: string, result: unknown) => boolean;
    continuationPayload: (task: unknown) => Record<string, unknown> | undefined;
  };
  const videoUrl = 'https://www.tiktok.com/@creator/video/123';
  const result = {
    sideEffectStarted: true,
    report: { entries: [
      { action: 'REPLY', status: 'SENT', videoUrl },
      { action: 'REPLY', status: 'FAILED', videoUrl, reason: 'temporary error' },
    ] },
  };
  assert.equal(internal.canContinueFromCheckpoint('REPLY_TIKTOK_COMMENTS', result), true);
  const payload = internal.continuationPayload({
    action: 'REPLY_TIKTOK_COMMENTS',
    payload: { videoUrls: [videoUrl], text: 'Hi', maxReplies: 2 },
    runs: [{ result }],
  });
  assert.deepEqual(payload?.completedCountsByVideo, { [videoUrl]: 1 });
  assert.equal(payload?.resumeCompletedCount, 1);
});

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

test('TikTok batch creation assigns one stable campaign batch id to every profile task', async () => {
  const createdInputs: Array<{ data: { batchId?: string; accountId: string; status: string } }> = [];
  const prisma = {
    platformAccount: { count: async () => 2 },
    task: {
      create: (input: { data: { batchId?: string; accountId: string; status: string } }) => {
        createdInputs.push(input);
        return Promise.resolve({ id: `task-${createdInputs.length}`, ...input.data, approvalStatus: 'PENDING' });
      },
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  };
  const service = new TasksService(prisma as never, { startTask: async () => undefined } as never);
  const taskFor = (accountId: string) => ({
    action: { platform: 'TIKTOK' as const, accountId, action: 'AUTO_COMMENT_TIKTOK_HOME' as const, payload: { name: 'Campaign chung', text: 'Xin chào', maxVideos: 2, minLikes: 0, intervalSeconds: 120 } },
    priority: 50,
    maxAttempts: 1,
  });

  const result = await service.createBatch('00000000-0000-4000-8000-000000000001', {
    idempotencyKey: 'tiktok-batch-test',
    tasks: [taskFor('00000000-0000-4000-8000-000000000010'), taskFor('00000000-0000-4000-8000-000000000011')],
  });

  assert.equal(result.tasks.length, 2);
  assert.ok(createdInputs[0]?.data.batchId);
  assert.equal(createdInputs[0]?.data.batchId, createdInputs[1]?.data.batchId);
  assert.equal(createdInputs.every(input => input.data.status === 'DRAFT'), true);
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

test('TikTok cancel marks a running task and lets the worker finalize it safely', async () => {
  const running = { id: 'tiktok-running', organizationId: 'org', accountId: 'account', workflowId: 'task/running', platform: 'TIKTOK', status: 'RUNNING', approvalStatus: 'NOT_REQUIRED', cancelledAt: null, pausedAt: null, account: { browserProfile: { id: 'profile' } } };
  let updateInput: any;
  let runUpdate: any;
  let workflowCancelled: string | undefined;
  const tx = {
    $executeRaw: async () => 1,
    task: {
      findFirst: async () => running,
      updateMany: async (input: any) => { updateInput = input; return { count: 1 }; },
    },
    taskRun: { updateMany: async (input: any) => { runUpdate = input; return { count: 1 }; } },
    browserSession: { updateMany: async () => ({ count: 0 }) },
    browserProfile: { updateMany: async () => ({ count: 1 }) },
    platformAccount: { updateMany: async () => ({ count: 1 }) },
  };
  const prisma = { $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx) };
  const temporal = { cancelTask: async (workflowId: string) => { workflowCancelled = workflowId; return true; } };
  const service = new TasksService(prisma as never, temporal as never);

  const result = await service.cancel('org', running.id);
  assert.equal(result.cancelRequested, true);
  assert.equal(result.cancelled, 1);
  assert.equal(updateInput.where.status, 'RUNNING');
  assert.equal(updateInput.data.status, undefined);
  assert.ok(updateInput.data.cancelledAt instanceof Date);
  assert.equal(runUpdate, undefined);
  assert.equal(workflowCancelled, running.workflowId);
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
  let cancelledWorkflow: string | undefined;
  const temporal = {
    startTask: async (...args: any[]) => { started = args; },
    cancelTask: async (workflowId: string) => { cancelledWorkflow = workflowId; return true; },
  };
  const service = new TasksService(prisma as never, temporal as never);

  const pauseResult = await service.pause('org', paused.id);
  assert.equal(pauseResult.paused, 1);
  assert.equal(updateInput.data.status, 'PAUSED');
  assert.ok(updateInput.data.pausedAt instanceof Date);
  assert.equal(cancelledWorkflow, paused.workflowId);

  const resumeResult = await service.resume('org', paused.id);
  assert.equal(resumeResult.status, 'QUEUED');
  assert.equal(updateInput.data.pausedAt, null);
  assert.equal(updateInput.data.attemptCount, 0);
  assert.ok(started?.[1].includes('/resume/'));
});
