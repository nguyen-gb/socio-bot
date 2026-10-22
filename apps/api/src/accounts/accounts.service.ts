import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateAccountInput, UpdateAccountInput } from '@socio/contracts';
import { Prisma } from '@socio/database';
import { PrismaService } from '../database/prisma.service';
import { CredentialVaultService } from '../credentials/credential-vault.service';

const accountInclude = Prisma.validator<Prisma.PlatformAccountInclude>()({
  browserProfile: {
    include: {
      sessions: {
        where: {
          status: {
            in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'],
          },
        },
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          status: true,
          expiresAt: true,
          startedAt: true,
        },
      },
    },
  },
  proxyBinding: { include: { proxy: true } },
});

type AccountWithDetails = Prisma.PlatformAccountGetPayload<{
  include: typeof accountInclude;
}>;

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CredentialVaultService,
  ) {}

  async list(organizationId: string) {
    const accounts = await this.prisma.platformAccount.findMany({
      where: { organizationId },
      include: accountInclude,
      orderBy: { createdAt: 'desc' },
    });
    return accounts.map((account) => this.present(account));
  }

  async get(organizationId: string, id: string) {
    const account = await this.prisma.platformAccount.findFirst({
      where: { id, organizationId },
      include: accountInclude,
    });
    if (!account) throw new NotFoundException('Account not found');
    return this.present(account);
  }

  async credentials(organizationId: string, id: string) {
    const account = await this.prisma.platformAccount.findFirst({
      where: { id, organizationId },
      select: { browserProfile: { select: { metadata: true } } },
    });
    if (!account?.browserProfile) throw new NotFoundException('Account not found');
    const metadata = asRecord(account.browserProfile.metadata);
    return typeof metadata.credentialsRef === 'string'
      ? this.vault.profileCredentials(metadata.credentialsRef)
      : {};
  }

  async create(organizationId: string, input: CreateAccountInput) {
    if (input.proxyId) {
      const proxy = await this.prisma.proxy.findFirst({
        where: { id: input.proxyId, organizationId },
        select: { id: true },
      });
      if (!proxy) throw new NotFoundException('Proxy not found');
    }

    const accountId = randomUUID();
    const profileId = randomUUID();

    const authentication = input.authentication;
    const profileMetadata = authenticationMetadata(authentication, this.vault, input.fingerprint);

    await this.prisma.$transaction(async (transaction) => {
      await transaction.platformAccount.create({
        data: {
          id: accountId,
          organizationId,
          platform: input.platform,
          username: input.username,
          externalId: input.externalId,
          status: 'LOGIN_REQUIRED',
          browserProfile: {
            create: {
              id: profileId,
              organizationId,
              storageUri: `profiles/${profileId}`,
              status: 'AVAILABLE',
              metadata: profileMetadata,
            },
          },
        },
      });

      if (input.proxyId) {
        await transaction.accountProxyBinding.create({
          data: { accountId, proxyId: input.proxyId },
        });
      }

    });
    return this.get(organizationId, accountId);
  }

  async update(
    organizationId: string,
    id: string,
    input: UpdateAccountInput,
  ) {
    const account = await this.prisma.platformAccount.findFirst({
      where: { id, organizationId },
      include: accountInclude,
    });
    if (!account) throw new NotFoundException('Account not found');
    if (account.browserProfile?.sessions.length) {
      throw new ConflictException('Close the browser before editing this account');
    }
    if (input.proxyId) {
      const proxy = await this.prisma.proxy.findFirst({
        where: { id: input.proxyId, organizationId },
        select: { id: true, status: true },
      });
      if (!proxy) throw new NotFoundException('Proxy not found');
      if (proxy.status === 'DISABLED') {
        throw new ConflictException('Cannot assign a disabled proxy');
      }
    }

    const authentication = input.authentication;
    const currentMetadata = asRecord(account.browserProfile?.metadata);
    const currentAuthentication = authentication && typeof currentMetadata.credentialsRef === 'string'
      ? this.vault.profileCredentials(currentMetadata.credentialsRef)
      : {};
    const authenticationChanged = authentication !== undefined && (
      (authentication.login?.trim() || undefined) !== (currentAuthentication.login?.trim() || undefined)
      || (authentication.password || undefined) !== (currentAuthentication.password || undefined)
      || (authentication.cookies?.trim() || undefined) !== (currentAuthentication.cookies?.trim() || undefined)
    );
    const platformChanged = input.platform !== undefined && input.platform !== account.platform;
    const profileMetadataRecord: Record<string, unknown> = authenticationChanged && authentication
      ? {
        ...(authenticationMetadata(authentication, this.vault) as Record<string, unknown>),
        ...(currentMetadata.fingerprint ? { fingerprint: currentMetadata.fingerprint } : {}),
      }
      : { ...currentMetadata };
    if (input.fingerprint) {
      profileMetadataRecord.fingerprint = input.fingerprint;
    }
    const profileMetadata = profileMetadataRecord as Prisma.InputJsonObject;

    await this.prisma.$transaction(async (transaction) => {
      await transaction.platformAccount.update({
        where: { id },
        data: {
          platform: input.platform,
          username: input.username,
          externalId: input.externalId,
          ...(platformChanged || authenticationChanged ? { status: 'LOGIN_REQUIRED' } : {}),
        },
      });
      if ((authenticationChanged || input.fingerprint !== undefined) && account.browserProfile) {
        await transaction.browserProfile.update({
          where: { id: account.browserProfile.id },
          data: { metadata: profileMetadata, status: 'AVAILABLE' },
        });
      }
      if (input.proxyId === null) {
        await transaction.accountProxyBinding.deleteMany({ where: { accountId: id } });
      } else if (input.proxyId) {
        await transaction.accountProxyBinding.upsert({
          where: { accountId: id },
          create: { accountId: id, proxyId: input.proxyId },
          update: { proxyId: input.proxyId },
        });
      }
    });
    return this.get(organizationId, id);
  }

  async remove(organizationId: string, id: string) {
    const account = await this.prisma.platformAccount.findFirst({
      where: { id, organizationId },
      include: {
        browserProfile: {
          include: {
            sessions: {
              where: { status: { in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'] } },
              select: { id: true },
              take: 1,
            },
          },
        },
        tasks: {
          where: { status: 'RUNNING' },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!account) throw new NotFoundException('Account not found');
    if (account.browserProfile?.sessions.length) {
      throw new ConflictException('Close the browser before deleting this account');
    }
    if (account.tasks.length) {
      throw new ConflictException(
        'Wait for this account\'s running task to finish before deleting the account',
      );
    }
    await this.prisma.$transaction(async (transaction) => {
      await transaction.schedule.deleteMany({ where: { accountId: id } });
      await transaction.task.deleteMany({ where: { accountId: id } });
      if (account.browserProfile) {
        await transaction.browserSession.deleteMany({
          where: { profileId: account.browserProfile.id },
        });
      }
      await transaction.platformAccount.delete({ where: { id } });
    });
    return { deleted: true };
  }

  private present(account: AccountWithDetails) {
    const profileMetadata = asRecord(account.browserProfile?.metadata);
    const legacyMethod = String(profileMetadata.loginMethod ?? '');
    const hasCookies = profileMetadata.hasCookies === true || legacyMethod === 'COOKIES';
    const hasPassword = profileMetadata.hasPassword === true || legacyMethod === 'PASSWORD';
    const fingerprint = profileMetadata.fingerprint && typeof profileMetadata.fingerprint === 'object' && !Array.isArray(profileMetadata.fingerprint)
      ? profileMetadata.fingerprint
      : undefined;
    const proxy = account.proxyBinding?.proxy;
    const safeBinding =
      account.proxyBinding && proxy
        ? {
            ...account.proxyBinding,
            proxy: withoutProxySecret(proxy),
          }
        : account.proxyBinding;
    return {
      ...account,
      browserProfile: account.browserProfile
        ? {
            ...account.browserProfile,
            metadata: { hasCookies, hasPassword },
            hasCookies,
            hasPassword,
            fingerprint,
          }
        : null,
      proxyBinding: safeBinding,
    };
  }
}

function authenticationMetadata(
  authentication: CreateAccountInput['authentication'],
  vault: CredentialVaultService,
  fingerprint?: CreateAccountInput['fingerprint'],
): Prisma.InputJsonObject {
  const hasPassword = Boolean(authentication.login && authentication.password);
  const hasCookies = Boolean(authentication.cookies);
  const credentialsRef = hasPassword || hasCookies
    ? vault.seal({
        login: authentication.login,
        password: authentication.password,
        cookies: authentication.cookies,
      })
    : undefined;
  return {
    hasPassword,
    hasCookies,
    ...(credentialsRef ? { credentialsRef } : {}),
    ...(fingerprint ? { fingerprint: fingerprint as unknown as Prisma.InputJsonValue } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function withoutProxySecret<T extends { credentialsRef: string | null }>(
  proxy: T,
) {
  const { credentialsRef, ...safe } = proxy;
  return { ...safe, hasAuthentication: Boolean(credentialsRef) };
}
