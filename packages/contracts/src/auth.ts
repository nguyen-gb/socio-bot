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

export const manageableOrganizationRoleSchema = z.enum(['ADMIN', 'OPERATOR', 'VIEWER']);

export const createUserSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  displayName: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(12).max(256),
  role: manageableOrganizationRoleSchema.default('OPERATOR'),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
  password: z.string().min(12).max(256).optional(),
  role: manageableOrganizationRoleSchema.optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one change');
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export interface AuthTokenResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; email: string; displayName: string | null };
  organization: { id: string; name: string; role: OrganizationRole };
}
