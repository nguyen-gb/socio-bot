import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { requiresExternalApproval, type CreateTaskInput } from '@socio/contracts';
import { Prisma, type Task } from '@socio/database';
import { PrismaService } from '../database/prisma.service';
import { TemporalClientService } from '../temporal/temporal-client.service';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalClientService,
  ) {}

  list(organizationId: string) {
    return this.prisma.task.findMany({
      where: { organizationId },
      include: {
        account: { select: { username: true, platform: true } },
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async get(organizationId: string, id: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, organizationId },
      include: { runs: true, artifacts: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    return task;
  }

  async create(
    organizationId: string,
    input: CreateTaskInput,
  ): Promise<Task> {
    const account = await this.prisma.platformAccount.findFirst({
      where: {
        id: input.action.accountId,
        organizationId,
        platform: input.action.platform,
      },
      select: { id: true },
    });
    if (!account) throw new NotFoundException('Account not found');

    if (input.action.action === 'PUBLISH_POST' && input.action.payload.mediaAssetIds.length > 0) {
      const mediaCount = await this.prisma.mediaAsset.count({
        where: {
          id: { in: input.action.payload.mediaAssetIds },
          organizationId,
          status: 'READY',
        },
      });
      if (mediaCount !== input.action.payload.mediaAssetIds.length) {
        throw new BadRequestException('Every media asset must belong to the organization and be READY');
      }
    }

    const taskId = randomUUID();
    const workflowId = `task/${taskId}`;
    const requiresApproval = requiresExternalApproval(input.action.action);
    const scheduledAt = input.scheduledAt
      ? new Date(input.scheduledAt)
      : undefined;

    let task: Task;
    try {
      task = await this.prisma.task.create({
        data: {
          id: taskId,
          organizationId,
          accountId: input.action.accountId,
          idempotencyKey: input.idempotencyKey,
          workflowId,
          platform: input.action.platform,
          action: input.action.action,
          payload: input.action.payload,
          priority: input.priority,
          scheduledAt,
          maxAttempts: requiresApproval ? 1 : input.maxAttempts,
          approvalStatus: requiresApproval ? 'PENDING' : 'NOT_REQUIRED',
          status: requiresApproval
            ? 'DRAFT'
            : scheduledAt && scheduledAt.getTime() > Date.now()
              ? 'SCHEDULED'
              : 'QUEUED',
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.task.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing) return existing;
      }
      throw error;
    }

    if (requiresApproval) return task;

    try {
      await this.temporal.startTask(task.id, workflowId, scheduledAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      task = await this.prisma.task.update({
        where: { id: task.id },
        data: { lastError: `Workflow dispatch pending: ${message}` },
      });
    }

    return task;
  }

  async approve(organizationId: string, id: string, userId?: string) {
    const task = await this.prisma.task.findFirst({ where: { id, organizationId } });
    if (!task) throw new NotFoundException('Task not found');
    if (task.campaignId) throw new BadRequestException('Duyệt toàn bộ chiến dịch Facebook để giữ đúng khoảng cách giữa các tác vụ.');
    if (!requiresExternalApproval(task.action)) {
      throw new BadRequestException('This task does not require publication approval');
    }
    const updated = await this.prisma.task.updateMany({
      where: { id, organizationId, approvalStatus: 'PENDING' },
      data: {
        approvalStatus: 'APPROVED',
        approvedByUserId: userId,
        approvedAt: new Date(),
        status: task.action === 'PUBLISH_POST' ? 'DRAFT' : 'QUEUED',
        lastError: task.action === 'PUBLISH_POST' ? 'Approved and held: external publishing connector is disabled' : null,
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException(`Task approval is already ${task.approvalStatus}`);
    }
    if (task.action !== 'PUBLISH_POST') {
      try { await this.temporal.startTask(task.id, task.workflowId!, task.scheduledAt ?? undefined); }
      catch (error) { await this.prisma.task.update({ where: { id }, data: { lastError: `Workflow dispatch pending: ${error instanceof Error ? error.message : String(error)}` } }); }
    }
    return this.prisma.task.findUniqueOrThrow({ where: { id } });
  }

  async reject(organizationId: string, id: string, userId?: string) {
    const task = await this.prisma.task.findFirst({ where: { id, organizationId } });
    if (!task) throw new NotFoundException('Task not found');
    const updated = await this.prisma.task.updateMany({
      where: { id, organizationId, approvalStatus: 'PENDING' },
      data: {
        approvalStatus: 'REJECTED',
        approvedByUserId: userId,
        rejectedAt: new Date(),
        status: 'CANCELLED',
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException(`Task approval is already ${task.approvalStatus}`);
    }
    return this.prisma.task.findUniqueOrThrow({ where: { id } });
  }
}
