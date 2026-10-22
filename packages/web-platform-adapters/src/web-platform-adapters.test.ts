import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformAction } from '@socio/contracts';
import type { BrowserPage, PlatformSession } from '@socio/platform-core';
import { createTikTokFixtureSearchProvider, likeTikTokComments, replyTikTokComments, solveVisibleTikTokRotateCaptcha } from './tiktok-automation';
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

test('TikTok rotate solver sends the two rendered images and drags the native slider', async () => {
  let solved = false;
  const mouseEvents: string[] = [];
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const locatorFor = (selector: string) => {
    const isOutside = selector.includes('#captcha-verify-image')
      || selector.includes('captcha_verify_img:not')
      || selector.includes('img')
      || selector.includes('canvas');
    const isInside = selector.includes('captcha_verify_img_slide') || (selector.includes('captcha') && !isOutside);
    const isTrack = selector.includes('slidebar');
    const isHandle = selector.includes('drag-icon');
    const active = isInside || isOutside || isTrack || isHandle;
    const candidate = {
      count: async () => active ? 1 : 0,
      nth: () => candidate,
      isVisible: async () => active && !solved,
      screenshot: async () => Buffer.from(isInside ? 'inside' : 'outside'),
      boundingBox: async () => isTrack ? box(100, 300, 300, 40) : isHandle ? box(100, 300, 40, 40) : box(100, 100, isInside ? 160 : 240, isInside ? 160 : 240),
    };
    return candidate;
  };
  const page = {
    url: () => 'https://www.tiktok.com/login',
    title: async () => 'TikTok',
    goto: async () => undefined,
    locator: locatorFor,
    evaluate: async () => solved ? { bodyText: '', challengeNode: false } : { bodyText: 'captcha', challengeNode: true },
    waitForTimeout: async () => undefined,
    mouse: {
      move: async () => { mouseEvents.push('move'); },
      down: async () => { mouseEvents.push('down'); },
      up: async () => { mouseEvents.push('up'); solved = true; },
    },
  } as unknown as BrowserPage & { evaluate: (pageFunction: (() => unknown) | string) => Promise<unknown> };

  let receivedImages: readonly [string, string] | undefined;
  const result = await solveVisibleTikTokRotateCaptcha(page as never, {
    solveRotate: async (images) => { receivedImages = images; return 0.5; },
  });

  assert.equal(result.solved, true);
  assert.deepEqual(receivedImages, [Buffer.from('inside').toString('base64'), Buffer.from('outside').toString('base64')]);
  assert.equal(mouseEvents[0], 'move');
  assert.equal(mouseEvents.includes('down'), true);
  assert.equal(mouseEvents.at(-1), 'up');
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

test('TikTok health check starts at root and does not force a login route', async () => {
  const targets: string[] = [];
  let currentUrl = 'about:blank';
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'Login',
    goto: async (url) => {
      targets.push(url);
      currentUrl = url;
    },
    locator: (selector) => ({ count: async () => selector.includes('/login') ? 1 : 0 }),
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
  assert.deepEqual(targets, ['https://www.tiktok.com/']);
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
  let searchNavigationAttempts = 0;
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url: string) => {
      events.push(`goto:${url}`);
      currentUrl = url;
      if (url.includes('/search/video') && searchNavigationAttempts++ === 0) {
        throw new Error(`page.goto: net::ERR_ABORTED at ${url}`);
      }
    },
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
  assert.match(events[0] ?? '', /^goto:https:\/\/www\.tiktok\.com\/$/);
  assert.equal(events.some((event) => event.includes('/foryou')), false);
  assert.equal(events.some((event) => event.includes('click-for-you')), false);
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
  let editorValue = '';
  const fakeLocator = {
    count: async () => 1,
    first: () => fakeLocator,
    fill: async (value: string) => { editorValue = value; },
    textContent: async () => editorValue,
    click: async () => undefined,
  };
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url) => { currentUrl = url; },
    locator: (selector) => selector.includes('contenteditable')
      || selector.includes('comment-input')
      || selector.includes('comment-post')
      ? fakeLocator
      : { count: async () => 0 },
  };
  const action: PlatformAction = {
    platform: 'TIKTOK', accountId, action: 'COMMENT_TIKTOK_VIDEOS',
    payload: { name: 'Comment test', videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'], text: 'Xin chào', mediaAssetIds: [], intervalSeconds: 120, maxVideos: 1 },
  };

  const result = await new TikTokAdapter().execute(action, session(page));

  assert.equal(result.ok, false);
  assert.equal(result.data?.sent, 0);
  assert.match(String((result.data?.failures as Array<{ reason: string }>)[0]?.reason), /approved task execution context/i);
  assert.equal((result.data?.report as { entries?: Array<{ status?: string; videoUrl?: string }> })?.entries?.[0]?.status, 'FAILED');
  assert.equal((result.data?.report as { entries?: Array<{ status?: string; videoUrl?: string }> })?.entries?.[0]?.videoUrl, action.payload.videoUrls[0]);
});

