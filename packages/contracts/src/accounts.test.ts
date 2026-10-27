import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountSchema } from './accounts';
import { browserFingerprintSchema } from './fingerprint';

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

test('auto browser profiles persist only desktop locale settings', () => {
  const parsed = browserFingerprintSchema.parse({
    mode: 'auto',
    localeMode: 'configured',
    locale: 'vi-VN',
    languages: ['vi-VN', 'vi'],
    timezoneId: 'Asia/Ho_Chi_Minh',
  });
  assert.deepEqual(parsed, {
    mode: 'auto',
    localeMode: 'configured',
    locale: 'vi-VN',
    languages: ['vi-VN', 'vi'],
    timezoneId: 'Asia/Ho_Chi_Minh',
  });

  assert.deepEqual(browserFingerprintSchema.parse({
    mode: 'native',
    localeMode: 'native',
    locale: 'vi-VN',
    languages: ['vi-VN', 'vi'],
    timezoneId: 'Asia/Ho_Chi_Minh',
  }), {
    mode: 'native',
    localeMode: 'native',
    locale: 'vi-VN',
    languages: ['vi-VN', 'vi'],
    timezoneId: 'Asia/Ho_Chi_Minh',
  });

  assert.equal(browserFingerprintSchema.safeParse({
    mode: 'custom',
    locale: 'vi-VN',
    languages: ['vi-VN', 'vi'],
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    deviceScaleFactor: 1,
    canvas: { signature: 'fixture', noise: [0, 1, 0] },
    webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel)' },
    gpu: { vendor: 'intel', architecture: 'gen-9', device: '0x3e92', description: 'Intel UHD' },
    userAgent: 'Mozilla/5.0 Chrome/155.0.0.0',
    clientHints: {
      brands: [{ brand: 'Chromium', version: '155' }],
      fullVersionList: [{ brand: 'Chromium', version: '155.0.0.0' }],
      mobile: true,
      platform: 'Windows',
      platformVersion: '19.0.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      uaFullVersion: '155.0.0.0',
    },
  }).success, false);
});
