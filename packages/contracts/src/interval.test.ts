import assert from 'node:assert/strict';
import test from 'node:test';
import { maximumIntervalSeconds, normalizeIntervalRange, randomIntervalSeconds } from './interval';
import { joinFacebookGroupsSchema } from './facebook';
import { autoCommentTikTokHomePayloadSchema } from './tiktok';

test('legacy fixed intervals remain fixed', () => {
  assert.deepEqual(normalizeIntervalRange({ intervalSeconds: 10 }), [10, 10]);
  assert.equal(randomIntervalSeconds({ intervalSeconds: 10 }, () => 0.5), 10);
});

test('random intervals include both configured integer boundaries', () => {
  const range = { intervalSeconds: 10, intervalMinSeconds: 8, intervalMaxSeconds: 12 };
  assert.equal(randomIntervalSeconds(range, () => 0), 8);
  assert.equal(randomIntervalSeconds(range, () => 0.999999), 12);
  assert.equal(maximumIntervalSeconds(range), 12);
});

test('Facebook and TikTok reject an inverted interval range', () => {
  const facebook = joinFacebookGroupsSchema.safeParse({
    name: 'Range', idempotencyKey: 'range-test-key', accountIds: [],
    groupUrls: ['https://www.facebook.com/groups/123/'],
    intervalMinSeconds: 12, intervalMaxSeconds: 8,
  });
  const tiktok = autoCommentTikTokHomePayloadSchema.safeParse({
    name: 'Range', text: 'Hello', maxVideos: 1, minLikes: 0,
    intervalMinSeconds: 12, intervalMaxSeconds: 8,
  });
  assert.equal(facebook.success, false);
  assert.equal(tiktok.success, false);
});
