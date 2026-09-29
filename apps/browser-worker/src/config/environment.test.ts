import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnvironment } from './environment';

const requiredKeys = [
  'NODE_ENV',
  'REMOTE_SESSION_SECRET',
  'PROFILE_ENCRYPTION_KEY',
  'BROWSER_HEADLESS',
] as const;

test('browser mode is headed in development and headless in production', () => {
  const previous = Object.fromEntries(
    requiredKeys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.NODE_ENV = 'development';
    process.env.BROWSER_HEADLESS = 'true';
    delete process.env.REMOTE_SESSION_SECRET;
    delete process.env.PROFILE_ENCRYPTION_KEY;
    assert.equal(loadEnvironment().browserHeadless, false);

    process.env.NODE_ENV = 'production';
    process.env.REMOTE_SESSION_SECRET = 'r'.repeat(32);
    process.env.PROFILE_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    process.env.BROWSER_HEADLESS = 'false';
    assert.equal(loadEnvironment().browserHeadless, true);
  } finally {
    for (const key of requiredKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
