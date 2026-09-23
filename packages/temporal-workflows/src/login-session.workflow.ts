import { proxyActivities } from '@temporalio/workflow';
import type {
  LoginSessionResult,
  LoginSessionWorkflowInput,
} from '@socio/contracts';

export interface LoginSessionActivities {
  runInteractiveLoginSession(
    input: LoginSessionWorkflowInput,
  ): Promise<LoginSessionResult>;
}

const { runInteractiveLoginSession } = proxyActivities<LoginSessionActivities>({
  startToCloseTimeout: '35 minutes',
  heartbeatTimeout: '30 seconds',
  cancellationType: 'WAIT_CANCELLATION_COMPLETED',
  retry: { maximumAttempts: 1 },
});

export async function loginSessionWorkflow(
  input: LoginSessionWorkflowInput,
): Promise<LoginSessionResult> {
  return runInteractiveLoginSession(input);
}
