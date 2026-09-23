import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Connection, ScheduleOverlapPolicy } from '@temporalio/client';
import type { Schedule } from '@socio/database';
import type { ProxyCheckResult, ProxyCheckWorkflowInput } from '@socio/contracts';
import type { ApiEnvironment } from '../config/environment';
import {
  executeTaskWorkflow,
  loginSessionWorkflow,
  proxyCheckWorkflow,
  scheduledTaskWorkflow,
} from '@socio/temporal-workflows';

@Injectable()
export class TemporalClientService implements OnModuleDestroy {
  private connection?: Connection;
  private connectionPromise?: Promise<Connection>;

  constructor(
    private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  async startTask(
    taskId: string,
    workflowId: string,
    scheduledAt?: Date,
  ): Promise<void> {
    const connection = await this.getConnection();
    const client = new Client({
      connection,
      namespace: this.config.get('temporalNamespace', { infer: true }),
    });

    await client.workflow.start(executeTaskWorkflow, {
      taskQueue: this.config.get('temporalTaskQueue', { infer: true }),
      workflowId,
      args: [{ taskId, workflowId, scheduledAt: scheduledAt?.toISOString() }],
    });
  }

  async startLoginSession(
    sessionId: string,
    workflowId: string,
  ): Promise<void> {
    const connection = await this.getConnection();
    const client = new Client({
      connection,
      namespace: this.config.get('temporalNamespace', { infer: true }),
    });

    await client.workflow.start(loginSessionWorkflow, {
      taskQueue: this.config.get('temporalTaskQueue', { infer: true }),
      workflowId,
      args: [{ sessionId }],
    });
  }

  async checkProxy(input: ProxyCheckWorkflowInput): Promise<ProxyCheckResult> {
    const client = await this.getClient();
    return client.workflow.execute(proxyCheckWorkflow, {
      taskQueue: this.config.get('temporalTaskQueue', { infer: true }),
      workflowId: `proxy-check/${input.proxyId}/${Date.now().toString()}`,
      args: [input],
      workflowRunTimeout: '50 seconds',
    });
  }

  async createSchedule(
    schedule: Pick<
      Schedule,
      'id' | 'cronExpression' | 'timezone' | 'enabled'
    >,
  ): Promise<Date | null> {
    const client = await this.getClient();
    const handle = await client.schedule.create({
      scheduleId: this.scheduleId(schedule.id),
      spec: {
        cronExpressions: [schedule.cronExpression],
        timezone: schedule.timezone,
      },
      action: {
        type: 'startWorkflow',
        workflowType: scheduledTaskWorkflow,
        taskQueue: this.config.get('temporalTaskQueue', { infer: true }),
        args: [{ scheduleId: schedule.id }],
      },
      policies: {
        overlap: ScheduleOverlapPolicy.SKIP,
        catchupWindow: '5 minutes',
      },
      state: {
        paused: !schedule.enabled,
        note: schedule.enabled ? undefined : 'Disabled when created in Socio',
      },
    });
    const description = await handle.describe();
    return description.info.nextActionTimes[0] ?? null;
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
    const handle = (await this.getClient()).schedule.getHandle(this.scheduleId(id));
    if (enabled) await handle.unpause('Enabled in Socio');
    else await handle.pause('Disabled in Socio');
  }

  async getScheduleNextRun(id: string): Promise<Date | null> {
    const handle = (await this.getClient()).schedule.getHandle(this.scheduleId(id));
    return (await handle.describe()).info.nextActionTimes[0] ?? null;
  }

  async triggerSchedule(id: string): Promise<void> {
    const handle = (await this.getClient()).schedule.getHandle(this.scheduleId(id));
    await handle.trigger(ScheduleOverlapPolicy.SKIP);
  }

  async deleteSchedule(id: string): Promise<void> {
    const handle = (await this.getClient()).schedule.getHandle(this.scheduleId(id));
    await handle.delete();
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }

  private async getConnection(): Promise<Connection> {
    if (this.connection) return this.connection;
    this.connectionPromise ??= Connection.connect({
      address: this.config.get('temporalAddress', { infer: true }),
    });
    this.connection = await this.connectionPromise;
    return this.connection;
  }

  private async getClient(): Promise<Client> {
    return new Client({
      connection: await this.getConnection(),
      namespace: this.config.get('temporalNamespace', { infer: true }),
    });
  }

  private scheduleId(id: string): string {
    return `socio-schedule-${id}`;
  }
}
