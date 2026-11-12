import { normalizeFacebookGroupUrl, normalizeFacebookPostUrl, normalizeFacebookProfileUrl, type ActionResult, type PlatformAction } from '@socio/contracts';
import {
  LoginRequiredError,
  gotoPlatformPage,
  type PlatformAdapter,
  type PlatformSession,
  UnsupportedPlatformActionError,
} from '@socio/platform-core';
import { FacebookGroupsAutomation } from './facebook-groups';
import { FacebookMessagesAutomation } from './facebook-messages';
import { FacebookCommentsAutomation } from './facebook-comments';

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
        return executeFacebookOnce(session, 'JOIN', normalizeFacebookGroupUrl(action.payload.groupUrl),
          () => new FacebookGroupsAutomation().join(session, action.payload.groupUrl),
          { groupUrl: normalizeFacebookGroupUrl(action.payload.groupUrl), membershipStatus: 'SKIPPED_DUPLICATE' });
      case 'POST_FACEBOOK_GROUP':
        return executeFacebookOnce(session, 'POST', facebookPostTargetKey(action.payload.groupUrl, action.payload.text),
          () => new FacebookGroupsAutomation().post(session, action.payload.groupUrl, action.payload.text, action.payload.mediaAssetIds),
          { groupUrl: normalizeFacebookGroupUrl(action.payload.groupUrl), publicationStatus: 'SKIPPED_DUPLICATE' });
      case 'MESSAGE_FACEBOOK_RECIPIENT':
        return action.payload.profileUrl
          ? executeFacebookOnce(session, 'MESSAGE', normalizeFacebookProfileUrl(action.payload.profileUrl),
            () => new FacebookMessagesAutomation().message(session, action.payload.profileUrl!, action.payload.text, action.payload.mediaAssetIds)
              .then(result => ({ ...result, data: { ...result.data, groupUrl: action.payload.groupUrl, profileUrl: action.payload.profileUrl, displayName: action.payload.displayName } })),
            { groupUrl: action.payload.groupUrl, profileUrl: normalizeFacebookProfileUrl(action.payload.profileUrl), displayName: action.payload.displayName, messageStatus: 'SKIPPED_DUPLICATE' })
          : new FacebookMessagesAutomation().messageRandomGroupMember(session, action.payload.groupUrl, action.payload.text, action.payload.mediaAssetIds, action.payload.excludeProfileUrls);
      case 'MESSAGE_FACEBOOK_REACTOR':
        return new FacebookMessagesAutomation().messageRandomPostReactor(session, action.payload.postUrl, action.payload.text, action.payload.mediaAssetIds, action.payload.excludeProfileUrls, action.payload.recipientSource);
      case 'SCAN_FACEBOOK_POST_COMMENTS':
        return new FacebookCommentsAutomation().scanPostComments(session, action.payload.postUrl);
      case 'REPLY_FACEBOOK_POST_COMMENTS':
        return executeFacebookOnce(session, 'REPLY', normalizeFacebookPostUrl(action.payload.postUrl),
          () => new FacebookCommentsAutomation().replyPostComments(session, action.payload.postUrl, action.payload.text, action.payload.maxReplies, action.payload.mediaAssetIds, action.payload),
          { postUrl: normalizeFacebookPostUrl(action.payload.postUrl), repliesRequested: action.payload.maxReplies, repliesSent: 0, replyStatus: 'SKIPPED_DUPLICATE' });
      case 'COMMENT_FACEBOOK_GROUP_POSTS':
        return new FacebookCommentsAutomation().commentGroupPosts(session, action.payload.groupUrl, action.payload.text, action.payload.mediaAssetIds, {
          daysRecent: action.payload.daysRecent,
          minReactions: action.payload.minReactions,
          maxReactions: action.payload.maxReactions,
          minComments: action.payload.minComments,
          maxComments: action.payload.maxComments,
          maxPosts: action.payload.maxPosts,
        }, action.payload);
    }
  }

  private async healthCheck(session: PlatformSession): Promise<ActionResult> {
    await gotoPlatformPage(session.page, session.platformHomeUrl ?? FACEBOOK_HOME);

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

function facebookPostTargetKey(groupUrl: string, text: string): string {
  return `${normalizeFacebookGroupUrl(groupUrl)}|${text.replace(/\s+/g, ' ').trim()}`;
}

async function executeFacebookOnce(
  session: PlatformSession,
  action: 'JOIN' | 'POST' | 'REPLY' | 'MESSAGE',
  targetKey: string,
  execute: () => Promise<ActionResult>,
  duplicateData: Record<string, unknown>,
): Promise<ActionResult> {
  if (await session.reserveFacebookTarget?.({ action, targetKey }) === false) {
    return { ok: true, data: { ...duplicateData, deduplicated: true, actionStatus: 'SKIPPED' } };
  }
  try {
    const result = await execute();
    if (result.ok) await session.completeFacebookTarget?.({ action, targetKey });
    else if (!facebookResultMayHaveSideEffect(result)) await session.releaseFacebookTarget?.({ action, targetKey });
    return result;
  } catch (error) {
    // A thrown error can occur after the worker's durable before-action
    // marker. Keep the reservation so a later campaign cannot send twice.
    throw error;
  }
}

function facebookResultMayHaveSideEffect(result: ActionResult): boolean {
  return result.data?.sideEffectStarted === true
    || result.data?.publicationStatus === 'UNKNOWN'
    || result.data?.replyStatus === 'UNKNOWN'
    || (typeof result.data?.repliesSent === 'number' && result.data.repliesSent > 0);
}
