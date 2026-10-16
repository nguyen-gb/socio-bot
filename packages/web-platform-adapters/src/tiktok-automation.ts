import {
  gotoPlatformPage,
  type BrowserPage,
  type PlatformSession,
} from '@socio/platform-core';

export interface TikTokVideoMetadata {
  videoUrl: string;
  videoId?: string;
  title?: string;
  username?: string;
  profileUrl?: string;
  description?: string;
  thumbnailUrl?: string;
  likes?: number;
  publishedAt?: string;
  views?: number;
  comments?: number;
  statsSource?: 'TIKTOK_VIDEO_STATS';
}

/**
 * Injectable search boundary used by local/staging product tests.
 *
 * The live implementation below remains the default. A test provider keeps
 * CAPTCHA and anti-bot behavior out of deterministic workflow tests without
 * changing the browser fingerprint or making a network request to TikTok.
 */
export interface TikTokSearchProvider {
  search(query: string, maxVideos: number): Promise<TikTokVideoMetadata[]>;
}

/** Solver boundary kept in the adapter package so the worker can provide the
 * AntiCaptcha.top implementation without creating a package dependency cycle. */
export interface TikTokRotateCaptchaSolver {
  /** Returns the provider's normalized rotate ratio (0..1). */
  solveRotate(imageBase64s: readonly [string, string]): Promise<number>;
  report?: (message: string) => void;
}

export interface TikTokRotateCaptchaSolveResult {
  attempted: boolean;
  solved: boolean;
  reason?: string;
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
  locator?: (selector: string) => LocatorLike;
  isVisible?: () => Promise<boolean>;
  isEnabled?: () => Promise<boolean>;
  textContent?: () => Promise<string | null>;
  fill?: (value: string) => Promise<void>;
  click?: () => Promise<void>;
  press?: (key: string) => Promise<void>;
  inputValue?: () => Promise<string>;
  innerText?: () => Promise<string>;
  allTextContents?: () => Promise<string[]>;
  getAttribute?: (name: string) => Promise<string | null>;
  type?: (value: string) => Promise<void>;
  pressSequentially?: (value: string) => Promise<void>;
  setInputFiles?: (files: Array<{ name: string; mimeType: string; buffer: Buffer }>) => Promise<void>;
  screenshot?: () => Promise<Buffer>;
  boundingBox?: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
}

interface FrameLike {
  locator: (selector: string) => unknown;
  evaluate?: <T>(pageFunction: () => T) => Promise<T>;
}

interface EvaluatablePage extends BrowserPage {
  evaluate?: <T, A = unknown>(pageFunction: ((arg?: A) => T) | string, arg?: A) => Promise<T>;
  waitForTimeout?: (timeout: number) => Promise<void>;
  close?: () => Promise<void>;
  keyboard?: { press: (key: string) => Promise<void>; type?: (text: string) => Promise<void> };
  frames?: () => FrameLike[];
  mouse?: {
    move: (x: number, y: number, options?: { steps?: number }) => Promise<void>;
    down: () => Promise<void>;
    up: () => Promise<void>;
  };
}

interface TikTokRotateChallengeSnapshot {
  imageBase64s: [string, string];
  imageBoxes: { inside?: { x: number; y: number; width: number; height: number }; outside?: { x: number; y: number; width: number; height: number } };
  track: { x: number; y: number; width: number; height: number };
  handle?: { x: number; y: number; width: number; height: number };
}

const tikTokRotateSolveAttempts = new WeakMap<object, number>();

const tiktokHomeUrl = 'https://www.tiktok.com/';

const tiktokCommentEditorSelectors = [
  '[data-e2e="comment-input"] [contenteditable="true"]',
  '[data-e2e*="comment-input" i] [contenteditable="true"]',
  '[data-e2e*="comment" i] [contenteditable]',
  '[data-e2e="comment-input"] textarea',
  '[data-e2e*="comment-input" i] textarea',
  'textarea[placeholder*="Add comment" i]',
  'textarea[placeholder*="comment" i]',
  '[data-e2e="comment-input"] input',
  '[data-e2e*="comment-input" i] input',
  'input[placeholder*="Add comment" i]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[contenteditable]',
  '[role="textbox"]',
  'textarea',
  'input[placeholder*="comment" i]',
  'input[placeholder*="bình luận" i]',
];

const tiktokCommentPlaceholderSelectors = [
  'text=/add\\s+comment/i',
  'text=/bình\\s+luận/i',
  '[placeholder*="Add comment" i]',
  '[data-placeholder*="Add comment" i]',
  '[aria-label*="Add comment" i]',
  '[aria-label*="comment" i]',
];

const tiktokCommentTextSelectors = [
  '[data-e2e*="comment-level" i]',
  '[data-e2e*="comment-text" i]',
  '[data-e2e*="comment-content" i]',
];

const tiktokMessageEditorSelectors = [
  '[data-e2e*="message-input" i] [contenteditable="true"]',
  '[data-e2e*="message-input" i] textarea',
  '[data-e2e*="message-input" i] input',
  'textarea[placeholder*="message" i]',
  'textarea[placeholder*="tin nhắn" i]',
  'input[placeholder*="message" i]',
  'input[placeholder*="tin nhắn" i]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
];

const tiktokMessageTextSelectors = [
  '[data-e2e*="message-content" i]',
  '[data-e2e*="chat-message" i]',
  '[data-testid*="message" i]',
  '[role="log"]',
  '[role="list"] [role="listitem"]',
];

export function buildTikTokProfileUrl(username: string): string {
  return `https://www.tiktok.com/@${encodeURIComponent(username.replace(/^@/, ''))}`;
}

async function hasTikTokProfileSurface(page: EvaluatablePage): Promise<boolean> {
  // A video route also contains `tiktok.com/@`; only accept the exact
  // profile route after a search-result click. This prevents a nested video
  // link inside TikTok's search-user card from being mistaken for a profile.
  if (!extractTikTokUsernameFromUrl(page.url())) return false;
  if (await hasTikTokErrorSurface(page)) return false;
  try {
    const signal = await firstLocator(page, [
      'a[href*="/followers"]',
      '[data-e2e*="followers"]',
      'button:has-text("Message")',
      '[data-e2e*="user-title"]',
    ]);
    if (signal && (await signal.count()) > 0) return true;
    if (page.evaluate) {
      const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
      return /Followers|Following|Message/i.test(bodyText);
    }
  } catch { /* The page may still be committing. */ }
  return false;
}

async function gotoTikTokSurface(page: EvaluatablePage, url: string): Promise<void> {
  const currentUrl = page.url().split('?')[0];
  if (currentUrl === url.split('?')[0] && await hasTikTokProfileSurface(page)) return;
  let navigationError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // TikTok can replace the document while DOMContentLoaded is pending.
      // Commit is sufficient here; readiness is checked after the replacement
      // document has settled.
      await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
      navigationError = undefined;
      break;
    } catch (error) {
      navigationError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isTikTokNavigationRace(message) && !/ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(message)) throw error;
      await page.waitForTimeout?.(650 + attempt * 450);
    }
  }
  if (navigationError && !isTikTokNavigationRace(String(navigationError))) throw navigationError;
  await waitForTikTokPageReady(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  if (await hasTikTokErrorSurface(page)) {
    throw new Error('TikTok không hiển thị được trang profile trong browser automation');
  }
  if (!(await hasTikTokProfileSurface(page))) {
    throw new Error('TikTok chưa hiển thị xong trang profile trong browser automation');
  }
}

async function gotoTikTokVideoPage(page: EvaluatablePage, url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!isTikTokNavigationRace(message) && !/ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(message)) throw error;
      await page.waitForTimeout?.(650 + attempt * 450);
    }
  }
  if (lastError
    && !isTikTokNavigationRace(String(lastError))
    && !/ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(String(lastError))) throw lastError;
  await waitForTikTokPageReady(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  if (await hasTikTokErrorSurface(page)) {
    throw new Error('TikTok không hiển thị được trang video trong browser automation');
  }
}

/**
 * Prefer TikTok's own rendered video link when it is already on the current
 * surface. Direct navigation to a video URL can be rejected by TikTok even
 * though the same card is playable from the feed; clicking the rendered link
 * preserves the current document, cookies, and client-side route state.
 */
async function openTikTokVideoPage(page: EvaluatablePage, url: string): Promise<void> {
  const clicked = await clickVisibleTikTokVideoLink(page, url);
  if (clicked) {
    await waitForTikTokPageReady(page);
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    if (await hasTikTokErrorSurface(page)) {
      throw new Error('TikTok không hiển thị được trang video trong browser automation');
    }
    if (isTikTokVideoPath(page.url(), url)) return;
  }
  await gotoTikTokVideoPage(page, url);
}

async function clickVisibleTikTokVideoLink(page: EvaluatablePage, url: string): Promise<boolean> {
  const targetPath = tikTokVideoPath(url);
  if (!targetPath) return false;
  const links = page.locator('a[href*="/video/"]') as unknown as LocatorLike;
  const count = await links.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = links.nth ? links.nth(index) : links;
    if (!await isLocatorVisible(candidate)) continue;
    const href = await candidate.getAttribute?.('href');
    if (!href || tikTokVideoPath(href) !== targetPath || !candidate.click) continue;
    try {
      await candidate.click();
      await waitForTikTokUi(page, 650, 1_100);
      return true;
    } catch {
      // The card may have been recycled during a feed update. Re-resolve the
      // next candidate or fall back to the bounded direct navigation below.
    }
  }
  return false;
}

function tikTokVideoPath(value: string): string | undefined {
  try {
    const parsed = new URL(value, tiktokHomeUrl);
    const match = parsed.pathname.match(/^\/@[^/]+\/video\/[^/]+\/?$/i);
    return match ? parsed.pathname.replace(/\/$/, '').toLocaleLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function isTikTokVideoPath(currentUrl: string, expectedUrl: string): boolean {
  const currentPath = tikTokVideoPath(currentUrl);
  const expectedPath = tikTokVideoPath(expectedUrl);
  return Boolean(currentPath && expectedPath && currentPath === expectedPath);
}

function isTikTokNavigationRace(message: string): boolean {
  return /ERR_ABORTED|interrupted by another navigation|chrome-error:\/\/chromewebdata/i.test(message);
}

async function hasTikTokErrorSurface(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    return await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const bodyText = document.body?.innerText ?? '';
      const errorText = /something went wrong|please try again later|page unavailable|không thể tải|đã xảy ra lỗi/i.test(bodyText);
      const refresh = [...document.querySelectorAll('button,a')]
        .filter(visible)
        .some((element) => /refresh|try again|tải lại|thử lại/i.test((element as HTMLElement).innerText || element.getAttribute('aria-label') || ''));
      return errorText && refresh;
    });
  } catch {
    return false;
  }
}

async function hasTikTokDeniedDocument(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    return await page.evaluate(() => {
      const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const title = document.title ?? '';
      const hardDenied = /access to (?:www\.)?tiktok\.com was denied|you don't have authorization to view this page|http error 403|err_http_response_code_failure/i.test(`${title} ${bodyText}`);
      const waitingInterstitial = /^please wait\.?$/i.test(bodyText)
        && !document.querySelector('[data-e2e], input, button, video');
      return hardDenied || waitingInterstitial;
    });
  } catch {
    return false;
  }
}

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
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<TikTokVideoMetadata[]> {
  const page = session.page as EvaluatablePage;
  let verificationSeenDuringNavigation = false;
  try {
    // Search directly on the Videos surface. The previous flow opened For You,
    // dismissed the onboarding UI, watched/scrolled several feed items, opened
    // the search box, and only then navigated here. None of those steps are
    // required once CAPTCHA solving is available and they add several seconds.
    await gotoPlatformPage(page, buildTikTokVideoSearchUrl(query));
    // The first page visit is the most sensitive BDTuring window. Let the
    // route, challenge scripts, and result surface settle before inspecting
    // the DOM or performing the next action.
    await waitForTikTokUi(page, 1_200, 2_200);
    verificationSeenDuringNavigation = await waitForTikTokVideoResults(page, captchaSolver);
  } catch (error) {
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(error instanceof Error ? error.message : String(error))) {
      throw new TikTokVerificationRequiredError(
        'TikTok đã từ chối trang Search và có thể đang yêu cầu xác minh anti-bot. Hãy hoàn tất xác minh thủ công trên browser rồi chạy lại campaign.',
      );
    }
    throw error;
  }
  const videos = new Map<string, TikTokVideoMetadata>();
  let unchangedPasses = 0;

  // Search results are lazy-loaded. The scroll budget follows the requested
  // result count instead of using a fixed number of feed passes: roughly six
  // newly visible cards are expected per pass, with a hard safety cap for a
  // malformed page.
  const requestedVideoCount = Math.max(0, Math.floor(maxVideos));
  const maxScrollPasses = Math.min(30, Math.max(1, Math.ceil(requestedVideoCount / 6)));
  for (let pass = 0; pass < maxScrollPasses && videos.size < maxVideos; pass += 1) {
    const batch = await extractVisibleVideos(page);
    const before = videos.size;
    for (const video of batch) {
      if (videos.size >= maxVideos) break;
      videos.set(video.videoUrl, video);
    }
    unchangedPasses = videos.size === before ? unchangedPasses + 1 : 0;
    if (unchangedPasses >= 3) break;
    if (videos.size >= maxVideos) break;
    await waitForTikTokActionDelay(page);
    const scrollState = await scrollSearchResults(page);
    await waitForTikTokResultsLoad(page, before);
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired) {
      const solved = await solveVisibleTikTokRotateCaptcha(page, captchaSolver);
      if (!solved.solved) {
        throw new TikTokVerificationRequiredError(
          `TikTok CAPTCHA chưa được giải${solved.reason ? `: ${solved.reason}` : '.'}`,
        );
      }
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

function buildTikTokVideoSearchUrl(query: string): string {
  const url = new URL('https://www.tiktok.com/search/video');
  url.searchParams.set('q', query);
  return url.toString();
}

/**
 * Open TikTok's generic entry page, enter the For You feed through the UI,
 * then watch a few random videos before starting a search. This keeps the
 * search flow aligned with the browser's normal navigation instead of
 * jumping directly to /foryou or /search/video.
 */
async function openTikTokHomeFeed(
  page: EvaluatablePage,
  options: { scrollAfterClick?: boolean } = {},
): Promise<void> {
  // Search is intentionally anonymous: never fall back to TikTok's login
  // route and never reuse a persisted profile when the home route is blocked.
  if (!isTikTokHomeShellUrl(page.url())) await gotoTikTokHomeEntry(page);
  // Let the ordinary home shell, navigation, and client scripts finish before
  // looking up the For You control. The extra randomized pause is deliberate:
  // it keeps the first click from racing hydration.
  await waitForTikTokPageReady(page);
  await waitForTikTokActionDelay(page);

  // TikTok may show a first-visit guide with a full-screen blur. It can leave
  // the navigation in the DOM while preventing the real For You target from
  // receiving pointer events, so dismiss it before resolving the nav item.
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);

  let forYouLabel: LocatorLike | undefined;
  let feedAlreadyMounted = false;
  // A cold anonymous TikTok profile can spend several seconds rendering the
  // feed skeleton before the side navigation is mounted. Poll the actual nav
  // item instead of failing after the short human-like pauses used between
  // interactions. This keeps scroll/search pauses short while allowing the
  // initial page load to finish.
  for (let attempt = 0; !forYouLabel && attempt < 20; attempt += 1) {
    await dismissTikTokBlockingPopup(page);
    forYouLabel = await firstTikTokForYouLabel(page);
    if (!forYouLabel && await hasTikTokFeedSurface(page)) {
      // Root can land directly on the feed (or render the compact shell
      // without a visible side-nav label). In that case the requested For You
      // surface is already active and there is nothing safe to click.
      feedAlreadyMounted = true;
      break;
    }
    if (!forYouLabel) await waitForTikTokUi(page, 450, 850);
  }

  let clickedForYou = feedAlreadyMounted;
  if (!clickedForYou && !forYouLabel?.click) throw new Error('Không tìm thấy nút For You trên trang chủ TikTok');
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
  await waitForTikTokPageReady(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);

  if (options.scrollAfterClick !== false) {
    const videoPasses = randomInteger(2, 4);
    for (let pass = 0; pass < videoPasses; pass += 1) {
      await dismissTikTokBlockingPopup(page);
      await scrollTikTokFeed(page);
      await waitForTikTokUi(page);
      await dismissTikTokBlockingPopup(page);
    }
  }
}

function isTikTokHomeShellUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^(?:www\.)?tiktok\.com$/i.test(url.hostname)
      && (url.pathname === '/' || url.pathname === '/foryou' || url.pathname === '/foryou/');
  } catch {
    return false;
  }
}

/** Wait for the current TikTok document to finish loading before interacting. */
async function waitForTikTokPageReady(page: EvaluatablePage): Promise<void> {
  if (!page.evaluate) {
    await waitForTikTokUi(page, 1_200, 2_200);
    return;
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    let readyState: string | undefined;
    try {
      readyState = await page.evaluate(() => document.readyState);
    } catch {
      // A route transition can briefly detach the document. Keep waiting for
      // the replacement document instead of starting another navigation.
    }
    if (readyState === 'complete') {
      // DOM complete does not mean TikTok's React shell has finished hydrating.
      await waitForTikTokUi(page, 900, 1_600);
      return;
    }
    await waitForTikTokUi(page, 250, 500);
  }

  // Do not issue another goto when a slow profile misses the readiness
  // deadline. A final quiet period lets the existing document settle and keeps
  // the campaign on the single root-entry navigation.
  await waitForTikTokUi(page, 1_000, 1_800);
}

/**
 * Enter TikTok through the requested root URL without treating TikTok's own
 * client-side handoff to its feed as a failed campaign navigation. Waiting for
 * `domcontentloaded` on this route is racy: TikTok can replace the document
 * with `/foryou` while Chromium is still resolving the root navigation, which
 * surfaces as `ERR_ABORTED` from Playwright. We only accept that race when the
 * final document is still on TikTok. We never retry by navigating to
 * `/foryou`; the rest of the flow observes whichever document TikTok mounted.
 */
export async function enterTikTokRoot(page: EvaluatablePage): Promise<void> {
  // Browser sessions are created with TikTok's ordinary root already open.
  // Re-navigating a healthy root immediately after Chromium startup can turn
  // a usable document into TikTok's transient 403 error page. Reuse that
  // document and let the caller wait for hydration instead of reloading it.
  if (isTikTokHomeShellUrl(page.url())
    && !(await hasTikTokDeniedDocument(page))
    && !(await hasTikTokErrorSurface(page))) return;

  try {
    await page.goto(tiktokHomeUrl, { waitUntil: 'commit', timeout: 45_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isOwnNavigationRace = /ERR_ABORTED|interrupted by another navigation|chrome-error:\/\/chromewebdata/i.test(message);
    if (!isOwnNavigationRace) throw error;
  }

  // A cold profile can receive a transient 403 on the first root request.
  // Retry the same requested root once after the document has settled; never
  // substitute /foryou here.
  if (await hasTikTokDeniedDocument(page)) {
    await waitForTikTokUi(page, 1_200, 2_200);
    try {
      await page.goto(tiktokHomeUrl, { waitUntil: 'commit', timeout: 45_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isTikTokNavigationRace(message) && !/ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(message)) throw error;
    }
  }
}

// Keep the internal name at call sites that specifically mean the initial
// home-feed transition. The exported entry helper is also used by the adapter
// so every TikTok action starts from the same root URL.
const gotoTikTokHomeEntry = enterTikTokRoot;

async function searchTikTokFromHome(
  page: EvaluatablePage,
  query: string,
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<boolean> {
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
  const topVerificationSeen = await waitForTikTokTopResults(page, captchaSolver);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  await clickTikTokVideoTab(page, query);
  const videoVerificationSeen = await waitForTikTokVideoResults(page, captchaSolver);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  return topVerificationSeen || videoVerificationSeen;
}

/**
 * Find a TikTok profile through TikTok's own home/search UI. Direct profile
 * navigation is intentionally not used here: the same profile route can
 * return TikTok's generic error page when it is opened as a cold navigation,
 * while the profile renders normally after a search result click.
 */
async function searchTikTokProfileFromHome(
  page: EvaluatablePage,
  username: string,
  captchaSolver?: TikTokRotateCaptchaSolver,
  recoveryAttempt = 0,
): Promise<void> {
  const targetUsername = normalizeTikTokUsername(username);
  if (!targetUsername) throw new Error('Username TikTok rỗng');
  const searchQuery = recoveryAttempt >= 2 ? targetUsername : `@${targetUsername}`;

  await enterTikTokRoot(page);
  await waitForTikTokPageReady(page);
  await waitForTikTokActionDelay(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);

  let searchInput = await firstVisibleLocator(page, [
    'input[data-e2e="search-user-input"]',
    'input[aria-label*="Search" i]',
    'input[placeholder*="Search" i]',
    'input[placeholder*="Tìm kiếm" i]',
    'input[type="search"]',
  ]);

  // Compact layouts render only the search trigger until it is clicked.
  for (let attempt = 0; !searchInput && attempt < 2; attempt += 1) {
    const trigger = await firstVisibleLocator(page, [
      'button[data-e2e="nav-search"]',
      '[data-e2e*="search-icon" i]',
      'button[aria-label*="Search" i]',
      '[role="searchbox"]',
    ]);
    if (!trigger?.click) break;
    await trigger.click();
    await waitForTikTokActionDelay(page);
    searchInput = await firstVisibleLocator(page, [
      'input[data-e2e="search-user-input"]',
      'input[aria-label*="Search" i]',
      'input[placeholder*="Search" i]',
      'input[placeholder*="Tìm kiếm" i]',
      'input[type="search"]',
    ]);
  }

  if (!searchInput?.fill) throw new Error('Không tìm thấy ô search TikTok để tìm profile');
  await searchInput.click?.();
  await waitForTikTokActionDelay(page);
  // Prefixing the exact handle keeps TikTok on the user-result path for
  // handles that also occur in unrelated video captions or hashtags.
  await searchInput.fill(searchQuery);
  await waitForTikTokActionDelay(page);
  if (searchInput.press) {
    await searchInput.press('Enter');
  } else {
    const submit = await firstVisibleLocator(page, [
      'button[data-e2e*="search" i]',
      'button[aria-label*="Search" i]',
    ]);
    if (!submit?.click) throw new Error('Không tìm thấy nút submit search profile TikTok');
    await submit.click();
  }

  await waitForTikTokActionDelay(page);
  let usersTabClicked = false;
  let videoTabTried = false;
  let errorRetryCount = 0;
  let fallbackTabIndex = 0;
  const fallbackTabs = [/^top$/, /^videos?$/];
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired) {
      const solved = await solveVisibleTikTokRotateCaptcha(page, captchaSolver);
      if (!solved.solved) {
        throw new TikTokVerificationRequiredError(
          `TikTok CAPTCHA chưa được giải khi tìm profile${solved.reason ? `: ${solved.reason}` : '.'}`,
        );
      }
      await waitForTikTokActionDelay(page);
      continue;
    }

    // The default Top surface often wraps the user card around several
    // nested video links. Switch to the dedicated Users surface before
    // resolving the exact profile so a click cannot land on a child video.
    if (recoveryAttempt === 0 && !usersTabClicked) {
      usersTabClicked = await clickTikTokUsersTab(page);
      if (usersTabClicked) {
        await waitForTikTokActionDelay(page);
        continue;
      }
    }

    // If the first exact user-card click reaches TikTok's generic profile
    // error surface, restart from Home and use the creator link on the video
    // result surface. It is still an ordinary search -> exact profile click,
    // but it avoids reusing a broken Users response from the same session.
    if (recoveryAttempt > 0 && !videoTabTried) {
      try {
        await clickTikTokVideoTab(page, searchQuery);
        videoTabTried = true;
        await waitForTikTokActionDelay(page);
        continue;
      } catch {
        videoTabTried = true;
      }
    }

    // Logged-in TikTok sessions can reject the Users API while still serving
    // the same query on the Videos surface. Try that rendered tab before
    // retrying the error page; its cards include the exact creator profile
    // anchors, so the next step is still a normal search-result click.
    if (await hasTikTokErrorSurface(page) && !videoTabTried) {
      try {
        await clickTikTokVideoTab(page, `@${targetUsername}`);
        videoTabTried = true;
        await waitForTikTokActionDelay(page);
        continue;
      } catch {
        videoTabTried = true;
      }
    }

    // TikTok sometimes paints the search shell successfully but returns its
    // generic server error for the first Users request. A normal retry from
    // the rendered UI can recover it; never reload the profile URL as a
    // workaround because that reintroduces the cold-navigation block.
    if (await hasTikTokErrorSurface(page)) {
      if (errorRetryCount >= 2) {
        const fallbackTab = fallbackTabs[fallbackTabIndex++];
        if (fallbackTab && await clickTikTokSearchTab(page, fallbackTab)) {
          errorRetryCount = 0;
          usersTabClicked = true;
          await waitForTikTokActionDelay(page);
          continue;
        }
        break;
      }
      const retry = await firstVisibleLocatorWithText(page, ['button', 'a'], 'try again')
        ?? await firstVisibleLocatorWithText(page, ['button', 'a'], 'refresh');
      if (!retry?.click) break;
      errorRetryCount += 1;
      await retry.click();
      await waitForTikTokActionDelay(page);
      continue;
    }

    const profileResult = await findTikTokProfileSearchResult(page, targetUsername);
    if (profileResult?.click) {
      await waitForTikTokActionDelay(page);
      const profileClicked = await clickTikTokProfileSearchResult(page, profileResult, targetUsername);
      if (!profileClicked) {
        // Some TikTok search cards expose the profile text as a nested element
        // but attach navigation only to the parent anchor. The helper retries
        // through that anchor/hit target without ever constructing a profile
        // URL, preserving the Home -> Search -> exact result flow.
        await waitForTikTokUi(page, 450, 850);
        continue;
      }
      await waitForTikTokActionDelay(page);
      await waitForTikTokPageReady(page);
      await dismissTikTokBlockingPopup(page);
      await dismissTikTokCloseablePopup(page);
      // A profile click can mount BDTuring after the search-page probe has
      // completed. Resolve that challenge before classifying the profile
      // route; otherwise TikTok's generic error shell hides a usable profile.
      await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
      const currentUsername = extractTikTokUsernameFromUrl(page.url());
      if (currentUsername === targetUsername) {
        if (await hasTikTokProfileSurface(page)) return;
        if (await hasTikTokErrorSurface(page)) {
          // A profile route can finish its first request with TikTok's generic
          // error shell even though the same route becomes usable after the
          // rendered Refresh action. Try that recovery on the route we just
          // reached before rebuilding the search state.
          for (let refreshAttempt = 0; refreshAttempt < 2; refreshAttempt += 1) {
            const refresh = await firstVisibleLocatorWithText(page, ['button', 'a'], 'refresh')
              ?? await firstVisibleLocatorWithText(page, ['button', 'a'], 'try again');
            if (!refresh?.click) break;
            await refresh.click();
            await waitForTikTokActionDelay(page);
            await waitForTikTokPageReady(page);
            await dismissTikTokBlockingPopup(page);
            await dismissTikTokCloseablePopup(page);
            await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
            if (await hasTikTokProfileSurface(page)) return;
          }
          if (recoveryAttempt < 2) {
            await waitForTikTokActionDelay(page);
            return searchTikTokProfileFromHome(page, username, captchaSolver, recoveryAttempt + 1);
          }
        }
      }
    }

    // Some desktop builds put profile cards only under the Users tab. Click
    // that visible tab once, then keep resolving the exact username from the
    // live DOM instead of guessing a profile URL.
    if (!usersTabClicked) {
      usersTabClicked = await clickTikTokUsersTab(page);
      if (usersTabClicked) {
        await waitForTikTokActionDelay(page);
        continue;
      }
    }
    await waitForTikTokUi(page, 450, 850);
  }

  const diagnostics = await describeTikTokProfileSearchSurface(page, targetUsername);
  throw new Error(`TikTok không tìm thấy profile @${targetUsername} từ kết quả search${diagnostics ? ` (${diagnostics})` : ''}`);
}

async function findTikTokProfileSearchResult(
  page: EvaluatablePage,
  targetUsername: string,
): Promise<LocatorLike | undefined> {
  const selectors = [
    'main a[href*="/@"]',
    '[data-e2e*="search" i] a[href*="/@"]',
    'a[href*="/@"]',
  ];
  for (const selector of selectors) {
    const links = page.locator(selector) as unknown as LocatorLike;
    const count = await links.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = links.nth ? links.nth(index) : links;
      if (!await isLocatorVisible(candidate)) continue;
      const href = await candidate.getAttribute?.('href');
      if (extractTikTokUsernameFromUrl(href) !== targetUsername) continue;
      // Search-user cards can wrap a grid of video links inside the profile
      // anchor. Clicking the anchor's center then activates one of those
      // nested videos. Target the profile label/paragraph first so the click
      // lands on the profile header itself.
      const profileLabel = candidate.locator?.('p')?.first?.();
      if (profileLabel && await isLocatorVisible(profileLabel)) return profileLabel;
      return candidate;
    }
  }
  return undefined;
}

async function clickTikTokProfileSearchResult(
  page: EvaluatablePage,
  result: LocatorLike,
  targetUsername: string,
): Promise<boolean> {
  const alreadyOnTarget = (): boolean => extractTikTokUsernameFromUrl(page.url()) === targetUsername;

  // First use the semantic locator click. A short second attempt is useful
  // when TikTok has just mounted the result card and the first click lands
  // before its client-side handler is attached.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 0) {
      await result.click?.();
    } else if (page.mouse && result.boundingBox) {
      const box = await result.boundingBox();
      if (box) {
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y, { steps: 4 });
        await page.mouse.down();
        await page.mouse.up();
      }
    }
    await waitForTikTokActionDelay(page);
    if (alreadyOnTarget()) return true;
  }

  // If the nested label was not a hit target, retry the exact anchor exposed
  // by the current search DOM. This is still a UI click on the rendered result,
  // never a direct navigation to a guessed profile URL.
  for (const selector of [
    `a[href="/@${targetUsername}"]`,
    `a[href="https://www.tiktok.com/@${targetUsername}"]`,
  ]) {
    const anchors = page.locator(selector) as unknown as LocatorLike;
    const count = await anchors.count();
    for (let index = 0; index < count; index += 1) {
      const anchor = anchors.nth ? anchors.nth(index) : anchors;
      if (!await isLocatorVisible(anchor)) continue;
      await anchor.click?.();
      await waitForTikTokActionDelay(page);
      if (alreadyOnTarget()) return true;
    }
  }
  return false;
}

