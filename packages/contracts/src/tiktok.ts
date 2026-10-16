import { z } from 'zod';
import { facebookMediaIdsSchema } from './media';

export const tiktokVideoUrlSchema = z.string().max(2_048).trim().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com'].includes(url.hostname)
      && /^\/(\@[^/]+\/video\/\d+|player\/v1\/\d+|embed\/v2\/\d+)\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}, 'URL TikTok video không hợp lệ');

export const tiktokUsernameSchema = z.string().trim().regex(/^@?[a-zA-Z0-9._-]{2,64}$/, 'Username TikTok không hợp lệ');
const tiktokCampaignNameSchema = z.string().trim().min(1).max(120).default('TikTok campaign');

const tiktokSearchFields = {
  name: tiktokCampaignNameSchema,
  query: z.string().trim().min(1).max(200),
  maxVideos: z.number().int().min(1).max(100).default(30),
  minLikes: z.number().int().min(0).max(2_000_000_000).optional(),
  maxLikes: z.number().int().min(0).max(2_000_000_000).optional(),
  minViews: z.number().int().min(0).max(2_000_000_000).optional(),
  maxViews: z.number().int().min(0).max(2_000_000_000).optional(),
};

function refineSearchFilters(input: { minLikes?: number; maxLikes?: number; minViews?: number; maxViews?: number }, context: z.RefinementCtx) {
  if (input.maxLikes != null && input.minLikes != null && input.maxLikes < input.minLikes) {
    context.addIssue({ code: 'custom', path: ['maxLikes'], message: 'Số tim tối đa phải lớn hơn hoặc bằng số tim tối thiểu' });
  }
  if (input.maxViews != null && input.minViews != null && input.maxViews < input.minViews) {
    context.addIssue({ code: 'custom', path: ['maxViews'], message: 'Số view tối đa phải lớn hơn hoặc bằng số view tối thiểu' });
  }
}

export const tiktokSearchVideosPayloadSchema = z.object(tiktokSearchFields).superRefine(refineSearchFilters);
export const tiktokSearchVideosSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128),
  accountId: z.uuid(),
  ...tiktokSearchFields,
}).superRefine(refineSearchFilters);
export type TikTokSearchVideosInput = z.infer<typeof tiktokSearchVideosSchema>;

const tiktokContentFields = {
  name: tiktokCampaignNameSchema,
  text: z.string().trim().max(5_000).default(''),
  mediaAssetIds: facebookMediaIdsSchema,
  intervalSeconds: z.number().int().min(60).max(86_400).default(120),
};

const tiktokVideoTargetFields = {
  ...tiktokContentFields,
  videoUrls: z.array(tiktokVideoUrlSchema).min(1).max(100).transform((urls) => [...new Set(urls)]),
};

function refineTikTokContent(input: { text: string; mediaAssetIds: string[] }, context: z.RefinementCtx) {
  if (input.text.length === 0 && input.mediaAssetIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'Nhập nội dung hoặc chọn ít nhất một ảnh' });
  }
}

const commentTikTokVideosPayloadShape = {
  ...tiktokVideoTargetFields,
  maxVideos: z.number().int().min(1).max(100).default(10),
};
export const commentTikTokVideosPayloadSchema = z.object(commentTikTokVideosPayloadShape).superRefine(refineTikTokContent);
export const commentTikTokVideosSchema = z.object({ accountId: z.uuid(), ...commentTikTokVideosPayloadShape }).superRefine(refineTikTokContent);
export type CommentTikTokVideosInput = z.infer<typeof commentTikTokVideosSchema>;

const replyTikTokCommentsPayloadShape = {
  name: tiktokCampaignNameSchema,
  videoUrls: z.array(tiktokVideoUrlSchema).min(1).max(100).transform((urls) => [...new Set(urls)]),
  text: z.string().trim().max(5_000).default(''),
  mediaAssetIds: facebookMediaIdsSchema,
  maxReplies: z.number().int().min(1).max(50).default(10),
  intervalSeconds: z.number().int().min(60).max(86_400).default(120),
};
export const replyTikTokCommentsPayloadSchema = z.object(replyTikTokCommentsPayloadShape).superRefine(refineTikTokContent);
export const replyTikTokCommentsSchema = z.object({ accountId: z.uuid(), ...replyTikTokCommentsPayloadShape }).superRefine(refineTikTokContent);
export type ReplyTikTokCommentsInput = z.infer<typeof replyTikTokCommentsSchema>;

const likeTikTokCommentsPayloadShape = {
  name: tiktokCampaignNameSchema,
  videoUrls: z.array(tiktokVideoUrlSchema).min(1).max(100).transform((urls) => [...new Set(urls)]),
  maxLikes: z.number().int().min(1).max(50).default(10),
  intervalSeconds: z.number().int().min(60).max(86_400).default(120),
};
export const likeTikTokCommentsPayloadSchema = z.object(likeTikTokCommentsPayloadShape);
export const likeTikTokCommentsSchema = z.object({ accountId: z.uuid(), ...likeTikTokCommentsPayloadShape });
export type LikeTikTokCommentsInput = z.infer<typeof likeTikTokCommentsSchema>;

const autoCommentTikTokHomePayloadShape = {
  ...tiktokContentFields,
  maxVideos: z.number().int().min(1).max(100).default(10),
  minLikes: z.number().int().min(0).max(2_000_000_000).default(0),
  maxLikes: z.number().int().min(0).max(2_000_000_000).optional(),
};
const refineHomeComment = (input: { text: string; mediaAssetIds: string[]; minLikes: number; maxLikes?: number }, context: z.RefinementCtx) => {
  refineTikTokContent(input, context);
  if (input.maxLikes != null && input.maxLikes < input.minLikes) {
    context.addIssue({ code: 'custom', path: ['maxLikes'], message: 'Số tim tối đa phải lớn hơn hoặc bằng số tim tối thiểu' });
  }
};
export const autoCommentTikTokHomePayloadSchema = z.object(autoCommentTikTokHomePayloadShape).superRefine(refineHomeComment);
export const autoCommentTikTokHomeSchema = z.object({ accountId: z.uuid(), ...autoCommentTikTokHomePayloadShape }).superRefine(refineHomeComment);
export type AutoCommentTikTokHomeInput = z.infer<typeof autoCommentTikTokHomeSchema>;

const messageTikTokFollowersPayloadShape = {
  name: tiktokCampaignNameSchema,
  username: tiktokUsernameSchema,
  text: z.string().trim().max(5_000).default(''),
  mediaAssetIds: facebookMediaIdsSchema,
  maxFollowers: z.number().int().min(1).max(100).default(20),
  intervalSeconds: z.number().int().min(60).max(86_400).default(120),
};

const refineFollowerMessage = (input: { text: string; mediaAssetIds: string[] }, context: z.RefinementCtx) => {
  if (input.text.length === 0 && input.mediaAssetIds.length === 0) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'Nhập nội dung hoặc chọn ít nhất một ảnh' });
  }
};

export const messageTikTokFollowersPayloadSchema = z.object(messageTikTokFollowersPayloadShape).superRefine(refineFollowerMessage);
export const messageTikTokFollowersSchema = z.object({ accountId: z.uuid(), ...messageTikTokFollowersPayloadShape }).superRefine(refineFollowerMessage);
export type MessageTikTokFollowersInput = z.infer<typeof messageTikTokFollowersSchema>;
