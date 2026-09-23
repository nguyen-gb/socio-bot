import { z } from 'zod';

export const organizationRoleSchema = z.enum([
  'OWNER',
  'ADMIN',
  'OPERATOR',
  'VIEWER',
]);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const loginSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(12).max(256),
  organizationId: z.uuid().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(32).max(512),
});
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;

export interface AuthTokenResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string; displayName: string | null };
  organization: { id: string; name: string; role: OrganizationRole };
}
