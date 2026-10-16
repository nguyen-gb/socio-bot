import type { ActionResult, Platform, PlatformAction } from '@socio/contracts';
import {
  LoginRequiredError,
  gotoPlatformPage,
  type PlatformAdapter,
  type PlatformSession,
  UnsupportedPlatformActionError,
} from '@socio/platform-core';
import {
  autoCommentTikTokHome,
  commentTikTokVideos,
  enterTikTokRoot,
  likeTikTokComments,
  messageTikTokFollowers,
  replyTikTokComments,
  searchTikTokVideos,
  type TikTokSearchProvider,
  type TikTokRotateCaptchaSolver,
  TikTokSearchAutomationError,
  TikTokVerificationRequiredError,
} from './tiktok-automation';

interface AdapterDefinition {
  platform: Exclude<Platform, 'FACEBOOK'>;
  homeUrl: string;
  fallbackUrl?: string;
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

  protected async healthCheck(session: PlatformSession): Promise<ActionResult> {
    await gotoPlatformPage(
      session.page,
      this.definition.homeUrl,
      this.definition.fallbackUrl,
    );
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
  constructor(private readonly options: {
    searchProvider?: TikTokSearchProvider;
    captchaSolver?: TikTokRotateCaptchaSolver;
  } = {}) {
    super();
  }

  protected readonly definition: AdapterDefinition = {
    platform: this.platform,
    homeUrl: 'https://www.tiktok.com/',
    fallbackUrl: 'https://www.tiktok.com/login',
    loginUrlFragments: ['/login', '/passport/'],
    loginSelectors: ['a[href*="/login"]', 'button[data-e2e*="login"]'],
  };

  async execute(action: PlatformAction, session: PlatformSession): Promise<ActionResult> {
    if (action.platform !== this.platform) {
      throw new UnsupportedPlatformActionError(action.platform, action.action);
    }
    if (action.action === 'HEALTH_CHECK' || action.action === 'GET_PROFILE') {
      return super.execute(action, session);
    }
    // TikTok owns the first route transition: always start at its ordinary
    // root and use commit so a client-side redirect is not mistaken for a
    // failed navigation. The action itself decides which surface to open
    // next (search, For You, profile, or video).
    await enterTikTokRoot(session.page);
    // The worker initializes/authenticates sessions for side-effect actions.
    // Search is the read-only exception: it runs in a fresh anonymous context
    // and must not be rejected just because that context has no login.
    const currentUrl = session.page.url().toLowerCase();
    if (action.action !== 'SEARCH_TIKTOK_VIDEOS' && (currentUrl.includes('/login') || currentUrl.includes('/passport') || (await session.page.locator('input[type="password"]').count()) > 0)) {
      throw new LoginRequiredError('TikTok profile chưa đăng nhập');
    }

    switch (action.action) {
      case 'SEARCH_TIKTOK_VIDEOS': {
        let videos;
        try {
          videos = this.options.searchProvider
            ? await this.options.searchProvider.search(action.payload.query, action.payload.maxVideos)
            : await searchTikTokVideos(session, action.payload.query, action.payload.maxVideos, this.options.captchaSolver);
        } catch (error) {
          if (error instanceof TikTokVerificationRequiredError) {
            return {
              ok: false,
              data: {
                requiresAction: true,
                accountChallenged: true,
                reason: error.message,
              },
            };
          }
          throw new TikTokSearchAutomationError(
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        const filtered = videos.filter((video) =>
          (action.payload.minLikes == null || video.likes != null && video.likes >= action.payload.minLikes)
          && (action.payload.maxLikes == null || video.likes != null && video.likes <= action.payload.maxLikes)
          && (action.payload.minViews == null || video.views != null && video.views >= action.payload.minViews)
          && (action.payload.maxViews == null || video.views != null && video.views <= action.payload.maxViews),
        );
        return { ok: true, data: { query: action.payload.query, videos: filtered, count: filtered.length } };
      }
      case 'AUTO_COMMENT_TIKTOK_HOME':
        {
          const data = await autoCommentTikTokHome(session, action.payload, this.options.captchaSolver);
          return { ok: typeof data.sent === 'number' && data.sent > 0, data };
        }
      case 'COMMENT_TIKTOK_VIDEOS':
        {
          const data = await commentTikTokVideos(session, action.payload, this.options.captchaSolver);
          return { ok: typeof data.sent === 'number' && data.sent > 0, data };
        }
      case 'REPLY_TIKTOK_COMMENTS':
        return { ok: true, data: await replyTikTokComments(session, action.payload, this.options.captchaSolver) };
      case 'LIKE_TIKTOK_COMMENTS':
        return { ok: true, data: await likeTikTokComments(session, action.payload) };
      case 'MESSAGE_TIKTOK_FOLLOWERS':
        {
          const data = await messageTikTokFollowers(session, action.payload, this.options.captchaSolver);
          return { ok: typeof data.sent === 'number' && data.sent > 0, data };
        }
      default:
        throw new UnsupportedPlatformActionError(this.platform, action.action);
    }
  }

  protected async healthCheck(session: PlatformSession): Promise<ActionResult> {
    await enterTikTokRoot(session.page);
    const currentUrl = session.page.url().toLowerCase();
    let loginRequired = this.definition.loginUrlFragments.some((fragment) => currentUrl.includes(fragment));
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
