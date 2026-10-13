import {
  gotoPlatformPage,
  type BrowserPage,
  type PlatformSession,
} from '@socio/platform-core';

export interface TikTokVideoMetadata {
  videoUrl: string;
  videoId?: string;
  username?: string;
  description?: string;
  thumbnailUrl?: string;
  likes?: number;
  views?: number;
  comments?: number;
  statsSource?: 'TIKTOK_VIDEO_STATS';
}

/**
 * Injectable search boundary used by local/staging product tests.
 *
 * The live implementation below remains the default. A test provider keeps
 * CAPTCHA and anti-bot behavior out of deterministic workflow tests without
 * changing the browser fingerprint or attempting to defeat a platform
 * challenge.
 */
export interface TikTokSearchProvider {
  search(query: string, maxVideos: number): Promise<TikTokVideoMetadata[]>;
}

export type TikTokFixtureScenario = 'success' | 'empty' | 'challenge';

export function createTikTokFixtureSearchProvider(
  scenario: TikTokFixtureScenario = 'success',
): TikTokSearchProvider {
  return {
    async search(query, maxVideos) {
      if (scenario === 'challenge') {
        throw new TikTokVerificationRequiredError(
          'Fixture TikTok đang mô phỏng trạng thái cần xác minh; không gửi request tới TikTok thật.',
        );
      }
      if (scenario === 'empty') return [];

      const boundedMaxVideos = Math.min(20, Math.max(0, Math.floor(maxVideos)));
      return Array.from({ length: boundedMaxVideos }, (_, index) => ({
        videoUrl: `https://www.tiktok.com/@socio_fixture/video/${(1_000_000_000_000_000_001n + BigInt(index)).toString()}`,
        videoId: (1_000_000_000_000_000_001n + BigInt(index)).toString(),
        username: '@socio_fixture',
        description: `[fixture] ${query}`,
        likes: 100 + index,
        views: 1_000 + index * 100,
        comments: 10 + index,
      }));
    },
  };
}

interface LocatorLike {
  count(): Promise<number>;
  first?: () => LocatorLike;
  nth?: (index: number) => LocatorLike;
  isVisible?: () => Promise<boolean>;
  textContent?: () => Promise<string | null>;
  fill?: (value: string) => Promise<void>;
  click?: () => Promise<void>;
  press?: (key: string) => Promise<void>;
  getAttribute?: (name: string) => Promise<string | null>;
  setInputFiles?: (files: Array<{ name: string; mimeType: string; buffer: Buffer }>) => Promise<void>;
}

interface EvaluatablePage extends BrowserPage {
  evaluate?: <T>(pageFunction: (() => T) | string) => Promise<T>;
  waitForTimeout?: (timeout: number) => Promise<void>;
  keyboard?: { press: (key: string) => Promise<void> };
}

const loginUrl = 'https://www.tiktok.com/login';
const tiktokHomeUrl = 'https://www.tiktok.com/';

export class TikTokVerificationRequiredError extends Error {
  constructor(message = 'TikTok đang yêu cầu xác minh anti-bot. Hãy hoàn tất xác minh thủ công trên browser rồi chạy lại campaign.') {
    super(message);
    this.name = 'TikTokVerificationRequiredError';
  }
}

export class TikTokSearchAutomationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TikTokSearchAutomationError';
  }
}

export async function searchTikTokVideos(
  session: PlatformSession,
  query: string,
  maxVideos: number,
): Promise<TikTokVideoMetadata[]> {
  const page = session.page as EvaluatablePage;
  let verificationSeenDuringNavigation = false;
  try {
    await openTikTokHomeFeed(page);
    verificationSeenDuringNavigation = await searchTikTokFromHome(page, query);
  } catch (error) {
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(error instanceof Error ? error.message : String(error))) {
      throw new TikTokVerificationRequiredError(
        'TikTok đã từ chối trang Search và có thể đang yêu cầu xác minh anti-bot. Hãy hoàn tất xác minh thủ công trên browser rồi chạy lại campaign.',
      );
    }
    throw error;
  }
  // Search results are hydrated asynchronously. Keep this pause short while
  // still giving the UI time to switch away from the home feed.
  await waitForTikTokUi(page, 650, 1_050);
  const initialState = await inspectTikTokSearchState(page);
  if (initialState.verificationRequired) {
    throw new TikTokVerificationRequiredError();
  }
  const videos = new Map<string, TikTokVideoMetadata>();
  let unchangedPasses = 0;

  // Search results are lazy-loaded. Keep scrolling bounded so a malformed page
  // cannot leave the worker in an endless loop.
  const maxScrollPasses = Math.min(10, Math.max(6, Math.ceil(maxVideos / 4)));
  for (let pass = 0; pass < maxScrollPasses && videos.size < maxVideos; pass += 1) {
    const batch = await extractVisibleVideos(page);
    const before = videos.size;
    for (const video of batch) {
      if (videos.size >= maxVideos) break;
      videos.set(video.videoUrl, video);
    }
    unchangedPasses = videos.size === before ? unchangedPasses + 1 : 0;
    if (unchangedPasses >= 2) break;
    if (videos.size >= maxVideos) break;
    const scrollState = await scrollSearchResults(page);
    await waitForTikTokUi(page);
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired) {
      throw new TikTokVerificationRequiredError();
    }
    if (!scrollState.moved && unchangedPasses > 0) break;
  }

  if (videos.size === 0) {
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired || verificationSeenDuringNavigation || !state.explicitEmpty) {
      throw new TikTokVerificationRequiredError(
        state.verificationRequired
          ? undefined
          : verificationSeenDuringNavigation
            ? 'TikTok đã hiển thị challenge/CAPTCHA trong lúc chuyển sang tab Videos; không ghi nhận kết quả rỗng là thành công. Hãy xử lý xác minh thủ công trên browser rồi chạy lại campaign.'
            : 'TikTok chưa trả dữ liệu search video. Có thể phiên tạm đang bị BDTuring yêu cầu xác minh; hãy xử lý xác minh thủ công trên browser rồi chạy lại campaign.',
      );
    }
  }

  return [...videos.values()].slice(0, maxVideos);
}

/**
 * Open TikTok's generic entry page, enter the For You feed through the UI,
 * then watch a few random videos before starting a search. This keeps the
 * search flow aligned with the browser's normal navigation instead of
 * jumping directly to /foryou or /search/video.
 */
