export interface ProxyCheckWorkflowInput {
  organizationId: string;
  proxyId: string;
}

export interface ProxyCheckResult {
  ok: boolean;
  check: 'playwright_navigation';
  latencyMs?: number;
  locale?: string;
  languages?: string[];
  timezoneId?: string;
  error?: string;
}