async function clickTikTokUsersTab(page: EvaluatablePage): Promise<boolean> {
  const selectors = [
    'a[href*="/search/user"]',
    '[role="tab"]',
    'button',
  ];
  for (const selector of selectors) {
    const candidates = page.locator(selector) as unknown as LocatorLike;
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth ? candidates.nth(index) : candidates;
      if (!await isLocatorVisible(candidate)) continue;
      const label = normalizeTikTokUiText(
        `${await candidate.textContent?.() ?? ''} ${await candidate.getAttribute?.('aria-label') ?? ''}`,
      );
      if (!/^(users?|người dùng|tài khoản)$/.test(label)) continue;
      if (!candidate.click) continue;
      await candidate.click();
      return true;
    }
  }
  return false;
}

async function clickTikTokSearchTab(page: EvaluatablePage, expected: RegExp): Promise<boolean> {
  for (const selector of ['[role="tab"]', 'a', 'button']) {
    const candidates = page.locator(selector) as unknown as LocatorLike;
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth ? candidates.nth(index) : candidates;
      if (!await isLocatorVisible(candidate)) continue;
      const label = normalizeTikTokUiText(
        `${await candidate.textContent?.() ?? ''} ${await candidate.getAttribute?.('aria-label') ?? ''}`,
      );
      if (!expected.test(label) || !candidate.click) continue;
      await candidate.click();
      return true;
    }
  }
  return false;
}

function extractTikTokUsernameFromUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, tiktokHomeUrl);
    const match = parsed.pathname.match(/^\/@([a-zA-Z0-9._-]+)\/?$/);
    return match ? normalizeTikTokUsername(match[1] ?? '') : undefined;
  } catch {
    return undefined;
  }
}

async function describeTikTokProfileSearchSurface(
  page: EvaluatablePage,
  targetUsername: string,
): Promise<string | undefined> {
  if (!page.evaluate) return undefined;
  try {
    const snapshot = await page.evaluate((expected) => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && element.getClientRects().length > 0;
      };
      const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/@"]')]
        .filter(visible)
        .slice(0, 20)
        .map((anchor) => ({ href: anchor.getAttribute('href'), text: (anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) }));
      return {
        url: location.href,
        expected,
        anchors,
        body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      };
    }, targetUsername);
    return JSON.stringify(snapshot).slice(0, 2_000);
  } catch {
    return undefined;
  }
}

async function waitForTikTokTopResults(
  page: EvaluatablePage,
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<boolean> {
  const deadline = Date.now() + 8_000;
  const canWait = Boolean(page.waitForTimeout);
  let verificationSeen = false;
  while (Date.now() < deadline) {
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired) {
      const solved = await solveVisibleTikTokRotateCaptcha(page, captchaSolver);
      if (solved.solved) {
        await waitForTikTokUi(page, 700, 1_100);
        continue;
      }
      verificationSeen = true;
      // A closeable login/captcha dialog is allowed to disappear.  If the
      // verification surface remains after that, fail closed instead of
      // pretending that an empty result is a successful search.
      await waitForTikTokUi(page, 180, 360);
      const afterClose = await inspectTikTokSearchState(page);
      if (afterClose.verificationRequired) {
        throw new TikTokVerificationRequiredError(
          `TikTok CAPTCHA chưa được giải${solved.reason ? `: ${solved.reason}` : '.'}`,
        );
      }
    }
    const surface = await inspectTikTokResultSurface(page);
    if (surface.explicitEmpty || surface.visibleVideoLinks > 0) return verificationSeen;
    if (!canWait) return verificationSeen;
    await waitForTikTokUi(page, 350, 650);
  }
  return verificationSeen;
}

async function waitForTikTokVideoResults(
  page: EvaluatablePage,
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<boolean> {
  const deadline = Date.now() + 6_000;
  const canWait = Boolean(page.waitForTimeout);
  let verificationSeen = false;
  while (Date.now() < deadline) {
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired) {
      const solved = await solveVisibleTikTokRotateCaptcha(page, captchaSolver);
      if (solved.solved) {
        await waitForTikTokUi(page, 700, 1_100);
        continue;
      }
      verificationSeen = true;
      await waitForTikTokUi(page, 180, 360);
      const afterClose = await inspectTikTokSearchState(page);
      if (afterClose.verificationRequired) {
        throw new TikTokVerificationRequiredError(
          `TikTok CAPTCHA chưa được giải${solved.reason ? `: ${solved.reason}` : '.'}`,
        );
      }
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
    'a[href="/foryou"]',
    'a[href="/foryou/"]',
    'a[href^="/foryou?"]',
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
    'a[href="/foryou"]',
    'a[href="/foryou/"]',
    'a',
    'button',
    '[role="link"]',
    '[role="tab"]',
  ], 'for you');
  if (visibleTextTarget) return visibleTextTarget;

  const vietnameseTextTarget = await firstVisibleLocatorWithText(page, [
    'a[href="/"]',
    'a[href="/foryou"]',
    'a[href="/foryou/"]',
    'a',
    'button',
    '[role="link"]',
    '[role="tab"]',
  ], 'dành cho bạn');
  if (vietnameseTextTarget) return vietnameseTextTarget;

  // A few Playwright-compatible test/embedded page implementations do not
  // expose textContent on locators. The class is specific enough to use the
  // first label as a safe fallback in that case.
  return labels.length > 0 && labels.every((label) => !label.textContent) ? labels[0] : undefined;
}

async function hasTikTokFeedSurface(page: EvaluatablePage): Promise<boolean> {
  try {
    const videos = page.locator('a[href*="/video/"]') as unknown as LocatorLike;
    const count = await videos.count();
    for (let index = 0; index < Math.min(count, 8); index += 1) {
      const candidate = videos.nth ? videos.nth(index) : videos;
      if (await isLocatorVisible(candidate)) return true;
    }
    if (page.evaluate) {
      return await page.evaluate(() => Boolean(document.querySelector(
        '[data-e2e*="recommend-list-item" i], [data-e2e*="video-card" i], [data-e2e*="feed-item" i]',
      )));
    }
  } catch {
    // The root document may still be replacing itself; let the normal retry
    // window continue instead of treating that transient state as a feed.
  }
  return false;
}

async function isTikTokForYouSurface(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    return await page.evaluate(() => /^\/(?:foryou)?\/?$/i.test(location.pathname)
      || Boolean(document.querySelector(
        '[data-e2e*="recommend" i], [data-e2e*="feed-item" i], [data-e2e*="video-card" i]',
      )));
  } catch {
    return false;
  }
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
  // CAPTCHA is a blocking verification surface, not an optional TikTok
  // dialog. Never let the generic popup cleanup click its close button.
  if (await hasVisibleTikTokCaptcha(page)) return;

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
    const result = await page.evaluate((captchaSelector) => {
      const selector = captchaSelector ?? '';
      const normalize = (value: string | null | undefined): string => (value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase();
      const isCaptchaRoot = (root: HTMLElement): boolean => root.matches(selector)
        || Boolean(root.querySelector(selector));
      const roots = [...document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [data-floating-ui-portal], [data-testid*="modal"], [data-e2e*="modal"]',
      )];
      const visible = (element: HTMLElement): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && element.getClientRects().length > 0;
      };
      for (const root of roots.reverse()) {
        if (!visible(root)) continue;
        if (isCaptchaRoot(root)) continue;
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
    }, TIKTOK_CAPTCHA_ROOT_SELECTOR);
    return result === true;
  } catch {
    return false;
  }
}

async function hasVisibleTikTokCloseablePopup(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    const result = await page.evaluate((captchaSelector) => {
      const selector = captchaSelector ?? '';
      const isCaptchaRoot = (root: HTMLElement): boolean => root.matches(selector)
        || Boolean(root.querySelector(selector));
      const roots = [...document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [data-floating-ui-portal], [data-testid*="modal"], [data-e2e*="modal"]',
      )];
      const overlay = document.querySelector<HTMLElement>('#tux-web-canary-1-modal-overlay');
      if (overlay) {
        const overlayStyle = window.getComputedStyle(overlay);
        const overlayVisible = overlayStyle.display !== 'none'
          && overlayStyle.visibility !== 'hidden'
          && overlay.getClientRects().length > 0;
        const portal = overlay.closest<HTMLElement>('[data-floating-ui-portal]') ?? overlay.parentElement;
        if (overlayVisible && portal && !isCaptchaRoot(portal) && portal.querySelector('button, [role="button"]')) return true;
      }
      return roots.some((root) => {
        const style = window.getComputedStyle(root);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && root.getClientRects().length > 0
          && !isCaptchaRoot(root)
          && Boolean(root.querySelector('button, [role="button"], [data-e2e*="close"], [data-testid*="close"], [class*="CloseButtonWrapper"]'));
      });
    }, TIKTOK_CAPTCHA_ROOT_SELECTOR);
    return result === true;
  } catch {
    return false;
  }
}

/** CAPTCHA/BDTuring roots are protected from all generic popup cleanup. */
async function hasVisibleTikTokCaptcha(page: EvaluatablePage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    // Playwright's locator engine pierces open shadow roots, while
    // document.querySelectorAll (used below for frame diagnostics) does not.
    // Check the same protected-root selectors through the live browser API so
    // a shadow-mounted BDTuring widget cannot be mistaken for a normal popup.
    const protectedRoots = page.locator(TIKTOK_CAPTCHA_ROOT_SELECTOR) as unknown as LocatorLike;
    const protectedRootCount = await protectedRoots.count();
    for (let index = 0; index < protectedRootCount; index += 1) {
      const candidate = protectedRoots.nth ? protectedRoots.nth(index) : protectedRoots;
      if (await isLocatorVisible(candidate)) return true;
    }
    for (const selector of [
      'text=Drag the slider to fit the puzzle',
      'text=/drag\\s+the\\s+slider/i',
      'text=/slide\\s+to\\s+complete/i',
    ]) {
      const instruction = page.locator(selector) as unknown as LocatorLike;
      const count = await instruction.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = instruction.nth ? instruction.nth(index) : instruction;
        if (await isLocatorVisible(candidate)) return true;
      }
    }

    const mainFrameHasChallenge = await page.evaluate((captchaSelector) => {
      const isVisible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && element.getClientRects().length > 0;
      };
      const selector = captchaSelector ?? '';
      const roots = [...document.querySelectorAll<HTMLElement>(selector)];
      if (roots.some(isVisible)) return true;

      // The current TikTok BDTuring variant can render the challenge in a
      // generic portal/canvas without a captcha class on the root. Its
      // visible instruction is stable, so use that as a second signal. This
      // also matters when the challenge is mounted only after the comment
      // drawer is opened.
      const bodyText = document.body?.innerText ?? '';
      if (!/drag\s+the\s+slider|slide\s+to\s+complete|verify\s+you\s+are\s+human|security\s+verification/i.test(bodyText)) {
        return false;
      }
      return [...document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="verify" i], [class*="captcha" i], canvas, iframe',
      )].some(isVisible);
    }, TIKTOK_CAPTCHA_ROOT_SELECTOR);
    if (mainFrameHasChallenge) return true;

    // BDTuring sometimes puts the entire visible puzzle in a generic
    // cross-origin iframe. The parent document then contains neither the
    // instruction text nor a captcha-specific class; inspect the child-frame
    // body text and its visible challenge nodes as well.
    for (const frame of page.frames?.().slice(1) ?? []) {
      if (!frame.evaluate) continue;
      try {
        const frameHasChallenge = await frame.evaluate(() => {
          const isVisible = (element: Element): boolean => {
            const style = window.getComputedStyle(element);
            return style.display !== 'none'
              && style.visibility !== 'hidden'
              && style.opacity !== '0'
              && element.getClientRects().length > 0;
          };
          const bodyText = document.body?.innerText ?? '';
          const instruction = /drag\s+the\s+slider|slide\s+to\s+complete|verify\s+you\s+are\s+human|security\s+verification/i.test(bodyText);
          if (!instruction) return false;
          return [...document.querySelectorAll<HTMLElement>(
            '[class*="captcha" i], [class*="verify" i], [class*="slide" i], [id*="captcha" i], [id*="verify" i], canvas, img',
          )].some(isVisible);
        });
        if (frameHasChallenge) return true;
      } catch {
        // The frame may detach while TikTok refreshes the challenge.
      }
    }
    return false;
  } catch {
    return false;
  }
}