test('TikTok reply keeps the configured target and reports why no comment was replied to', async () => {
  let currentUrl = 'about:blank';
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url) => { currentUrl = url; },
    locator: () => ({ count: async () => 0 }),
  };

  const result = await replyTikTokComments(
    session(page),
    {
      videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'],
      text: 'Xin chào',
      mediaAssetIds: [],
      maxReplies: 2,
    },
  );

  assert.equal(result.requested, 2);
  assert.equal(result.sent, 0);
  assert.equal(result.reason, 'Không mở được danh sách comment TikTok');
  assert.match(String((result.failures as string[])[0]), /Không mở được danh sách comment TikTok/);
  const entry = (result.report as { entries?: Array<{ status?: string; reason?: string; videoUrl?: string }> }).entries?.[0];
  assert.equal(entry?.status, 'FAILED');
  assert.equal(entry?.reason, 'Không mở được danh sách comment TikTok');
  assert.equal(entry?.videoUrl, 'https://www.tiktok.com/@creator/video/1234567890123456789');
});

test('TikTok reply with zero sends is a failed action, not a successful task', async () => {
  const page: BrowserPage = {
    url: () => 'https://www.tiktok.com/@creator/video/1234567890123456789',
    title: async () => 'TikTok',
    goto: async () => undefined,
    locator: () => ({ count: async () => 0 }),
  };
  const action: PlatformAction = {
    platform: 'TIKTOK',
    accountId,
    action: 'REPLY_TIKTOK_COMMENTS',
    payload: {
      name: 'Reply test',
      videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'],
      text: 'Xin chào',
      mediaAssetIds: [],
      intervalSeconds: 120,
      maxReplies: 2,
    },
  };

  const result = await new TikTokAdapter().execute(action, session(page));

  assert.equal(result.ok, false);
  assert.equal(result.data?.sent, 0);
  assert.equal(result.data?.requested, 2);
  assert.equal(result.data?.reason, 'Không mở được danh sách comment TikTok');
});

test('TikTok reply reports a single reload-aware error when a video still returns HTTP 403', async () => {
  let reloadAttempts = 0;
  const videoUrl = 'https://www.tiktok.com/@usaclips32/video/7671995025307225375';
  const reloadButton = {
    count: async () => 1,
    nth: () => ({
      isVisible: async () => true,
      isEnabled: async () => true,
      click: async () => { reloadAttempts += 1; throw new Error('reload click failed'); },
    }),
  };
  const page: BrowserPage = {
    url: () => 'chrome-error://chromewebdata/',
    title: async () => 'HTTP ERROR 403',
    goto: async () => { throw new Error(`page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at ${videoUrl}`); },
    locator: (selector) => selector === '#reload-button' ? reloadButton : { count: async () => 0 },
  };

  const result = await replyTikTokComments(
    session(page),
    { videoUrls: [videoUrl], text: 'Xin chào', mediaAssetIds: [], maxReplies: 3 },
  );

  assert.equal(reloadAttempts, 1);
  assert.equal(result.requested, 3);
  assert.equal(result.sent, 0);
  assert.match(String(result.reason), /đã thử Reload.*HTTP 403.*7671995025307225375/i);
  assert.equal((result.failures as string[]).length, 1);
  assert.equal((result.report as { entries: Array<{ reason?: string }> }).entries.length, 1);
});

