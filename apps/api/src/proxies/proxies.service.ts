import { lookup } from 'node:dns/promises';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import type { CreateProxyDto } from './dto/create-proxy.dto';
import type { UpdateProxyDto } from './dto/update-proxy.dto';
import { CredentialVaultService } from '../credentials/credential-vault.service';
import { TemporalClientService } from '../temporal/temporal-client.service';

@Injectable()
export class ProxiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<ApiEnvironment, true>,
    private readonly vault: CredentialVaultService,
    private readonly temporal: TemporalClientService,
  ) {}

  async list(organizationId: string) {
    const proxies = await this.prisma.proxy.findMany({
      where: { organizationId },
      include: {
        accountBindings: {
          include: {
            account: {
              select: { id: true, username: true, platform: true, status: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return proxies.map(withoutSecret);
  }

  async create(organizationId: string, input: CreateProxyDto) {
    validateCredentials(input);
    await this.validateAccounts(organizationId, input.accountIds);
    await this.ensureNoActiveBindings(undefined, input.accountIds);
    const credentialsRef =
      input.username && input.password
        ? this.vault.seal({
            username: input.username,
            password: input.password,
          })
        : input.credentialsRef;
    const proxy = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.proxy.create({
        data: {
          organizationId,
          name: input.name,
          protocol: input.protocol,
          host: input.host,
          port: input.port,
          credentialsRef,
        },
      });
      for (const accountId of unique(input.accountIds)) {
        await transaction.accountProxyBinding.upsert({
          where: { accountId },
          create: { accountId, proxyId: created.id },
          update: { proxyId: created.id },
        });
      }
      return created;
    });
    return withoutSecret(proxy);
  }

  async credentials(organizationId: string, id: string) {
    const proxy = await this.find(organizationId, id);
    return proxy.credentialsRef
      ? this.vault.proxyCredentials(proxy.credentialsRef)
      : {};
  }

  async update(organizationId: string, id: string, input: UpdateProxyDto) {
    const proxy = await this.find(organizationId, id);
    validateCredentials(input);
    if (input.clearAuthentication && (input.credentialsRef || input.username || input.password)) {
      throw new BadRequestException(
        'Cannot clear and replace proxy authentication at the same time',
      );
    }
    const accountIds = input.accountIds === undefined ? undefined : unique(input.accountIds);
    await this.validateAccounts(organizationId, accountIds);
    await this.ensureNoActiveBindings(id, accountIds);

    const replaceCredentials = Boolean(input.credentialsRef || input.username);
    const credentialsRef = input.clearAuthentication
      ? null
      : input.username && input.password
        ? this.vault.seal({ username: input.username, password: input.password })
        : input.credentialsRef;
    const connectionChanged =
      input.protocol !== undefined ||
      input.host !== undefined ||
      input.port !== undefined ||
      replaceCredentials ||
      Boolean(input.clearAuthentication);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.proxy.update({
        where: { id: proxy.id },
        data: {
          name: input.name,
          protocol: input.protocol,
          host: input.host,
          port: input.port,
          ...(replaceCredentials || input.clearAuthentication
            ? { credentialsRef }
            : {}),
          ...(connectionChanged
            ? { status: 'CREATED', latencyMs: null, lastCheckedAt: null }
            : {}),
        },
      });
      if (accountIds !== undefined) {
        await transaction.accountProxyBinding.deleteMany({
          where: {
            proxyId: id,
            ...(accountIds.length ? { accountId: { notIn: accountIds } } : {}),
          },
        });
        for (const accountId of accountIds) {
          await transaction.accountProxyBinding.upsert({
            where: { accountId },
            create: { accountId, proxyId: id },
            update: { proxyId: id },
          });
        }
      }
    });
    return this.getPresented(organizationId, id);
  }

  async remove(organizationId: string, id: string) {
    await this.find(organizationId, id);
    await this.ensureNoActiveBindings(id);
    await this.prisma.$transaction(async (transaction) => {
      await transaction.accountProxyBinding.deleteMany({ where: { proxyId: id } });
      await transaction.proxy.delete({ where: { id } });
    });
    return { deleted: true };
  }

  async test(organizationId: string, id: string) {
    const proxy = await this.find(organizationId, id);
    const startedAt = Date.now();
    try {
      const addresses = await lookup(proxy.host, { all: true, verbatim: true });
      if (addresses.length === 0) throw new Error('Proxy host did not resolve');
      if (
        !this.config.get('allowPrivateProxyHosts', { infer: true }) &&
        addresses.some(({ address }) => isPrivateAddress(address))
      ) {
        throw new Error('Private and local proxy hosts are disabled');
      }
      const result = await this.temporal.checkProxy({ organizationId, proxyId: proxy.id });
      if (!result.ok) throw new Error(result.error ?? 'Proxy test failed');
      const latencyMs = result.latencyMs ?? Date.now() - startedAt;
      await this.prisma.proxy.update({
        where: { id: proxy.id },
        data: { status: 'HEALTHY', latencyMs, lastCheckedAt: new Date() },
      });
      return { ok: true, check: result.check, latencyMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.proxy.update({
        where: { id: proxy.id },
        data: {
          status: 'UNHEALTHY',
          latencyMs: null,
          lastCheckedAt: new Date(),
        },
      });
      return { ok: false, check: 'playwright_navigation', error: proxyErrorMessage(message) };
    }
  }

  async assign(organizationId: string, proxyId: string, accountId: string) {
    const [proxy, account] = await Promise.all([
      this.find(organizationId, proxyId),
      this.prisma.platformAccount.findFirst({
        where: { id: accountId, organizationId },
        include: {
          browserProfile: {
            include: {
              sessions: {
                where: {
                  status: {
                    in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'],
                  },
                },
                select: { id: true },
                take: 1,
              },
            },
          },
        },
      }),
    ]);
    if (!account) throw new NotFoundException('Account not found');
    if (account.browserProfile?.sessions.length) {
      throw new ConflictException('Cannot change proxy during an active session');
    }
    if (proxy.status === 'DISABLED') {
      throw new ConflictException('Cannot assign a disabled proxy');
    }
    const binding = await this.prisma.accountProxyBinding.upsert({
      where: { accountId },
      create: { accountId, proxyId },
      update: { proxyId },
      include: { proxy: true },
    });
    return { ...binding, proxy: withoutSecret(binding.proxy) };
  }

  async release(organizationId: string, proxyId: string, accountId: string) {
    await this.find(organizationId, proxyId);
    const binding = await this.prisma.accountProxyBinding.findFirst({
      where: {
        accountId,
        proxyId,
        account: { organizationId },
      },
      include: {
        account: {
          include: {
            browserProfile: {
              include: {
                sessions: {
                  where: {
                    status: {
                      in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'],
                    },
                  },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    if (!binding) throw new NotFoundException('Proxy binding not found');
    if (binding.account.browserProfile?.sessions.length) {
      throw new ConflictException('Cannot release proxy during an active session');
    }
    await this.prisma.accountProxyBinding.delete({ where: { accountId } });
    return { released: true };
  }

  private async find(organizationId: string, id: string) {
    const proxy = await this.prisma.proxy.findFirst({
      where: { id, organizationId },
    });
    if (!proxy) throw new NotFoundException('Proxy not found');
    return proxy;
  }

  private async getPresented(organizationId: string, id: string) {
    const proxy = await this.prisma.proxy.findFirst({
      where: { id, organizationId },
      include: {
        accountBindings: {
          include: {
            account: {
              select: { id: true, username: true, platform: true, status: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!proxy) throw new NotFoundException('Proxy not found');
    return withoutSecret(proxy);
  }

  private async validateAccounts(
    organizationId: string,
    accountIds: string[] | undefined,
  ) {
    const ids = unique(accountIds);
    if (!ids.length) return;
    const accounts = await this.prisma.platformAccount.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true },
    });
    if (accounts.length !== ids.length) {
      throw new NotFoundException('One or more accounts were not found');
    }
  }

  private async ensureNoActiveBindings(
    proxyId: string | undefined,
    nextAccountIds?: string[],
  ) {
    const bindings = await this.prisma.accountProxyBinding.findMany({
      where: {
        OR: [
          ...(proxyId ? [{ proxyId }] : []),
          ...(nextAccountIds?.length ? [{ accountId: { in: nextAccountIds } }] : []),
        ],
      },
      include: {
        account: {
          include: {
            browserProfile: {
              include: {
                sessions: {
                  where: {
                    status: {
                      in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'],
                    },
                  },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        },
      },
    });
    if (bindings.some((binding) => binding.account.browserProfile?.sessions.length)) {
      throw new ConflictException(
        'Close browsers for assigned profiles before changing this proxy',
      );
    }
  }
}

function validateCredentials(input: {
  username?: string;
  password?: string;
  credentialsRef?: string;
}) {
  if (Boolean(input.username) !== Boolean(input.password)) {
    throw new BadRequestException(
      'Proxy username and password must be provided together',
    );
  }
  if (input.credentialsRef && input.username) {
    throw new BadRequestException(
      'Use either a secret reference or username/password',
    );
  }
}

function unique(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

function withoutSecret<T extends { credentialsRef: string | null }>(proxy: T) {
  const { credentialsRef, ...safe } = proxy;
  return { ...safe, hasAuthentication: Boolean(credentialsRef) };
}

function proxyErrorMessage(message: string): string {
  if (/timed?\s*out|ETIMEDOUT/i.test(message)) return 'Không thể kết nối proxy: hết thời gian chờ';
  if (/ECONNREFUSED/i.test(message)) return 'Proxy từ chối kết nối';
  if (/ENETUNREACH|EHOSTUNREACH/i.test(message)) return 'Không thể truy cập máy chủ proxy';
  if (/ENOTFOUND/i.test(message)) return 'Không tìm thấy máy chủ proxy';
  return message;
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const ipv4 = normalized.startsWith('::ffff:')
    ? normalized.slice('::ffff:'.length)
    : normalized;
  const octets = ipv4.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    a! >= 224
  );
}
