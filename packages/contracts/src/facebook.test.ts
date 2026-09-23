import assert from 'node:assert/strict';
import test from 'node:test';
import { postFacebookGroupsSchema } from './facebook';

const base = { name: 'Post fixture', idempotencyKey: 'fixture-key', text: 'Fixture never published', maxGroupsPerAccount: 5 };
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
