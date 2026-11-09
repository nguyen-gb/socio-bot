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

test('a direct Facebook inbox skips a profile completed by an earlier campaign', async () => {
  let navigations = 0;
  const page = fakePage('about:blank', 0);
  page.goto = async () => { navigations += 1; return undefined; };
  const result = await new FacebookAdapter().execute({
    platform: 'FACEBOOK', accountId, action: 'MESSAGE_FACEBOOK_RECIPIENT',
    payload: {
      groupUrl: 'https://www.facebook.com/groups/123/',
      profileUrl: 'https://www.facebook.com/profile.php?id=100012345678901',
      displayName: 'Người nhận', text: 'Xin chào', mediaAssetIds: [], excludeProfileUrls: [],
    },
  }, {
    ...sessionWithPage(page),
    reserveFacebookTarget: async () => false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data?.messageStatus, 'SKIPPED_DUPLICATE');
  assert.equal(result.data?.deduplicated, true);
  assert.equal(navigations, 0);
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