const TIKTOK_CAPTCHA_ROOT_SELECTOR = [
  '.captcha_verify_container',
  '.captcha-verify-container',
  '[class*="captcha_verify_container" i]',
  '[class*="captcha-verify-container" i]',
  '[data-e2e*="captcha" i]',
  '[data-e2e*="verify" i]',
  '[class*="bdturing" i]',
  '[class*="captcha" i]',
  '[class*="verify" i]',
  '[id*="captcha" i]',
  '[id*="bdturing" i]',
  'iframe[src*="captcha" i]',
  'iframe[src*="bdturing" i]',
].join(', ');

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

/** Wait for the smooth scroll, result cards, and their thumbnails to hydrate. */
async function waitForTikTokResultsLoad(page: EvaluatablePage, previousVideoCount: number): Promise<void> {
  if (!page.evaluate) {
    await waitForTikTokUi(page, 500, 900);
    return;
  }
  const deadline = Date.now() + 3_500;
  let settledPasses = 0;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]')].filter(visible);
      const images = links.flatMap(link => {
        const card = link.closest('article, li, [data-e2e], [class*="DivItemContainer" i]') ?? link.parentElement ?? link;
        return [...card.querySelectorAll<HTMLImageElement>('img')];
      }).filter(visible);
      const mediaLoading = images.some(image => !image.complete || image.naturalWidth === 0);
      return { videoCount: links.length, mediaLoading };
    }).catch(() => ({ videoCount: 0, mediaLoading: false }));
    if (snapshot.videoCount > previousVideoCount && !snapshot.mediaLoading) return;
    if (snapshot.videoCount >= previousVideoCount && !snapshot.mediaLoading) settledPasses += 1;
    else settledPasses = 0;
    if (settledPasses >= 2) return;
    await waitForTikTokUi(page, 180, 320);
  }
  // The result list can contain cards without images (for example while the
  // CDN is slow). Do not discard the cards just because the media deadline
  // expired; extraction will still return their URL/title/username.
}

async function waitForTikTokUi(page: EvaluatablePage, minMs = 350, maxMs = 750): Promise<void> {
  await page.waitForTimeout?.(randomInteger(minMs, maxMs));
}

/** Add a small human-like pause between high-level browser actions. */
async function waitForTikTokActionDelay(page: EvaluatablePage): Promise<void> {
  await waitForTikTokUi(page, 450, 900);
}

