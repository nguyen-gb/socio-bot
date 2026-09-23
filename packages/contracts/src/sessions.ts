import { z } from 'zod';

export const browserSessionStatusSchema = z.enum([
  'STARTING',
  'RUNNING',
  'AUTHENTICATED',
  'CLOSING',
  'CLOSED',
  'EXPIRED',
  'CRASHED',
]);
export type BrowserSessionStatus = z.infer<
  typeof browserSessionStatusSchema
>;

export const createLoginSessionSchema = z.object({
  ttlSeconds: z.number().int().min(60).max(1_800).default(600),
});
export type CreateLoginSessionInput = z.infer<
  typeof createLoginSessionSchema
>;

export const loginSessionWorkflowInputSchema = z.object({
  sessionId: z.uuid(),
});
export type LoginSessionWorkflowInput = z.infer<
  typeof loginSessionWorkflowInputSchema
>;

export interface LoginSessionResult {
  status: 'AUTHENTICATED' | 'CLOSED' | 'EXPIRED';
}

export const remoteBrowserCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('browserState') }),
  z.object({ type: z.literal('navigate'), url: z.string().max(4096).url().refine(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, 'Chỉ hỗ trợ URL HTTP/HTTPS không chứa thông tin đăng nhập') }),
  z.object({ type: z.literal('navigation'), action: z.enum(['back', 'forward', 'reload']) }),
  z.object({ type: z.literal('newTab') }),
  z.object({ type: z.literal('selectTab'), tabId: z.uuid() }),
  z.object({ type: z.literal('closeTab'), tabId: z.uuid() }),
  z.object({
    type: z.literal('wheel'),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    deltaX: z.number().min(-4000).max(4000),
    deltaY: z.number().min(-4000).max(4000),
  }),
  z.object({
    type: z.literal('mouse'),
    action: z.enum(['down', 'move', 'up']),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }),
  z.object({ type: z.literal('release') }),
  z.object({
    type: z.literal('click'),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    button: z.enum(['left', 'middle', 'right']).default('left'),
  }),
  z.object({
    type: z.literal('text'),
    text: z.string().max(2_000),
  }),
  z.object({
    type: z.literal('key'),
    key: z.enum(['Backspace', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']),
    shift: z.boolean().default(false),
  }),
]);
export type RemoteBrowserCommand = z.infer<
  typeof remoteBrowserCommandSchema
>;
