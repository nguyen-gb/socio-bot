"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FacebookAdapter = void 0;
const platform_core_1 = require("@socio/platform-core");
const facebook_groups_1 = require("./facebook-groups");
const facebook_messages_1 = require("./facebook-messages");
const facebook_comments_1 = require("./facebook-comments");
const FACEBOOK_HOME = 'https://www.facebook.com/';
class FacebookAdapter {
    platform = 'FACEBOOK';
    async execute(action, session) {
        if (action.platform !== this.platform) {
            throw new platform_core_1.UnsupportedPlatformActionError(action.platform, action.action);
        }
        switch (action.action) {
            case 'HEALTH_CHECK':
                return this.healthCheck(session);
            case 'GET_PROFILE':
                return this.getProfile(session);
            case 'PUBLISH_POST':
                throw new platform_core_1.UnsupportedPlatformActionError(this.platform, action.action);
            case 'SYNC_FACEBOOK_GROUPS':
                return new facebook_groups_1.FacebookGroupsAutomation().sync(session);
            case 'JOIN_FACEBOOK_GROUP':
                return new facebook_groups_1.FacebookGroupsAutomation().join(session, action.payload.groupUrl);
            case 'POST_FACEBOOK_GROUP':
                return new facebook_groups_1.FacebookGroupsAutomation().post(session, action.payload.groupUrl, action.payload.text, action.payload.mediaAssetIds);
            case 'MESSAGE_FACEBOOK_RECIPIENT':
                return new facebook_messages_1.FacebookMessagesAutomation().messageRandomGroupMember(session, action.payload.groupUrl, action.payload.text, action.payload.mediaAssetIds, action.payload.excludeProfileUrls);
            case 'MESSAGE_FACEBOOK_REACTOR':
                return new facebook_messages_1.FacebookMessagesAutomation().messageRandomPostReactor(session, action.payload.postUrl, action.payload.text, action.payload.mediaAssetIds, action.payload.excludeProfileUrls, action.payload.recipientSource);
            case 'SCAN_FACEBOOK_POST_COMMENTS':
                return new facebook_comments_1.FacebookCommentsAutomation().scanPostComments(session, action.payload.postUrl);
            case 'REPLY_FACEBOOK_POST_COMMENTS':
                return new facebook_comments_1.FacebookCommentsAutomation().replyPostComments(session, action.payload.postUrl, action.payload.text, action.payload.maxReplies, action.payload.mediaAssetIds);
        }
    }
    async healthCheck(session) {
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
    async getProfile(session) {
        const health = await this.healthCheck(session);
        if (health.data?.loginRequired === true)
            throw new platform_core_1.LoginRequiredError();
        return {
            ok: true,
            data: {
                url: session.page.url(),
                title: await session.page.title(),
            },
        };
    }
    async isLoginRequired(session) {
        const url = session.page.url();
        if (url.includes('/login') || url.includes('/checkpoint'))
            return true;
        const emailInputs = await session.page.locator('input[name="email"]').count();
        const passwordInputs = await session.page.locator('input[name="pass"]').count();
        return emailInputs > 0 && passwordInputs > 0;
    }
}
exports.FacebookAdapter = FacebookAdapter;
//# sourceMappingURL=facebook-adapter.js.map