function randomInteger(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Solve the visible TikTok whirl CAPTCHA through the injected solver and then
 * perform the browser-native drag. The worker owns the remote API client; the
 * adapter only knows how to extract the two rendered images and operate the
 * normal slider control.
 */
export async function solveVisibleTikTokRotateCaptcha(
  page: EvaluatablePage,
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<TikTokRotateCaptchaSolveResult> {
  if (!captchaSolver) return { attempted: false, solved: false, reason: 'disabled' };
  if (!page.evaluate || !page.mouse) {
    return { attempted: false, solved: false, reason: 'browser page does not expose evaluate/mouse controls' };
  }

  const maxAttempts = 5;
  const previousAttempts = tikTokRotateSolveAttempts.get(page) ?? 0;
  if (previousAttempts >= maxAttempts) return { attempted: true, solved: false, reason: 'solve attempt limit reached' };

  const boxSummary = (box: { x: number; y: number; width: number; height: number } | undefined): string => box
    ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}x${Math.round(box.height)}`
    : 'none';
  let lastReason = 'TikTok rotate CAPTCHA could not be solved';
  let attempted = false;

  // A rejected drag causes TikTok to issue a fresh challenge. Retry against
  // the fresh image pair instead of reusing a stale provider answer.
  for (let attemptIndex = previousAttempts; attemptIndex < maxAttempts; attemptIndex += 1) {
    let challenge: TikTokRotateChallengeSnapshot | undefined;
    for (let waitAttempt = 0; waitAttempt < 8 && !challenge; waitAttempt += 1) {
      challenge = await inspectTikTokRotateChallenge(page);
      if (!challenge) await page.waitForTimeout?.(250);
    }
    if (!challenge) {
      const diagnostics = await describeTikTokCaptchaSurface(page);
      lastReason = `rotate images or slider were not found${diagnostics ? ` (${diagnostics})` : ''}`;
      captchaSolver.report?.(lastReason);
      if (attemptIndex + 1 >= maxAttempts) break;
      await page.waitForTimeout?.(500);
      continue;
    }
    attempted = true;
    tikTokRotateSolveAttempts.set(page, attemptIndex + 1);

    try {
      const rotate = await captchaSolver.solveRotate(challenge.imageBase64s);
      if (!Number.isFinite(rotate) || rotate < 0 || rotate > 1) {
        lastReason = 'solver returned an invalid rotate ratio';
        captchaSolver.report?.(lastReason);
        continue;
      }
      await dragTikTokRotateSlider(page, challenge, rotate);

      // TikTok verifies asynchronously after mouseup. Poll briefly instead of
      // immediately classifying the still-mounted widget as an unsolved CAPTCHA.
      for (let pollAttempt = 0; pollAttempt < 8; pollAttempt += 1) {
        await page.waitForTimeout?.(300 + pollAttempt * 100);
        const state = await inspectTikTokSearchState(page);
        if (!state.verificationRequired) return { attempted: true, solved: true };
      }
      lastReason = `TikTok challenge remained visible after drag (rotate=${Math.round(rotate * 180).toString()}deg; inside=${boxSummary(challenge.imageBoxes.inside)}; outside=${boxSummary(challenge.imageBoxes.outside)}; track=${boxSummary(challenge.track)}; handle=${boxSummary(challenge.handle)})`;
      captchaSolver.report?.(lastReason);
      await page.waitForTimeout?.(500);
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      captchaSolver.report?.(lastReason);
      await page.waitForTimeout?.(500);
    }
  }

  return { attempted, solved: false, reason: lastReason };
}

async function inspectTikTokRotateChallenge(
  page: EvaluatablePage,
): Promise<TikTokRotateChallengeSnapshot | undefined> {
  const inside = await captureTikTokCaptchaImage(page, [
    '.captcha_verify_container .captcha_verify_img_slide:visible',
    '.captcha_verify_container [class*="captcha_verify_img_slide" i]:visible',
    '.captcha-verify-container .captcha_verify_img_slide:visible',
    '.captcha-verify-container [class*="cap-absolute" i]:visible',
    '.captcha-verify-container [class*="puzzle" i]:visible',
    '[class*="captcha_verify_container" i] [class*="captcha_verify_img_slide" i]:visible',
    '[class*="captcha-verify-container" i] [class*="cap-absolute" i]:visible',
  ]);
  const outside = await captureTikTokCaptchaImage(page, [
    '.captcha_verify_container #captcha-verify-image:visible',
    '.captcha_verify_container .captcha_verify_img:not(.captcha_verify_img_slide):visible',
    '.captcha-verify-container #captcha-verify-image:visible',
    '.captcha-verify-container img[class*="cap-h" i]:visible',
    '[class*="captcha_verify_container" i] [class*="captcha_verify_img" i]:not([class*="slide" i]):visible',
    '[class*="captcha-verify-container" i] img:visible',
  ]);

  const fallbackImages = inside && outside
    ? undefined
    : await captureTikTokCaptchaImages(page);
  const imagePair = inside && outside
    ? [inside.base64, outside.base64] as [string, string]
    : fallbackImages && fallbackImages.length >= 2
      ? [fallbackImages[0]!.base64, fallbackImages[1]!.base64] as [string, string]
      : fallbackImages?.length === 1
        // New TikTok BDTuring renders the inner and outer circles together in
        // one 210px image. AntiCaptcha type 43 still requires both fields;
        // send the composite image in both slots for this widget variant.
        ? [fallbackImages[0]!.base64, fallbackImages[0]!.base64] as [string, string]
        : undefined;
  if (!imagePair || imagePair.length !== 2) return undefined;

  const slider = await inspectTikTokSlider(page);
  const track = slider?.track ?? await firstVisibleBox(page, [
    '.captcha_verify_container .captcha_verify_slide--slidebar:visible',
    '.captcha_verify_container [class*="captcha_verify_slide--slidebar" i]:visible',
    '.captcha-verify-container [class*="slidebar" i]:visible',
    '.captcha-verify-container [class*="slider" i]:visible',
    '[class*="captcha_verify_container" i] [class*="slidebar" i]:visible',
    '[class*="captcha_verify_container" i] [class*="slider" i]:visible',
  ]);
  if (!track || track.width <= 1 || track.height <= 1) return undefined;

  const handle = slider?.handle ?? await firstVisibleBox(page, [
    '.captcha_verify_container .secsdk-captcha-drag-icon:visible',
    '.captcha_verify_container [class*="secsdk-captcha-drag-icon" i]:visible',
    '.captcha-verify-container #captcha_slide_button:visible',
    '.captcha-verify-container [class*="secsdk-captcha-drag-icon" i]:visible',
    '#captcha_slide_button:visible',
    '[class*="captcha_verify_container" i] [class*="drag-icon" i]:visible',
    '[class*="captcha_verify_container" i] [class*="slidebar" i] [class*="drag" i]:visible',
  ]);
  return {
    imageBase64s: imagePair,
    imageBoxes: {
      ...(inside ? { inside: inside.box } : {}),
      ...(outside ? { outside: outside.box } : {}),
    },
    track,
    ...(handle ? { handle } : {}),
  };
}

async function inspectTikTokSlider(
  page: EvaluatablePage,
): Promise<{ track: { x: number; y: number; width: number; height: number }; handle: { x: number; y: number; width: number; height: number } } | undefined> {
  if (!page.evaluate) return undefined;
  try {
    return await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const button = document.querySelector<HTMLElement>(
        '#captcha_slide_button, .captcha-verify-container .secsdk-captcha-drag-icon',
      );
      if (!button || !visible(button)) return undefined;
      const handle = rect(button);
      let ancestor: HTMLElement | null = button.parentElement;
      for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
        if (!visible(ancestor)) continue;
        const candidate = rect(ancestor);
        if (candidate.width >= handle.width * 2 && candidate.height >= handle.height * 0.6 && candidate.height <= handle.height * 2) {
          return { track: candidate, handle };
        }
      }
      return undefined;
    });
  } catch {
    return undefined;
  }
}

async function captureTikTokCaptchaImage(
  page: EvaluatablePage,
  selectors: string[],
): Promise<{ base64: string; area: number; box: { x: number; y: number; width: number; height: number } } | undefined> {
  for (const context of selectorContexts(page)) {
    for (const selector of selectors) {
      const locator = context.locator(selector) as LocatorLike;
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth ? locator.nth(index) : locator;
        if (!(await isLocatorVisible(candidate)) || !candidate.screenshot) continue;
        try {
          const screenshot = await candidate.screenshot();
          const box = await candidate.boundingBox?.();
          if (!screenshot.length || !box || box.width <= 1 || box.height <= 1) continue;
          const source = await candidate.getAttribute?.('src');
          const embeddedBase64 = source?.match(/^data:[^;]+;base64,(.+)$/i)?.[1];
          return {
            base64: embeddedBase64 || screenshot.toString('base64'),
            area: box.width * box.height,
            box,
          };
        } catch {
          // A challenge image can be replaced while it is loading. Continue
          // with the next selector/candidate rather than failing the task.
        }
      }
    }
  }
  return undefined;
}

async function captureTikTokCaptchaImages(
  page: EvaluatablePage,
): Promise<Array<{ base64: string; area: number }>> {
  const images: Array<{ base64: string; area: number }> = [];
  const seen = new Set<string>();
  const selectors = [
    '.captcha_verify_container img:visible',
    '.captcha_verify_container canvas:visible',
    '.captcha-verify-container img:visible',
    '.captcha-verify-container [class*="cap-absolute" i]:visible',
    '.captcha-verify-container [class*="puzzle" i]:visible',
    '[class*="captcha_verify_container" i] img:visible',
    '[class*="captcha_verify_container" i] canvas:visible',
    '[class*="captcha-verify-container" i] img:visible',
    '[class*="captcha-verify-container" i] canvas:visible',
    '[class*="captcha-verify-container" i] [class*="cap-absolute" i]:visible',
  ];
  for (const context of selectorContexts(page)) {
    for (const selector of selectors) {
      const locator = context.locator(selector) as LocatorLike;
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth ? locator.nth(index) : locator;
        if (!(await isLocatorVisible(candidate)) || !candidate.screenshot) continue;
        try {
          const screenshot = await candidate.screenshot();
          const box = await candidate.boundingBox?.();
          if (!screenshot.length || !box || box.width <= 1 || box.height <= 1) continue;
          const base64 = screenshot.toString('base64');
          if (seen.has(base64)) continue;
          seen.add(base64);
          images.push({ base64, area: box.width * box.height });
        } catch {
          // See captureTikTokCaptchaImage: the challenge may be rerendering.
        }
      }
    }
  }
  return images.sort((left, right) => left.area - right.area).slice(0, 2);
}

async function firstVisibleBox(
  page: EvaluatablePage,
  selectors: string[],
): Promise<{ x: number; y: number; width: number; height: number } | undefined> {
  for (const context of selectorContexts(page)) {
    for (const selector of selectors) {
      const locator = context.locator(selector) as LocatorLike;
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth ? locator.nth(index) : locator;
        if (!(await isLocatorVisible(candidate)) || !candidate.boundingBox) continue;
        const box = await candidate.boundingBox().catch(() => null);
        if (box && box.width > 1 && box.height > 1) return box;
      }
    }
  }
  return undefined;
}

function selectorContexts(page: EvaluatablePage): Array<{ locator: (selector: string) => unknown }> {
  // Playwright's page.frames() includes the main frame at index zero. Search
  // it through page.locator once, then inspect child frames for TikTok's
  // cross-origin BDTuring widget, which is where the images often live.
  return [page, ...(page.frames?.().slice(1) ?? [])];
}

/** Keep challenge extraction failures actionable without logging page HTML or
 * image data. This is especially useful when TikTok moves the widget into a
 * new BDTuring iframe/class name. */
async function describeTikTokCaptchaSurface(page: EvaluatablePage): Promise<string | undefined> {
  const contexts = [page, ...(page.frames?.().slice(1) ?? [])] as Array<{
    evaluate?: <T>(pageFunction: () => T) => Promise<T>;
  }>;
  const snapshots: unknown[] = [];
  for (const context of contexts.slice(0, 6)) {
    if (!context.evaluate) continue;
    try {
      snapshots.push(await context.evaluate(() => {
        const visible = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const safeUrl = (value: string): string => {
          if (/^(data|blob):/i.test(value)) return '[embedded-image]';
          try {
            const parsed = new URL(value, window.location.href);
            if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return '[embedded-image]';
            return `${parsed.origin}${parsed.pathname}`;
          } catch {
            return value.split('?')[0]?.slice(0, 160) ?? '';
          }
        };
        const surfaces = [...document.querySelectorAll<HTMLElement>('body *')]
          .filter(element => visible(element) && /captcha|verify|bdturing|whirl|rotate|slide/i.test(
            `${element.id} ${typeof element.className === 'string' ? element.className : ''} ${element.getAttribute('data-e2e') ?? ''}`,
          ))
          .slice(0, 20)
          .map(element => ({
            tag: element.tagName,
            id: element.id,
            className: typeof element.className === 'string' ? element.className.slice(0, 180) : '',
            dataE2e: element.getAttribute('data-e2e'),
          }));
        const images = [...document.querySelectorAll<HTMLImageElement | HTMLCanvasElement>('img, canvas')]
          .filter(visible)
          .slice(0, 20)
          .map(element => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              id: element.id,
              className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              src: element instanceof HTMLImageElement ? safeUrl(element.currentSrc || element.src) : undefined,
            };
          });
        const backgrounds = [...document.querySelectorAll<HTMLElement>('*')]
          .filter(element => visible(element) && window.getComputedStyle(element).backgroundImage !== 'none')
          .slice(0, 20)
          .map(element => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              id: element.id,
              className: typeof element.className === 'string' ? element.className.slice(0, 120) : '',
              width: Math.round(rect.width),
              height: Math.round(rect.height),
              hasBackgroundImage: true,
            };
          });
        return {
          href: safeUrl(window.location.href),
          title: document.title.slice(0, 120),
          iframes: [...document.querySelectorAll<HTMLIFrameElement>('iframe')]
            .filter(visible)
            .slice(0, 10)
            .map(frame => ({ title: frame.title, src: safeUrl(frame.src) })),
          surfaces,
          images,
          backgrounds,
        };
      }));
    } catch {
      // A cross-origin or already-detached frame is not diagnostic data.
    }
  }
  if (snapshots.length === 0) return undefined;
  return JSON.stringify(snapshots).slice(0, 2_500);
}

async function dragTikTokRotateSlider(
  page: EvaluatablePage,
  challenge: TikTokRotateChallengeSnapshot,
  rotate: number,
): Promise<void> {
  const handle = challenge.handle ?? {
    x: challenge.track.x,
    y: challenge.track.y,
    width: Math.min(challenge.track.height, 40),
    height: challenge.track.height,
  };
  const startX = handle.x + handle.width / 2;
  const startY = handle.y + handle.height / 2;
  // TikTok's web whirl slider maps 0..1 to the usable travel of the bar,
  // excluding the drag icon's own width.
  const travel = Math.max(1, challenge.track.width - handle.width);
  const targetX = Math.min(
    challenge.track.x + handle.width / 2 + travel,
    Math.max(challenge.track.x + handle.width / 2, challenge.track.x + handle.width / 2 + travel * rotate),
  );
  const steps = 24 + Math.round(rotate * 12);
  await page.mouse!.move(startX, startY);
  await page.mouse!.down();
  try {
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const jitter = index === steps ? 0 : (Math.random() - 0.5) * 2;
      await page.mouse!.move(
        startX + (targetX - startX) * progress,
        startY + jitter,
        { steps: 1 },
      );
      await page.waitForTimeout?.(12 + Math.floor(Math.random() * 18));
    }
  } finally {
    await page.mouse!.up();
  }
}

async function inspectTikTokSearchState(page: EvaluatablePage): Promise<{ verificationRequired: boolean; explicitEmpty: boolean }> {
  if (!page.evaluate) return { verificationRequired: false, explicitEmpty: false };
  try {
    const snapshot = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? '';
      const challengeNode = [...document.querySelectorAll<HTMLElement>(
        '[data-e2e*="captcha"], [data-e2e*="verify"], [class*="captcha"], [class*="verify"], [class*="bdturing"], [id*="captcha"], [id*="verify"], [id*="bdturing"]',
      )].some((element) => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
      const challengeIframe = [...document.querySelectorAll<HTMLIFrameElement>(
        'iframe[src*="captcha" i], iframe[src*="bdturing" i], iframe[src*="verify" i]',
      )].some((element) => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      });
      return { bodyText, challengeNode, challengeIframe };
    });
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof snapshot.bodyText !== 'string') {
      return { verificationRequired: false, explicitEmpty: false };
    }
    const bodyText = snapshot.bodyText.toLowerCase();
    const signalText = snapshot.bodyText.toLowerCase();
    let nestedFrameChallenge: boolean | undefined;
    if (snapshot.challengeIframe && page.frames) {
      const childFrames = page.frames().slice(1);
      nestedFrameChallenge = childFrames.length === 0 ? true : false;
      let inspectedFrame = false;
      for (const frame of childFrames) {
        if (!frame.evaluate) continue;
        try {
          const frameSnapshot = await frame.evaluate(() => {
            const visible = (element: Element): boolean => {
              const style = window.getComputedStyle(element);
              return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
            };
            const bodyText = document.body?.innerText ?? '';
            const challengeNode = [...document.querySelectorAll<HTMLElement>(
              '[data-e2e*="captcha" i], [data-e2e*="verify" i], [class*="captcha" i], [class*="verify" i], [class*="bdturing" i], [id*="captcha" i], [id*="verify" i], [id*="bdturing" i]',
            )].some(visible);
            const captchaSurface = [...document.querySelectorAll<HTMLElement>(
              '.captcha_verify_container, [class*="captcha_verify_container" i], [class*="captcha-verify-container" i], [class*="slidebar" i] [class*="drag" i]',
            )].some(visible);
            return { bodyText, challengeNode, captchaSurface };
          });
          inspectedFrame = true;
          const frameText = typeof frameSnapshot?.bodyText === 'string' ? frameSnapshot.bodyText.toLowerCase() : '';
          if (frameSnapshot?.challengeNode || frameSnapshot?.captchaSurface || /bdturing|whirl|verify to continue|security verification|captcha|xác minh/.test(frameText)) {
            nestedFrameChallenge = true;
            break;
          }
        } catch {
          // A cross-origin frame may be available for locators but reject
          // evaluate; leave the visible iframe classified as a challenge.
        }
      }
      if (!inspectedFrame) nestedFrameChallenge = true;
    }
    const verificationRequired = snapshot.challengeNode
      || nestedFrameChallenge === true
      || /bdturing|bdturing-verify|whirl|verify to continue|security verification|captcha|unusual traffic|too many requests|anti.?bot|robot|xác minh|bất thường/.test(signalText);
    const explicitEmpty = /no results|no videos|didn't find|nothing found|không tìm thấy|không có kết quả|không có video/.test(bodyText);
    return { verificationRequired, explicitEmpty };
  } catch {
    // A page implementation without evaluate support cannot prove that an
    // empty result is a legitimate empty search, so the caller fails closed.
    return { verificationRequired: false, explicitEmpty: false };
  }
}

async function inspectTikTokSurfaceError(page: EvaluatablePage): Promise<string | undefined> {
  if (!page.evaluate) return undefined;
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? '');
    const normalized = bodyText.replace(/\s+/g, ' ').trim();
    if (/something went wrong|sorry about that|try again later|page isn't available|couldn't load/i.test(normalized)) {
      return normalized.slice(0, 180);
    }
  } catch {
    // The page may have been replaced by a challenge or navigation error.
  }
  return undefined;
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
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<Record<string, unknown>> {
  const page = session.page as EvaluatablePage;
  // Start at TikTok's ordinary root page, wait for the complete shell to
  // hydrate, then enter For You through the visible navigation. Do not jump
  // directly to /foryou: that route is more likely to be rejected on a cold
  // persisted profile.
  await openTikTokHomeFeed(page, { scrollAfterClick: false });
  // The For You surface is lazy. On a cold profile TikTok often renders the
  // shell first and mounts the video cards a little later. Do not start
  // extracting (or conclude that the feed is empty) during that window.
  await waitForTikTokResultsLoad(page, 0);
  const visible = new Map<string, TikTokVideoMetadata>();
  // Keep the first hydrated For You player mounted when no like range was
  // requested.  For You often exposes its item in hydration data without a
  // `/video/` anchor; scrolling before acting would make that item disappear
  // and force an unsafe direct navigation to the video URL.
  const hasLikeFilter = input.minLikes > 0 || input.maxLikes != null;
  const discoveryTarget = hasLikeFilter ? input.maxVideos * 3 : input.maxVideos;
  for (let pass = 0; pass < 10 && visible.size < discoveryTarget; pass += 1) {
    for (const video of await extractVisibleVideos(page)) visible.set(video.videoUrl, video);
    if (visible.size >= discoveryTarget) break;
    await waitForTikTokActionDelay(page);
    await scrollSearchResults(page);
    await waitForTikTokResultsLoad(page, visible.size);
  }

  if (visible.size === 0) {
    const state = await inspectTikTokSearchState(page);
    if (state.verificationRequired) {
      throw new TikTokVerificationRequiredError(
        'TikTok For You đang yêu cầu xác minh anti-bot. Hãy hoàn tất xác minh thủ công trên browser rồi chạy lại campaign.',
      );
    }
    const surfaceError = await inspectTikTokSurfaceError(page);
    if (surfaceError) {
      throw new TikTokVerificationRequiredError(
        `TikTok For You không tải được dữ liệu (${surfaceError}). Hãy kiểm tra phiên TikTok trên browser rồi chạy lại campaign.`,
      );
    }
    throw new TikTokSearchAutomationError(
      'TikTok For You chưa trả về video sau khi chờ tải và scroll; campaign không được ghi nhận thành công với 0 video.',
    );
  }

  // A missing like count is common on the For You surface while the card is
  // still hydrating.  With no like filter configured, the video is still a
  // valid target; only discard unknown counts when the user explicitly asked
  // for a like range.
  const candidates = [...visible.values()].filter((video) => {
    if (video.likes == null) return !hasLikeFilter;
    if (video.likes < input.minLikes) return false;
    return input.maxLikes == null || video.likes <= input.maxLikes;
  }).slice(0, input.maxVideos);

  if (candidates.length === 0) {
    throw new TikTokSearchAutomationError(
      `TikTok For You đã tải ${visible.size.toString()} video nhưng không có video nào phù hợp bộ lọc tim; chưa gửi comment.`,
    );
  }

  const result = await commentTikTokVideos(session, {
    videoUrls: candidates.map((video) => video.videoUrl),
    text: input.text,
    mediaAssetIds: input.mediaAssetIds,
    maxVideos: candidates.length,
    intervalSeconds: input.intervalSeconds,
  }, captchaSolver);
  return { ...result, discovered: visible.size, candidates: candidates.length };
}

export async function commentTikTokVideos(
  session: PlatformSession,
  input: { videoUrls: string[]; text: string; mediaAssetIds: string[]; maxVideos: number; intervalSeconds?: number },
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<Record<string, unknown>> {
  const videos = input.videoUrls.slice(0, input.maxVideos);
  let sent = 0;
  const failures: Array<{ videoUrl: string; reason: string }> = [];

  for (const [index, videoUrl] of videos.entries()) {
    try {
      const page = session.page as EvaluatablePage;
      // For You cards already expose the comment action in the current
      // document. Prefer that client-side surface: TikTok can return 403 for
      // a cold direct navigation to the same video URL even though the card
      // itself is fully playable and commentable.
      const openedCardComments = await clickTikTokCommentOnVisibleCard(page, videoUrl);
      if (!openedCardComments) {
        // A For You player can expose the current video only through
        // hydration data.  Do not turn that into a direct navigation: TikTok
        // may answer the navigation with a 403 while the same player remains
        // usable on the feed surface.
        if (await isTikTokForYouSurface(page)) {
          throw new Error('Không tìm thấy nút mở bình luận trên video For You đang hiển thị');
        }
        await openTikTokVideoPage(page, videoUrl);
      }
      // Give the video page and its comment surface time to hydrate before
      // reading the editor. This mirrors Search's paced navigation and avoids
      // clicking the first card while TikTok is still switching routes.
      await waitForTikTokActionDelay(page);
      await sendComment(session, input.text, input.mediaAssetIds, captchaSolver);
      sent += 1;
      if (input.intervalSeconds && index < videos.length - 1) {
        await page.waitForTimeout?.(input.intervalSeconds * 1_000);
      }
    } catch (error) {
      failures.push({ videoUrl, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    requested: videos.length,
    sent,
    failures,
    ...(sent === 0 && videos.length > 0 ? { reason: 'Không gửi được bình luận TikTok nào.' } : {}),
  };
}

export async function replyTikTokComments(
  session: PlatformSession,
  input: { videoUrls: string[]; text: string; mediaAssetIds: string[]; maxReplies: number; intervalSeconds?: number },
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<Record<string, unknown>> {
  const page = session.page as EvaluatablePage;
  let requested = 0;
  let sent = 0;
  const failures: string[] = [];
  for (let videoIndex = 0; videoIndex < input.videoUrls.length; videoIndex += 1) {
    const videoUrl = input.videoUrls[videoIndex]!;
    try {
      await gotoPlatformPage(session.page, videoUrl);
      await waitForTikTokActionDelay(page);
      const replyButtons = await findLocators(page, [
        '[data-e2e*="comment-reply"]',
        'button[aria-label*="Reply"]',
        'button:has-text("Reply")',
      ]);
      const count = Math.min(replyButtons.length, input.maxReplies);
      requested += count;
      for (let index = 0; index < count; index += 1) {
        try {
          await waitForTikTokActionDelay(page);
          await replyButtons[index]!.click?.();
          await waitForTikTokUi(page, 350, 700);
          await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
          const editor = await fillTikTokCommentEditor(page, input.text, tiktokCommentEditorSelectors);
          if (!editor) throw new Error('Không thể nhập nội dung vào ô reply TikTok');
          await submitComment(page, input.text, input.mediaAssetIds, session, captchaSolver);
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
      await gotoPlatformPage(session.page, videoUrl);
      await waitForTikTokActionDelay(page);
      const likeButtons = await findLocators(page, [
        '[data-e2e*="comment-like"]',
        'button[aria-label*="Like"]',
      ]);
      const count = Math.min(likeButtons.length, input.maxLikes);
      requested += count;
      for (let index = 0; index < count; index += 1) {
        try {
          await waitForTikTokActionDelay(page);
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
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<Record<string, unknown>> {
  let page = session.page as EvaluatablePage;
  const username = input.username.replace(/^@/, '');
  // Start from TikTok's root, wait for the shell to settle, then open the
  // channel directly. This avoids the extra home -> search -> result steps
  // while preserving the same navigation/recovery behaviour used elsewhere.
  await enterTikTokRoot(page);
  await waitForTikTokPageReady(page);
  await waitForTikTokActionDelay(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  await session.captureStepScreenshot?.('tiktok-message-root-ready');
  await gotoPlatformPage(page, buildTikTokProfileUrl(username));
  await waitForTikTokPageReady(page);
  await waitForTikTokActionDelay(page);
  await dismissTikTokBlockingPopup(page);
  await dismissTikTokCloseablePopup(page);
  await session.captureStepScreenshot?.('tiktok-message-channel-profile');
  // The profile route can mount BDTuring a moment after the search-result
  // click. Resolve it before looking for the followers control; otherwise the
  // challenge overlay makes the visible/hidden responsive tabs misleading.
  await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
  let followersButton = await waitForTikTokFollowersButton(page);
  if (!followersButton) {
    // TikTok sometimes leaves a cold direct profile on its interstitial
    // "Please wait" document. Keep the requested direct URL as the fast path,
    // then fall back to the hydrated home-search route in the same tab only
    // for that case. A new tab has no tab-scoped TikTok bootstrap state and
    // is much more likely to receive the anti-bot "Please wait" surface.
    await session.captureStepScreenshot?.('tiktok-message-direct-profile-not-ready');
    await enterTikTokRoot(page);
    await waitForTikTokPageReady(page);
    await waitForTikTokActionDelay(page);
    await searchTikTokProfileFromHome(page, username, captchaSolver);
    await waitForTikTokActionDelay(page);
    await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
    await session.captureStepScreenshot?.('tiktok-message-channel-profile-search-fallback');
    followersButton = await waitForTikTokFollowersButton(page);
  }
  if (!followersButton?.click) throw new Error('Không tìm thấy danh sách follower của kênh TikTok');
  const ownUsernames = new Set(
    [session.accountUsername, session.accountExternalId]
      .map(value => normalizeTikTokUsername(value ?? ''))
      .filter(Boolean),
  );
  // The account table can contain a display name and a stale external id,
  // while TikTok's current handle is exposed only by the signed-in profile
  // link in the left rail. Read that rendered handle before opening followers
  // so the campaign never messages the logged-in account itself.
  for (const handle of await extractVisibleTikTokProfileHandles(page)) {
    if (normalizeTikTokUsername(handle) !== normalizeTikTokUsername(username)) {
      ownUsernames.add(normalizeTikTokUsername(handle));
    }
  }
  await waitForTikTokActionDelay(page);
  await followersButton.click();
  await waitForTikTokActionDelay(page);
  await session.captureStepScreenshot?.('tiktok-message-followers-list');

  const followers = new Map<string, string>();
  let unchangedPasses = 0;
  for (let pass = 0; pass < 10 && followers.size < input.maxFollowers; pass += 1) {
    const before = followers.size;
    for (const follower of await extractVisibleFollowerProfiles(page)) {
      if (followers.size >= input.maxFollowers) break;
      if (ownUsernames.has(normalizeTikTokUsername(follower.username))) continue;
      followers.set(follower.username, follower.profileUrl);
    }
    unchangedPasses = followers.size === before ? unchangedPasses + 1 : 0;
    if (unchangedPasses >= 2 || followers.size >= input.maxFollowers) break;
    await scrollFollowerList(page);
    await waitForTikTokActionDelay(page);
  }

  const targets = [...followers.entries()].slice(0, input.maxFollowers);
  await session.captureStepScreenshot?.('tiktok-message-followers-collected');
  let sent = 0;
  const failures: Array<{ username: string; reason: string }> = [];
  for (const [targetUsername, targetProfileUrl] of targets) {
    try {
      // Keep each recipient on the same protected route: search from home and
      // click the exact follower result instead of opening the collected href
      // as a direct navigation. TikTok can nevertheless return an approximate
      // handle for a follower whose rendered href is valid. In that case use
      // the verified href from the follower list as a bounded UI fallback.
      try {
        await searchTikTokProfileFromHome(page, targetUsername, captchaSolver);
      } catch (searchError) {
        await gotoPlatformPage(page, targetProfileUrl);
        await waitForTikTokPageReady(page);
        await waitForTikTokActionDelay(page);
        await dismissTikTokBlockingPopup(page);
        await dismissTikTokCloseablePopup(page);
        await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
        if (!await hasTikTokProfileSurface(page)) throw searchError;
      }
      await waitForTikTokActionDelay(page);
      await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
      await session.captureStepScreenshot?.('tiktok-message-follower-profile');
      // Do not match the persistent left-rail `nav-messages` control. On a
      // profile route it opens the general inbox without selecting the target
      // conversation, so the composer never mounts and the send step reports
      // a misleading missing-editor error. Prefer profile-specific controls,
      // then require the exact visible label "Message".
      const messageButton = await findTikTokProfileMessageButton(page);
      if (!messageButton?.click) throw new Error('Không tìm thấy nút nhắn tin cho follower');
      await waitForTikTokActionDelay(page);
      await messageButton.click();
      await waitForTikTokActionDelay(page);
      await session.captureStepScreenshot?.('tiktok-message-composer-route');
      await sendTikTokMessage(session, input.text, input.mediaAssetIds, captchaSolver, targetUsername, targetProfileUrl);
      await session.captureStepScreenshot?.('tiktok-message-sent');
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

async function waitForTikTokFollowersButton(page: EvaluatablePage): Promise<LocatorLike | undefined> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const button = await firstVisibleLocator(page, [
      'a[href*="/followers"]',
      '[data-e2e*="followers"]',
      'button:has-text("Followers")',
    ]);
    if (button) return button;
    await waitForTikTokUi(page, 550, 950);
  }
  return undefined;
}

async function findTikTokProfileMessageButton(page: EvaluatablePage): Promise<LocatorLike | undefined> {
  // TikTok's current desktop profile surface uses `message-button`. Keep the
  // profile-specific selectors ahead of the text fallback so the persistent
  // left-rail Messages button can never open the generic inbox by mistake.
  return await firstVisibleLocator(page, [
    '[data-e2e="message-button"]',
    '[data-e2e="user-profile-message"]',
    '[data-e2e="profile-message"]',
    '[data-e2e="message"]',
    '[data-testid*="profile-message" i]',
    'button[aria-label="Message"]',
    'a[aria-label="Message"]',
  ]) ?? await firstVisibleLocatorWithText(page, [
    'button',
    'a',
    '[role="button"]',
  ], 'Message');
}

async function sendComment(
  session: PlatformSession,
  text: string,
  mediaAssetIds: string[],
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<void> {
  const page = session.page as EvaluatablePage;
  // TikTok can place the rotate challenge over the freshly opened comment
  // drawer. Resolve it before looking for an editor; otherwise the overlay
  // makes every editor candidate invisible and the task incorrectly reports
  // that the comment text was not accepted.
  await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
  let editor: LocatorLike | undefined;
  for (let attempt = 0; attempt < 10 && !editor; attempt += 1) {
    editor = await findVisibleLocator(page, tiktokCommentEditorSelectors);
    if (editor) break;
    // The comment drawer is lazy-mounted on both direct video routes and
    // feed-card panels. Re-resolve the opener on every pass because TikTok
    // recycles the card DOM during hydration.
    const commentOpener = await firstVisibleLocator(page, [
      '[data-e2e="comment-icon"]',
      '[data-e2e*="comment-icon" i]',
      '[data-e2e*="comment" i]',
      'button[aria-label*="comment" i]',
      'button[aria-label*="bình luận" i]',
      '[role="button"][aria-label*="comment" i]',
      '[role="button"][aria-label*="bình luận" i]',
    ]);
    if (commentOpener?.click) {
      try { await commentOpener.click(); } catch { /* Re-resolve after route hydration. */ }
    }
    await waitForTikTokUi(page, 350, 750);
    // Opening the drawer is what triggers the BDTuring challenge on some
    // desktop builds. Solve it here before trying the editor again; waiting
    // until submit would leave the overlay covering the editor and produce a
    // misleading "text was not accepted" error.
    await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
    editor = await findVisibleLocator(page, tiktokCommentEditorSelectors);
  }
  // A challenge can be mounted just after the final editor scan. Give the
  // solver one last chance, then re-scan the live drawer before failing.
  if (!editor) {
    await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
    editor = await findVisibleLocator(page, tiktokCommentEditorSelectors);
  }
  let filled = editor
    ? await fillTikTokCommentEditor(page, text, tiktokCommentEditorSelectors)
    : false;
  if (!filled) {
    filled = await fillTikTokCommentByVisiblePlaceholder(page, text);
  }
  if (!filled) {
    const diagnostics = await describeTikTokCommentEditors(page);
    throw new Error(`${editor ? 'TikTok không nhận nội dung trong ô nhập bình luận' : 'Không tìm thấy ô nhập bình luận TikTok'}${diagnostics ? ` (${diagnostics})` : ''}`);
  }
  await waitForTikTokActionDelay(page);
  await submitComment(page, text, mediaAssetIds, session, captchaSolver);
}

async function findVisibleLocator(page: EvaluatablePage, selectors: string[]): Promise<LocatorLike | undefined> {
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

async function readTikTokEditorValue(editor: LocatorLike): Promise<string> {
  const inputValue = editor.inputValue ? await editor.inputValue().catch(() => '') : '';
  if (inputValue) return inputValue;
  const text = editor.textContent ? await editor.textContent().catch(() => null) : null;
  if (text) return text;
  const innerText = editor.innerText ? await editor.innerText().catch(() => '') : '';
  if (innerText) return innerText;
  const value = editor.getAttribute ? await editor.getAttribute('value').catch(() => null) : null;
  return value ?? '';
}

async function fillTikTokCommentEditor(
  page: EvaluatablePage,
  text: string,
  selectors: string[],
): Promise<boolean> {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  for (const selector of selectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const editor = locator.nth ? locator.nth(index) : locator;
      if (!await isLocatorVisible(editor) || !editor.fill) continue;
      try {
        await editor.click?.();
        await editor.fill(text);
        await waitForTikTokUi(page, 180, 420);
        let actual = (await readTikTokEditorValue(editor)).replace(/\s+/g, ' ').trim();
        if (actual === normalizedText || actual.includes(normalizedText)) return true;

        // Some TikTok editor builds swallow Playwright's fill event while the
        // comment drawer is hydrating. Re-focus the same live control and use
        // native keyboard input as a fallback, then verify the rendered value
        // before allowing the Post action.
        if (editor.fill) await editor.fill('');
        if (editor.pressSequentially) await editor.pressSequentially(text);
        else if (editor.type) await editor.type(text);
        await waitForTikTokUi(page, 180, 420);
        actual = (await readTikTokEditorValue(editor)).replace(/\s+/g, ' ').trim();
        if (actual === normalizedText || actual.includes(normalizedText)) return true;
      } catch {
        // A recycled TikTok comment drawer can detach the candidate while it
        // is being hydrated. Try the next live editor instead of submitting
        // against a disabled/stale Post button.
      }
    }
  }
  return false;
}

async function fillTikTokCommentByVisiblePlaceholder(page: EvaluatablePage, text: string): Promise<boolean> {
  const placeholder = await firstVisibleLocator(page, tiktokCommentPlaceholderSelectors);
  if (!placeholder?.click) return false;
  try {
    await placeholder.click();
    if (page.keyboard?.type) {
      await page.keyboard.type(text);
    } else {
      // Keep this fallback limited to ordinary printable characters for the
      // lightweight BrowserPage implementations used by local tests.
      for (const character of text) await page.keyboard?.press(character);
    }
    await waitForTikTokUi(page, 180, 420);
    if (page.evaluate) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      const rendered = await page.evaluate((expected) => (document.body?.innerText ?? '').replace(/\s+/g, ' ').includes(expected ?? ''), normalized);
      if (rendered) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function describeTikTokCommentEditors(page: EvaluatablePage): Promise<string | undefined> {
  const inspect = async (context: { evaluate?: <T>(pageFunction: () => T) => Promise<T> }): Promise<unknown> => {
    if (!context.evaluate) return undefined;
    try {
      return await context.evaluate(() => {
        const visible = (element: Element): boolean => {
          const style = window.getComputedStyle(element);
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && style.opacity !== '0'
            && element.getClientRects().length > 0;
        };
        const nodes = [...document.querySelectorAll<HTMLElement>(
          'input, textarea, [contenteditable], [role="textbox"], [data-e2e*="comment" i]',
        )].filter(visible).slice(-25).map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            type: element.getAttribute('type'),
            role: element.getAttribute('role'),
            dataE2e: element.getAttribute('data-e2e'),
            placeholder: element.getAttribute('placeholder') ?? element.getAttribute('data-placeholder'),
            ariaLabel: element.getAttribute('aria-label'),
            contenteditable: element.getAttribute('contenteditable'),
            value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value.slice(0, 120) : (element.textContent ?? '').slice(0, 120),
            box: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}`,
          };
        });
        return nodes;
      });
    } catch {
      return undefined;
    }
  };
  const snapshots = [await inspect(page), ...(page.frames?.().slice(1) ?? []).slice(0, 4).map(frame => inspect(frame))];
  const resolved = await Promise.all(snapshots);
  const useful = resolved.filter((snapshot): snapshot is unknown => Array.isArray(snapshot) && snapshot.length > 0);
  return useful.length > 0 ? JSON.stringify(useful).slice(0, 2_000) : undefined;
}

