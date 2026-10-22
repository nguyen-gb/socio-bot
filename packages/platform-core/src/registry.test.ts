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

test('keeps a target route when Chromium times out after committing it', async () => {
  let currentUrl = 'about:blank';
  let attempts = 0;
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'Facebook',
    waitForTimeout: async () => undefined,
    goto: async (url) => {
      currentUrl = url;
      attempts += 1;
      throw new Error('page.goto: Timeout 45000ms exceeded');
    },
    locator: () => ({ count: async () => 0 }),
  };

  await gotoPlatformPage(page, 'https://www.facebook.com/groups/123/');

  assert.equal(attempts, 1);
  assert.equal(currentUrl, 'https://www.facebook.com/groups/123/');
});

test('waits for the full page load before returning from navigation', async () => {
  const milestones: string[] = [];
  const page: BrowserPage = {
    url: () => 'https://www.facebook.com/',
    title: async () => 'Facebook',
    goto: async () => { milestones.push('goto'); },
    waitForLoadState: async (state) => { milestones.push(state ?? 'unknown'); },
    waitForTimeout: async (milliseconds) => { milestones.push(`settle:${milliseconds}`); },
    evaluate: async () => 'complete' as never,
    locator: () => ({ count: async () => 0 }),
  };

  await gotoPlatformPage(page, 'https://www.facebook.com/');

  assert.deepEqual(milestones, ['goto', 'domcontentloaded', 'load', 'settle:400']);
});

test('reloads a failed target once before surfacing the navigation error', async () => {
  let reloads = 0;
  let currentUrl = 'about:blank';
  const target = 'https://www.tiktok.com/@creator/video/123';
  const reloadButton = {
    count: async () => 1,
    nth: () => ({
      isVisible: async () => true,
      isEnabled: async () => true,
      click: async () => {
        reloads += 1;
        currentUrl = target;
      },
    }),
  };
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url) => {
      currentUrl = url;
      throw new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE');
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async () => true as never,
    locator: (selector) => selector === '#reload-button' ? reloadButton : { count: async () => 0 },
  };

  await assert.rejects(() => gotoPlatformPage(page, target), /ERR_HTTP_RESPONSE_CODE_FAILURE/);
  assert.equal(reloads, 1);
});
