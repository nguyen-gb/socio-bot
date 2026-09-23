import { proxyActivities } from '@temporalio/workflow';
import type { ProxyCheckResult, ProxyCheckWorkflowInput } from '@socio/contracts';

export interface ProxyCheckActivities {
  checkProxyConnectivity(input: ProxyCheckWorkflowInput): Promise<ProxyCheckResult>;
}

const { checkProxyConnectivity } = proxyActivities<ProxyCheckActivities>({
  startToCloseTimeout: '45 seconds',
  retry: { maximumAttempts: 1 },
});

export async function proxyCheckWorkflow(
  input: ProxyCheckWorkflowInput,
): Promise<ProxyCheckResult> {
  return checkProxyConnectivity(input);
}
