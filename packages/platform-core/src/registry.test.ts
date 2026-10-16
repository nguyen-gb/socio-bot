import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserPage, PlatformAdapter } from './index';
import { gotoPlatformPage, PlatformAdapterRegistry } from './index';

const adapter: PlatformAdapter = {
  platform: 'X',
  execute: async () => ({ ok: true }),
};

test('adapter registry supports extension without changing execution core', () => {
  const registry = new PlatformAdapterRegistry([adapter]);
  assert.equal(registry.get('X'), adapter);
  assert.deepEqual(registry.list(), ['X']);
  assert.throws(() => registry.register(adapter), /already registered/);
});

test('fallback navigation retries when chrome error page interrupts the login route', async () => {
  const targets: string[] = [];
  let currentUrl = 'about:blank';
  let loginAttempts = 0;
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    waitForTimeout: async () => undefined,
    goto: async (url) => {
      targets.push(url);
      if (url === 'https://www.tiktok.com/') {
        currentUrl = 'chrome-error://chromewebdata/';
        throw new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE');
      }
      loginAttempts += 1;
      if (loginAttempts === 1) {
        throw new Error('page.goto: Navigation to login is interrupted by another navigation to chrome-error://chromewebdata/');
      }
      currentUrl = url;
    },
    locator: () => ({ count: async () => 0 }),
  };

  await gotoPlatformPage(page, 'https://www.tiktok.com/', 'https://www.tiktok.com/login');

  assert.deepEqual(targets, [
    'https://www.tiktok.com/',
    'https://www.tiktok.com/login',
    'https://www.tiktok.com/login',
  ]);
  assert.equal(currentUrl, 'https://www.tiktok.com/login');
});
