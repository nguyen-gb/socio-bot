import type { ActionResult, Platform, PlatformAction } from '@socio/contracts';

export interface BrowserPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: 'commit' | 'domcontentloaded' | 'load'; timeout?: number }): Promise<unknown>;
  waitForTimeout?(milliseconds: number): Promise<void>;
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
): Promise<unknown> {
  try {
    return await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
  } catch (error) {
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
        return await page.goto(fallbackUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
      } catch (retryError) {
        fallbackError = retryError;
        if (!isNavigationRace(retryError) || attempt === 2) throw retryError;
        await page.waitForTimeout?.(500);
      }
    }
    throw fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
  }
}

function isHttpResponseCodeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ERR_HTTP_RESPONSE_CODE_FAILURE/i.test(message);
}

function isNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /interrupted by another navigation|ERR_ABORTED|chrome-error:\/\/chromewebdata/i.test(message);
}

export interface PlatformMediaFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface PlatformSession {
  page: BrowserPage;
  profileId: string;
  /** Optional platform identity used to avoid acting on the logged-in user's own content. */
  accountUsername?: string;
  accountExternalId?: string;
  /** Optional opt-in diagnostics hook; production sessions leave it unset. */
  captureStepScreenshot?: (step: string) => Promise<void>;
  /** Optional same-context page factory used to recover a poisoned document. */
  openPage?: () => Promise<BrowserPage>;
  replacePage?: (page: BrowserPage) => void;
  beforeExternalAction?: () => Promise<void>;
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