async function openTikTokHomeFeed(page: EvaluatablePage): Promise<void> {
  // Search is intentionally anonymous: never fall back to TikTok's login
  // route and never reuse a persisted profile when the home route is blocked.
  if (page.url() !== tiktokHomeUrl) await gotoPlatformPage(page, tiktokHomeUrl);
  await waitForTikTokUi(page);

  // TikTok may show a first-visit guide with a full-screen blur. It can leave
  // the navigation in the DOM while preventing the real For You target from
  // receiving pointer events, so dismiss it before resolving the nav item.
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);

  let forYouLabel: LocatorLike | undefined;
  // A cold anonymous TikTok profile can spend several seconds rendering the
  // feed skeleton before the side navigation is mounted. Poll the actual nav
  // item instead of failing after the short human-like pauses used between
  // interactions. This keeps scroll/search pauses short while allowing the
  // initial page load to finish.
  for (let attempt = 0; !forYouLabel && attempt < 20; attempt += 1) {
    await dismissTikTokBlockingPopup(page);
    forYouLabel = await firstTikTokForYouLabel(page);
    if (!forYouLabel) await waitForTikTokUi(page, 450, 850);
  }
  if (!forYouLabel?.click) throw new Error('Không tìm thấy nút For You trên trang chủ TikTok');

  let clickedForYou = false;
  for (let attempt = 0; !clickedForYou && attempt < 3; attempt += 1) {
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    const target = forYouLabel;
    if (!target?.click) {
      if (attempt === 2) throw new Error('Không thể click nút For You trên trang chủ TikTok');
      forYouLabel = await firstTikTokForYouLabel(page);
      continue;
    }
    try {
      await target.click();
      clickedForYou = true;
    } catch (error) {
      // The first-visit guide can mount between resolving the nav item and
      // Playwright's pointer check. In that case the element is visible, but
      // #tux-web-canary-1-modal-overlay intercepts the click. Give the guide
      // one more chance to close before resolving the target again.
      await waitForTikTokUi(page, 180, 360);
      await dismissTikTokBlockingPopup(page);
      forYouLabel = await firstTikTokForYouLabel(page);
      if (!forYouLabel?.click) {
        if (attempt === 2) throw error;
        continue;
      }
      if (attempt === 2 && await clickTikTokForYouInDom(page)) clickedForYou = true;
    }
  }
  if (!clickedForYou) throw new Error('Không thể click nút For You trên trang chủ TikTok');
  await waitForTikTokUi(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);

  const videoPasses = randomInteger(2, 4);
  for (let pass = 0; pass < videoPasses; pass += 1) {
    await dismissTikTokBlockingPopup(page);
    await scrollTikTokFeed(page);
    await waitForTikTokUi(page);
    await dismissTikTokBlockingPopup(page);
  }
}

async function searchTikTokFromHome(page: EvaluatablePage, query: string): Promise<boolean> {
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  let searchInput = await firstVisibleLocator(page, [
    'input[data-e2e="search-user-input"]',
    'input[aria-label*="Search"]',
    'input[placeholder*="Search"]',
    'input[placeholder*="Tìm kiếm"]',
    'input[type="search"]',
  ]);

  // On some responsive layouts the search field is opened by the header icon.
  // Click that control first, then resolve the input again after the panel has
  // had time to mount.
  for (let attempt = 0; !searchInput && attempt < 2; attempt += 1) {
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    const searchTriggerSelectors = [
      'button[data-e2e="nav-search"]',
      '[data-e2e*="search-icon"]',
      'button[aria-label*="Search"]',
      '[role="searchbox"]',
    ];
    let searchTrigger = await firstVisibleLocator(page, searchTriggerSelectors);
    if (!searchTrigger?.click) break;
    try {
      await searchTrigger.click();
    } catch {
      // A login/onboarding dialog can mount between resolving the header
      // button and the pointer check. Close it, then resolve the target again
      // instead of retrying a stale locator behind the overlay.
      await dismissTikTokCloseablePopup(page);
      await waitForTikTokUi(page, 120, 280);
      searchTrigger = await firstVisibleLocator(page, searchTriggerSelectors);
      if (!searchTrigger?.click) throw new TikTokSearchAutomationError('Không tìm thấy nút mở search TikTok sau khi đóng popup');
      await searchTrigger.click();
    }
    await waitForTikTokUi(page);
    searchInput = await firstVisibleLocator(page, [
      'input[data-e2e="search-user-input"]',
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      'input[placeholder*="Tìm kiếm"]',
      'input[type="search"]',
    ]);
  }

  if (!searchInput?.fill) throw new Error('Không tìm thấy ô search TikTok trên trang chủ');
  await dismissTikTokBlockingPopup(page);
  await searchInput.click?.();
  await waitForTikTokUi(page, 250, 550);
  await searchInput.fill(query);
  await waitForTikTokUi(page, 250, 550);

  if (searchInput.press) {
    await searchInput.press('Enter');
  } else {
    const submit = await firstLocator(page, [
      'button[data-e2e*="search"]',
      'button[aria-label*="Search"]',
    ]);
    if (!submit?.click) throw new Error('Không tìm thấy nút submit search TikTok');
    await submit.click();
  }
  await waitForTikTokUi(page, 500, 900);
  // TikTok first renders the default Top result surface.  On a cold
  // anonymous profile the Videos tab can be visible before Top has hydrated;
  // switching immediately can leave the page with an empty result surface or
  // mount the login/captcha dialog on top of the tab.  Let Top settle first,
  // closing only an optional closeable dialog when it appears.
  const topVerificationSeen = await waitForTikTokTopResults(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  await clickTikTokVideoTab(page, query);
  const videoVerificationSeen = await waitForTikTokVideoResults(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  return topVerificationSeen || videoVerificationSeen;
}

async function waitForTikTokTopResults(page: EvaluatablePage): Promise<boolean> {
  const deadline = Date.now() + 8_000;
  const canWait = Boolean(page.waitForTimeout);
  let verificationSeen = false;
  while (Date.now() < deadline) {
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired) {
      verificationSeen = true;
      // A closeable login/captcha dialog is allowed to disappear.  If the
      // verification surface remains after that, fail closed instead of
      // pretending that an empty result is a successful search.
      await waitForTikTokUi(page, 180, 360);
      const afterClose = await inspectTikTokSearchState(page);
      if (afterClose.verificationRequired) throw new TikTokVerificationRequiredError();
    }
    const surface = await inspectTikTokResultSurface(page);
    if (surface.explicitEmpty || surface.visibleVideoLinks > 0) return verificationSeen;
    if (!canWait) return verificationSeen;
    await waitForTikTokUi(page, 350, 650);
  }
  return verificationSeen;
}

async function waitForTikTokVideoResults(page: EvaluatablePage): Promise<boolean> {
  const deadline = Date.now() + 6_000;
  const canWait = Boolean(page.waitForTimeout);
  let verificationSeen = false;
  while (Date.now() < deadline) {
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired) {
      verificationSeen = true;
      await waitForTikTokUi(page, 180, 360);
      const afterClose = await inspectTikTokSearchState(page);
      if (afterClose.verificationRequired) throw new TikTokVerificationRequiredError();
    }
    const surface = await inspectTikTokResultSurface(page);
    if (surface.explicitEmpty || surface.visibleVideoLinks > 0) return verificationSeen;
    if (!canWait) return verificationSeen;
    await waitForTikTokUi(page, 350, 650);
  }
  return verificationSeen;
}

