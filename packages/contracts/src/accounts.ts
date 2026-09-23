import { z } from 'zod';
import { platformSchema } from './status';

export const accountAuthenticationSchema = z
  .object({
    login: z.string().trim().min(1).max(255).optional(),
    password: z.string().min(1).max(512).optional(),
    cookies: z.string().trim().min(1).max(200_000).optional(),
  })
  .refine((value) => Boolean(value.login) === Boolean(value.password), {
    message: 'Login and password must be provided together',
  });

export const createAccountSchema = z.object({
  platform: platformSchema.default('FACEBOOK'),
  username: z.string().trim().min(1).max(255).optional(),
  externalId: z.string().trim().min(1).max(255).nullish().transform(value => value ?? undefined),
  proxyId: z.uuid().nullish().transform(value => value ?? undefined),
  authentication: accountAuthenticationSchema.default({}),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    platform: platformSchema.optional(),
    username: z.string().trim().min(1).max(255).optional(),
    externalId: z.string().trim().min(1).max(255).nullable().optional(),
    proxyId: z.uuid().nullable().optional(),
    authentication: accountAuthenticationSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one account field is required',
  });
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
