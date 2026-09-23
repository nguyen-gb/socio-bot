import { z } from 'zod';

export const platformSchema = z.enum([
  'FACEBOOK',
  'INSTAGRAM',
  'TIKTOK',
  'X',
]);
export type Platform = z.infer<typeof platformSchema>;

export const accountStatusSchema = z.enum([
  'CREATED',
  'LOGIN_REQUIRED',
  'READY',
  'RUNNING',
  'CHALLENGED',
  'EXPIRED',
  'DISABLED',
  'ERROR',
]);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const profileStatusSchema = z.enum([
  'CREATED',
  'AVAILABLE',
  'LEASED',
  'SNAPSHOTTING',
  'ERROR',
]);
export type ProfileStatus = z.infer<typeof profileStatusSchema>;

export const taskStatusSchema = z.enum([
  'DRAFT',
  'PAUSED',
  'SCHEDULED',
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'REQUIRES_ACTION',
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskRunStatusSchema = z.enum([
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
export type TaskRunStatus = z.infer<typeof taskRunStatusSchema>;
