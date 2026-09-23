import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformAction } from '@socio/contracts';
import {
  type BrowserPage,
  type PlatformSession,
  UnsupportedPlatformActionError,
} from '@socio/platform-core';
import { FacebookAdapter } from './facebook-adapter';

const accountId = '00000000-0000-4000-8000-000000000002';

test('health check reports a Facebook login form', async () => {
  const adapter = new FacebookAdapter();
  const session = sessionWithPage(
    fakePage('https://www.facebook.com/login', 1),
  );
  const action: PlatformAction = {
    platform: 'FACEBOOK',
    accountId,
    action: 'HEALTH_CHECK',
    payload: {},
  };

  const result = await adapter.execute(action, session);
  assert.equal(result.ok, false);
  assert.equal(result.data?.loginRequired, true);
});

test('publishing is disabled until the authorized flow is configured', async () => {
  const adapter = new FacebookAdapter();
  const action: PlatformAction = {
    platform: 'FACEBOOK',
    accountId,
    action: 'PUBLISH_POST',
    payload: { text: 'staging post', mediaAssetIds: [] },
  };

  await assert.rejects(
    () => adapter.execute(action, sessionWithPage(fakePage('about:blank', 0))),
    UnsupportedPlatformActionError,
  );
});

function sessionWithPage(page: BrowserPage): PlatformSession {
  return { profileId: 'profile-test', page };
}

function fakePage(url: string, loginInputCount: number): BrowserPage {
  let currentUrl = url;
  return {
    url: () => currentUrl,
    title: async () => 'Facebook',
    goto: async (nextUrl) => {
      if (!currentUrl.includes('/login')) currentUrl = nextUrl;
      return undefined;
    },
    locator: () => ({ count: async () => loginInputCount }),
  };
}
