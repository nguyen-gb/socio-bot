import { Injectable } from '@nestjs/common';
import type { ProxyCheckResult, ProxyCheckWorkflowInput } from '@socio/contracts';
import { chromium } from 'playwright';
import { PrismaService } from '../database/prisma.service';
import { SecretsService } from '../secrets/secrets.service';

@Injectable()
export class ProxyCheckActivities {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
  ) {}

  async checkProxyConnectivity(
    input: ProxyCheckWorkflowInput,
  ): Promise<ProxyCheckResult> {
    const proxy = await this.prisma.proxy.findFirst({
      where: { id: input.proxyId, organizationId: input.organizationId },
    });
    if (!proxy) {
      return { ok: false, check: 'playwright_navigation', error: 'Không tìm thấy proxy' };
    }

    const credentials = proxy.credentialsRef
      ? await this.secrets.proxyCredentials(proxy.credentialsRef)
      : undefined;
    if (proxy.protocol === 'SOCKS5' && credentials) {
      return {
        ok: false,
        check: 'playwright_navigation',
        error: 'Chromium/Playwright không hỗ trợ username và password cho proxy SOCKS5',
      };
    }

    const startedAt = Date.now();
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: {
          server: `${proxy.protocol.toLowerCase()}://${proxy.host}:${proxy.port.toString()}`,
          username: credentials?.username,
          password: credentials?.password,
        },
      });
      const page = await browser.newPage();
      await page.goto('https://www.facebook.com/robots.txt', {
        waitUntil: 'commit',
        timeout: 25_000,
      });
      return {
        ok: true,
        check: 'playwright_navigation',
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        check: 'playwright_navigation',
        error: normalizeProxyError(error),
      };
    } finally {
      await browser?.close();
    }
  }
}

export function normalizeProxyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ERR_PROXY_CONNECTION_FAILED|ECONNREFUSED/i.test(message)) return 'Proxy từ chối hoặc không nhận kết nối';
  if (/ERR_TIMED_OUT|timed?\s*out|ETIMEDOUT/i.test(message)) return 'Không thể kết nối proxy: hết thời gian chờ';
  if (/ERR_INVALID_AUTH_CREDENTIALS|407|authentication.*failed/i.test(message)) return 'Username hoặc password của proxy không đúng';
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(message)) return 'Không tìm thấy máy chủ proxy';
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(message)) return 'Proxy không thể tạo kết nối HTTPS tới Facebook';
  return message.replace(/^page\.goto:\s*/i, '').split('\n')[0] ?? message;
}