async function inspectTikTokResultSurface(page: EvaluatablePage): Promise<{ visibleVideoLinks: number; explicitEmpty: boolean }> {
  if (!page.evaluate) return { visibleVideoLinks: 0, explicitEmpty: false };
  try {
    const result = await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && element.getClientRects().length > 0;
      };
      const bodyText = document.body?.innerText ?? '';
      const explicitEmpty = /no results|no videos|didn't find|nothing found|không tìm thấy|không có kết quả|không có video/i.test(bodyText);
      const visibleVideoLinks = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]')]
        .filter(visible)
        .length;
      return { visibleVideoLinks, explicitEmpty };
    });
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const surface = result as { visibleVideoLinks?: unknown; explicitEmpty?: unknown };
      return {
        visibleVideoLinks: typeof surface.visibleVideoLinks === 'number' ? surface.visibleVideoLinks : 0,
        explicitEmpty: surface.explicitEmpty === true,
      };
    }
  } catch {
    // The caller still has the bounded wait and the later extraction/state
    // checks as a fallback for lightweight BrowserPage implementations.
  }
  return { visibleVideoLinks: 0, explicitEmpty: false };
}

/** Switch Search to the Video/Videos result type before collecting cards. */
async function clickTikTokVideoTab(page: EvaluatablePage, query: string): Promise<void> {
  const tabSelectors = [
    'a[href*="/search/video"]',
    'button[data-e2e*="search-video"]',
    '[data-e2e*="search-video"]',
    '[role="tab"]',
    '[role="link"]',
    'button',
    'a',
  ];
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  const tab = await firstTikTokVideoTabForQuery(page, tabSelectors, query);
  if (tab?.click) {
    try {
      await tab.click();
      await waitForTikTokUi(page, 250, 500);
      if (isTikTokVideoSearchForQuery(page.url(), query)) return;
    } catch {
      await dismissTikTokCloseablePopup(page);
      await dismissTikTokBlockingPopup(page);
      const refreshed = await firstTikTokVideoTabForQuery(page, tabSelectors, query);
      if (refreshed?.click) {
        await refreshed.click();
        await waitForTikTokUi(page, 250, 500);
        if (isTikTokVideoSearchForQuery(page.url(), query)) return;
      }
    }
  }

  // Some TikTok builds navigate directly to /search/video after Enter.  Do
  // not accept a stale shared-profile URL for a different query.
  if (isTikTokVideoSearchForQuery(page.url(), query)) return;
  throw new TikTokSearchAutomationError('Không tìm thấy tab Video trên trang kết quả TikTok');
}

async function firstTikTokVideoTabForQuery(
  page: EvaluatablePage,
  selectors: string[],
  query: string,
): Promise<LocatorLike | undefined> {
  const expectedQuery = normalizeSearchQuery(query);
  for (const selector of selectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth ? locator.nth(index) : locator;
      if (!await isLocatorVisible(candidate)) continue;
      const text = normalizeTikTokUiText(await candidate.textContent?.());
      const ariaLabel = normalizeTikTokUiText(await candidate.getAttribute?.('aria-label'));
      if (text !== 'videos' && text !== 'video' && ariaLabel !== 'videos' && ariaLabel !== 'video') continue;
      const href = await candidate.getAttribute?.('href');
      if (href) {
        let url: URL;
        try { url = new URL(href, page.url()); } catch { continue; }
        if (!/\/search\/video(?:[/?]|$)/i.test(url.pathname)) continue;
        const candidateQuery = url.searchParams.get('q');
        if (candidateQuery && normalizeSearchQuery(candidateQuery) !== expectedQuery) continue;
      }
      return candidate;
    }
  }
  return undefined;
}

function normalizeSearchQuery(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function isTikTokVideoSearchForQuery(urlValue: string, query: string): boolean {
  try {
    const url = new URL(urlValue);
    return /\/search\/video(?:[/?]|$)/i.test(url.pathname)
      && normalizeSearchQuery(url.searchParams.get('q')) === normalizeSearchQuery(query);
  } catch {
    return false;
  }
}

async function firstTikTokForYouLabel(page: BrowserPage): Promise<LocatorLike | undefined> {
  const directForYou = await firstVisibleLocator(page, [
    'button[aria-label="For You"]',
    'a[aria-label="For You"]',
    '[role="tab"][aria-label="For You"]',
    '[role="link"][aria-label="For You"]',
    '[data-e2e="nav-for-you"]',
    '[data-e2e="nav-foryou"]',
    '[data-e2e="nav-home"]',
    '[data-e2e="nav-home-feed"]',
    '[data-e2e*="for-you"]',
    '[data-e2e*="for_you"]',
  ]);
  if (directForYou) return directForYou;

  // At narrow widths TikTok collapses the label to an icon. In that layout
  // the accessible text may disappear too, but the navigation test id stays
  // attached to the home/For You control.
  const iconNavigation = await firstVisibleLocator(page, [
    '[data-testid="nav-home"]',
    '[data-testid="nav-foryou"]',
    '[data-testid="nav-for-you"]',
    '[data-e2e*="nav-home"]',
    '[data-e2e*="nav-foryou"]',
    '[data-e2e*="nav-for-you"]',
  ]);
  if (iconNavigation) return iconNavigation;

  const labels = await findLocators(page, ['div.TUXButton-label', '[class~="TUXButton-label"]']);
  for (const label of labels) {
    const text = normalizeTikTokUiText(await label.textContent?.());
    if (text !== 'for you') continue;
    if (await isLocatorVisible(label)) return label;

    // TikTok's compact side navigation keeps the text label in the DOM but
    // visually collapses it. The parent nav button remains the real click
    // target, so resolve that visible button after identifying the label.
    const visibleButton = await firstVisibleLocator(page, [
      'button[aria-label="For You"]',
      'a[aria-label="For You"]',
      '[role="tab"][aria-label="For You"]',
      'button:has(div.TUXButton-label)',
    ]);
    if (visibleButton) return visibleButton;
  }

  // Some TikTok builds render the nav item as a plain link and omit the
  // TUXButton-label class entirely. Match the visible accessible text as a
  // final DOM-shape-independent fallback.
  const visibleTextTarget = await firstVisibleLocatorWithText(page, [
    'a[href="/"]',
    'a',
    'button',
    '[role="link"]',
    '[role="tab"]',
  ], 'for you');
  if (visibleTextTarget) return visibleTextTarget;

  // A few Playwright-compatible test/embedded page implementations do not
  // expose textContent on locators. The class is specific enough to use the
  // first label as a safe fallback in that case.
  return labels.length > 0 && labels.every((label) => !label.textContent) ? labels[0] : undefined;
}

async function firstVisibleLocator(page: BrowserPage, selectors: string[]): Promise<LocatorLike | undefined> {
  // Do not stop after the first selector that has hidden matches. Responsive
  // TikTok layouts often keep a hidden desktop control while rendering the
  // clickable mobile/compact control under a later selector.
  for (const selector of selectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth ? locator.nth(index) : locator;
      if (await isLocatorVisible(candidate)) return candidate;
    }
  }
  return undefined;
}

