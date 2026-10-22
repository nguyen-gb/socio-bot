import type { ActionResult, Platform, PlatformAction } from '@socio/contracts';

export interface BrowserPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: 'commit' | 'domcontentloaded' | 'load'; timeout?: number }): Promise<unknown>;
  /** Optional Playwright load-state primitive exposed by real pages. */
  waitForLoadState?(state?: 'domcontentloaded' | 'load' | 'networkidle', options?: { timeout?: number }): Promise<void>;
  waitForTimeout?(milliseconds: number): Promise<void>;
  /** Optional document probe used to verify that a committed SPA has completed its load milestone. */
  evaluate?<T, A = unknown>(pageFunction: ((arg?: A) => T) | string, arg?: A): Promise<T>;
  locator(selector: string): {
    count(): Promise<number>;
  };
}

/**
 * Navigate to a platform entry page and recover from Chromium's special
 * error for an HTTP error response without a renderable body. Some platforms
 * return that response for their generic landing route while their login
 * route is still usable.
 */
export async function gotoPlatformPage(
  page: BrowserPage,
  url: string,
  fallbackUrl?: string,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  try {
    const result = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });
    await waitForPlatformPageReady(page, { timeoutMs });
    if (await hasPlatformErrorSurface(page) && !(await clickPlatformReloadButton(page, { timeoutMs }))) {
      throw new Error(`Trang không tải được sau khi click Reload: ${url}`);
    }
    return result;
  } catch (error) {
    // Chromium can report ERR_ABORTED after the requested document has
    // already committed (for example when a client-side router replaces the
    // shell). If the current page is the requested route, keep that document
    // and let the caller wait for its actual controls instead of treating the
    // navigation as a failed campaign.
    if (isHttpResponseCodeFailure(error) || isNavigationRace(error) || isNavigationTimeout(error)) {
      const sameRoute = isSamePlatformRoute(page.url(), url);
      const shouldReload = isHttpResponseCodeFailure(error) || sameRoute || await hasPlatformErrorSurface(page);
      if (shouldReload && await clickPlatformReloadButton(page, { timeoutMs }) && isSamePlatformRoute(page.url(), url)) {
        return undefined;
      }
    }
    if ((isNavigationRace(error) || isNavigationTimeout(error)) && isSamePlatformRoute(page.url(), url)) {
      await waitForPlatformPageReady(page, { timeoutMs });
      return undefined;
    }
    if (!fallbackUrl || fallbackUrl === url || !isHttpResponseCodeFailure(error)) {
      throw error;
    }
    // Chromium can still be committing chrome-error://chromewebdata/ when the
    // first navigation fails. Starting the fallback immediately then produces
    // "navigation ... is interrupted by another navigation" even though the
    // fallback route itself is healthy. Give the error page a moment to settle
    // and retry only this narrow navigation-race failure.
    await page.waitForTimeout?.(350);
    let fallbackError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await page.goto(fallbackUrl, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        await waitForPlatformPageReady(page, { timeoutMs });
        if (await hasPlatformErrorSurface(page) && !(await clickPlatformReloadButton(page, { timeoutMs }))) {
          throw new Error(`Trang không tải được sau khi click Reload: ${fallbackUrl}`);
        }
        return result;
      } catch (retryError) {
        fallbackError = retryError;
        if ((isHttpResponseCodeFailure(retryError) || isNavigationRace(retryError) || isNavigationTimeout(retryError))
          && (isHttpResponseCodeFailure(retryError) || isSamePlatformRoute(page.url(), fallbackUrl) || await hasPlatformErrorSurface(page))
          && await clickPlatformReloadButton(page, { timeoutMs })
          && isSamePlatformRoute(page.url(), fallbackUrl)) {
          return undefined;
        }
        if (isNavigationRace(retryError) && isSamePlatformRoute(page.url(), fallbackUrl)) {
          await waitForPlatformPageReady(page, { timeoutMs });
          return undefined;
        }
        if (!isNavigationRace(retryError) || attempt === 2) throw retryError;
        await page.waitForTimeout?.(500);
      }
    }
    throw fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
  }
}

/**
 * Click Chromium's visible Reload button once after a navigation error. On a
 * chrome-error/403 document this is intentionally a real UI click rather than
 * a call to the Playwright reload primitive.
 */
export async function clickPlatformReloadButton(
  page: BrowserPage,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const selectors = [
    '#reload-button',
    'button#reload-button',
    'button:has-text("Reload")',
    '[role="button"]:has-text("Reload")',
    'button:has-text("Tải lại")',
    '[role="button"]:has-text("Tải lại")',
  ];
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector) as unknown as {
        count(): Promise<number>;
        nth?: (index: number) => {
          isVisible?: () => Promise<boolean>;
          isEnabled?: () => Promise<boolean>;
          click?: () => Promise<void>;
        };
        isVisible?: () => Promise<boolean>;
        isEnabled?: () => Promise<boolean>;
        click?: () => Promise<void>;
      };
      const count = await locator.count();
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth ? locator.nth(index) : locator;
        if (candidate.isVisible && !await candidate.isVisible()) continue;
        if (candidate.isEnabled && !await candidate.isEnabled()) continue;
        if (!candidate.click) continue;
        await candidate.click();
        await waitForPlatformPageReady(page, { timeoutMs });
        return !(await hasPlatformErrorSurface(page));
      }
    } catch {
      // The chrome-error document may be replaced as soon as the button is
      // clicked. Continue only through the readiness/error-surface check above.
      return false;
    }
  }
  return false;
}

