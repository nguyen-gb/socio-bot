import { z } from 'zod';

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

export const postFacebookGroupsSchema = campaignBase.extend({
  text: z.string().trim().min(1).max(20_000),
  selection: z.enum(['ALL', 'CUSTOM']).default('ALL'),
  maxGroupsPerAccount: z.number().int().min(1).max(500),
  groupUrls: z.array(facebookGroupUrlSchema).min(1).max(100).transform((urls) => [...new Set(urls)]).optional(),
}).refine((input) => input.selection !== 'CUSTOM' || Boolean(input.groupUrls?.length), {
  message: 'Chọn ít nhất một nhóm đã đồng bộ', path: ['groupUrls'],
});
export type PostFacebookGroupsInput = z.infer<typeof postFacebookGroupsSchema>;

export const syncFacebookGroupsSchema = z.object({
  accountIds: z.array(z.uuid()).max(100).default([]),
  idempotencyKey: z.string().trim().min(8).max(128),
});
