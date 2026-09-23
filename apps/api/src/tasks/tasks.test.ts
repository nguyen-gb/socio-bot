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