async function sendTikTokMessage(
  session: PlatformSession,
  text: string,
  mediaAssetIds: string[],
  captchaSolver?: TikTokRotateCaptchaSolver,
  targetUsername?: string,
  targetProfileUrl?: string,
): Promise<void> {
  let page = session.page as EvaluatablePage;
  await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
  let editor: LocatorLike | undefined;
  if (text) {
    editor = await waitForTikTokMessageEditor(page, captchaSolver);
    if (!editor && targetUsername) {
      // A profile Message click can land on TikTok's generic `/messages`
      // shell while the IM SDK is still in a failed/poisoned route instance.
      // Reopen the same recipient once in the original tab. This preserves
      // the tab-scoped TikTok bootstrap state; a fresh tab can itself be
      // rejected with the anti-bot "Please wait" surface.
      const recovered = await reopenTikTokMessageComposer(session, targetUsername, targetProfileUrl, captchaSolver);
      if (recovered) {
        page = recovered;
        await session.captureStepScreenshot?.('tiktok-message-composer-retry');
        editor = await waitForTikTokMessageEditor(page, captchaSolver);
      }
    }
    if (!editor) {
      const diagnostics = await describeTikTokMessageSurface(page);
      throw new Error(`Không tìm thấy ô nhập tin nhắn TikTok${diagnostics ? ` (${diagnostics})` : ''}`);
    }
    if (!await fillTikTokMessageEditor(page, editor, text)) {
      throw new Error('TikTok không nhận nội dung trong ô nhập tin nhắn');
    }
  }
  const beforeMessages = await readVisibleTikTokMessageTexts(page);
  if (mediaAssetIds.length > 0) {
    if (!session.resolveMediaAssets) throw new Error('Chưa có bộ giải media cho TikTok');
    const files = await session.resolveMediaAssets(mediaAssetIds);
    const input = await firstLocator(page, ['input[type="file"]']);
    if (!input?.setInputFiles) throw new Error('TikTok không hiển thị input upload ảnh trong tin nhắn');
    await input.setInputFiles(files);
  }
  await waitForTikTokActionDelay(page);
  if (editor?.click) {
    try { await editor.click(); } catch { /* Re-resolve below if TikTok recycled the composer. */ }
  } else if (text) {
    editor = await findVisibleLocator(page, tiktokMessageEditorSelectors);
    try { await editor?.click?.(); } catch { /* The composer may still be hydrating. */ }
  }
  await beginExternalAction(session);
  let pressed = false;
  if (editor?.press) {
    try {
      await editor.press('Enter');
      pressed = true;
    } catch {
      // The message drawer can recycle its editor after media upload. Fall
      // back to the page keyboard while keeping Enter as the only submit path.
    }
  }
  if (!pressed && page.keyboard?.press) {
    await page.keyboard.press('Enter');
    pressed = true;
  }
  if (!pressed) throw new Error('TikTok không hỗ trợ nhấn Enter để gửi tin nhắn');
  await waitForTikTokMessagePosted(page, text, beforeMessages);
}

