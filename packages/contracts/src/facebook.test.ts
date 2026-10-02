import assert from 'node:assert/strict';
import test from 'node:test';
import { commentFacebookGroupPostsSchema, facebookGroupCollectionSchema, facebookOptInRecipientSchema, messageFacebookRecipientsSchema, messageFacebookReactorsSchema, normalizeFacebookPostUrl, normalizeFacebookProfileUrl, postFacebookGroupsSchema, replyFacebookPostCommentsSchema, scanFacebookPostCommentsSchema, syncFacebookGroupsSchema } from './facebook';
import { postFacebookGroupActionSchema } from './actions';

const base = { name: 'Post fixture', idempotencyKey: 'fixture-key', text: 'Fixture never published', maxGroupsPerAccount: 5 };
const imageId = '00000000-0000-4000-8000-000000000001';

test('group sync explicitly distinguishes ALL from an empty SELECTED request', () => {
  const input = { idempotencyKey: 'sync-fixture-key' };
  assert.deepEqual(syncFacebookGroupsSchema.parse({ ...input, scope: 'ALL' }).accountIds, []);
  assert.deepEqual(syncFacebookGroupsSchema.parse({ ...input, scope: 'SELECTED', accountIds: [imageId] }).accountIds, [imageId]);
  assert.equal(syncFacebookGroupsSchema.safeParse({ ...input, scope: 'SELECTED', accountIds: [] }).success, false);
  assert.equal(syncFacebookGroupsSchema.safeParse({ ...input, scope: 'ALL', accountIds: [imageId] }).success, false);
  assert.deepEqual(syncFacebookGroupsSchema.parse(input).accountIds, []); // Existing API callers.
});

test('Facebook posts accept text, images or both and reject empty or invalid attachments', () => {
  assert.deepEqual(postFacebookGroupsSchema.parse(base).mediaAssetIds, []);
  assert.equal(postFacebookGroupsSchema.parse({ ...base, text: '', mediaAssetIds: [imageId] }).text, '');
  assert.equal(postFacebookGroupActionSchema.safeParse({ platform: 'FACEBOOK', accountId: imageId, action: 'POST_FACEBOOK_GROUP', payload: { groupUrl: 'https://www.facebook.com/groups/123/', mediaAssetIds: [imageId] } }).success, true);
  for (const input of [{ text: '  ' }, { mediaAssetIds: [imageId, imageId] }, { mediaAssetIds: ['invalid-id'] }, { mediaAssetIds: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }]) {
    assert.equal(postFacebookGroupsSchema.safeParse({ ...base, ...input }).success, false);
  }
});
test('custom posting normalizes Facebook links and removes duplicates', () => {
  const input = postFacebookGroupsSchema.parse({ ...base, selection: 'CUSTOM', groupUrls: [
    'https://m.facebook.com/groups/123/?ref=test', 'https://www.facebook.com/groups/123/', 'https://facebook.com/groups/fixture-name/',
  ] });
  assert.deepEqual(input.groupUrls, ['https://www.facebook.com/groups/123/', 'https://www.facebook.com/groups/fixture-name/']);
  assert.deepEqual(input.accountIds, []);
});
test('custom posting requires 1 to 100 valid group links', () => {
  for (const groupUrls of [undefined, [], ['https://evil.test/groups/123/'], ['http://facebook.com/groups/123/'],
    ['https://www.facebook.com/groups/123/posts/456/'], ['https://user:pass@facebook.com/groups/123/'],
    Array.from({ length: 101 }, (_, index) => `https://www.facebook.com/groups/${index}/`)]) {
    assert.equal(postFacebookGroupsSchema.safeParse({ ...base, selection: 'CUSTOM', groupUrls }).success, false);
  }
});
test('group source and per-account maximum are independent', () => {
  assert.equal(postFacebookGroupsSchema.parse(base).selection, 'ALL');
  assert.equal(postFacebookGroupsSchema.parse({ ...base, selection: 'CUSTOM', groupUrls: ['https://facebook.com/groups/123/'], maxGroupsPerAccount: 2 }).maxGroupsPerAccount, 2);
  assert.equal(postFacebookGroupsSchema.safeParse({ name: base.name, idempotencyKey: base.idempotencyKey, text: base.text }).success, false);
  assert.equal(postFacebookGroupsSchema.safeParse({ ...base, selection: 'LIMIT' }).success, false);
});

test('group collections normalize and deduplicate up to 1000 synchronized groups', () => {
  const parsed = facebookGroupCollectionSchema.parse({ name: '  Hải sản  ', description: '  Nhóm bán hải sản  ', groupUrls: [
    'https://m.facebook.com/groups/123/?ref=share', 'https://www.facebook.com/groups/123/', 'https://facebook.com/groups/seafood/',
  ] });
  assert.equal(parsed.name, 'Hải sản');
  assert.equal(parsed.description, 'Nhóm bán hải sản');
  assert.deepEqual(parsed.groupUrls, ['https://www.facebook.com/groups/123/', 'https://www.facebook.com/groups/seafood/']);
  assert.equal(facebookGroupCollectionSchema.safeParse({ name: '', groupUrls: [] }).success, false);
});

