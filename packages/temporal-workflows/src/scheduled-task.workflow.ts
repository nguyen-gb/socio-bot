import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  ActionResult,
  ExecuteTaskWorkflowInput,
  MaterializedScheduledTask,
  MaterializeScheduledTaskInput,
  ScheduledTaskWorkflowInput,
} from '@socio/contracts';

interface ScheduledTaskActivities {
  materializeScheduledTask(
    input: MaterializeScheduledTaskInput,
  ): Promise<MaterializedScheduledTask | null>;
  executeBrowserTask(input: ExecuteTaskWorkflowInput): Promise<ActionResult>;
}

const { materializeScheduledTask, executeBrowserTask } =
  proxyActivities<ScheduledTaskActivities>({
    startToCloseTimeout: '15 minutes',
    heartbeatTimeout: '30 seconds',
    retry: {
      maximumAttempts: 5,
      initialInterval: '5 seconds',
      backoffCoefficient: 2,
      maximumInterval: '1 minute',
    },
  });

export async function scheduledTaskWorkflow(
  input: ScheduledTaskWorkflowInput,
): Promise<ActionResult> {
  const materialized = await materializeScheduledTask({
    scheduleId: input.scheduleId,
    runKey: workflowInfo().workflowId,
  });
  if (!materialized) {
    return { ok: true, data: { skipped: true, reason: 'schedule_disabled' } };
  }
  if (!materialized.dispatch) {
    return {
      ok: true,
      data: { taskId: materialized.taskId, awaitingApproval: true },
    };
  }
  return executeBrowserTask({ taskId: materialized.taskId });
}
