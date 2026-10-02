import { z } from 'zod';
import { platformSchema } from './status';
import { facebookGroupUrlSchema, facebookPostRecipientSourceSchema, facebookPostUrlSchema } from './facebook';
import { facebookMediaIdsSchema } from './media';

const baseActionSchema = z.object({
  platform: platformSchema,
  accountId: z.uuid(),
});

export const healthCheckActionSchema = baseActionSchema.extend({
  action: z.literal('HEALTH_CHECK'),
  payload: z.object({}).default({}),
});

export const getProfileActionSchema = baseActionSchema.extend({
  action: z.literal('GET_PROFILE'),
  payload: z.object({}).default({}),
});

export const publishPostActionSchema = baseActionSchema.extend({
  action: z.literal('PUBLISH_POST'),
  payload: z.object({
    text: z.string().trim().max(20_000).default(''),
    mediaAssetIds: z.array(z.uuid()).max(20).default([]),
  }).refine(
    (payload) => payload.text.length > 0 || payload.mediaAssetIds.length > 0,
    'A post needs text or at least one media asset',
  ),
});

export const syncFacebookGroupsActionSchema = baseActionSchema.extend({
  platform: z.literal('FACEBOOK'),
  action: z.literal('SYNC_FACEBOOK_GROUPS'),
  payload: z.object({}).default({}),
});
export const joinFacebookGroupActionSchema = baseActionSchema.extend({
  platform: z.literal('FACEBOOK'),
  action: z.literal('JOIN_FACEBOOK_GROUP'),
  payload: z.object({ groupUrl: facebookGroupUrlSchema }),
});
export const postFacebookGroupActionSchema = baseActionSchema.extend({
  platform: z.literal('FACEBOOK'),
  action: z.literal('POST_FACEBOOK_GROUP'),
  payload: z.object({ groupUrl: facebookGroupUrlSchema, text: z.string().trim().max(20_000).default(''), mediaAssetIds: facebookMediaIdsSchema })
    .refine(payload => payload.text.length > 0 || payload.mediaAssetIds.length > 0, 'Nhập nội dung hoặc chọn ít nhất một ảnh'),
});
export const messageFacebookRecipientActionSchema = baseActionSchema.extend({
  platform: z.literal('FACEBOOK'),
  action: z.literal('MESSAGE_FACEBOOK_RECIPIENT'),
  payload: z.object({
    groupUrl: facebookGroupUrlSchema,
    text: z.string().trim().max(5_000).default(''),
    mediaAssetIds: facebookMediaIdsSchema,
    excludeProfileUrls: z.array(z.string().max(2048)).max(500).default([]),
  }).refine(payload => payload.text.length > 0 || payload.mediaAssetIds.length > 0, 'Nhập nội dung hoặc chọn ít nhất một ảnh'),
});
export const messageFacebookReactorActionSchema = baseActionSchema.extend({
  platform: z.literal('FACEBOOK'),
  action: z.literal('MESSAGE_FACEBOOK_REACTOR'),
  payload: z.object({
    postUrl: facebookPostUrlSchema,
    recipientSource: facebookPostRecipientSourceSchema.default('REACTORS'),
    text: z.string().trim().max(5_000).default(''),
    mediaAssetIds: facebookMediaIdsSchema,
    excludeProfileUrls: z.array(z.string().max(2048)).max(500).default([]),
  }).refine(payload => payload.text.length > 0 || payload.mediaAssetIds.length > 0, 'Nhập nội dung hoặc chọn ít nhất một ảnh'),
});
export const scanFacebookPostCommentsActionSchema = baseActionSchema.extend({
  platform: z.literal('FACEBOOK'),
  action: z.literal('SCAN_FACEBOOK_POST_COMMENTS'),
  payload: z.object({ postUrl: facebookPostUrlSchema }),
});
export const replyFacebookPostCommentsActionSchema = baseActionSchema.extend({
  platform: z.literal('FACEBOOK'),
  action: z.literal('REPLY_FACEBOOK_POST_COMMENTS'),
  payload: z.object({
    postUrl: facebookPostUrlSchema,
    text: z.string().trim().max(5_000).default(''),
    mediaAssetIds: facebookMediaIdsSchema,
    maxReplies: z.number().int().min(1).max(50),
  }).refine(
    payload => payload.text.length > 0 || payload.mediaAssetIds.length > 0,
    'Nhập nội dung hoặc chọn ít nhất một ảnh',
  ),
});
export const commentFacebookGroupPostsActionSchema = baseActionSchema.extend({
  platform: z.literal('FACEBOOK'),
  action: z.literal('COMMENT_FACEBOOK_GROUP_POSTS'),
  payload: z.object({
    groupUrl: facebookGroupUrlSchema,
    text: z.string().trim().max(5_000).default(''),
    mediaAssetIds: facebookMediaIdsSchema,
    daysRecent: z.number().int().min(1).max(365).default(7),
    minReactions: z.number().int().min(0).max(10_000_000).default(0),
    maxReactions: z.number().int().min(0).max(10_000_000).optional(),
    minComments: z.number().int().min(0).max(10_000_000).default(0),
    maxComments: z.number().int().min(0).max(10_000_000).optional(),
    maxPosts: z.number().int().min(1).max(50).default(10),
  }),
});

export function requiresExternalApproval(action: string): boolean {
  return ['PUBLISH_POST', 'JOIN_FACEBOOK_GROUP', 'POST_FACEBOOK_GROUP', 'MESSAGE_FACEBOOK_RECIPIENT', 'MESSAGE_FACEBOOK_REACTOR', 'SCAN_FACEBOOK_POST_COMMENTS', 'REPLY_FACEBOOK_POST_COMMENTS', 'COMMENT_FACEBOOK_GROUP_POSTS'].includes(action);
}

export const platformActionSchema = z.discriminatedUnion('action', [
  healthCheckActionSchema,
  getProfileActionSchema,
  publishPostActionSchema,
  syncFacebookGroupsActionSchema,
  joinFacebookGroupActionSchema,
  postFacebookGroupActionSchema,
  messageFacebookRecipientActionSchema,
  messageFacebookReactorActionSchema,
  scanFacebookPostCommentsActionSchema,
  replyFacebookPostCommentsActionSchema,
  commentFacebookGroupPostsActionSchema,
]);
export type PlatformAction = z.infer<typeof platformActionSchema>;

export const createTaskSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
  action: platformActionSchema,
  priority: z.number().int().min(0).max(100).default(50),
  scheduledAt: z.iso.datetime().optional(),
  maxAttempts: z.number().int().min(1).max(5).default(3),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const executeTaskWorkflowInputSchema = z.object({
  taskId: z.uuid(),
  workflowId: z.string().optional(),
  scheduledAt: z.iso.datetime().optional(),
});
export type ExecuteTaskWorkflowInput = z.infer<
  typeof executeTaskWorkflowInputSchema
>;

export interface ActionResult {
  ok: boolean;
  externalReference?: string;
  data?: Record<string, unknown>;
}
