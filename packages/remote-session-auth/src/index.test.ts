import assert from 'node:assert/strict';
import test from 'node:test';
import {
  signRemoteSessionToken,
  verifyRemoteSessionToken,
} from './index';

const secret = 'test-secret-with-at-least-32-characters';
const now = new Date('2026-09-10T00:00:00.000Z');

test('signs and verifies a scoped session token', () => {
  const signed = signRemoteSessionToken('session-a', secret, 60, now);
  assert.equal(
    verifyRemoteSessionToken('session-a', signed.token, secret, now),
    true,
  );
  assert.equal(
    verifyRemoteSessionToken('session-b', signed.token, secret, now),
    false,
  );
});

test('rejects expired session tokens', () => {
  const signed = signRemoteSessionToken('session-a', secret, 60, now);
  const later = new Date(now.getTime() + 61_000);
  assert.equal(
    verifyRemoteSessionToken('session-a', signed.token, secret, later),
    false,
  );
});
