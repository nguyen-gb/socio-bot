import { z } from 'zod';
import { facebookMediaIdsSchema } from './media';

export const retryFacebookCampaignSchema = z.object({
  taskIds: z.array(z.uuid()).min(1).max(500),
  verifiedUnsentTaskIds: z.array(z.uuid()).max(500).default([]),
});
export type RetryFacebookCampaignInput = z.infer<typeof retryFacebookCampaignSchema>;

export function normalizeFacebookGroupUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Chỉ chấp nhận link https://www.facebook.com/groups/...');
  }
  const match = /^\/groups\/([a-zA-Z0-9._-]+)\/?$/.exec(url.pathname);
  if (!match || ['feed', 'joins', 'discover', 'create'].includes(match[1]!)) {
    throw new Error('Link phải trỏ đến một nhóm Facebook, không phải bài viết hoặc trang danh sách');
  }
  return `https://www.facebook.com/groups/${match[1]}/`;
}

export function normalizeFacebookPostUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Chỉ chấp nhận link bài viết Facebook HTTPS');
  }
  const path = url.pathname.replace(/\/$/, '');
  const supported = [
    /^\/groups\/[a-zA-Z0-9._-]+\/(?:posts|permalink)\/\d+$/,
    /^\/[a-zA-Z0-9._-]+\/(?:posts|permalink)\/\d+$/,
    /^\/(?:posts|permalink)\/\d+$/,
  ].some(pattern => pattern.test(path))
    || (path === '/story.php' && /^\d+$/.test(url.searchParams.get('story_fbid') ?? ''))
    || (path === '/permalink.php' && /^\d+$/.test(url.searchParams.get('story_fbid') ?? ''));
  if (!supported) throw new Error('Link phải trỏ đến một bài viết Facebook hợp lệ');
  return `https://www.facebook.com${path}${url.search}`;
}

export const facebookPostUrlSchema = z.string().max(2048).transform((value, context) => {
  try { return normalizeFacebookPostUrl(value); }
  catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Link bài viết không hợp lệ' });
    return z.NEVER;
  }
});

export const facebookGroupUrlSchema = z.string().max(2048).transform((value, context) => {
  try { return normalizeFacebookGroupUrl(value); }
  catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Link nhóm không hợp lệ' });
    return z.NEVER;
  }
});

const campaignBase = z.object({
  name: z.string().trim().min(1).max(120),
  idempotencyKey: z.string().trim().min(8).max(128),
  accountIds: z.array(z.uuid()).max(100).default([]),
  intervalSeconds: z.number().int().min(30).max(3600).default(60),
});

export const joinFacebookGroupsSchema = campaignBase.extend({
  groupUrls: z.array(facebookGroupUrlSchema).min(1).max(100).transform((urls) => [...new Set(urls)]),
});
export type JoinFacebookGroupsInput = z.infer<typeof joinFacebookGroupsSchema>;

export const facebookGroupCollectionSchema = z.object({
  name: z.string().trim().min(1, 'Nhập tên tập hợp').max(80),
  description: z.string().trim().max(500).optional().default(''),
  groupUrls: z.array(facebookGroupUrlSchema).min(1, 'Chọn ít nhất một nhóm').max(1000).transform((urls) => [...new Set(urls)]),
});
export type FacebookGroupCollectionInput = z.infer<typeof facebookGroupCollectionSchema>;

export function normalizeFacebookProfileUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname) || url.username || url.password || url.port) {
    throw new Error('Chỉ chấp nhận link profile Facebook HTTPS');
  }
  if (url.pathname === '/profile.php') {
    const id = url.searchParams.get('id');
    if (!id || !/^\d+$/.test(id)) throw new Error('Link profile.php phải có ID số hợp lệ');
    return `https://www.facebook.com/profile.php?id=${id}`;
  }

  const groupMemberMatch = /^\/groups\/[^/]+\/user\/(\d+)\/?$/.exec(url.pathname);
  if (groupMemberMatch) return `https://www.facebook.com/${groupMemberMatch[1]}`;

  const peopleMatch = /^\/people\/[^/]+\/(\d+)\/?$/.exec(url.pathname);
  if (peopleMatch) return `https://www.facebook.com/profile.php?id=${peopleMatch[1]}`;
  const match = /^\/([a-zA-Z0-9._-]+)\/?$/.exec(url.pathname);
  const reserved = new Set(['groups', 'pages', 'events', 'marketplace', 'watch', 'messages', 'login', 'checkpoint']);
  if (!match || reserved.has(match[1]!.toLowerCase())) throw new Error('Link phải trỏ đến một profile Facebook');
  return `https://www.facebook.com/${match[1]}/`;
}