test('TikTok reply opens the comment drawer before looking for reply controls', async () => {
  let commentsOpen = false;
  let openerClicks = 0;
  const replyButton = {
    count: async () => commentsOpen ? 1 : 0,
    nth: () => replyButton,
    isVisible: async () => commentsOpen,
    click: async () => undefined,
  };
  const opener = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { commentsOpen = true; openerClicks += 1; },
  };
  const drawer = {
    count: async () => commentsOpen ? 1 : 0,
    isVisible: async () => commentsOpen,
  };
  const page: BrowserPage = {
    url: () => 'https://www.tiktok.com/@creator/video/1234567890123456789',
    title: async () => 'TikTok',
    goto: async () => undefined,
    locator: (selector: string) => {
      if (selector.includes('comment-reply') || selector.includes('aria-label*="Reply"') || selector.includes('has-text("Reply")')) return replyButton;
      if (selector.includes('comment-icon')) return opener;
      if (selector.includes('comment-list') || selector.includes('comment-container') || selector.includes('comment-panel') || selector.includes('comment-input')) return drawer;
      return { count: async () => 0 };
    },
  };

  const result = await replyTikTokComments(
    session(page),
    {
      videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'],
      text: 'Xin chào',
      mediaAssetIds: [],
      maxReplies: 1,
    },
  );

  assert.equal(openerClicks, 1);
  assert.equal(result.requested, 1);
  assert.equal(result.sent, 0);
  assert.notEqual(result.reason, 'Không tìm thấy comment TikTok có thể reply.');
});

test('TikTok reply fills the reply editor and presses Enter instead of falling back to the main comment box', async () => {
  let commentsOpen = false;
  let replyOpened = false;
  let replyText = '';
  let posted = false;
  let openerClicks = 0;
  const replyButton = {
    count: async () => commentsOpen ? 1 : 0,
    nth: () => replyButton,
    isVisible: async () => commentsOpen,
    click: async () => { replyOpened = true; },
  };
  const opener = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { commentsOpen = true; openerClicks += 1; },
  };
  const drawer = {
    count: async () => commentsOpen ? 1 : 0,
    isVisible: async () => commentsOpen,
  };
  const replyEditor = {
    count: async () => replyOpened ? 1 : 0,
    nth: () => replyEditor,
    isVisible: async () => replyOpened,
    click: async () => undefined,
    fill: async (value: string) => { replyText = value; },
    inputValue: async () => replyText,
    press: async (key: string) => { if (key === 'Enter') posted = true; },
  };
  const postedComment = {
    count: async () => posted ? 1 : 0,
    nth: () => postedComment,
    isVisible: async () => posted,
    innerText: async () => 'Xin chào reply',
  };
  const page: BrowserPage = {
    url: () => 'https://www.tiktok.com/@creator/video/1234567890123456789',
    title: async () => 'TikTok',
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    locator: (selector: string) => {
      if (selector.includes('contenteditable') || selector.includes('data-e2e="comment-reply-text"')) return replyEditor;
      if (selector.includes('comment-reply') || selector.includes('aria-label*="Reply"') || selector.includes('has-text("Reply")')) return replyButton;
      if (selector.includes('comment-icon')) return opener;
      if (selector.includes('comment-list') || selector.includes('comment-container') || selector.includes('comment-panel') || selector.includes('comment-input')) return drawer;
      if (selector.includes('data-placeholder') || selector.includes('placeholder*="Add a reply"') || selector.includes('placeholder*="reply"') || selector.includes('aria-label*="Add a reply"') || selector.includes('aria-label*="reply"')) return replyEditor;
      if (selector.includes('comment-text') || selector.includes('comment-content') || selector.includes('comment-level')) return postedComment;
      return { count: async () => 0 };
    },
  };

  const result = await replyTikTokComments(
    { ...session(page), beforeExternalAction: async () => undefined },
    {
      videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'],
      text: 'Xin chào reply',
      mediaAssetIds: [],
      maxReplies: 1,
    },
  );

  assert.equal(openerClicks, 1);
  assert.equal(replyText, 'Xin chào reply');
  assert.equal(posted, true);
  assert.equal(result.sent, 1);
  assert.equal(result.reason, undefined);
});

