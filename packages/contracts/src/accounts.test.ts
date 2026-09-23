import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountSchema } from './accounts';

test('an account may store cookies and password credentials together', () => {
  const result = createAccountSchema.parse({
    platform: 'FACEBOOK',
    username: 'Primary page',
    authentication: {
      login: 'operator@example.com',
      password: 'secret',
      cookies: 'c_user=123; xs=abc',
    },
  });

  assert.equal(result.authentication.login, 'operator@example.com');
  assert.equal(result.authentication.cookies, 'c_user=123; xs=abc');
});

test('login and password must be supplied together', () => {
  const result = createAccountSchema.safeParse({
    platform: 'FACEBOOK',
    authentication: { login: 'operator@example.com' },
  });

  assert.equal(result.success, false);
});

test('creating without a proxy or external id accepts omitted and null optional fields', () => {
  for (const optional of [{}, { proxyId: null, externalId: null }]) {
    const result = createAccountSchema.parse({ username: 'Direct connection', ...optional });
    assert.equal(result.proxyId, undefined);
    assert.equal(result.externalId, undefined);
    assert.deepEqual(result.authentication, {});
  }
  assert.equal(createAccountSchema.safeParse({ proxyId: 'invalid-proxy' }).success, false);
});