async function reopenTikTokMessageComposer(
  session: PlatformSession,
  targetUsername: string,
  targetProfileUrl: string | undefined,
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<EvaluatablePage | undefined> {
  // Keep TikTok recovery in the original tab. Opening a second tab creates a
  // new tab-scoped bootstrap context; on the same account that can produce a
  // "Please wait"/403 document even while the original tab is healthy.
  const page = session.page as EvaluatablePage;
  try {
    await enterTikTokRoot(page);
    await waitForTikTokPageReady(page);
    await waitForTikTokActionDelay(page);
    await dismissTikTokBlockingPopup(page);
    await dismissTikTokCloseablePopup(page);
    try {
      await searchTikTokProfileFromHome(page, targetUsername, captchaSolver);
    } catch {
      // The search endpoint can return approximate users on a fresh tab even
      // when the exact follower profile URL was already collected. Reuse that
      // verified rendered href for this bounded recovery attempt.
      await gotoPlatformPage(page, targetProfileUrl ?? buildTikTokProfileUrl(targetUsername));
      await waitForTikTokPageReady(page);
      await waitForTikTokActionDelay(page);
      if (!await hasTikTokProfileSurface(page)) return undefined;
    }
    await waitForTikTokActionDelay(page);
    await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
    const messageButton = await findTikTokProfileMessageButton(page);
    if (!messageButton?.click) return undefined;
    await messageButton.click();
    await waitForTikTokActionDelay(page);
    return page;
  } catch {
    return undefined;
  }
}

async function waitForTikTokMessageEditor(
  page: EvaluatablePage,
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<LocatorLike | undefined> {
  let expandedChat = false;
  // The profile Message button can first mount TikTok's compact DM drawer and
  // only then hydrate the conversation composer. Give that route enough time
  // to settle, and expand the drawer once when the compact chat exposes its
  // standard control. This remains scoped to the live DM surface; it never
  // clicks the persistent left-rail Messages button.
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
    const editor = await findVisibleLocator(page, tiktokMessageEditorSelectors);
    if (editor) return editor;

    if (!expandedChat) {
      const expandChat = await firstVisibleLocator(page, [
        '[data-testid="dm-new-v3-chat-expand-btn"]',
        '[data-e2e*="chat-expand" i]',
        'button[aria-label*="expand chat" i]',
        'button[aria-label*="mở rộng đoạn chat" i]',
      ]);
      if (expandChat?.click) {
        try {
          await expandChat.click();
          expandedChat = true;
          await waitForTikTokActionDelay(page);
          continue;
        } catch {
          expandedChat = true;
        }
      }
    }
    await waitForTikTokUi(page, 550, 950);
  }
  return undefined;
}

async function describeTikTokMessageSurface(page: EvaluatablePage): Promise<string | undefined> {
  if (!page.evaluate) return undefined;
  try {
    const snapshot = await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && element.getClientRects().length > 0;
      };
      const elements = [...document.querySelectorAll<HTMLElement>(
        'input, textarea, [contenteditable], [role="textbox"], button, a[href*="message" i], [data-e2e*="message" i], [data-testid*="message" i]',
      )].filter(visible).slice(-80).map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          role: element.getAttribute('role'),
          dataE2e: element.getAttribute('data-e2e'),
          dataTestId: element.getAttribute('data-testid'),
          href: element.getAttribute('href'),
          placeholder: element.getAttribute('placeholder') ?? element.getAttribute('data-placeholder'),
          ariaLabel: element.getAttribute('aria-label'),
          contenteditable: element.getAttribute('contenteditable'),
          text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          box: `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)}x${Math.round(rect.height)}`,
        };
      });
      return {
        url: location.href,
        title: document.title,
        body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
        elements,
      };
    });
    return JSON.stringify(snapshot).slice(0, 4_000);
  } catch {
    return undefined;
  }
}

async function fillTikTokMessageEditor(
  page: EvaluatablePage,
  editor: LocatorLike,
  text: string,
): Promise<boolean> {
  if (!editor.fill) return false;
  const expected = normalizeTikTokUiText(text);
  try {
    await editor.click?.();
    await editor.fill(text);
    await waitForTikTokUi(page, 180, 420);
    let actual = normalizeTikTokUiText(await readTikTokEditorValue(editor));
    if (actual === expected || actual.includes(expected)) return true;
    await editor.fill('');
    if (editor.pressSequentially) await editor.pressSequentially(text);
    else if (editor.type) await editor.type(text);
    await waitForTikTokUi(page, 180, 420);
    actual = normalizeTikTokUiText(await readTikTokEditorValue(editor));
    return actual === expected || actual.includes(expected);
  } catch {
    return false;
  }
}

async function waitForTikTokMessagePosted(
  page: EvaluatablePage,
  text: string,
  beforeMessages: string[],
): Promise<void> {
  const expected = normalizeTikTokUiText(text);
  await waitForTikTokUi(page, 1_100, 1_800);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const messages = await readVisibleTikTokMessageTexts(page);
    const matchingBefore = beforeMessages.filter((message) => normalizeTikTokUiText(message).includes(expected)).length;
    const matchingAfter = messages.filter((message) => normalizeTikTokUiText(message).includes(expected)).length;
    const editorValues: string[] = [];
    for (const selector of tiktokMessageEditorSelectors) {
      const candidates = page.locator(selector) as unknown as LocatorLike;
      const count = await candidates.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth ? candidates.nth(index) : candidates;
        if (await isLocatorVisible(candidate)) editorValues.push(await readTikTokEditorValue(candidate));
      }
    }
    const editorStillContains = expected.length > 0
      && editorValues.some((value) => normalizeTikTokUiText(value).includes(expected));
    const newMatchingMessage = expected
      ? matchingAfter > matchingBefore || messages.length > beforeMessages.length
      : messages.length > beforeMessages.length;
    if (newMatchingMessage && !editorStillContains) return;
    await waitForTikTokUi(page, 450, 750);
  }
  throw new Error(`TikTok chưa hiển thị tin nhắn sau khi nhấn Enter${text ? `: ${text}` : ''}`);
}

async function readVisibleTikTokMessageTexts(page: EvaluatablePage): Promise<string[]> {
  const texts: string[] = [];
  for (const selector of tiktokMessageTextSelectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    const count = await locator.count();
    for (let index = 0; index < Math.min(count, 100); index += 1) {
      const candidate = locator.nth ? locator.nth(index) : locator;
      if (!await isLocatorVisible(candidate)) continue;
      const value = candidate.innerText
        ? await candidate.innerText().catch(() => '')
        : await candidate.textContent?.().catch(() => null) ?? '';
      if (value) texts.push(value);
    }
    if (texts.length > 0) return texts;
  }
  return texts;
}

/**
 * Open the comment drawer for a video card that is already visible in the
 * current For You document. This keeps the interaction inside TikTok's
 * hydrated client route and avoids a direct video navigation that can return
 * an HTTP 403 page even when the same card is available in the feed.
 */
async function clickTikTokCommentOnVisibleCard(page: EvaluatablePage, videoUrl: string): Promise<boolean> {
  if (!page.evaluate) return false;
  const targetPath = tikTokVideoPath(videoUrl);
  if (!targetPath) return false;
  try {
    return await page.evaluate((expectedPath?: string) => {
      if (!expectedPath) return false;
      const normalizePath = (value: string): string | undefined => {
        try {
          const parsed = new URL(value, location.href);
          const match = parsed.pathname.match(/^\/\@[^/]+\/video\/[^/]+\/?$/i);
          return match ? parsed.pathname.replace(/\/$/, '').toLowerCase() : undefined;
        } catch { return undefined; }
      };
      const videoLink = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]')]
        .find(candidate => normalizePath(candidate.href) === expectedPath);
      const isVisible = (element: Element): boolean => {
        const style = getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.pointerEvents !== 'none'
          && element.getClientRects().length > 0;
      };

      // On For You, the current player is frequently rendered without an
      // anchor for its video URL.  In that case the visible comment control
      // belongs to the current player, which is exactly the item kept mounted
      // by autoCommentTikTokHome above.
      if (!videoLink && (/^\/(?:foryou)?\/?$/i.test(location.pathname) || document.querySelector('[data-e2e*="recommend" i]'))) {
        const currentPlayerControl = [...document.querySelectorAll<HTMLElement>([
          '[data-e2e="comment-icon"]',
          '[data-e2e*="comment-icon" i]',
          'button[aria-label*="comment" i]',
          'button[aria-label*="bình luận" i]',
          '[role="button"][aria-label*="comment" i]',
          '[role="button"][aria-label*="bình luận" i]',
        ].join(','))].find(element => isVisible(element));
        if (currentPlayerControl) {
          currentPlayerControl.click();
          return true;
        }

        // Some desktop builds render the right-side player controls as
        // unlabeled containers while the feed skeleton is hydrating. Keep the
        // fallback scoped to the normal For You player and click the stable
        // comment-control slot (the second right-rail control) only when no
        // semantic control exists. This is a normal user-facing click, not a
        // browser fingerprint or network workaround.
        const controlX = Math.round(window.innerWidth * 0.714);
        const controlY = Math.round(window.innerHeight * 0.478);
        const pointTarget = document.elementFromPoint(controlX, controlY) as HTMLElement | null;
        if (!pointTarget || !isVisible(pointTarget)) return false;
        pointTarget.click();
        return true;
      }
      if (!videoLink) return false;

      let card: Element = videoLink;
      for (let depth = 0; depth < 14 && card.parentElement; depth += 1) {
        const parent = card.parentElement;
        const hasCommentControl = Boolean(parent.querySelector(
          '[data-e2e*="comment" i], button[aria-label*="comment" i], [role="button"][aria-label*="comment" i]',
        ));
        card = parent;
        if (hasCommentControl) break;
      }
      const control = [...card.querySelectorAll<HTMLElement>([
        '[data-e2e*="comment" i]',
        'button[aria-label*="comment" i]',
        'button[aria-label*="bình luận" i]',
        '[role="button"][aria-label*="comment" i]',
        '[role="button"][aria-label*="bình luận" i]',
      ].join(','))].find(element => isVisible(element));
      if (!control) return false;
      control.click();
      return true;
    }, targetPath);
  } catch {
    return false;
  }
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