test('TikTok reply resolves the real DraftEditor contenteditable behind the Add a reply placeholder', async () => {
  let commentsOpen = false;
  let replyOpened = false;
  let draftEditorMarked = false;
  let replyText = '';
  let posted = false;
  const replyButton = {
    count: async () => commentsOpen ? 1 : 0,
    nth: () => replyButton,
    isVisible: async () => commentsOpen,
    click: async () => { replyOpened = true; },
  };
  const opener = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { commentsOpen = true; },
  };
  const drawer = {
    count: async () => commentsOpen ? 1 : 0,
    isVisible: async () => commentsOpen,
  };
  const draftEditor = {
    count: async () => replyOpened && draftEditorMarked ? 1 : 0,
    nth: () => draftEditor,
    isVisible: async () => replyOpened && draftEditorMarked,
    click: async () => undefined,
    fill: async (value: string) => { replyText = value; },
    inputValue: async () => replyText,
    press: async (key: string) => { if (key === 'Enter') posted = true; },
  };
  const postedComment = {
    count: async () => posted ? 1 : 0,
    nth: () => postedComment,
    isVisible: async () => posted,
    innerText: async () => 'Draft reply',
  };
  const page = {
    url: () => 'https://www.tiktok.com/@creator/video/1234567890123456789',
    title: async () => 'TikTok',
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async <T, A = unknown>(pageFunction: ((arg?: A) => T) | string, arg?: A) => {
      if (arg !== undefined) return false as T;
      if (replyOpened && typeof pageFunction === 'function' && pageFunction.toString().includes('DraftEditor-root')) {
        draftEditorMarked = true;
        return true as T;
      }
      return false as T;
    },
    locator: (selector: string) => {
      if (selector.includes('contenteditable') || selector.includes('data-e2e="comment-reply-text"')) return draftEditor;
      if (selector === '[data-socio-active-reply-editor="true"]') return draftEditor;
      if (selector.includes('comment-reply') || selector.includes('aria-label*="Reply"') || selector.includes('has-text("Reply")')) return replyButton;
      if (selector.includes('comment-icon')) return opener;
      if (selector.includes('comment-list') || selector.includes('comment-container') || selector.includes('comment-panel') || selector.includes('comment-input')) return drawer;
      if (selector.includes('comment-text') || selector.includes('comment-content') || selector.includes('comment-level')) return postedComment;
      return { count: async () => 0 };
    },
  } as unknown as BrowserPage;

  const result = await replyTikTokComments(
    { ...session(page), beforeExternalAction: async () => undefined },
    {
      videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'],
      text: 'Draft reply',
      mediaAssetIds: [],
      maxReplies: 1,
    },
  );

  assert.equal(draftEditorMarked, true);
  assert.equal(replyText, 'Draft reply');
  assert.equal(posted, true);
  assert.equal(result.sent, 1);
});

