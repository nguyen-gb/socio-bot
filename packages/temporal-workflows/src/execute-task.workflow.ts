import { proxyActivities, sleep } from '@temporalio/workflow';
import type {
  ActionResult,
  ExecuteTaskWorkflowInput,
} from '@socio/contracts';

export interface BrowserTaskActivities {
  executeBrowserTask(input: ExecuteTaskWorkflowInput): Promise<ActionResult>;
}

const { executeBrowserTask } = proxyActivities<BrowserTaskActivities>({
  startToCloseTimeout: '15 minutes',
  // Keep task execution on the task queue's active worker pool. The local
  // Temporal server may expose SDK build capabilities while no compatible
  // version set is configured; the default intent would otherwise leave the
  // activity scheduled indefinitely without a worker claiming it.
  versioningIntent: 'DEFAULT',
  // Restoring a persisted browser profile and launching Chrome can take over
  // 30 seconds on a cold worker. Avoid a false Temporal retry before the
  // browser task has even been claimed.
  heartbeatTimeout: '2 minutes',
  retry: {
    maximumAttempts: 5,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    maximumInterval: '1 minute',
  },
});

export async function executeTaskWorkflow(
  input: ExecuteTaskWorkflowInput,
): Promise<ActionResult> {
  if (input.scheduledAt) {
    const delayMs = new Date(input.scheduledAt).getTime() - Date.now();
    if (delayMs > 0) await sleep(delayMs);
  }
  return executeBrowserTask(input);
}