async function extractVisibleTikTokProfileHandles(page: EvaluatablePage): Promise<string[]> {
  if (!page.evaluate) return [];
  try {
    return await page.evaluate(() => {
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && style.opacity !== '0'
          && element.getClientRects().length > 0;
      };
      const handles = new Set<string>();
      for (const link of [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/@"]')]) {
        if (!visible(link)) continue;
        try {
          const url = new URL(link.href, location.href);
          const match = url.pathname.match(/^\/@([a-zA-Z0-9._-]+)\/?$/);
          if (match) handles.add(`@${match[1]}`);
        } catch { /* Ignore a recycled anchor. */ }
      }
      return [...handles];
    });
  } catch {
    return [];
  }
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

async function submitComment(
  page: EvaluatablePage,
  text: string,
  mediaAssetIds: string[],
  session: PlatformSession,
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<void> {
  if (mediaAssetIds.length > 0) {
    if (!session.resolveMediaAssets) throw new Error('Chưa có bộ giải media cho TikTok');
    const files = await session.resolveMediaAssets(mediaAssetIds);
    const input = await firstLocator(page, ['input[type="file"]']);
    if (!input?.setInputFiles) throw new Error('TikTok không hiển thị input upload ảnh');
    await input.setInputFiles(files);
  }
  await waitForTikTokActionDelay(page);
  await ensureTikTokCommentCaptchaSolved(page, captchaSolver);
  // TikTok's desktop comment surface accepts Enter from the focused editor.
  // Re-focus the live editor after CAPTCHA/media handling because solving the
  // challenge can leave focus on the slider instead of the comment field.
  const editor = await firstVisibleLocator(page, tiktokCommentEditorSelectors);
  if (editor?.click) {
    try { await editor.click(); } catch { /* The drawer may recycle the editor while hydrating. */ }
  } else {
    const placeholder = await firstVisibleLocator(page, tiktokCommentPlaceholderSelectors);
    if (placeholder?.click) {
      try { await placeholder.click(); } catch { /* Let the keyboard fallback report the real failure. */ }
    }
  }

  // Do not mark the task as having started an external side effect until the
  // final Enter is about to be dispatched. The verification below only
  // returns after TikTok renders the submitted comment in the comment list.
  await beginExternalAction(session);
  let pressed = false;
  if (editor?.press) {
    try {
      await editor.press('Enter');
      pressed = true;
    } catch {
      // Fall back to the page keyboard if the editor was recycled after the
      // focus click.
    }
  }
  if (!pressed && page.keyboard?.press) {
    await page.keyboard.press('Enter');
    pressed = true;
  }
  if (!pressed) throw new Error('TikTok không hỗ trợ nhấn Enter để gửi bình luận');
  await waitForTikTokCommentPosted(page, text);
}

async function waitForTikTokCommentPosted(page: EvaluatablePage, text: string): Promise<void> {
  const expected = normalizeTikTokUiText(text);
  if (!expected) throw new Error('Nội dung bình luận TikTok rỗng sau khi nhập');

  // Give TikTok time to dispatch the comment request and update the drawer.
  // This delay is intentionally longer than the ordinary UI pacing delay so
  // the browser/profile is not closed while the submit request is in flight.
  await waitForTikTokUi(page, 1_100, 1_800);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const comments = await readVisibleTikTokCommentTexts(page);
    if (comments.some((comment) => normalizeTikTokUiText(comment).includes(expected))) return;
    await waitForTikTokUi(page, 450, 750);
  }
  throw new Error(`TikTok chưa hiển thị bình luận sau khi nhấn Enter: ${text}`);
}

async function readVisibleTikTokCommentTexts(page: EvaluatablePage): Promise<string[]> {
  const texts: string[] = [];
  for (const selector of tiktokCommentTextSelectors) {
    const locator = page.locator(selector) as unknown as LocatorLike;
    const count = await locator.count();
    for (let index = 0; index < Math.min(count, 100); index += 1) {
      const candidate = locator.nth ? locator.nth(index) : locator;
      if (!(await isLocatorVisible(candidate))) continue;
      const value = candidate.innerText
        ? await candidate.innerText().catch(() => '')
        : await candidate.textContent?.().catch(() => null) ?? '';
      if (value) texts.push(value);
    }
    if (texts.length > 0) return texts;
  }
  return texts;
}

async function firstVisibleEnabledLocator(
  page: EvaluatablePage,
  selectors: string[],
  attempts = 20,
): Promise<LocatorLike | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const selector of selectors) {
      const locator = page.locator(selector) as unknown as LocatorLike;
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth ? locator.nth(index) : locator;
        if (!await isLocatorVisible(candidate)) continue;
        // The lightweight browser-page test double does not expose
        // isEnabled(); a real Playwright Locator always does. Preserve the
        // test-double behavior while never selecting TikTok's disabled Post
        // button in production.
        if (candidate.isEnabled && !await candidate.isEnabled()) continue;
        return candidate;
      }
    }
    await waitForTikTokUi(page, 180, 420);
  }
  return undefined;
}

async function ensureTikTokCommentCaptchaSolved(
  page: EvaluatablePage,
  captchaSolver?: TikTokRotateCaptchaSolver,
): Promise<void> {
  const captchaVisible = await hasVisibleTikTokCaptcha(page);
  // The challenge may be inside a generic iframe whose root is invisible to
  // the parent document. Reuse the same verification-state probe used by the
  // search flow before deciding that no challenge exists.
  const verificationState = captchaVisible ? undefined : await inspectTikTokSearchState(page);
  if (!captchaVisible && !verificationState?.verificationRequired) return;
  const solved = await solveVisibleTikTokRotateCaptcha(page, captchaSolver);
  if (!solved.solved) {
    throw new TikTokVerificationRequiredError(
      `TikTok CAPTCHA chưa được giải${solved.reason ? `: ${solved.reason}` : '.'}`,
    );
  }
  await waitForTikTokUi(page, 700, 1_100);
  if (await hasVisibleTikTokCaptcha(page)) {
    throw new TikTokVerificationRequiredError('TikTok CAPTCHA vẫn còn hiển thị sau khi kéo slider.');
  }
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
    const trailingNumberFromText = (value: string | null | undefined): number | undefined => {
      const match = (value ?? '').trim().match(/(?:^|[^\d])([\d.,]+\s*[KMB]?)\s*$/i);
      return match ? numberFromText(match[1] ?? '') : undefined;
    };
    type MetricKind = 'likes' | 'views' | 'comments';
    const metricMarkers: Record<MetricKind, RegExp[]> = {
      likes: [/like/, /digg/],
      views: [/\bview(?:s|count)?\b/, /play(?:s|count)?/],
      comments: [/comment/],
    };
    const metric = (card: Element, kind: MetricKind): number | undefined => {
      // Search cards expose the like count in a dedicated node. Read that
      // node first so a number from the caption, author row, or another card
      // metric can never be mistaken for likes.
      if (kind === 'likes') {
        const dedicatedLike = card.querySelector<HTMLElement>(
          '[data-e2e="search-card-video-like"], [data-e2e*="video-like" i], [data-e2e*="video-digg" i]',
        );
        if (dedicatedLike) {
          for (const value of [dedicatedLike.getAttribute('aria-label'), dedicatedLike.textContent]) {
            const parsed = value ? numberFromText(value.trim()) : undefined;
            if (parsed != null) return parsed;
          }
        }
      }
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
        // Do not scan the entire card as a last resort: captions can contain
        // heart emojis followed by numbers and would produce a false like
        // count. An unknown count is safer than a wrong count.
        return undefined;
      }
      return undefined;
    };
    const structuredMetadata = new Map<string, {
      videoUrl?: string;
      title?: string;
      username?: string;
      profileUrl?: string;
      thumbnailUrl?: string;
      publishedAt?: string;
      likes?: number;
      views?: number;
      comments?: number;
    }>();
    const asObject = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const asNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 10) return;
      if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }
      const object = asObject(value);
      if (!object) return;
      const id = String(object.id ?? object.videoId ?? object.itemId ?? '').match(/\d{8,}/)?.[0];
      const stats = asObject(object.stats ?? object.statistics);
      const author = asObject(object.author);
      const video = asObject(object.video);
      const title = [object.desc, object.title, object.description]
        .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
        ?.trim();
      const usernameValue = [
        author?.uniqueId,
        author?.unique_id,
        object.authorUniqueId,
        object.authorUsername,
      ].find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
      const normalizedUsername = usernameValue?.replace(/^@/, '').trim();
      const explicitVideoUrl = [object.webVideoUrl, object.shareUrl, object.videoUrl]
        .find((candidate): candidate is string => typeof candidate === 'string' && /\/video\/\d+/i.test(candidate));
      const derivedVideoUrl = id && normalizedUsername
        ? `https://www.tiktok.com/@${normalizedUsername}/video/${id}`
        : undefined;
      const thumbnailUrl = [
        object.thumbnailUrl,
        object.coverUrl,
        video?.cover,
        video?.originCover,
        video?.dynamicCover,
      ].find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
      const createTime = object.createTime ?? object.createdAt;
      const publishedAt = typeof createTime === 'number' || typeof createTime === 'string' && /^\d{9,13}$/.test(createTime)
        ? new Date(Number(createTime) * (String(createTime).length > 10 ? 1 : 1_000)).toISOString().slice(0, 10)
        : undefined;
      if (id && (stats || title || usernameValue || explicitVideoUrl)) {
        const current = structuredMetadata.get(id) ?? {};
        const likes = asNumber(stats?.diggCount ?? stats?.likeCount ?? stats?.likes);
        const views = asNumber(stats?.playCount ?? stats?.viewCount ?? stats?.views);
        const comments = asNumber(stats?.commentCount ?? stats?.comments);
        structuredMetadata.set(id, {
          videoUrl: explicitVideoUrl ?? derivedVideoUrl ?? current.videoUrl,
          title: title ?? current.title,
          username: normalizedUsername ? `@${normalizedUsername}` : current.username,
          profileUrl: normalizedUsername ? `https://www.tiktok.com/@${normalizedUsername}` : current.profileUrl,
          thumbnailUrl: thumbnailUrl ?? current.thumbnailUrl,
          publishedAt: publishedAt ?? current.publishedAt,
          likes: likes ?? current.likes,
          views: views ?? current.views,
          comments: comments ?? current.comments,
        });
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
      for (let depth = 0; depth < 14 && ancestor; depth += 1) {
        ancestors.push(ancestor);
        ancestor = ancestor.parentElement;
      }
      // The video URL anchor is only the media surface on TikTok Search. The
      // caption, author link, and date live in the outer grid item. Prefer an
      // ancestor that contains those metadata nodes; otherwise use TikTok's
      // stable grid-item marker before falling back to metric discovery.
      const metadataCard = ancestors.find((candidate) => Boolean(
        candidate.querySelector('[data-e2e="search-card-video-caption"]')
          && candidate.querySelector('[id^="search_video-item-user-link"], a[href*="/@"]'),
      ));
      const gridItemCard = ancestors.find((candidate) => candidate.matches(
        '[id*="grid-item-container" i], [class*="grid-item-container" i], [data-e2e*="grid-item-container" i]',
      ));
      const card = metadataCard
        ?? gridItemCard
        ?? ancestors.find((candidate) => metric(candidate, 'likes') != null)
        ?? ancestors.find((candidate) => (candidate.textContent?.length ?? 0) > 20 && candidate.querySelector('img'))
        ?? link.parentElement
        ?? link;
      const structured = structuredMetadata.get(videoUrl.match(/\/video\/(\d+)/)?.[1] ?? '');
      const hasVerifiedStats = structured?.views != null || structured?.comments != null;
      // The video link owns the large card thumbnail; only fall back to the
      // card wrapper when TikTok renders the image outside that link. This
      // avoids accidentally returning the small author avatar.
      const image = link.querySelector<HTMLImageElement>('img') ?? card?.querySelector<HTMLImageElement>('img');
      const author = link.href.match(/tiktok\.com\/@([^/]+)/)?.[1];
      const authorLink = card
        ? [...card.querySelectorAll<HTMLAnchorElement>('a[href*="/@"]')].find(candidate => !candidate.href.includes('/video/'))
        : undefined;
      const profileUrl = authorLink
        ? new URL(authorLink.href, location.href).href.split('?')[0]
        : author
          ? `https://www.tiktok.com/@${author}`
          : undefined;
      const authorName = authorLink?.textContent?.trim().replace(/\s+/g, ' ')
        || (authorLink?.getAttribute('aria-label') ?? '').replace(/['’]s profile$/i, '').trim()
        || undefined;
      const cardText = card?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 500);
      // TikTok's search cards expose the actual caption (including hashtags)
      // in this dedicated node. Prefer it over the whole card text so likes,
      // comments, and other card metadata never become the video title.
      const caption = card?.querySelector<HTMLElement>('[data-e2e="search-card-video-caption"]');
      const titleFromCaption = caption?.textContent?.trim().replace(/\s+/g, ' ');
      const titleFromCard = [
        link.getAttribute('title'),
        card?.querySelector<HTMLElement>('[data-e2e*="desc" i], [class*="desc" i], [class*="title" i]')?.textContent,
      ].find(value => {
        const normalized = value?.trim();
        return Boolean(normalized && !/^\d[\d.,]*\s*[KMB]?$/i.test(normalized));
      })?.trim();
      const datePattern = /^(?:\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,4})?|\d+\s*(?:d|h|m|w)\s*ago|\d+\s*(?:ngày|giờ|phút|tuần)(?:\s*trước)?)$/i;
      const publishedAt = card
        ? [card, ...card.querySelectorAll<HTMLElement>('*')]
            .map(element => element.textContent?.trim().replace(/\s+/g, ' ') ?? '')
            .filter(value => value.length > 0 && value.length <= 40 && datePattern.test(value))
            .sort((left, right) => left.length - right.length)[0]
        : undefined;
      const domLikes = card ? metric(card, 'likes') : undefined;
      // TikTok also exposes the rendered heart count as the trailing number
      // in the video link's accessible label (for example, `... 2370`). Use
      // this only after the dedicated like node, never by scanning card text.
      const accessibleLikes = domLikes == null
        ? [link.getAttribute('aria-label'), link.getAttribute('title')]
            .map(trailingNumberFromText)
            .find(value => value != null)
        : undefined;
      output.push({
        videoUrl,
        videoId: videoUrl.match(/\/video\/(\d+)/)?.[1],
        title: titleFromCaption ?? structured?.title ?? titleFromCard ?? cardText,
        username: authorName ?? structured?.username ?? (author ? `@${author}` : undefined),
        profileUrl,
        description: cardText,
        thumbnailUrl: image?.src,
        // The visible search-card count is authoritative for this list. Use
        // structured data only when TikTok did not render the dedicated node.
        likes: domLikes ?? accessibleLikes ?? structured?.likes,
        publishedAt,
        // Search cards expose a like count, but do not expose reliable view or
        // comment counts. Never infer either field from the card; only use
        // explicit stats from TikTok's video data.
        views: structured?.views,
        comments: structured?.comments,
        ...(hasVerifiedStats ? { statsSource: 'TIKTOK_VIDEO_STATS' as const } : {}),
      });
    }
    // For You cards can be rendered as a player/feed item without an anchor
    // containing `/video/`. TikTok still serializes the item in its hydration
    // payload; use that payload as a fallback so the campaign can discover
    // the video instead of scrolling ten times and reporting zero results.
    for (const [videoId, structured] of structuredMetadata) {
      const videoUrl = structured.videoUrl
        ?? (structured.username ? `https://www.tiktok.com/${structured.username}/video/${videoId}` : undefined);
      if (!videoUrl || seen.has(videoUrl)) continue;
      seen.add(videoUrl);
      const hasVerifiedStats = structured.views != null || structured.comments != null;
      output.push({
        videoUrl,
        videoId,
        title: structured.title,
        username: structured.username,
        profileUrl: structured.profileUrl,
        description: structured.title,
        thumbnailUrl: structured.thumbnailUrl,
        likes: structured.likes,
        publishedAt: structured.publishedAt,
        views: structured.views,
        comments: structured.comments,
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
