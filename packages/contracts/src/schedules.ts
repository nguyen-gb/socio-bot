import { z } from 'zod';
import { platformActionSchema } from './actions';

const timezoneSchema = z.string().trim().min(1).max(100).refine((timezone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}, 'Invalid IANA timezone');

export const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  cronExpression: z.string().trim().min(1).max(200),
  timezone: timezoneSchema.default('UTC'),
  action: platformActionSchema,
  priority: z.number().int().min(0).max(100).default(50),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  enabled: z.boolean().default(true),
});
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const scheduledTaskWorkflowInputSchema = z.object({
  scheduleId: z.uuid(),
});
export type ScheduledTaskWorkflowInput = z.infer<
  typeof scheduledTaskWorkflowInputSchema
>;

export const materializeScheduledTaskInputSchema = z.object({
  scheduleId: z.uuid(),
  runKey: z.string().min(1).max(500),
});
export type MaterializeScheduledTaskInput = z.infer<
  typeof materializeScheduledTaskInputSchema
>;

export interface MaterializedScheduledTask {
  taskId: string;
  dispatch: boolean;
}
