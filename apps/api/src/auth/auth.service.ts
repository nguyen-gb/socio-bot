import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LoginInput } from '@socio/contracts';
import type { ApiEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { AccessTokenService } from './access-token.service';
import { verifyPassword } from './password';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AccessTokenService,
    private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  async login(input: LoginInput) {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: {
        memberships: { include: { organization: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !user.passwordHash ||
      !(await verifyPassword(input.password, user.passwordHash))
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const membership = input.organizationId
      ? user.memberships.find((item) => item.organizationId === input.organizationId)
      : user.memberships[0];
    if (!membership) throw new UnauthorizedException('User is not a member of this organization');

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueSession(user, membership);
  }

  async refresh(rawToken: string) {
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: {
        user: {
          include: {
            memberships: { include: { organization: true } },
          },
        },
      },
    });
    if (!current || current.revokedAt || current.expiresAt <= new Date() || current.user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    const membership = current.user.memberships.find(
      (item) => item.organizationId === current.organizationId,
    );
    if (!membership) throw new UnauthorizedException('Organization membership no longer exists');

    await this.prisma.refreshToken.update({
      where: { id: current.id },
      data: { revokedAt: new Date() },
    });
    return this.issueSession(current.user, membership);
  }

  async logout(rawToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueSession(
    user: { id: string; email: string; displayName: string | null },
    membership: {
      organizationId: string;
      role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
      organization: { name: string };
    },
  ) {
    const access = this.tokens.issue({
      userId: user.id,
      organizationId: membership.organizationId,
      role: membership.role,
      email: user.email,
    });
    const refreshToken = randomBytes(48).toString('base64url');
    const refreshExpiresAt = new Date(
      Date.now() + this.config.get('refreshTokenTtlDays', { infer: true }) * 86_400_000,
    );
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        organizationId: membership.organizationId,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName },
      organization: {
        id: membership.organizationId,
        name: membership.organization.name,
        role: membership.role,
      },
    };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