async function firstVisibleLocatorWithText(
  page: BrowserPage,
  selectors: string[],
  expectedText: string,
): Promise<LocatorLike | undefined> {
  const expected = normalizeTikTokUiText(expectedText);
  for (const selector of selectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth ? locator.nth(index) : locator;
      if (!await isLocatorVisible(candidate)) continue;
      const text = normalizeTikTokUiText(await candidate.textContent?.());
      const ariaLabel = normalizeTikTokUiText(await candidate.getAttribute?.('aria-label'));
      if (text === expected || ariaLabel === expected) return candidate;
    }
  }
  return undefined;
}

async function dismissTikTokBlockingPopup(page: EvaluatablePage): Promise<void> {
  // The first-visit guide is currently labelled "Got it". Keep the selector
  // broad because TikTok has used both a regular button and a role=button
  // wrapper for the same control.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const gotIt = await firstVisibleLocatorWithText(page, [
      '#tux-web-canary-1-modal-overlay button',
      '#tux-web-canary-1-modal-overlay [role="button"]',
      '[data-testid*="modal"] button',
      'button',
      '[role="button"]',
      '[data-e2e*="got"]',
      '[aria-label*="Got it"]',
    ], 'got it');
    let dismissed = false;
    if (gotIt?.click) {
      try {
        await gotIt.click();
        dismissed = true;
      } catch {
        // The guide may be replacing its overlay at the same time as the
        // click. Fall through to the DOM-backed action below.
      }
    }
    if (!dismissed) dismissed = await clickTikTokGuideButtonInDom(page);
    if (!dismissed && !(await hasVisibleTikTokBlockingOverlay(page))) return;
    await waitForTikTokUi(page, 120, 260);
    if (!(await hasVisibleTikTokBlockingOverlay(page))) return;
  }
}

/** Close optional login/captcha dialogs without logging in or solving a challenge. */
async function dismissTikTokCloseablePopup(page: EvaluatablePage): Promise<void> {
  const closeSelectors = [
    '#tux-portal-container [role="dialog"] [class*="CloseButtonWrapper"]',
    '#tux-portal-container [role="dialog"] button[class*="ButtonHeaderIcon"]',
    '#tux-portal-container [role="dialog"] button[aria-label*="close" i]',
    '#tux-portal-container button[class*="ButtonHeaderIcon"]',
    '#tux-portal-container button[aria-label*="close" i]',
    '[data-floating-ui-portal] button[class*="ButtonHeaderIcon"]',
    '[role="dialog"] button[class*="ButtonHeaderIcon"]',
    '[role="dialog"] [class*="CloseButtonWrapper"]',
    '[role="dialog"] button[aria-label*="close" i]',
    '[role="dialog"] [data-e2e*="close"]',
    '[role="dialog"] [data-testid*="close"]',
    '[data-floating-ui-portal] button[aria-label*="close" i]',
    '[data-testid*="modal"] button[aria-label*="close" i]',
    '[data-e2e*="modal"] button[aria-label*="close" i]',
    'button[aria-label="Close"]',
    'button[aria-label*="close" i]',
    '[data-e2e*="close"]',
    '[data-testid*="close"]',
  ];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // TikTok leaves exiting dialogs mounted for a short time. Search from
    // the last visible match so an older dialog cannot consume the click
    // while the topmost onboarding/login/captcha dialog remains open.
    const close = await lastVisibleLocator(page, closeSelectors);
    let dismissed = false;
    if (close?.click) {
      try {
        await close.click();
        dismissed = true;
      } catch {
        // A popup can be replaced while the close button is being clicked.
      }
    }
    if (!dismissed) dismissed = await clickTikTokCloseButtonInDom(page);
    if (!dismissed && await hasVisibleTikTokCloseablePopup(page) && page.keyboard?.press) {
      try {
        await page.keyboard.press('Escape');
        dismissed = true;
      } catch {
        // Keep the dialog state intact if keyboard input is unavailable.
      }
    }
    if (!dismissed) return;
    await waitForTikTokUi(page, 100, 240);
    if (!(await hasVisibleTikTokCloseablePopup(page))) return;
  }
}

async function clickTikTokCloseButtonInDom(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    const result = await page.evaluate(() => {
      const normalize = (value: string | null | undefined): string => (value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase();
      const roots = [...document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [data-floating-ui-portal], [data-testid*="modal"], [data-e2e*="modal"], iframe[src*="captcha"]',
      )];
      const visible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && element.getClientRects().length > 0;
      };
      for (const root of roots.reverse()) {
        if (!visible(root)) continue;
        const candidates = [...root.querySelectorAll<HTMLElement>(
          'button, [role="button"], [data-e2e*="close"], [data-testid*="close"], [class*="CloseButtonWrapper"]',
        )];
        const target = candidates.reverse().find((element) => {
          if (!visible(element)) return false;
          const className = typeof element.className === 'string' ? element.className : '';
          if (/ButtonHeaderIcon|CloseButtonWrapper/i.test(className)) return true;
          const label = normalize(element.getAttribute('aria-label')) || normalize(element.textContent);
          return label === 'close' || label === 'dismiss' || label === 'cancel' || label === 'x';
        });
        if (target) {
          target.click();
          return true;
        }
      }
      return false;
    });
    return result === true;
  } catch {
    return false;
  }
}

