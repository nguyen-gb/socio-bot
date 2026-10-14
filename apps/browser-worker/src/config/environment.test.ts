import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnvironment } from './environment';

const requiredKeys = [
  'NODE_ENV',
  'REMOTE_SESSION_SECRET',
  'PROFILE_ENCRYPTION_KEY',
  'BROWSER_HEADLESS',
  'TIKTOK_SEARCH_MODE',
  'TIKTOK_SEARCH_FIXTURE_SCENARIO',
] as const;

test('browser mode follows the environment default and accepts an explicit override', () => {
  const previous = Object.fromEntries(
    requiredKeys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.BROWSER_HEADLESS;
    delete process.env.REMOTE_SESSION_SECRET;
    delete process.env.PROFILE_ENCRYPTION_KEY;
    assert.equal(loadEnvironment().browserHeadless, false);

    process.env.NODE_ENV = 'production';
    process.env.REMOTE_SESSION_SECRET = 'r'.repeat(32);
    process.env.PROFILE_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.BROWSER_HEADLESS;
    assert.equal(loadEnvironment().browserHeadless, true);

    process.env.BROWSER_HEADLESS = 'false';
    assert.equal(loadEnvironment().browserHeadless, false);
    process.env.BROWSER_HEADLESS = 'true';
    assert.equal(loadEnvironment().browserHeadless, true);

    process.env.NODE_ENV = 'development';
    process.env.TIKTOK_SEARCH_MODE = 'fixture';
    process.env.TIKTOK_SEARCH_FIXTURE_SCENARIO = 'challenge';
    assert.equal(loadEnvironment().tiktokSearchMode, 'fixture');
    assert.equal(loadEnvironment().tiktokSearchFixtureScenario, 'challenge');

    process.env.NODE_ENV = 'production';
    assert.throws(() => loadEnvironment(), /only allowed outside production/i);
  } finally {
    for (const key of requiredKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test('browser locale and timezone reject malformed values before launching the worker', () => {
  const previous = Object.fromEntries(['BROWSER_LOCALE', 'BROWSER_TIMEZONE_ID'].map(key => [key, process.env[key]]));
  try {
    process.env.BROWSER_LOCALE = 'en_US';
    assert.throws(() => loadEnvironment(), /Invalid BROWSER_LOCALE/);
    process.env.BROWSER_LOCALE = 'en-US';
    process.env.BROWSER_TIMEZONE_ID = 'Mars/Olympus_Mons';
    assert.throws(() => loadEnvironment(), /Invalid BROWSER_TIMEZONE_ID/);
    process.env.BROWSER_TIMEZONE_ID = 'Asia/Ho_Chi_Minh';
    assert.equal(loadEnvironment().browserLocale, 'en-US');
    assert.equal(loadEnvironment().browserTimezoneId, 'Asia/Ho_Chi_Minh');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
