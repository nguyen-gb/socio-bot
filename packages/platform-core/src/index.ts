import type { ActionResult, Platform, PlatformAction } from '@socio/contracts';

export interface BrowserPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number }): Promise<unknown>;
  locator(selector: string): {
    count(): Promise<number>;
  };
}

export interface PlatformSession {
  page: BrowserPage;
  profileId: string;
  beforeExternalAction?: () => Promise<void>;
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
