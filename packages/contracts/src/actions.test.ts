import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskSchema } from './actions';

const accountId = '00000000-0000-4000-8000-000000000002';

test('createTaskSchema applies safe task defaults', () => {
  const task = createTaskSchema.parse({
    idempotencyKey: 'test-task-0001',
    action: {
      platform: 'FACEBOOK',
      accountId,
      action: 'HEALTH_CHECK',
      payload: {},
    },
  });

  assert.equal(task.priority, 50);
  assert.equal(task.maxAttempts, 3);
});

test('publish post requires text or media', () => {
  const result = createTaskSchema.safeParse({
    idempotencyKey: 'test-task-0002',
    action: {
      platform: 'FACEBOOK',
      accountId,
      action: 'PUBLISH_POST',
      payload: { text: '', mediaAssetIds: [] },
    },
  });

  assert.equal(result.success, false);
});