async function hasVisibleTikTokCloseablePopup(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    const result = await page.evaluate(() => {
      const roots = [...document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [data-floating-ui-portal], [data-testid*="modal"], [data-e2e*="modal"], iframe[src*="captcha"]',
      )];
      const overlay = document.querySelector<HTMLElement>('#tux-web-canary-1-modal-overlay');
      if (overlay) {
        const overlayStyle = window.getComputedStyle(overlay);
        const overlayVisible = overlayStyle.display !== 'none'
          && overlayStyle.visibility !== 'hidden'
          && overlay.getClientRects().length > 0;
        const portal = overlay.closest<HTMLElement>('[data-floating-ui-portal]') ?? overlay.parentElement;
        if (overlayVisible && portal?.querySelector('button, [role="button"]')) return true;
      }
      return roots.some((root) => {
        const style = window.getComputedStyle(root);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && root.getClientRects().length > 0
        && Boolean(root.querySelector('button, [role="button"], [data-e2e*="close"], [data-testid*="close"], [class*="CloseButtonWrapper"]'));
      });
    });
    return result === true;
  } catch {
    return false;
  }
}

async function lastVisibleLocator(page: BrowserPage, selectors: string[]): Promise<LocatorLike | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    const count = await locator.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth ? locator.nth(index) : locator;
      if (await isLocatorVisible(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Use the guide's own action as a last-resort fallback when Playwright's
 * locator cannot see the button correctly (TikTok sometimes marks the modal
 * subtree aria-hidden while it is still painted and intercepting pointers).
 */
async function clickTikTokGuideButtonInDom(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    const result = await page.evaluate(() => {
      const normalize = (value: string | null | undefined): string => (value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase();
      const overlay = document.querySelector<HTMLElement>('#tux-web-canary-1-modal-overlay');
      if (!overlay) return false;
      const root = overlay.parentElement ?? document;
      const candidates = [...root.querySelectorAll<HTMLElement>('button, [role="button"], a, input[type="button"]')];
      const target = candidates.find((element) => {
        const label = normalize(element.textContent) || normalize(element.getAttribute('aria-label'));
        return label === 'got it' || label === 'dismiss' || label === 'close guide' || label === 'close tutorial';
      });
      if (!target) return false;
      target.click();
      return true;
    });
    return result === true;
  } catch {
    return false;
  }
}

async function hasVisibleTikTokBlockingOverlay(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    const result = await page.evaluate(() => {
      const overlay = document.querySelector<HTMLElement>('#tux-web-canary-1-modal-overlay');
      if (!overlay) return false;
      const style = window.getComputedStyle(overlay);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.pointerEvents !== 'none'
        && overlay.getClientRects().length > 0;
    });
    return result === true;
  } catch {
    return false;
  }
}

/** Last-resort navigation click after the blocking guide has disappeared. */
async function clickTikTokForYouInDom(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate || await hasVisibleTikTokBlockingOverlay(page)) return false;
  try {
    const result = await page.evaluate(() => {
      const normalize = (value: string | null | undefined): string => (value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase();
      const candidates = [...document.querySelectorAll<HTMLElement>(
        'button[aria-label="For You"], a[aria-label="For You"], [role="tab"][aria-label="For You"], [role="link"][aria-label="For You"], [data-e2e="nav-for-you"], [data-e2e="nav-foryou"], button, a',
      )];
      const target = candidates.find((element) => {
        const label = normalize(element.getAttribute('aria-label')) || normalize(element.textContent);
        const style = window.getComputedStyle(element);
        return label === 'for you'
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && element.getClientRects().length > 0;
      });
      if (!target) return false;
      target.click();
      return true;
    });
    return result === true;
  } catch {
    return false;
  }
}

function normalizeTikTokUiText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?]+$/g, '');
}

async function isLocatorVisible(locator: LocatorLike): Promise<boolean> {
  if (!locator.isVisible) return true;
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function scrollTikTokFeed(page: EvaluatablePage): Promise<void> {
  await scrollSearchResults(page);
}

async function waitForTikTokUi(page: EvaluatablePage, minMs = 350, maxMs = 750): Promise<void> {
  await page.waitForTimeout?.(randomInteger(minMs, maxMs));
}

function randomInteger(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function inspectTikTokSearchState(page: EvaluatablePage): Promise<{ verificationRequired: boolean; explicitEmpty: boolean }> {
  if (!page.evaluate) return { verificationRequired: false, explicitEmpty: false };
  try {
    const snapshot = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? '';
      const challengeNode = [...document.querySelectorAll<HTMLElement>(
        'iframe[src*="captcha"], [data-e2e*="captcha"], [data-e2e*="verify"], [class*="captcha"], [class*="verify"], [class*="bdturing"], [id*="captcha"], [id*="verify"], [id*="bdturing"]',
      )].some((element) => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
      return { bodyText, challengeNode };
    });
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.bodyText !== 'string') {
      return { verificationRequired: false, explicitEmpty: false };
    }
    const bodyText = snapshot.bodyText.toLowerCase();
    const signalText = snapshot.bodyText.toLowerCase();
    const verificationRequired = snapshot.challengeNode || /bdturing|bdturing-verify|whirl|verify to continue|security verification|captcha|unusual traffic|too many requests|anti.?bot|robot|xác minh|bất thường/.test(signalText);
    const explicitEmpty = /no results|no videos|didn't find|nothing found|không tìm thấy|không có kết quả|không có video/.test(bodyText);
    return { verificationRequired, explicitEmpty };
  } catch {
    // A page implementation without evaluate support cannot prove that an
    // empty result is a legitimate empty search, so the caller fails closed.
    return { verificationRequired: false, explicitEmpty: false };
  }
}

export async function autoCommentTikTokHome(
  session: PlatformSession,
  input: {
    text: string;
    mediaAssetIds: string[];
    maxVideos: number;
    minLikes: number;
    maxLikes?: number;
    intervalSeconds: number;
  },
): Promise<Record<string, unknown>> {
  const page = session.page as EvaluatablePage;
  await gotoPlatformPage(page, 'https://www.tiktok.com/foryou', loginUrl);
  const visible = new Map<string, TikTokVideoMetadata>();
  for (let pass = 0; pass < 10 && visible.size < input.maxVideos * 3; pass += 1) {
    for (const video of await extractVisibleVideos(page)) visible.set(video.videoUrl, video);
    if (visible.size >= input.maxVideos * 3) break;
    await scrollSearchResults(page);
    await page.waitForTimeout?.(750);
  }
  const candidates = [...visible.values()].filter((video) => {
    if (video.likes == null || video.likes < input.minLikes) return false;
    return input.maxLikes == null || video.likes <= input.maxLikes;
  }).slice(0, input.maxVideos);

  const result = await commentTikTokVideos(session, {
    videoUrls: candidates.map((video) => video.videoUrl),
    text: input.text,
    mediaAssetIds: input.mediaAssetIds,
    maxVideos: candidates.length,
    intervalSeconds: input.intervalSeconds,
  });
  return { ...result, candidates: candidates.length };
}

