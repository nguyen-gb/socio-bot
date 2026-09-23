import type { ActionResult, Platform, PlatformAction } from '@socio/contracts';
import {
  LoginRequiredError,
  type PlatformAdapter,
  type PlatformSession,
  UnsupportedPlatformActionError,
} from '@socio/platform-core';

interface AdapterDefinition {
  platform: Exclude<Platform, 'FACEBOOK'>;
  homeUrl: string;
  loginUrlFragments: string[];
  loginSelectors: string[];
}

abstract class WebPlatformAdapter implements PlatformAdapter {
  abstract readonly platform: Exclude<Platform, 'FACEBOOK'>;
  protected abstract readonly definition: AdapterDefinition;

  async execute(
    action: PlatformAction,
    session: PlatformSession,
  ): Promise<ActionResult> {
    if (action.platform !== this.platform) {
      throw new UnsupportedPlatformActionError(action.platform, action.action);
    }
    if (!['HEALTH_CHECK', 'GET_PROFILE'].includes(action.action)) {
      throw new UnsupportedPlatformActionError(this.platform, action.action);
    }
    const health = await this.healthCheck(session);
    if (action.action === 'GET_PROFILE' && health.data?.loginRequired === true) {
      throw new LoginRequiredError();
    }
    return health;
  }

  private async healthCheck(session: PlatformSession): Promise<ActionResult> {
    await session.page.goto(this.definition.homeUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    const currentUrl = session.page.url().toLowerCase();
    let loginRequired = this.definition.loginUrlFragments.some((fragment) =>
      currentUrl.includes(fragment),
    );
    if (!loginRequired) {
      for (const selector of this.definition.loginSelectors) {
        if ((await session.page.locator(selector).count()) > 0) {
          loginRequired = true;
          break;
        }
      }
    }
    return {
      ok: !loginRequired,
      data: {
        loginRequired,
        url: session.page.url(),
        title: await session.page.title(),
      },
    };
  }
}

export class InstagramAdapter extends WebPlatformAdapter {
  readonly platform = 'INSTAGRAM' as const;
  protected readonly definition: AdapterDefinition = {
    platform: this.platform,
    homeUrl: 'https://www.instagram.com/',
    loginUrlFragments: ['/accounts/login', '/challenge/'],
    loginSelectors: ['input[name="username"]', 'input[name="password"]'],
  };
}

export class XAdapter extends WebPlatformAdapter {
  readonly platform = 'X' as const;
  protected readonly definition: AdapterDefinition = {
    platform: this.platform,
    homeUrl: 'https://x.com/home',
    loginUrlFragments: ['/login', '/i/flow/login', '/account/access'],
    loginSelectors: ['input[autocomplete="username"]', 'input[name="password"]'],
  };
}

export class TikTokAdapter extends WebPlatformAdapter {
  readonly platform = 'TIKTOK' as const;
  protected readonly definition: AdapterDefinition = {
    platform: this.platform,
    homeUrl: 'https://www.tiktok.com/',
    loginUrlFragments: ['/login', '/passport/'],
    loginSelectors: ['a[href*="/login"]', 'button[data-e2e*="login"]'],
  };
}