test('TikTok reply keeps each click bound to its own in-viewport editor without scrolling between visible rows', async () => {
  let commentsOpen = false;
  let activeEditor = -1;
  let postedCount = 0;
  let scrollCount = 0;
  const buttonClicks: number[] = [];
  const editorFills: number[] = [];
  const editorValues = ['', ''];

  const makeReplyButton = (index: number) => ({
    count: async () => commentsOpen ? 2 : 0,
    nth: (next: number) => makeReplyButton(next),
    isVisible: async () => commentsOpen,
    click: async () => { activeEditor = index; buttonClicks.push(index); },
  });
  const replyButtons = makeReplyButton(0);
  const opener = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { commentsOpen = true; },
  };
  const drawer = {
    count: async () => commentsOpen ? 1 : 0,
    isVisible: async () => commentsOpen,
  };
  const makeReplyEditor = (index: number) => ({
    count: async () => 2,
    nth: (next: number) => makeReplyEditor(next),
    // TikTok can keep the old editor visible in the DOM after it is clipped
    // out of the scrollable drawer. Only the editor opened by the latest
    // Reply click intersects the real viewport.
    isVisible: async () => true,
    evaluate: async () => index === activeEditor,
    click: async () => undefined,
    fill: async (value: string) => {
      editorValues[index] = value;
      editorFills.push(index);
    },
    inputValue: async () => editorValues[index],
    press: async (key: string) => {
      if (key === 'Enter' && index === activeEditor) {
        postedCount += 1;
        activeEditor = -1;
      }
    },
  });
  const replyEditors = makeReplyEditor(0);
  const postedComment = {
    count: async () => postedCount,
    nth: () => postedComment,
    isVisible: async () => postedCount > 0,
    innerText: async () => 'Xin chào reply',
  };
  const page = {
    url: () => 'https://www.tiktok.com/@creator/video/1234567890123456789',
    title: async () => 'TikTok',
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async <T, A = unknown>(pageFunction: ((arg?: A) => T) | string, arg?: A) => {
      if (arg !== undefined) return false as T;
      if (typeof pageFunction === 'function' && pageFunction.toString().includes('scrollBy')) scrollCount += 1;
      return false as T;
    },
    locator: (selector: string) => {
      if (selector.includes('contenteditable')
        || selector.includes('data-placeholder')
        || selector.includes('placeholder*="Add a reply"')
        || selector.includes('placeholder*="reply"')
        || selector.includes('aria-label*="Add a reply"')
        || selector.includes('aria-label*="reply"')) return replyEditors;
      if (selector.includes('comment-reply')
        || selector.includes('data-e2e*="reply" i][data-e2e*="comment"')
        || selector.includes('aria-label*="Reply"')
        || selector.includes('has-text("Reply")')) return replyButtons;
      if (selector.includes('comment-icon')) return opener;
      if (selector.includes('comment-list') || selector.includes('comment-container') || selector.includes('comment-panel') || selector.includes('comment-input')) return drawer;
      if (selector.includes('comment-text') || selector.includes('comment-content') || selector.includes('comment-level')) return postedComment;
      return { count: async () => 0 };
    },
  } as unknown as BrowserPage;

  const result = await replyTikTokComments(
    { ...session(page), beforeExternalAction: async () => undefined },
    {
      videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'],
      text: 'Xin chào reply',
      mediaAssetIds: [],
      maxReplies: 2,
    },
  );

  assert.deepEqual(buttonClicks, [0, 1]);
  assert.deepEqual(editorFills, [0, 1]);
  assert.equal(scrollCount, 0);
  assert.equal(postedCount, 2);
  assert.equal(result.sent, 2);
});