test('collection posting requires collection ids and removes duplicate ids', () => {
  const parsed = postFacebookGroupsSchema.parse({ ...base, selection: 'COLLECTIONS', collectionIds: [imageId, imageId] });
  assert.deepEqual(parsed.collectionIds, [imageId]);
  assert.equal(postFacebookGroupsSchema.safeParse({ ...base, selection: 'COLLECTIONS', collectionIds: [] }).success, false);
  assert.equal(postFacebookGroupsSchema.safeParse({ ...base, selection: 'COLLECTIONS', collectionIds: ['invalid'] }).success, false);
});

test('opt-in recipients require consent evidence and canonical Facebook profile URLs', () => {
  assert.equal(normalizeFacebookProfileUrl('https://m.facebook.com/consented.user/?ref=x'), 'https://www.facebook.com/consented.user/');
  assert.equal(normalizeFacebookProfileUrl('https://facebook.com/profile.php?id=123&ref=x'), 'https://www.facebook.com/profile.php?id=123');
  assert.equal(normalizeFacebookProfileUrl('https://www.facebook.com/people/Nguyen-Van-A/100012345678901/'), 'https://www.facebook.com/profile.php?id=100012345678901');
  assert.equal(normalizeFacebookProfileUrl('https://www.facebook.com/groups/1710577763336777/user/100028475506542/'), 'https://www.facebook.com/100028475506542');
  assert.equal(normalizeFacebookProfileUrl('https://www.facebook.com/100028475506542/'), 'https://www.facebook.com/100028475506542');
  const input = { groupUrl: 'https://facebook.com/groups/123/', profileUrl: 'https://facebook.com/consented.user/', displayName: 'Người đã đồng ý', consentSource: 'Form đăng ký', consentRecordedAt: '2026-09-26T00:00:00.000Z' };
  assert.equal(facebookOptInRecipientSchema.safeParse(input).success, true);
  assert.equal(facebookOptInRecipientSchema.safeParse({ ...input, consentSource: '' }).success, false);
  for (const profileUrl of ['https://evil.test/user', 'http://facebook.com/user', 'https://facebook.com/groups/', 'https://facebook.com/profile.php?id=abc']) {
    assert.throws(() => normalizeFacebookProfileUrl(profileUrl));
  }
});

test('message campaign bounds random-member attempts per group and pacing', () => {
  const parsed = messageFacebookRecipientsSchema.parse({ ...base, text: 'Tin nhắn', groupUrls: ['https://facebook.com/groups/123/'], maxRecipientsPerGroup: 10 });
  assert.equal(parsed.intervalSeconds, 120);
  assert.deepEqual(messageFacebookRecipientsSchema.parse({ ...base, text: 'Tin nhắn', maxRecipientsPerGroup: 10 }).groupUrls, []);
  assert.equal(messageFacebookRecipientsSchema.safeParse({ ...base, text: 'Tin nhắn', groupUrls: ['https://facebook.com/groups/123/'], maxRecipientsPerGroup: 51 }).success, false);
  assert.equal(messageFacebookRecipientsSchema.safeParse({ ...base, text: 'Tin nhắn', groupUrls: ['https://facebook.com/groups/123/'], maxRecipientsPerGroup: 10, intervalSeconds: 30 }).success, false);
});

test('reactor message campaigns accept one post and split the total by profile', () => {
  const parsed = messageFacebookReactorsSchema.parse({ ...base, text: 'Tin nhắn người react', postUrl: 'https://facebook.com/groups/123/posts/456', maxRecipientsPerPost: 10 });
  assert.equal(parsed.postUrl, 'https://www.facebook.com/groups/123/posts/456');
  assert.equal(parsed.intervalSeconds, 120);
  assert.equal(parsed.recipientSource, 'REACTORS');
  assert.equal(messageFacebookReactorsSchema.parse({ ...base, text: 'Tin nhắn người bình luận', postUrl: 'https://facebook.com/groups/123/posts/456', recipientSource: 'COMMENTERS', maxRecipientsPerPost: 10 }).recipientSource, 'COMMENTERS');
  assert.deepEqual(messageFacebookReactorsSchema.parse({ ...base, text: 'Tin nhắn nhiều bài', postUrls: ['https://facebook.com/groups/123/posts/456', 'https://facebook.com/groups/123/posts/789'], maxRecipientsPerPost: 10 }).postUrls, ['https://www.facebook.com/groups/123/posts/456', 'https://www.facebook.com/groups/123/posts/789']);
  assert.equal(messageFacebookReactorsSchema.safeParse({ ...base, text: 'Thiếu URL', maxRecipientsPerPost: 10 }).success, false);
  assert.equal(messageFacebookReactorsSchema.safeParse({ ...base, text: 'Tin nhắn', postUrl: 'https://facebook.com/groups/123/', maxRecipientsPerPost: 10 }).success, false);
});

