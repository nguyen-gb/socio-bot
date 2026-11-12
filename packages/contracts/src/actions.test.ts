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

test('random Facebook post-reactor messages require approval', () => {
  const result = createTaskSchema.safeParse({
    idempotencyKey: 'reactor-message-task-0001',
    action: {
      platform: 'FACEBOOK', accountId, action: 'MESSAGE_FACEBOOK_REACTOR',
      payload: { postUrl: 'https://facebook.com/groups/123/posts/456', recipientSource: 'COMMENTERS', text: 'Tin nhắn người bình luận' },
    },
  });
  assert.equal(result.success, true);
  assert.equal(requiresExternalApproval('MESSAGE_FACEBOOK_REACTOR'), true);
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
  assert.equal(createTaskSchema.safeParse({
    idempotencyKey: 'reply-comments-task-0002',
    action: {
      platform: 'FACEBOOK', accountId, action: 'REPLY_FACEBOOK_POST_COMMENTS',
      payload: { postUrl: 'https://facebook.com/groups/123/posts/456', text: 'Cảm ơn bạn', maxReplies: 2, intervalMinSeconds: 12, intervalMaxSeconds: 8 },
    },
  }).success, false);
  assert.equal(requiresExternalApproval('REPLY_FACEBOOK_POST_COMMENTS'), true);
});

test('TikTok search is read-only and bounded', () => {
  const result = createTaskSchema.safeParse({
    idempotencyKey: 'tiktok-search-0001',
    action: {
      platform: 'TIKTOK', accountId, action: 'SEARCH_TIKTOK_VIDEOS',
      payload: { query: 'du lịch', maxVideos: 25 },
    },
  });
  assert.equal(result.success, true);
  assert.equal(requiresExternalApproval('SEARCH_TIKTOK_VIDEOS'), false);
});

test('TikTok comment, reply and like actions require approval', () => {
  const comment = createTaskSchema.safeParse({
    idempotencyKey: 'tiktok-comment-0001',
    action: {
      platform: 'TIKTOK', accountId, action: 'COMMENT_TIKTOK_VIDEOS',
      payload: { videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'], text: 'Xin chào', intervalSeconds: 5 },
    },
  });
  const reply = createTaskSchema.safeParse({
    idempotencyKey: 'tiktok-reply-0001',
    action: {
      platform: 'TIKTOK', accountId, action: 'REPLY_TIKTOK_COMMENTS',
      payload: { videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'], text: 'Cảm ơn bạn' },
    },
  });
  const like = createTaskSchema.safeParse({
    idempotencyKey: 'tiktok-like-0001',
    action: {
      platform: 'TIKTOK', accountId, action: 'LIKE_TIKTOK_COMMENTS',
      payload: { videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'] },
    },
  });
  assert.equal(comment.success, true);
  assert.equal(reply.success, true);
  assert.equal(like.success, true);
  assert.equal(requiresExternalApproval('COMMENT_TIKTOK_VIDEOS'), true);
  assert.equal(requiresExternalApproval('REPLY_TIKTOK_COMMENTS'), true);
  assert.equal(requiresExternalApproval('LIKE_TIKTOK_COMMENTS'), true);
});

test('TikTok comment actions reject image attachments', () => {
  const videoUrl = 'https://www.tiktok.com/@creator/video/1234567890123456789';
  const mediaAssetIds = ['00000000-0000-4000-8000-000000000020'];
  const actions = [
    { action: 'AUTO_COMMENT_TIKTOK_HOME', payload: { text: 'Xin chào', mediaAssetIds, maxVideos: 1, minLikes: 0 } },
    { action: 'COMMENT_TIKTOK_VIDEOS', payload: { videoUrls: [videoUrl], text: 'Xin chào', mediaAssetIds, maxVideos: 1 } },
    { action: 'REPLY_TIKTOK_COMMENTS', payload: { videoUrls: [videoUrl], text: 'Cảm ơn bạn', mediaAssetIds, maxReplies: 1 } },
  ] as const;

  for (const [index, action] of actions.entries()) {
    const result = createTaskSchema.safeParse({
      idempotencyKey: `tiktok-no-image-${index}`,
      action: { platform: 'TIKTOK', accountId, ...action },
    });
    assert.equal(result.success, false);
  }
});

test('TikTok follower messaging accepts an image-only campaign and requires approval', () => {
  const result = createTaskSchema.safeParse({
    idempotencyKey: 'tiktok-follower-dm-0001',
    action: {
      platform: 'TIKTOK', accountId, action: 'MESSAGE_TIKTOK_FOLLOWERS',
      payload: { name: 'IB follower', username: '@kenh_cua_toi', text: '', maxFollowers: 10, mediaAssetIds: ['00000000-0000-4000-8000-000000000020'], intervalSeconds: 5 },
    },
  });
  assert.equal(result.success, true);
  assert.equal(requiresExternalApproval('MESSAGE_TIKTOK_FOLLOWERS'), true);
});