test('TikTok reply scrolls the comment drawer to reach the next reply row', async () => {
  let commentsOpen = false;
  let replyOpened = false;
  let postedCount = 0;
  let scrollCount = 0;
  const replyButton = {
    count: async () => commentsOpen ? 1 : 0,
    nth: () => replyButton,
    isVisible: async () => commentsOpen,
    click: async () => { replyOpened = true; },
  };
  const opener = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { commentsOpen = true; },
  };
  const drawer = {
    count: async () => commentsOpen ? 1 : 0,
    isVisible: async () => commentsOpen,
  };
  const replyEditor = {
    count: async () => replyOpened ? 1 : 0,
    nth: () => replyEditor,
    isVisible: async () => replyOpened,
    click: async () => undefined,
    fill: async () => undefined,
    inputValue: async () => 'Xin chào reply',
    press: async (key: string) => { if (key === 'Enter') { postedCount += 1; replyOpened = false; } },
  };
  const postedComment = {
    count: async () => postedCount,
    nth: () => postedComment,
    isVisible: async () => postedCount > 0,
    innerText: async () => 'Xin chào reply',
  };
  const page = {
    url: () => 'https://www.tiktok.com/@creator/video/1234567890123456789',
    title: async () => 'TikTok',
    goto: async () => undefined,
    waitForTimeout: async () => undefined,
    evaluate: async <T, A = unknown>(_pageFunction: ((arg?: A) => T) | string, arg?: A) => {
      // CAPTCHA probes pass a selector argument; the no-argument call is the
      // comment-list scroll performed between the two replies.
      if (arg !== undefined) return false as T;
      if (typeof _pageFunction !== 'function' || !_pageFunction.toString().includes('scrollBy')) return false as T;
      scrollCount += 1;
      return (scrollCount === 1) as T;
    },
    locator: (selector: string) => {
      if (selector.includes('contenteditable') || selector.includes('data-e2e="comment-reply-text"')) return replyEditor;
      if (selector.includes('comment-reply') || selector.includes('aria-label*="Reply"') || selector.includes('has-text("Reply")')) return replyButton;
      if (selector.includes('comment-icon')) return opener;
      if (selector.includes('comment-list') || selector.includes('comment-container') || selector.includes('comment-panel') || selector.includes('comment-input')) return drawer;
      if (selector.includes('data-placeholder') || selector.includes('placeholder*="Add a reply"') || selector.includes('placeholder*="reply"') || selector.includes('aria-label*="Add a reply"') || selector.includes('aria-label*="reply"')) return replyEditor;
      if (selector.includes('comment-text') || selector.includes('comment-content') || selector.includes('comment-level')) return postedComment;
      return { count: async () => 0 };
    },
  } as unknown as BrowserPage;

  const result = await replyTikTokComments(
    { ...session(page), beforeExternalAction: async () => undefined },
    {
      videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'],
      text: 'Xin chào reply',
      mediaAssetIds: [],
      maxReplies: 2,
    },
  );

  assert.equal(scrollCount, 1);
  assert.equal(postedCount, 2);
  assert.equal(result.sent, 2);
  assert.equal(result.requested, 2);
  assert.equal(result.reason, undefined);
});

test('TikTok like-comments opens the comment drawer before resolving like controls', async () => {
  let currentUrl = 'about:blank';
  let commentsOpen = false;
  const active = [false, false];
  let clicked = 0;
  const makeLike = (index: number) => ({
    count: async () => commentsOpen ? 2 : 0,
    nth: (next: number) => makeLike(next),
    isVisible: async () => commentsOpen,
    getAttribute: async (name: string) => name === 'aria-pressed' ? (active[index] ? 'true' : 'false') : null,
    click: async () => { active[index] = true; clicked += 1; },
  });
  const opener = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { commentsOpen = true; },
  };
  const page: BrowserPage = {
    url: () => currentUrl,
    title: async () => 'TikTok',
    goto: async (url: string) => { currentUrl = url; },
    waitForTimeout: async () => undefined,
    locator: (selector: string) => {
      if (selector.includes('comment_like') || selector.includes('comment-like')) return makeLike(0);
      if (selector.includes('comment-icon')) return opener;
      if (selector.includes('comment-list') || selector.includes('comment-container') || selector.includes('comment-panel') || selector.includes('comment-input')) {
        return { count: async () => commentsOpen ? 1 : 0, isVisible: async () => commentsOpen };
      }
      return { count: async () => 0 };
    },
  };

  const result = await likeTikTokComments(
    { profileId: 'test-profile', page, beforeExternalAction: async () => undefined },
    { videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'], maxLikes: 2 },
  );

  assert.equal(commentsOpen, true);
  assert.equal(clicked, 2);
  assert.equal(result.requested, 2);
  assert.equal(result.liked, 2);
});

test('TikTok like keeps the configured target when the comment drawer is unavailable', async () => {
  const page: BrowserPage = {
    url: () => 'https://www.tiktok.com/@creator/video/1234567890123456789',
    title: async () => 'TikTok',
    goto: async () => undefined,
    locator: () => ({ count: async () => 0 }),
  };

  const result = await likeTikTokComments(
    session(page),
    { videoUrls: ['https://www.tiktok.com/@creator/video/1234567890123456789'], maxLikes: 2 },
  );

  assert.equal(result.requested, 2);
  assert.equal(result.liked, 0);
  assert.equal(result.reason, 'Không mở được danh sách comment TikTok');
  const entry = (result.report as { entries?: Array<{ status?: string; reason?: string }> }).entries?.[0];
  assert.equal(entry?.status, 'FAILED');
  assert.equal(entry?.reason, 'Không mở được danh sách comment TikTok');
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