test('comment scanning accepts canonical Facebook post URLs and rejects group or external URLs', () => {
  assert.equal(normalizeFacebookPostUrl('https://m.facebook.com/groups/123/permalink/456/?ref=share'), 'https://www.facebook.com/groups/123/permalink/456?ref=share');
  assert.equal(normalizeFacebookPostUrl('https://www.facebook.com/story.php?story_fbid=456&id=123'), 'https://www.facebook.com/story.php?story_fbid=456&id=123');
  const parsed = scanFacebookPostCommentsSchema.parse({ name: 'Quét bình luận', idempotencyKey: 'scan-comments-0001', postUrl: 'https://facebook.com/groups/123/posts/456' });
  assert.equal(parsed.postUrl, 'https://www.facebook.com/groups/123/posts/456');
  assert.equal(parsed.intervalSeconds, 60);
  const many = scanFacebookPostCommentsSchema.parse({ name: 'Quét nhiều bài', idempotencyKey: 'scan-comments-many', postUrls: [
    'https://facebook.com/groups/123/posts/456', 'https://m.facebook.com/groups/123/permalink/789/?ref=share', 'https://facebook.com/groups/123/posts/456',
  ] });
  assert.deepEqual(many.postUrls, ['https://www.facebook.com/groups/123/posts/456', 'https://www.facebook.com/groups/123/permalink/789?ref=share']);
  assert.equal(scanFacebookPostCommentsSchema.safeParse({ name: 'Quét bình luận', idempotencyKey: 'scan-comments-empty' }).success, false);
  for (const postUrl of ['https://www.facebook.com/groups/123/', 'https://evil.test/posts/456', 'http://facebook.com/groups/123/posts/456', 'https://facebook.com/story.php?story_fbid=abc']) {
    assert.equal(scanFacebookPostCommentsSchema.safeParse({ name: 'Quét bình luận', idempotencyKey: 'scan-comments-0002', postUrl }).success, false);
  }
});

test('comment replies require text, a bounded reply count and a Facebook post URL', () => {
  const parsed = replyFacebookPostCommentsSchema.parse({ name: 'Rep bình luận', idempotencyKey: 'reply-comments-0001', postUrl: 'https://facebook.com/groups/123/posts/456', text: 'Cảm ơn bạn', maxReplies: 10 });
  assert.equal(parsed.maxReplies, 10);
  assert.equal(parsed.intervalSeconds, 120);
  assert.equal(replyFacebookPostCommentsSchema.safeParse({ name: 'Rep bình luận', idempotencyKey: 'reply-comments-0002', postUrl: 'https://facebook.com/groups/123/posts/456', text: '', maxReplies: 1 }).success, false);
  assert.equal(replyFacebookPostCommentsSchema.safeParse({ name: 'Rep bình luận', idempotencyKey: 'reply-comments-0003', postUrl: 'https://facebook.com/groups/123/posts/456', text: 'Rep', maxReplies: 0 }).success, false);
  assert.equal(replyFacebookPostCommentsSchema.safeParse({ name: 'Rep bình luận', idempotencyKey: 'reply-comments-0004', postUrl: 'https://facebook.com/groups/123/posts/456', text: 'Rep', maxReplies: 51 }).success, false);
  assert.equal(replyFacebookPostCommentsSchema.safeParse({ name: 'Rep bình luận', idempotencyKey: 'reply-comments-0005', postUrl: 'https://facebook.com/groups/123/', text: 'Rep', maxReplies: 1 }).success, false);
});

test('group comment campaigns validate filters and normalize selected groups', () => {
  const parsed = commentFacebookGroupPostsSchema.parse({
    name: 'Cmt bài nhóm', idempotencyKey: 'comment-group-posts-0001', accountIds: [],
    groupUrls: ['https://facebook.com/groups/123/', 'https://www.facebook.com/groups/123/'],
    text: 'Bình luận', daysRecent: 7, minReactions: 2, maxReactions: 20,
    minComments: 1, maxComments: 10, maxPosts: 5,
  });
  assert.deepEqual(parsed.groupUrls, ['https://www.facebook.com/groups/123/']);
  assert.equal(parsed.maxPosts, 5);
  assert.equal(commentFacebookGroupPostsSchema.safeParse({ ...parsed, maxReactions: 1, minReactions: 2 }).success, false);
  assert.equal(commentFacebookGroupPostsSchema.safeParse({ ...parsed, maxComments: 0, minComments: 1 }).success, false);
  assert.equal(commentFacebookGroupPostsSchema.safeParse({ ...parsed, text: '', mediaAssetIds: [] }).success, false);
});
