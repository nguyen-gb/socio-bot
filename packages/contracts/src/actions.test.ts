import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskSchema, requiresExternalApproval } from './actions';

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

test('random Facebook group-member messages require approval', () => {
  const result = createTaskSchema.safeParse({
    idempotencyKey: 'message-task-0001',
    action: {
      platform: 'FACEBOOK', accountId, action: 'MESSAGE_FACEBOOK_RECIPIENT',
      payload: { groupUrl: 'https://facebook.com/groups/123/', text: 'Tin nhắn' },
    },
  });
  assert.equal(result.success, true);
  assert.equal(requiresExternalApproval('MESSAGE_FACEBOOK_RECIPIENT'), true);
});

test('Facebook post comment scans are valid actions and require approval', () => {
  const result = createTaskSchema.safeParse({
    idempotencyKey: 'scan-comments-task-0001',
    action: {
      platform: 'FACEBOOK', accountId, action: 'SCAN_FACEBOOK_POST_COMMENTS',
      payload: { postUrl: 'https://facebook.com/groups/123/posts/456' },
    },
  });
  assert.equal(result.success, true);
  assert.equal(requiresExternalApproval('SCAN_FACEBOOK_POST_COMMENTS'), true);
});

test('Facebook post comment replies are valid actions and require approval', () => {
  const result = createTaskSchema.safeParse({
    idempotencyKey: 'reply-comments-task-0001',
    action: {
      platform: 'FACEBOOK', accountId, action: 'REPLY_FACEBOOK_POST_COMMENTS',
      payload: { postUrl: 'https://facebook.com/groups/123/posts/456', text: 'Cảm ơn bạn', maxReplies: 2 },
    },
  });
  assert.equal(result.success, true);
  assert.equal(requiresExternalApproval('REPLY_FACEBOOK_POST_COMMENTS'), true);
});
