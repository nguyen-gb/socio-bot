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
  heartbeatTimeout: '30 seconds',
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
