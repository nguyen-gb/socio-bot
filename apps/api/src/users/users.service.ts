import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateUserInput, UpdateUserInput } from '@socio/contracts';
import { Prisma } from '@socio/database';
import { PrismaService } from '../database/prisma.service';
import { hashPassword } from '../auth/password';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string) {
    return this.prisma.organizationMember.findMany({
      where: { organizationId },
      select: {
        role: true,
        createdAt: true,
        user: { select: { id: true, email: true, displayName: true, status: true, lastLoginAt: true, createdAt: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(organizationId: string, input: CreateUserInput) {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.user.findUnique({ where: { email: input.email }, select: { id: true } });
        if (existing) {
          const member = await tx.organizationMember.findUnique({
            where: { organizationId_userId: { organizationId, userId: existing.id } },
          });
          if (member) throw new ConflictException('Email này đã có trong workspace');
          throw new ConflictException('Email này đã được sử dụng ở workspace khác');
        }
        const user = await tx.user.create({
          data: { email: input.email, displayName: input.displayName, passwordHash, status: 'ACTIVE' },
        });
        const membership = await tx.organizationMember.create({
          data: { organizationId, userId: user.id, role: input.role },
        });
        return { role: membership.role, createdAt: membership.createdAt, user: this.publicUser(user) };
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email này đã được sử dụng');
      }
      throw error;
    }
  }

  async update(organizationId: string, userId: string, actorUserId: string | undefined, input: UpdateUserInput) {
    const member = await this.member(organizationId, userId);
    if (member.role === 'OWNER') throw new ForbiddenException('Không thể chỉnh sửa tài khoản chủ sở hữu');
    if (actorUserId === userId && (input.status === 'DISABLED' || input.role)) {
      throw new ForbiddenException('Không thể tự thay đổi quyền hoặc vô hiệu hóa chính mình');
    }
    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    return this.prisma.$transaction(async (tx) => {
      if (input.role) {
        await tx.organizationMember.update({
          where: { organizationId_userId: { organizationId, userId } },
          data: { role: input.role },
        });
      }
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(passwordHash ? { passwordHash } : {}),
        },
      });
      if (input.status === 'DISABLED' || passwordHash) {
        await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      return { role: input.role ?? member.role, createdAt: member.createdAt, user: this.publicUser(user) };
    });
  }

  async remove(organizationId: string, userId: string, actorUserId?: string) {
    const member = await this.member(organizationId, userId);
    if (member.role === 'OWNER') throw new ForbiddenException('Không thể xóa tài khoản chủ sở hữu');
    if (actorUserId === userId) throw new ForbiddenException('Không thể tự xóa chính mình');
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.updateMany({ where: { userId, organizationId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.organizationMember.delete({ where: { organizationId_userId: { organizationId, userId } } });
      // Keep the identity row as a disabled historical actor so campaign
      // ownership and activity logs still show who performed the action.
      if (await tx.organizationMember.count({ where: { userId } }) === 0) {
        await tx.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });
      }
    });
    return { deleted: true };
  }

  private async member(organizationId: string, userId: string) {
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (!member) throw new NotFoundException('Không tìm thấy người dùng');
    return member;
  }

  private publicUser(user: { id: string; email: string; displayName: string | null; status: string; lastLoginAt: Date | null; createdAt: Date }) {
    return { id: user.id, email: user.email, displayName: user.displayName, status: user.status, lastLoginAt: user.lastLoginAt, createdAt: user.createdAt };
  }
}
