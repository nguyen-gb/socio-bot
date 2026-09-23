import type { ActionResult, PlatformAction } from '@socio/contracts';
import {
  LoginRequiredError,
  type PlatformAdapter,
  type PlatformSession,
  UnsupportedPlatformActionError,
} from '@socio/platform-core';
import { FacebookGroupsAutomation } from './facebook-groups';

const FACEBOOK_HOME = 'https://www.facebook.com/';

export class FacebookAdapter implements PlatformAdapter {
  readonly platform = 'FACEBOOK' as const;

  async execute(
    action: PlatformAction,
    session: PlatformSession,
  ): Promise<ActionResult> {
    if (action.platform !== this.platform) {
      throw new UnsupportedPlatformActionError(action.platform, action.action);
    }

    switch (action.action) {
      case 'HEALTH_CHECK':
        return this.healthCheck(session);
      case 'GET_PROFILE':
        return this.getProfile(session);
      case 'PUBLISH_POST':
        throw new UnsupportedPlatformActionError(this.platform, action.action);
      case 'SYNC_FACEBOOK_GROUPS':
        return new FacebookGroupsAutomation().sync(session);
      case 'JOIN_FACEBOOK_GROUP':
        return new FacebookGroupsAutomation().join(session, action.payload.groupUrl);
      case 'POST_FACEBOOK_GROUP':
        return new FacebookGroupsAutomation().post(session, action.payload.groupUrl, action.payload.text);
    }
  }

  private async healthCheck(session: PlatformSession): Promise<ActionResult> {
    await session.page.goto(FACEBOOK_HOME, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });

    const loginRequired = await this.isLoginRequired(session);
    return {
      ok: !loginRequired,
      data: {
        loginRequired,
        url: session.page.url(),
        title: await session.page.title(),
      },
    };
  }

  private async getProfile(session: PlatformSession): Promise<ActionResult> {
    const health = await this.healthCheck(session);
    if (health.data?.loginRequired === true) throw new LoginRequiredError();

    return {
      ok: true,
      data: {
        url: session.page.url(),
        title: await session.page.title(),
      },
    };
  }

  private async isLoginRequired(session: PlatformSession): Promise<boolean> {
    const url = session.page.url();
    if (url.includes('/login') || url.includes('/checkpoint')) return true;

    const emailInputs = await session.page.locator('input[name="email"]').count();
    const passwordInputs = await session.page.locator('input[name="pass"]').count();
    return emailInputs > 0 && passwordInputs > 0;
  }
}
