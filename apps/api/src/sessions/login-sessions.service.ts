import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CreateLoginSessionInput } from '@socio/contracts';
import { Prisma } from '@socio/database';
import { signRemoteSessionToken } from '@socio/remote-session-auth';
import type { ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { TemporalClientService } from '../temporal/temporal-client.service';

@Injectable()
export class LoginSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalClientService,
    private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  async create(
    organizationId: string,
    accountId: string,
    input: CreateLoginSessionInput,
  ) {
    const account = await this.prisma.platformAccount.findFirst({
      where: { id: accountId, organizationId },
      include: {
        browserProfile: true,
        proxyBinding: { include: { proxy: true } },
      },
    });
    if (!account?.browserProfile) {
      throw new NotFoundException('Account or browser profile not found');
    }
    if (['LEASED', 'SNAPSHOTTING'].includes(account.browserProfile.status)) {
      throw new ConflictException('Profile đang được sử dụng hoặc đang lưu dữ liệu. Đóng browser hiện tại và chờ hoàn tất.');
    }
    const assignedProxy = account.proxyBinding?.proxy;
    if (assignedProxy && assignedProxy.status !== 'HEALTHY') {
      throw new ConflictException({
        message: `Proxy "${assignedProxy.name}" chưa kết nối được. Hãy kiểm tra proxy trước khi mở browser.`,
        proxyId: assignedProxy.id,
        proxyStatus: assignedProxy.status,
      });
    }

    const existing = await this.prisma.browserSession.findFirst({
      where: {
        profileId: account.browserProfile.id,
        status: { in: ['STARTING', 'RUNNING', 'CLOSING'] },
      },
      orderBy: { startedAt: 'desc' },
    });
    if (existing) {
      throw new ConflictException({
        message: 'This account already has an active browser session',
        sessionId: existing.id,
      });
    }

    const sessionId = randomUUID();
    const workflowId = `login-session/${sessionId}`;
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1_000);

    try {
      await this.prisma.browserSession.create({
        data: {
          id: sessionId,
          profileId: account.browserProfile.id,
          workflowId,
          mode: 'LOGIN',
          status: 'STARTING',
          expiresAt,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'This account already has an active browser session',
        );
      }
      throw error;
    }

    try {
      await this.temporal.startLoginSession(sessionId, workflowId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.browserSession.update({
        where: { id: sessionId },
        data: { status: 'CRASHED', closedAt: new Date(), lastError: message },
      });
      throw error;
    }

    return this.get(organizationId, sessionId);
  }

  async listForAccount(organizationId: string, accountId: string) {
    const sessions = await this.prisma.browserSession.findMany({
      where: {
        profile: { organizationId, accountId },
        mode: 'LOGIN',
      },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    return sessions.map((session) => this.present(session));
  }

  async listActive(organizationId: string) {
    const sessions = await this.prisma.browserSession.findMany({
      where: {
        profile: { organizationId },
        status: { in: ['STARTING', 'RUNNING', 'CLOSING'] },
      },
      include: {
        profile: {
          select: {
            account: {
              select: {
                id: true,
                platform: true,
                username: true,
              },
            },
          },
        },
      },
      orderBy: { startedAt: 'desc' },
    });
    return sessions.map((session) => ({
      ...this.present(session),
      account: session.profile.account,
      profile: undefined,
    }));
  }

  async get(organizationId: string, sessionId: string) {
    const session = await this.prisma.browserSession.findFirst({
      where: {
        id: sessionId,
        profile: { organizationId },
      },
    });
    if (!session) throw new NotFoundException('Browser session not found');
    return this.present(session);
  }

  async close(organizationId: string, sessionId: string, force = false) {
    const session = await this.prisma.browserSession.findFirst({
      where: { id: sessionId, profile: { organizationId } },
    });
    if (!session) throw new NotFoundException('Browser session not found');

    if (['AUTHENTICATED', 'CLOSED', 'EXPIRED', 'CRASHED'].includes(session.status)) {
      return this.present(session);
    }
    if (!session.workerId && ['STARTING', 'CLOSING'].includes(session.status)) {
      await this.prisma.browserSession.updateMany({ where: { id: session.id, workerId: null, status: { in: ['STARTING', 'CLOSING'] } }, data: { status: 'CLOSED', closedAt: new Date() } });
      return this.get(organizationId, sessionId);
    }

    await this.prisma.browserSession.updateMany({
      where: { id: session.id, status: { in: ['STARTING', 'RUNNING', 'IDLE', 'CLOSING'] } },
      data: { status: 'CLOSING', ...(force ? { forceCloseRequestedAt: new Date() } : {}) },
    });
    return this.get(organizationId, sessionId);
  }

  private present<T extends {
    id: string;
    status: string;
    debugEndpoint: string | null;
    expiresAt: Date;
  }>(session: T) {
    let accessUrl: string | null = null;
    let accessExpiresAt: string | null = null;

    if (
      session.status === 'RUNNING' &&
      session.debugEndpoint &&
      session.expiresAt.getTime() > Date.now()
    ) {
      const signed = signRemoteSessionToken(
        session.id,
        this.config.get('remoteSessionSecret', { infer: true }),
        60,
      );
      const url = new URL(session.debugEndpoint);
      url.searchParams.set('token', signed.token);
      accessUrl = url.toString();
      accessExpiresAt = signed.expiresAt.toISOString();
    }

    return { ...session, accessUrl, accessExpiresAt };
  }
}
