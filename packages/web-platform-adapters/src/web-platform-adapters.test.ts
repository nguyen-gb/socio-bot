import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformAction } from '@socio/contracts';
import type { BrowserPage, PlatformSession } from '@socio/platform-core';
import { InstagramAdapter, TikTokAdapter, XAdapter } from './web-platform-adapters';

const accountId = '00000000-0000-4000-8000-000000000002';

for (const [adapter, loginUrl] of [
  [new InstagramAdapter(), 'https://www.instagram.com/accounts/login/'],
  [new XAdapter(), 'https://x.com/i/flow/login'],
  [new TikTokAdapter(), 'https://www.tiktok.com/login'],
] as const) {
  test(`${adapter.platform} health check recognizes login state`, async () => {
    const action: PlatformAction = {
      platform: adapter.platform,
      accountId,
      action: 'HEALTH_CHECK',
      payload: {},
    };
    const result = await adapter.execute(action, session(fakePage(loginUrl)));
    assert.equal(result.ok, false);
    assert.equal(result.data?.loginRequired, true);
  });
}

function session(page: BrowserPage): PlatformSession {
  return { profileId: 'test-profile', page };
}

function fakePage(loginUrl: string): BrowserPage {
  return {
    url: () => loginUrl,
    title: async () => 'Login',
    goto: async () => undefined,
    locator: () => ({ count: async () => 0 }),
  };
}