/** Detect Chromium's rendered HTTP error page when navigation did not throw. */
export async function hasPlatformErrorSurface(page: BrowserPage): Promise<boolean> {
  if (!page.evaluate) return false;
  try {
    const result = await page.evaluate(() => {
      const text = `${document.title ?? ''} ${document.body?.innerText ?? ''}`.replace(/\s+/g, ' ');
      return /access to .* was denied|you don't have authorization to view this page|http error \d{3}|err_http_response_code_failure|this page (?:isn't|is not) working|this site can't be reached/i.test(text);
    });
    return result === true;
  } catch {
    return false;
  }
}

/**
 * A successful `page.goto(..., {waitUntil: 'domcontentloaded'})` only means
 * the document event fired. SPA platforms can still be replacing the shell
 * and mounting the controls that campaigns need. Wait for both the DOM and
 * full page load milestones, verify the document reports `complete`, then
 * give the client a short bounded settle window before any adapter resolves
 * locators or starts the next navigation.
 */
export async function waitForPlatformPageReady(
  page: BrowserPage,
  options: { timeoutMs?: number; settleMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  let loadStateError: unknown;

  try {
    await page.waitForLoadState?.('domcontentloaded', { timeout: remaining() });
  } catch {
    // A client-side route can detach the document between the navigation and
    // this wait. The document probe below decides whether that replacement is
    // already complete.
  }
  try {
    await page.waitForLoadState?.('load', { timeout: remaining() });
  } catch (error) {
    loadStateError = error;
  }

  let documentComplete = false;
  if (page.evaluate) {
    while (Date.now() < deadline) {
      try {
        const readyState = await page.evaluate(() => document.readyState);
        // Lightweight test/remote shims may implement evaluate without a real
        // DOM. Preserve their existing fast path instead of waiting for the
        // full navigation budget on a value that cannot represent readyState.
        if (typeof readyState !== 'string') {
          documentComplete = true;
          break;
        }
        if (readyState === 'complete') {
          documentComplete = true;
          break;
        }
      } catch {
        // The SPA may be swapping documents. Keep observing the replacement
        // until the bounded navigation budget expires.
      }
      await page.waitForTimeout?.(100);
    }
  } else {
    // Test/remote shims do not expose document evaluation. The load-state
    // primitive is still authoritative when it is available.
    documentComplete = !page.waitForLoadState || !loadStateError;
  }

  if (loadStateError && page.evaluate && !documentComplete) {
    throw loadStateError;
  }

  if (page.waitForTimeout) await page.waitForTimeout(options.settleMs ?? 400);
}

function isHttpResponseCodeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(message);
}

function isNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /interrupted by another navigation|ERR_ABORTED|chrome-error:\/\/chromewebdata/i.test(message);
}

function isNavigationTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Timeout \d+ms exceeded|Navigation timeout/i.test(message);
}

function isSamePlatformRoute(currentUrl: string, expectedUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const expected = new URL(expectedUrl);
    if (current.origin !== expected.origin) return false;
    const normalizePath = (value: string) => value.replace(/\/+$/, '') || '/';
    return normalizePath(current.pathname) === normalizePath(expected.pathname);
  } catch {
    return false;
  }
}

export interface PlatformMediaFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface PlatformSession {
  page: BrowserPage;
  profileId: string;
  /** Localized platform entry URL selected from the profile fingerprint. */
  platformHomeUrl?: string;
  /** Optional platform identity used to avoid acting on the logged-in user's own content. */
  accountUsername?: string;
  accountExternalId?: string;
  /** Optional opt-in diagnostics hook; production sessions leave it unset. */
  captureStepScreenshot?: (step: string) => Promise<void>;
  /** Optional same-context page factory used to recover a poisoned document. */
  openPage?: () => Promise<BrowserPage>;
  replacePage?: (page: BrowserPage) => void;
  beforeExternalAction?: () => Promise<void>;
  /** Persist one completed/failed target while a long campaign is running. */
  recordActionProgress?: (entry: Record<string, unknown>) => Promise<void>;
  resolveMediaAssets?: (ids: string[]) => Promise<PlatformMediaFile[]>;
  /** Reserve a random Facebook group member before the send is started. */
  reserveMessageRecipient?: (input: { groupUrl: string; profileUrl: string; displayName?: string }) => Promise<boolean>;
  /** Release a reservation only when Facebook definitively did not send. */
  releaseMessageRecipient?: (input: { groupUrl: string; profileUrl: string }) => Promise<void>;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  execute(action: PlatformAction, session: PlatformSession): Promise<ActionResult>;
}

export class PlatformAdapterRegistry {
  private readonly adapters = new Map<Platform, PlatformAdapter>();

  constructor(adapters: PlatformAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: PlatformAdapter): void {
    if (this.adapters.has(adapter.platform)) {
      throw new Error(`Adapter already registered for ${adapter.platform}`);
    }
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: Platform): PlatformAdapter | undefined {
    return this.adapters.get(platform);
  }

  list(): Platform[] {
    return [...this.adapters.keys()];
  }
}

export class UnsupportedPlatformActionError extends Error {
  constructor(platform: Platform, action: string) {
    super(`${action} is not implemented for ${platform}`);
    this.name = 'UnsupportedPlatformActionError';
  }
}

export class LoginRequiredError extends Error {
  constructor(message = 'The platform account requires an interactive login') {
    super(message);
    this.name = 'LoginRequiredError';
  }
}
