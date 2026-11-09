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
      session.platformHomeUrl ?? this.definition.homeUrl,
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
    homeUrl: 'https://www.tiktok.com/en',
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
    // TikTok owns the first route transition: always start at /en (falling
    // back to /vi-VN/) and use commit so a client-side redirect is not mistaken for a
    // failed navigation. The action itself decides which surface to open
    // next (search, For You, profile, or video).
    await enterTikTokRoot(session.page, session.platformHomeUrl);
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
          return { ok: isTikTokCampaignComplete(data, 'sent'), data };
        }
      case 'COMMENT_TIKTOK_VIDEOS':
        {
          const data = await commentTikTokVideos(session, action.payload, this.options.captchaSolver);
          return { ok: isTikTokCampaignComplete(data, 'sent'), data };
        }
      case 'REPLY_TIKTOK_COMMENTS':
        {
          const data = await replyTikTokComments(session, action.payload, this.options.captchaSolver);
          // A reply campaign is complete only when every requested reply was
          // sent. Returning success for a partial run made the UI show
          // "Hoàn tất" while still carrying a failure reason from a later
          // video, which was misleading and unsafe to retry blindly.
          return { ok: isTikTokCampaignComplete(data, 'sent'), data };
        }
      case 'LIKE_TIKTOK_COMMENTS':
        {
          const data = await likeTikTokComments(session, action.payload);
          // A video navigation without opening the comment drawer used to
          // return a successful task with zero likes. Treat that as a failed
          // action so the report/manual retry path is visible to the user.
          return { ok: isTikTokCampaignComplete(data, 'liked'), data };
        }
      case 'MESSAGE_TIKTOK_FOLLOWERS':
        {
          const data = await messageTikTokFollowers(session, action.payload, this.options.captchaSolver);
          return { ok: isTikTokCampaignComplete(data, 'sent'), data };
        }
      default:
        throw new UnsupportedPlatformActionError(this.platform, action.action);
    }
  }

  protected async healthCheck(session: PlatformSession): Promise<ActionResult> {
    await enterTikTokRoot(session.page, session.platformHomeUrl);
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

export function isTikTokCampaignComplete(data: Record<string, unknown>, completedField: 'sent' | 'liked'): boolean {
  const completed = typeof data.totalSent === 'number'
    ? data.totalSent
    : typeof data[completedField] === 'number'
      ? data[completedField]
      : undefined;
  const requested = typeof data.totalRequested === 'number'
    ? data.totalRequested
    : typeof data.requested === 'number'
      ? data.requested
      : undefined;
  return completed != null && requested != null && requested > 0 && completed >= requested;
}