export const facebookProfileUrlSchema = z.string().max(2048).transform((value, context) => {
  try { return normalizeFacebookProfileUrl(value); }
  catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Link profile không hợp lệ' });
    return z.NEVER;
  }
});

export const facebookOptInRecipientSchema = z.object({
  groupUrl: facebookGroupUrlSchema,
  profileUrl: facebookProfileUrlSchema,
  displayName: z.string().trim().min(1).max(120),
  consentSource: z.string().trim().min(1, 'Ghi rõ nguồn đồng ý').max(200),
  consentNote: z.string().trim().max(1000).optional().default(''),
  consentRecordedAt: z.iso.datetime(),
});
export type FacebookOptInRecipientInput = z.infer<typeof facebookOptInRecipientSchema>;

export const messageFacebookRecipientsSchema = campaignBase.extend({
  text: z.string().trim().max(5_000).default(''),
  mediaAssetIds: facebookMediaIdsSchema,
  groupUrls: z.array(facebookGroupUrlSchema).max(100).default([]).transform((urls) => [...new Set(urls)]),
  maxRecipientsPerGroup: z.number().int().min(1).max(50),
  intervalSeconds: z.number().int().min(60).max(86_400).default(120),
}).refine(input => input.text.length > 0 || input.mediaAssetIds.length > 0, {
  message: 'Nhập nội dung hoặc chọn ít nhất một ảnh', path: ['text'],
});
export type MessageFacebookRecipientsInput = z.infer<typeof messageFacebookRecipientsSchema>;

export const scanFacebookPostCommentsSchema = campaignBase.extend({
  postUrl: facebookPostUrlSchema,
  intervalSeconds: z.number().int().min(30).max(3600).default(60),
});
export type ScanFacebookPostCommentsInput = z.infer<typeof scanFacebookPostCommentsSchema>;

export const replyFacebookPostCommentsSchema = campaignBase.extend({
  postUrl: facebookPostUrlSchema,
  text: z.string().trim().min(1).max(5_000),
  maxReplies: z.number().int().min(1).max(50),
  intervalSeconds: z.number().int().min(60).max(86_400).default(120),
});
export type ReplyFacebookPostCommentsInput = z.infer<typeof replyFacebookPostCommentsSchema>;

export const postFacebookGroupsSchema = campaignBase.extend({
  text: z.string().trim().max(20_000).default(''),
  mediaAssetIds: facebookMediaIdsSchema,
  selection: z.enum(['ALL', 'CUSTOM', 'COLLECTIONS']).default('ALL'),
  maxGroupsPerAccount: z.number().int().min(1).max(500),
  groupUrls: z.array(facebookGroupUrlSchema).min(1).max(100).transform((urls) => [...new Set(urls)]).optional(),
  collectionIds: z.array(z.uuid()).min(1).max(50).transform((ids) => [...new Set(ids)]).optional(),
}).refine(input => input.text.length > 0 || input.mediaAssetIds.length > 0, {
  message: 'Nhập nội dung hoặc chọn ít nhất một ảnh', path: ['text'],
}).refine((input) => input.selection !== 'CUSTOM' || Boolean(input.groupUrls?.length), {
  message: 'Chọn ít nhất một nhóm đã đồng bộ', path: ['groupUrls'],
}).refine((input) => input.selection !== 'COLLECTIONS' || Boolean(input.collectionIds?.length), {
  message: 'Chọn ít nhất một tập hợp nhóm', path: ['collectionIds'],
});
export type PostFacebookGroupsInput = z.infer<typeof postFacebookGroupsSchema>;

export const syncFacebookGroupsSchema = z.object({
  scope: z.enum(['ALL', 'SELECTED']).optional(),
  accountIds: z.array(z.uuid()).max(100).default([]),
  idempotencyKey: z.string().trim().min(8).max(128),
}).refine(input => input.scope !== 'SELECTED' || input.accountIds.length > 0, {
  message: 'Chọn ít nhất một profile để đồng bộ', path: ['accountIds'],
}).refine(input => input.scope !== 'ALL' || input.accountIds.length === 0, {
  message: 'Chọn tất cả không được kèm danh sách profile riêng', path: ['accountIds'],
});
export type SyncFacebookGroupsInput = z.infer<typeof syncFacebookGroupsSchema>;
