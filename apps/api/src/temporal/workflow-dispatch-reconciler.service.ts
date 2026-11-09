import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TemporalClientService } from './temporal-client.service';

@Injectable()
export class WorkflowDispatchReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowDispatchReconciler.name);
  private timer?: NodeJS.Timeout;
  private reconciling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly temporal: TemporalClientService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.reconcile(), 15_000);
    this.timer.unref();
    void this.reconcile();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const tasks = await this.prisma.task.findMany({
        where: {
          status: { in: ['QUEUED', 'SCHEDULED'] },
          workflowId: { not: null },
          dispatchedAt: null,
          pausedAt: null,
          cancelledAt: null,
        },
        select: { id: true, workflowId: true, scheduledAt: true },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      for (const task of tasks) {
        try {
          await this.temporal.startTask(task.id, task.workflowId!, task.scheduledAt ?? undefined);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.prisma.task.updateMany({
            where: { id: task.id, workflowId: task.workflowId!, dispatchedAt: null },
            data: { lastError: `Workflow dispatch pending: ${message}` },
          });
          this.logger.warn(`Dispatch pending for task ${task.id}: ${message}`);
        }
      }
    } finally {
      this.reconciling = false;
    }
  }
}
