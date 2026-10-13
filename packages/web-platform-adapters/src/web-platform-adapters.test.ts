import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformAction } from '@socio/contracts';
import type { BrowserPage, PlatformSession } from '@socio/platform-core';
import { createTikTokFixtureSearchProvider } from './tiktok-automation';
import { InstagramAdapter, TikTokAdapter, XAdapter } from './web-platform-adapters';

const accountId = '00000000-0000-4000-8000-000000000002';

test('TikTok fixture search is deterministic and does not require a browser page', async () => {
  const provider = createTikTokFixtureSearchProvider('success');
  const videos = await provider.search('du lịch', 2);

  assert.equal(videos.length, 2);
  assert.equal(videos[0]?.username, '@socio_fixture');
  assert.match(videos[0]?.videoUrl ?? '', /\/video\/1000000000000000001$/);
  assert.equal(videos[0]?.description, '[fixture] du lịch');
});

test('TikTok fixture challenge is surfaced as a verification result', async () => {
  const adapter = new TikTokAdapter({
    searchProvider: createTikTokFixtureSearchProvider('challenge'),
  });
  const action: PlatformAction = {
    platform: 'TIKTOK',
    accountId,
    action: 'SEARCH_TIKTOK_VIDEOS',
    payload: { name: 'Fixture challenge', query: 'test', maxVideos: 1 },
  };

  const result = await adapter.execute(action, session(fakePage('about:blank')));

  assert.equal(result.ok, false);
  assert.equal(result.data?.requiresAction, true);
  assert.equal(result.data?.accountChallenged, true);
});

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

test('TikTok health check falls back to the login route when the entry route has no renderable HTTP response', async () => {
  const targets: string[] = [];
  let currentUrl = 'about:blank';
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'Login',
    goto: async (url) => {
      targets.push(url);
      if (url === 'https://www.tiktok.com/') {
        throw new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://www.tiktok.com/');
      }
      currentUrl = url;
    },
    locator: () => ({ count: async () => 0 }),
  };
  const action: PlatformAction = {
    platform: 'TIKTOK',
    accountId,
    action: 'HEALTH_CHECK',
    payload: {},
  };

  const result = await new TikTokAdapter().execute(action, session(page));

  assert.equal(result.ok, false);
  assert.equal(result.data?.loginRequired, true);
  assert.deepEqual(targets, [
    'https://www.tiktok.com/',
    'https://www.tiktok.com/login',
  ]);
});

test('TikTok search returns bounded metadata without requiring an external-action approval', async () => {
  let currentUrl = 'about:blank';
  let searchInputVisible = false;
  let gotItVisible = true;
  const events: string[] = [];
  const gotItButton = {
    count: async () => 1,
    textContent: async () => gotItVisible ? 'Got it' : null,
    isVisible: async () => gotItVisible,
    click: async () => { gotItVisible = false; events.push('dismiss-got-it'); },
  };
  const forYouLabel = {
    count: async () => 1,
    textContent: async () => 'For You',
    isVisible: async () => false,
  };
  const forYouButton = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { events.push('click-for-you'); },
  };
  const navSearch = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { events.push('click-search'); searchInputVisible = true; },
  };
  const searchInput = {
    count: async () => 1,
    isVisible: async () => searchInputVisible,
    click: async () => { events.push('focus-search'); },
    fill: async (value: string) => { events.push(`fill:${value}`); },
    press: async (key: string) => { events.push(`press:${key}`); currentUrl = 'https://www.tiktok.com/search/video?q=du%20l%E1%BB%8Bch'; },
  };
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url: string) => { events.push(`goto:${url}`); currentUrl = url; },
    locator: (selector: string) => selector === 'button' ? gotItButton : selector.includes('TUXButton-label') ? forYouLabel : selector.includes('aria-label="For You"') ? forYouButton : selector.includes('nav-search') ? navSearch : selector.includes('search-user-input') ? searchInput : { count: async () => 0 },
    evaluate: async () => [{
      videoUrl: 'https://www.tiktok.com/@creator/video/1234567890123456789',
      videoId: '1234567890123456789',
      username: '@creator',
      description: 'du lịch',
      likes: 120,
      views: 2_000,
      comments: 8,
    }],
  } as unknown as BrowserPage & { evaluate: (pageFunction: (() => unknown) | string) => Promise<unknown> };
  const action: PlatformAction = {
    platform: 'TIKTOK', accountId, action: 'SEARCH_TIKTOK_VIDEOS',
    payload: { name: 'Search test', query: 'du lịch', maxVideos: 1 },
  };

  const result = await new TikTokAdapter().execute(action, session(page));

  assert.equal(result.ok, true);
  assert.equal(result.data?.count, 1);
  assert.equal((result.data?.videos as Array<{ videoId: string }>)[0]?.videoId, '1234567890123456789');
  assert.deepEqual(events.slice(0, 3), ['goto:https://www.tiktok.com/', 'dismiss-got-it', 'click-for-you']);
  assert.deepEqual(events.slice(-3), ['focus-search', 'fill:du lịch', 'press:Enter']);
  assert.equal(events.some((event) => event.includes('/foryou')), false);
});