export async function commentTikTokVideos(
  session: PlatformSession,
  input: { videoUrls: string[]; text: string; mediaAssetIds: string[]; maxVideos: number; intervalSeconds?: number },
): Promise<Record<string, unknown>> {
  const videos = input.videoUrls.slice(0, input.maxVideos);
  let sent = 0;
  const failures: Array<{ videoUrl: string; reason: string }> = [];

  for (const [index, videoUrl] of videos.entries()) {
    try {
      await gotoPlatformPage(session.page, videoUrl, loginUrl);
      await sendComment(session, input.text, input.mediaAssetIds);
      sent += 1;
      if (input.intervalSeconds && index < videos.length - 1) {
        await (session.page as EvaluatablePage).waitForTimeout?.(input.intervalSeconds * 1_000);
      }
    } catch (error) {
      failures.push({ videoUrl, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { requested: videos.length, sent, failures };
}

export async function replyTikTokComments(
  session: PlatformSession,
  input: { videoUrls: string[]; text: string; mediaAssetIds: string[]; maxReplies: number; intervalSeconds?: number },
): Promise<Record<string, unknown>> {
  const page = session.page as EvaluatablePage;
  let requested = 0;
  let sent = 0;
  const failures: string[] = [];
  for (let videoIndex = 0; videoIndex < input.videoUrls.length; videoIndex += 1) {
    const videoUrl = input.videoUrls[videoIndex]!;
    try {
      await gotoPlatformPage(session.page, videoUrl, loginUrl);
      const replyButtons = await findLocators(page, [
        '[data-e2e*="comment-reply"]',
        'button[aria-label*="Reply"]',
        'button:has-text("Reply")',
      ]);
      const count = Math.min(replyButtons.length, input.maxReplies);
      requested += count;
      for (let index = 0; index < count; index += 1) {
        try {
          await beginExternalAction(session);
          await replyButtons[index]!.click?.();
          const editor = await firstLocator(page, ['[contenteditable="true"]', '[data-e2e="comment-input"]']);
          if (!editor?.fill) throw new Error('Không tìm thấy ô nhập reply TikTok');
          await editor.fill(input.text);
          await submitComment(page, input.mediaAssetIds, session);
          sent += 1;
          if (input.intervalSeconds && (index < count - 1 || videoIndex < input.videoUrls.length - 1)) await page.waitForTimeout?.(input.intervalSeconds * 1_000);
        } catch (error) {
          failures.push(`${videoUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      failures.push(`${videoUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { requested, sent, videos: input.videoUrls.length, failures };
}

export async function likeTikTokComments(
  session: PlatformSession,
  input: { videoUrls: string[]; maxLikes: number; intervalSeconds?: number },
): Promise<Record<string, unknown>> {
  const page = session.page as EvaluatablePage;
  let requested = 0;
  let liked = 0;
  const failures: string[] = [];
  for (let videoIndex = 0; videoIndex < input.videoUrls.length; videoIndex += 1) {
    const videoUrl = input.videoUrls[videoIndex]!;
    try {
      await gotoPlatformPage(session.page, videoUrl, loginUrl);
      const likeButtons = await findLocators(page, [
        '[data-e2e*="comment-like"]',
        'button[aria-label*="Like"]',
      ]);
      const count = Math.min(likeButtons.length, input.maxLikes);
      requested += count;
      for (let index = 0; index < count; index += 1) {
        try {
          await beginExternalAction(session);
          await likeButtons[index]!.click?.();
          liked += 1;
          if (input.intervalSeconds && (index < count - 1 || videoIndex < input.videoUrls.length - 1)) await page.waitForTimeout?.(input.intervalSeconds * 1_000);
        } catch (error) {
          failures.push(`${videoUrl}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      failures.push(`${videoUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { requested, liked, videos: input.videoUrls.length, failures };
}

export async function messageTikTokFollowers(
  session: PlatformSession,
  input: { username: string; text: string; mediaAssetIds: string[]; maxFollowers: number; intervalSeconds?: number },
): Promise<Record<string, unknown>> {
  const page = session.page as EvaluatablePage;
  const username = input.username.replace(/^@/, '');
  await gotoPlatformPage(page, `https://www.tiktok.com/@${encodeURIComponent(username)}`, loginUrl);
  const followersButton = await firstLocator(page, [
    'a[href*="/followers"]',
    '[data-e2e*="followers"]',
    'button:has-text("Followers")',
  ]);
  if (!followersButton?.click) throw new Error('Không tìm thấy danh sách follower của kênh TikTok');
  await followersButton.click();
  await page.waitForTimeout?.(750);

  const followers = new Map<string, string>();
  let unchangedPasses = 0;
  for (let pass = 0; pass < 10 && followers.size < input.maxFollowers; pass += 1) {
    const before = followers.size;
    for (const follower of await extractVisibleFollowerProfiles(page)) {
      if (followers.size >= input.maxFollowers) break;
      if (session.accountUsername && normalizeTikTokUsername(session.accountUsername) === normalizeTikTokUsername(follower.username)) continue;
      followers.set(follower.username, follower.profileUrl);
    }
    unchangedPasses = followers.size === before ? unchangedPasses + 1 : 0;
    if (unchangedPasses >= 2 || followers.size >= input.maxFollowers) break;
    await scrollFollowerList(page);
    await page.waitForTimeout?.(750);
  }

  const targets = [...followers.entries()].slice(0, input.maxFollowers);
  let sent = 0;
  const failures: Array<{ username: string; reason: string }> = [];
  for (const [targetUsername, profileUrl] of targets) {
    try {
      await gotoPlatformPage(page, profileUrl, loginUrl);
      await page.waitForTimeout?.(500);
      const messageButton = await firstLocator(page, [
        '[data-e2e*="message"]',
        'button:has-text("Message")',
        'a[href*="/messages"]',
      ]);
      if (!messageButton?.click) throw new Error('Không tìm thấy nút nhắn tin cho follower');
      await messageButton.click();
      await page.waitForTimeout?.(500);
      await sendTikTokMessage(session, input.text, input.mediaAssetIds);
      sent += 1;
      if (input.intervalSeconds && targetUsername !== targets[targets.length - 1]?.[0]) {
        await page.waitForTimeout?.(input.intervalSeconds * 1_000);
      }
    } catch (error) {
      failures.push({ username: targetUsername, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    channelUsername: `@${username}`,
    discovered: followers.size,
    requested: targets.length,
    sent,
    failures,
  };
}

async function sendComment(session: PlatformSession, text: string, mediaAssetIds: string[]): Promise<void> {
  const page = session.page as EvaluatablePage;
  const editor = await firstLocator(page, ['[contenteditable="true"]', '[data-e2e="comment-input"]']);
  if (!editor?.fill) throw new Error('Không tìm thấy ô nhập bình luận TikTok');
  await editor.fill(text);
  await submitComment(page, mediaAssetIds, session);
}

async function sendTikTokMessage(session: PlatformSession, text: string, mediaAssetIds: string[]): Promise<void> {
  const page = session.page as EvaluatablePage;
  if (text) {
    const editor = await firstLocator(page, [
      '[contenteditable="true"]',
      'textarea',
      '[data-e2e*="message-input"]',
    ]);
    if (!editor?.fill) throw new Error('Không tìm thấy ô nhập tin nhắn TikTok');
    await editor.fill(text);
  }
  if (mediaAssetIds.length > 0) {
    if (!session.resolveMediaAssets) throw new Error('Chưa có bộ giải media cho TikTok');
    const files = await session.resolveMediaAssets(mediaAssetIds);
    const input = await firstLocator(page, ['input[type="file"]']);
    if (!input?.setInputFiles) throw new Error('TikTok không hiển thị input upload ảnh trong tin nhắn');
    await input.setInputFiles(files);
  }
  await beginExternalAction(session);
  const submit = await firstLocator(page, [
    '[data-e2e*="send"]',
    'button[type="submit"]',
    'button:has-text("Send")',
  ]);
  if (!submit?.click) throw new Error('Không tìm thấy nút gửi tin nhắn TikTok');
  await submit.click();
}

async function extractVisibleFollowerProfiles(page: EvaluatablePage): Promise<Array<{ username: string; profileUrl: string }>> {
  if (!page.evaluate) throw new Error('TikTok follower crawl cần BrowserPage.evaluate');
  return page.evaluate(() => {
    const output: Array<{ username: string; profileUrl: string }> = [];
    const seen = new Set<string>();
    for (const link of [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/@"]')]) {
      const url = new URL(link.href, location.href);
      const match = url.pathname.match(/^\/@([a-zA-Z0-9._-]+)\/?$/);
      if (!match) continue;
      const username = `@${match[1]}`;
      if (seen.has(username)) continue;
      seen.add(username);
      output.push({ username, profileUrl: `https://www.tiktok.com/@${match[1]}` });
    }
    return output;
  });
}

async function scrollFollowerList(page: EvaluatablePage): Promise<void> {
  if (!page.evaluate) return;
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    const scrollable = dialog
      ? [...dialog.querySelectorAll<HTMLElement>('*')].find((element) => element.scrollHeight > element.clientHeight + 50)
      : null;
    (scrollable ?? dialog ?? document.scrollingElement)?.scrollBy(0, 700);
  });
}

function normalizeTikTokUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

async function submitComment(page: EvaluatablePage, mediaAssetIds: string[], session: PlatformSession): Promise<void> {
  if (mediaAssetIds.length > 0) {
    if (!session.resolveMediaAssets) throw new Error('Chưa có bộ giải media cho TikTok');
    const files = await session.resolveMediaAssets(mediaAssetIds);
    const input = await firstLocator(page, ['input[type="file"]']);
    if (!input?.setInputFiles) throw new Error('TikTok không hiển thị input upload ảnh');
    await input.setInputFiles(files);
  }
  await beginExternalAction(session);
  const submit = await firstLocator(page, [
    '[data-e2e="comment-post"]',
    'button[type="submit"]',
    'button:has-text("Post")',
  ]);
  if (!submit?.click) throw new Error('Không tìm thấy nút gửi bình luận TikTok');
  await submit.click();
}

async function extractVisibleVideos(page: EvaluatablePage): Promise<TikTokVideoMetadata[]> {
  if (!page.evaluate) throw new Error('TikTok crawl cần BrowserPage.evaluate');
  return page.evaluate(() => {
    const numberFromText = (value: string): number | undefined => {
      const match = value.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
      if (!match) return undefined;
      const multiplier = match[2]?.toUpperCase() === 'B' ? 1_000_000_000 : match[2]?.toUpperCase() === 'M' ? 1_000_000 : match[2]?.toUpperCase() === 'K' ? 1_000 : 1;
      return Math.round(Number(match[1]) * multiplier);
    };
    type MetricKind = 'likes' | 'views' | 'comments';
    const metricMarkers: Record<MetricKind, RegExp[]> = {
      likes: [/like/, /digg/],
      views: [/\bview(?:s|count)?\b/, /play(?:s|count)?/],
      comments: [/comment/],
    };
    const likeFromHeartText = (value: string | null | undefined): number | undefined => {
      const match = (value ?? '').replace(/\s+/g, ' ').match(/[♡♥❤🖤]\s*([\d.,]+\s*[KMB]?)/i);
      return match ? numberFromText(match[1] ?? '') : undefined;
    };
    const metric = (card: Element, kind: MetricKind): number | undefined => {
      const nodes = [...card.querySelectorAll<HTMLElement>('[aria-label], [data-e2e], [class*="like" i], [class*="digg" i]')];
      for (const candidate of nodes) {
        const className = candidate.getAttribute('class') ?? (typeof candidate.className === 'string' ? candidate.className : '');
        const marker = `${candidate.getAttribute('aria-label') ?? ''} ${candidate.getAttribute('data-e2e') ?? ''} ${className}`.toLowerCase();
        if (!metricMarkers[kind].some((pattern) => pattern.test(marker))) continue;
        // A node carrying another metric's marker is not a valid fallback.
        // This prevents a like-count element from being reused as views.
        const otherKind = (Object.keys(metricMarkers) as MetricKind[]).find((other) => other !== kind && metricMarkers[other].some((pattern) => pattern.test(marker)));
        if (otherKind) continue;
        for (const valueNode of [candidate, candidate.parentElement, candidate.parentElement?.parentElement]) {
          if (!valueNode) continue;
          const value = (valueNode.getAttribute('aria-label') ?? valueNode.textContent ?? '').trim();
          if (value.length > 120) continue;
          const parsed = numberFromText(value);
          if (parsed != null) return parsed;
        }
      }
      if (kind === 'likes') {
        const icon = [...card.querySelectorAll<HTMLElement>('svg, [role="img"]')].find((candidate) => {
          const className = candidate.getAttribute('class') ?? (typeof candidate.className === 'string' ? candidate.className : '');
          const marker = `${candidate.getAttribute('aria-label') ?? ''} ${candidate.getAttribute('data-e2e') ?? ''} ${className}`.toLowerCase();
          return /heart|like|digg|favorite/.test(marker);
        });
        for (const wrapper of [icon?.parentElement, icon?.parentElement?.parentElement]) {
          if (!wrapper) continue;
          const value = wrapper.textContent?.trim() ?? '';
          if (value.length <= 120) {
            const parsed = numberFromText(value);
            if (parsed != null) return parsed;
          }
        }
        return likeFromHeartText(card.textContent);
      }
      return undefined;
    };
    const structuredStats = new Map<string, { likes?: number; views?: number; comments?: number }>();
    const asObject = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 10) return;
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
      const object = asObject(value);
      if (!object) return;
      const id = String(object.id ?? object.videoId ?? object.itemId ?? '').match(/\d{8,}/)?.[0];
      const stats = asObject(object.stats ?? object.statistics);
      if (id && stats) {
        const current = structuredStats.get(id) ?? {};
        const likes = asNumber(stats.diggCount ?? stats.likeCount ?? stats.likes);
        const views = asNumber(stats.playCount ?? stats.viewCount ?? stats.views);
        const comments = asNumber(stats.commentCount ?? stats.comments);
        structuredStats.set(id, { likes: likes ?? current.likes, views: views ?? current.views, comments: comments ?? current.comments });
      }
      for (const child of Object.values(object)) visit(child, depth + 1);
    };
    for (const script of [...document.querySelectorAll('script')]) {
      const raw = script.textContent ?? '';
      if (!raw.includes('playCount') && !raw.includes('diggCount')) continue;
      try { visit(JSON.parse(raw)); } catch { /* Most TikTok scripts are not JSON; DOM metrics remain usable. */ }
    }
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]')];
    const seen = new Set<string>();
    const output: TikTokVideoMetadata[] = [];
    for (const link of links) {
      const videoUrl = new URL(link.href, location.href).href.split('?')[0]!;
      if (seen.has(videoUrl)) continue;
      seen.add(videoUrl);
      const ancestors: Element[] = [link];
      let ancestor = link.parentElement;
      for (let depth = 0; depth < 8 && ancestor; depth += 1) {
        ancestors.push(ancestor);
        ancestor = ancestor.parentElement;
      }
      // The video URL anchor often contains only the thumbnail/title while
      // the heart and count live in its immediate card wrapper. Prefer the
      // smallest ancestor that owns the like marker or visible heart count.
      const card = ancestors.find((candidate) => metric(candidate, 'likes') != null)
        ?? ancestors.find((candidate) => (candidate.textContent?.length ?? 0) > 20 && candidate.querySelector('img'))
        ?? link.parentElement
        ?? link;
      const structured = structuredStats.get(videoUrl.match(/\/video\/(\d+)/)?.[1] ?? '');
      const hasVerifiedStats = structured?.views != null || structured?.comments != null;
      const image = card?.querySelector<HTMLImageElement>('img');
      const author = link.href.match(/tiktok\.com\/@([^/]+)/)?.[1];
      output.push({
        videoUrl,
        videoId: videoUrl.match(/\/video\/(\d+)/)?.[1],
        username: author ? `@${author}` : undefined,
        description: card?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 500),
        thumbnailUrl: image?.src,
        likes: structured?.likes ?? (card ? metric(card, 'likes') : undefined),
        // Search cards expose a like count, but do not expose reliable view or
        // comment counts. Never infer either field from the card; only use
        // explicit stats from TikTok's video data.
        views: structured?.views,
        comments: structured?.comments,
        ...(hasVerifiedStats ? { statsSource: 'TIKTOK_VIDEO_STATS' as const } : {}),
      });
    }
    return output;
  });
}

async function scrollSearchResults(page: EvaluatablePage): Promise<{ moved: boolean; top: number; height: number }> {
  if (!page.evaluate) return { moved: false, top: 0, height: 0 };
  try {
    return await page.evaluate(() => {
      const minimumStep = 600;
      const scrollElement = (element: HTMLElement): { moved: boolean; top: number; height: number } => {
        const before = element.scrollTop;
        const step = Math.max(minimumStep, Math.floor(element.clientHeight * 0.95));
        const target = Math.min(element.scrollHeight, before + step);
        if (target <= before + 1) return { moved: false, top: before, height: element.scrollHeight };
        // Keep the browser's native smooth-scroll animation instead of
        // assigning scrollTop directly. TikTok's feed then advances naturally
        // and has time to hydrate the next card without a visible jump.
        element.scrollTo({ top: target, behavior: 'smooth' });
        return { moved: true, top: target, height: element.scrollHeight };
      };
      const feedScroller = document.querySelector<HTMLElement>('#column-list-container');
      if (feedScroller && feedScroller.scrollHeight > feedScroller.clientHeight + 8) {
        return scrollElement(feedScroller);
      }
      const documentScroller = document.scrollingElement;
      const documentCanScroll = Boolean(documentScroller && documentScroller.scrollHeight > documentScroller.clientHeight + 8);

      if (documentCanScroll && documentScroller) {
        return scrollElement(documentScroller as HTMLElement);
      }

      // Some TikTok layouts put the result list in an internal scroll region.
      // Prefer a result-like region and otherwise use the largest scrollable
      // element, without scrolling every nested container at once.
      const candidates = [
        ...Array.from(document.querySelectorAll<HTMLElement>(
          'main, section, [role="main"], [data-e2e*="search"], [class*="search"]',
        )),
        ...Array.from(document.querySelectorAll<HTMLElement>('body *')),
      ];
      const scrollable = candidates
        .filter((element, index, all) => all.indexOf(element) === index)
        .filter((element) => {
          const style = window.getComputedStyle(element);
          return element.scrollHeight > element.clientHeight + 8 && /(auto|scroll|overlay)/i.test(style.overflowY);
        })
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0];

      if (!scrollable) return { moved: false, top: 0, height: 0 };
      return scrollElement(scrollable);
    });
  } catch {
    return { moved: false, top: 0, height: 0 };
  }
}

async function firstLocator(page: BrowserPage, selectors: string[]): Promise<LocatorLike | undefined> {
  for (const selector of selectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    if (await locator.count() > 0) return locator.first ? locator.first() : locator;
  }
  return undefined;
}

async function findLocators(page: BrowserPage, selectors: string[]): Promise<LocatorLike[]> {
  const result: LocatorLike[] = [];
  for (const selector of selectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      result.push(locator.nth ? locator.nth(index) : locator);
    }
    if (result.length > 0) break;
  }
  return result;
}

async function beginExternalAction(session: PlatformSession): Promise<void> {
  if (!session.beforeExternalAction) {
    throw new Error('TikTok external action requires an approved task execution context');
  }
  await session.beforeExternalAction();
}
