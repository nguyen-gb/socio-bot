import { Injectable, NotFoundException } from '@nestjs/common';
import type { CreateScheduleInput } from '@socio/contracts';
import { Prisma } from '@socio/database';
import { PrismaService } from '../database/prisma.service';
import { TemporalClientService } from '../temporal/temporal-client.service';

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalClientService,
  ) {}

  list(organizationId: string) {
    return this.prisma.schedule.findMany({
      where: { organizationId },
      include: { account: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(organizationId: string, id: string) {
    const schedule = await this.prisma.schedule.findFirst({
      where: { id, organizationId },
      include: { account: true },
    });
    if (!schedule) throw new NotFoundException('Schedule not found');
    return schedule;
  }

  async create(organizationId: string, input: CreateScheduleInput) {
    const account = await this.prisma.platformAccount.findFirst({
      where: { id: input.action.accountId, organizationId },
      select: { id: true, platform: true },
    });
    if (!account) throw new NotFoundException('Account not found');
    if (account.platform !== input.action.platform) {
      throw new NotFoundException('Account platform does not match action');
    }

    const schedule = await this.prisma.schedule.create({
      data: {
        organizationId,
        accountId: account.id,
        name: input.name,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
        action: input.action.action,
        payload: input.action.payload as Prisma.InputJsonValue,
        enabled: input.enabled,
        priority: input.priority,
        maxAttempts: input.maxAttempts,
      },
    });

    try {
      const nextRunAt = await this.temporal.createSchedule(schedule);
      return this.prisma.schedule.update({
        where: { id: schedule.id },
        data: { nextRunAt },
      });
    } catch (error) {
      await this.prisma.schedule.delete({ where: { id: schedule.id } });
      throw error;
    }
  }

  async setEnabled(organizationId: string, id: string, enabled: boolean) {
    const schedule = await this.get(organizationId, id);
    await this.temporal.setScheduleEnabled(id, enabled);
    const nextRunAt = enabled
      ? await this.temporal.getScheduleNextRun(id)
      : null;
    return this.prisma.schedule.update({
      where: { id: schedule.id },
      data: { enabled, nextRunAt },
    });
  }

  async trigger(organizationId: string, id: string) {
    await this.get(organizationId, id);
    await this.temporal.triggerSchedule(id);
    return { accepted: true };
  }

  async remove(organizationId: string, id: string) {
    const schedule = await this.get(organizationId, id);
    await this.temporal.deleteSchedule(id);
    await this.prisma.schedule.delete({ where: { id: schedule.id } });
    return { deleted: true };
  }
}
