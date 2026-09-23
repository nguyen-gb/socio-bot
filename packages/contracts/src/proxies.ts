export interface ProxyCheckWorkflowInput {
  organizationId: string;
  proxyId: string;
}

export interface ProxyCheckResult {
  ok: boolean;
  check: 'playwright_navigation';
  latencyMs?: number;
  error?: string;
}