test('TikTok search fails closed when TikTok returns no data without an explicit empty state', async () => {
  let currentUrl = 'about:blank';
  const forYouLabel = {
    count: async () => 1,
    textContent: async () => 'For You',
    click: async () => undefined,
  };
  const searchInput = {
    count: async () => 1,
    click: async () => undefined,
    fill: async () => undefined,
    press: async () => { currentUrl = 'https://www.tiktok.com/search/video?q=%C3%A1o%20kho%C3%A1c%20nam'; },
  };
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url: string) => { currentUrl = url; },
    locator: (selector: string) => selector.includes('TUXButton-label') ? forYouLabel : selector.includes('search-user-input') ? searchInput : { count: async () => 0 },
    evaluate: async (pageFunction: (() => unknown) | string) => {
      if (typeof pageFunction === 'function' && pageFunction.toString().includes('bodyText')) {
        return { bodyText: '', htmlText: '', challengeNode: false };
      }
      return [];
    },
  } as unknown as BrowserPage & { evaluate: (pageFunction: (() => unknown) | string) => Promise<unknown> };
  const action: PlatformAction = {
    platform: 'TIKTOK', accountId, action: 'SEARCH_TIKTOK_VIDEOS',
    payload: { name: 'Search challenge', query: 'áo khoác nam', maxVideos: 5 },
  };

  const result = await new TikTokAdapter().execute(action, session(page));

  assert.equal(result.ok, false);
  assert.equal(result.data?.requiresAction, true);
  assert.equal(result.data?.accountChallenged, true);
  assert.match(String(result.data?.reason), /BDTuring|xác minh/i);
});

test('TikTok view filters do not treat an unavailable view metric as a match', async () => {
  let currentUrl = 'about:blank';
  const forYouLabel = {
    count: async () => 1,
    textContent: async () => 'For You',
    click: async () => undefined,
  };
  const searchInput = {
    count: async () => 1,
    click: async () => undefined,
    fill: async () => undefined,
    press: async () => { currentUrl = 'https://www.tiktok.com/search/video?q=du%20l%E1%BB%8Bch'; },
  };
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url: string) => { currentUrl = url; },
    locator: (selector: string) => selector.includes('TUXButton-label') ? forYouLabel : selector.includes('search-user-input') ? searchInput : { count: async () => 0 },
    evaluate: async () => [{ videoUrl: 'https://www.tiktok.com/@creator/video/1234567890123456789', likes: 120 }],
  } as unknown as BrowserPage & { evaluate: (pageFunction: (() => unknown) | string) => Promise<unknown> };
  const action: PlatformAction = {
    platform: 'TIKTOK', accountId, action: 'SEARCH_TIKTOK_VIDEOS',
    payload: { name: 'Search filter', query: 'du lịch', maxVideos: 1, minViews: 1 },
  };

  const result = await new TikTokAdapter().execute(action, session(page));

  assert.equal(result.ok, true);
  assert.equal(result.data?.count, 0);
});

test('TikTok live comment refuses to run without the worker approval hook', async () => {
  let currentUrl = 'about:blank';
  const fakeLocator = {
    count: async () => 1,
    first: () => fakeLocator,
    fill: async () => undefined,
    click: async () => undefined,
  };
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url) => { currentUrl = url; },
    locator: (selector) => selector.includes('contenteditable') || selector.includes('comment-input') ? fakeLocator : { count: async () => 0 },
  };
  const action: PlatformAction = {
    platform: 'TIKTOK', accountId, action: 'COMMENT_TIKTOK_VIDEOS',
    payload: { name: 'Comment test', videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'], text: 'Xin chào', mediaAssetIds: [], intervalSeconds: 120, maxVideos: 1 },
  };

  const result = await new TikTokAdapter().execute(action, session(page));

  assert.equal(result.ok, true);
  assert.equal(result.data?.sent, 0);
  assert.match(String((result.data?.failures as Array<{ reason: string }>)[0]?.reason), /approved task execution context/i);
});

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
