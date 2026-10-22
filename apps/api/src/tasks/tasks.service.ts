import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { requiresExternalApproval, type CreateTaskInput } from '@socio/contracts';
import { Prisma, type Task } from '@socio/database';
import { PrismaService } from '../database/prisma.service';
import { TemporalClientService } from '../temporal/temporal-client.service';
import { validateFacebookImages } from '../media/facebook-images';

// Browser deadline (15m) + Temporal/teardown grace (17m activity budget).
const STALE_BROWSER_RUN_MS = 18 * 60_000;

type RetryableTikTokTask = {
  id: string;
  organizationId: string;
  accountId: string;
  platform: string;
  action: string;
  payload: Prisma.JsonValue;
  status: string;
  attemptCount: number;
  lastError: string | null;
  account: { status: string; browserProfile: { id: string } | null };
  runs: Array<{ id: string; status: string; startedAt: Date; result: Prisma.JsonValue | null }>;
};

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
      account: { select: { id: true, username: true, platform: true, status: true } },
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

    if (input.action.action === 'POST_FACEBOOK_GROUP' || input.action.action === 'MESSAGE_FACEBOOK_RECIPIENT' || input.action.action === 'MESSAGE_FACEBOOK_REACTOR' || input.action.action === 'REPLY_FACEBOOK_POST_COMMENTS' || input.action.action === 'AUTO_COMMENT_TIKTOK_HOME' || input.action.action === 'COMMENT_TIKTOK_VIDEOS' || input.action.action === 'REPLY_TIKTOK_COMMENTS' || input.action.action === 'MESSAGE_TIKTOK_FOLLOWERS') {
      await validateFacebookImages(this.prisma, organizationId, input.action.payload.mediaAssetIds);
    }

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
    if (task.platform === 'TIKTOK') return this.approveTikTokTask(organizationId, id, task.accountId, userId);
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

  async retry(organizationId: string, id: string) {
    let task: RetryableTikTokTask | null = await this.prisma.task.findFirst({
      where: { id, organizationId },
      include: {
        account: { select: { status: true, browserProfile: { select: { id: true } } } },
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    }) as RetryableTikTokTask | null;
    if (!task) throw new NotFoundException('Task not found');
    task = await this.reconcileStaleBrowserRun(organizationId, task as RetryableTikTokTask);
    if (task.platform !== 'TIKTOK' || task.action !== 'SEARCH_TIKTOK_VIDEOS') {
      throw new BadRequestException('Chỉ có thể chạy lại campaign Search video TikTok bằng thao tác này.');
    }
    this.assertRetryableTikTokTask(task);
    return this.retryTikTokTask(organizationId, task);
  }

  async retryAction(organizationId: string, id: string, userId?: string, confirmResultChecked = false) {
    let task: RetryableTikTokTask | null = await this.prisma.task.findFirst({
      where: { id, organizationId },
      include: {
        account: { select: { status: true, browserProfile: { select: { id: true } } } },
        runs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    }) as RetryableTikTokTask | null;
    if (!task) throw new NotFoundException('Task not found');
    task = await this.reconcileStaleBrowserRun(organizationId, task as RetryableTikTokTask);
    if (task.platform !== 'TIKTOK' || !requiresExternalApproval(task.action)) {
      throw new BadRequestException('Chỉ có thể chạy lại campaign hành động TikTok bằng thao tác này.');
    }
    this.assertRetryableTikTokTask(task, confirmResultChecked);
    return this.retryTikTokTask(organizationId, task, userId, confirmResultChecked);
  }

  async cancel(organizationId: string, id: string) {
    const control = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok/task/${id}`}))`;
      const task = await tx.task.findFirst({
        where: { id, organizationId },
        include: { account: { select: { browserProfile: { select: { id: true } } } } },
      });
      if (!task) throw new NotFoundException('Task not found');
      if (task.platform !== 'TIKTOK') throw new BadRequestException('Chỉ có thể hủy campaign TikTok bằng thao tác này.');
      if (task.status === 'CANCELLED') {
        return { workflowId: task.workflowId, response: { cancelled: 0, cancelRequested: false, message: 'Campaign đã được hủy.' } };
      }
      if (task.status === 'SUCCEEDED') {
        return { workflowId: undefined, response: { cancelled: 0, cancelRequested: false, message: 'Campaign đã hoàn tất.' } };
      }
      const now = new Date();
      if (task.status === 'RUNNING') {
        const updated = await tx.task.updateMany({
          where: { id, organizationId, status: 'RUNNING' },
          data: { status: 'CANCELLED', cancelledAt: task.cancelledAt ?? now, pausedAt: null, lastError: null },
        });
        if (updated.count !== 1) throw new ConflictException('Campaign đã thay đổi trạng thái. Hãy tải lại danh sách campaign.');
        await tx.taskRun.updateMany({
          where: { taskId: id, status: 'RUNNING' },
          data: { status: 'CANCELLED', finishedAt: now, errorCode: 'TASK_CANCELLED', error: null },
        });
        const browserCloseRequested = await this.requestTaskBrowserStop(tx, task.accountId, task.account.browserProfile?.id, now);
        return {
          workflowId: task.workflowId,
          response: {
            cancelled: 1,
            cancelRequested: false,
            browserCloseRequested,
            message: 'Đã hủy campaign và yêu cầu dừng browser đang chạy.',
          },
        };
      }
      if (task.cancelledAt) {
        return { workflowId: task.workflowId, response: { cancelled: 0, cancelRequested: false, message: 'Campaign đã được yêu cầu hủy.' } };
      }
      const updated = await tx.task.updateMany({
        where: { id, organizationId, status: { in: ['DRAFT', 'SCHEDULED', 'QUEUED', 'PAUSED', 'FAILED', 'REQUIRES_ACTION'] } },
        data: { status: 'CANCELLED', cancelledAt: now, pausedAt: null, approvalStatus: task.approvalStatus === 'PENDING' ? 'REJECTED' : undefined, rejectedAt: task.approvalStatus === 'PENDING' ? now : undefined },
      });
      if (updated.count !== 1) throw new ConflictException('Campaign đã thay đổi trạng thái. Hãy tải lại danh sách campaign.');
      return { workflowId: task.workflowId, response: { cancelled: 1, cancelRequested: false, message: 'Đã hủy phần chưa chạy của campaign TikTok.' } };
    });
    const workflowCancellationRequested = control.workflowId
      ? await this.temporal.cancelTask(control.workflowId)
      : false;
    return { ...control.response, workflowCancellationRequested };
  }

  async pause(organizationId: string, id: string) {
    const control = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok/task/${id}`}))`;
      const task = await tx.task.findFirst({
        where: { id, organizationId },
        include: { account: { select: { browserProfile: { select: { id: true } } } } },
      });
      if (!task) throw new NotFoundException('Task not found');
      if (task.platform !== 'TIKTOK') throw new BadRequestException('Chỉ có thể dừng campaign TikTok bằng thao tác này.');
      if (task.status === 'SUCCEEDED' || task.status === 'CANCELLED' || task.cancelledAt) {
        throw new ConflictException('Campaign đã kết thúc hoặc đã hủy, không thể tạm dừng.');
      }
      if (task.status === 'PAUSED') {
        if (!task.pausedAt) await tx.task.update({ where: { id }, data: { pausedAt: new Date() } });
        return { workflowId: task.workflowId, response: { paused: 0, pauseRequested: false, alreadyPaused: true, message: 'Campaign đã đang tạm dừng.' } };
      }
      if (!['RUNNING', 'SCHEDULED', 'QUEUED'].includes(task.status)) {
        throw new ConflictException('Campaign không ở trạng thái đang chạy hoặc đang chờ để tạm dừng.');
      }
      const now = new Date();
      if (task.status === 'RUNNING') {
        const updated = await tx.task.updateMany({
          where: { id, organizationId, status: 'RUNNING', cancelledAt: null },
          data: { status: 'PAUSED', pausedAt: task.pausedAt ?? now, lastError: null },
        });
        if (updated.count !== 1) throw new ConflictException('Campaign đã thay đổi trạng thái. Hãy tải lại danh sách campaign.');
        await tx.taskRun.updateMany({
          where: { taskId: id, status: 'RUNNING' },
          data: { status: 'CANCELLED', finishedAt: now, errorCode: 'TASK_PAUSED', error: null },
        });
        const browserCloseRequested = await this.requestTaskBrowserStop(tx, task.accountId, task.account.browserProfile?.id, now);
        return {
          workflowId: task.workflowId,
          response: {
            paused: 1,
            pauseRequested: false,
            browserCloseRequested,
            message: 'Đã tạm dừng campaign và yêu cầu đóng browser đang chạy.',
          },
        };
      }
      const updated = await tx.task.updateMany({
        where: { id, organizationId, status: { in: ['SCHEDULED', 'QUEUED'] }, pausedAt: null, cancelledAt: null },
        data: { status: 'PAUSED', pausedAt: now },
      });
      if (updated.count !== 1) throw new ConflictException('Campaign đã thay đổi trạng thái. Hãy tải lại danh sách campaign.');
      return { workflowId: task.workflowId, response: { paused: 1, pauseRequested: false, message: 'Đã tạm dừng campaign TikTok; chưa mở browser cho phần còn lại.' } };
    });
    const workflowCancellationRequested = control.workflowId
      ? await this.temporal.cancelTask(control.workflowId)
      : false;
    return { ...control.response, workflowCancellationRequested };
  }

  async resume(organizationId: string, id: string) {
    let scheduledAt = new Date();
    const now = Date.now();
    const workflowId = `task/${id}/resume/${randomUUID()}`;
    const resumed = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok/task/${id}`}))`;
      const current = await tx.task.findFirst({
        where: { id, organizationId },
        include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
      });
      if (!current) throw new NotFoundException('Task not found');
      if (current.platform !== 'TIKTOK') throw new BadRequestException('Chỉ có thể tiếp tục campaign TikTok bằng thao tác này.');
      if (current.cancelledAt || current.status === 'CANCELLED') throw new ConflictException('Campaign đã hủy và không thể tiếp tục.');
      if (current.status === 'RUNNING' && current.pausedAt) throw new ConflictException('Tác vụ đang chạy chưa kết thúc an toàn; hãy chờ trạng thái chuyển sang tạm dừng.');
      if (current.status !== 'PAUSED') throw new ConflictException('Campaign này hiện không ở trạng thái tạm dừng.');

      const lastResult = current.runs[0]?.result;
      const sideEffectStarted = lastResult && typeof lastResult === 'object' && !Array.isArray(lastResult)
        ? (lastResult as Record<string, unknown>).sideEffectStarted
        : undefined;
      if (current.action !== 'SEARCH_TIKTOK_VIDEOS' && current.attemptCount > 0 && sideEffectStarted !== false) {
        throw new ConflictException('Campaign đã có side effect chưa rõ; không tự chạy lại để tránh gửi trùng.');
      }

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok/account/${current.accountId}`}))`;
      const activeTasks = await tx.task.findMany({
        where: {
          organizationId,
          accountId: current.accountId,
          platform: 'TIKTOK',
          status: { in: ['QUEUED', 'SCHEDULED', 'RUNNING'] },
          id: { not: id },
        },
        select: { scheduledAt: true, payload: true },
      });
      const queueTail = activeTasks.reduce(
        (tail, active) => Math.max(tail, this.estimatedTikTokTaskEnd(active, now)),
        now,
      );
      scheduledAt = new Date(queueTail);
      const updated = await tx.task.updateMany({
        where: { id, organizationId, status: 'PAUSED', cancelledAt: null },
        data: {
          workflowId,
          attemptCount: 0,
          scheduledAt,
          status: scheduledAt.getTime() > now ? 'SCHEDULED' : 'QUEUED',
          pausedAt: null,
          lastError: null,
        },
      });
      if (updated.count !== 1) throw new ConflictException('Campaign đã thay đổi trạng thái. Hãy tải lại danh sách campaign.');
      return { id: current.id, workflowId, scheduledAt };
    });

    try {
      await this.temporal.startTask(resumed.id, resumed.workflowId, resumed.scheduledAt);
    } catch (error) {
      await this.prisma.task.update({
        where: { id },
        data: { lastError: `Workflow dispatch pending: ${error instanceof Error ? error.message : String(error)}` },
      });
    }
    return this.prisma.task.findUniqueOrThrow({ where: { id } });
  }

  private assertRetryableTikTokTask(task: {
    action: string;
    status: string;
    account: { status: string };
    attemptCount: number;
    runs: Array<{ result: Prisma.JsonValue | null }>;
  }, allowVerifiedRetry = false) {
    if (!['FAILED', 'REQUIRES_ACTION'].includes(task.status)) {
      throw new ConflictException('Campaign này hiện không ở trạng thái có thể chạy lại.');
    }
    if (task.action !== 'SEARCH_TIKTOK_VIDEOS' && task.account.status !== 'READY') {
      throw new ConflictException('Profile TikTok chưa READY. Hãy mở Profiles, hoàn tất xác minh rồi thử lại.');
    }
    const result = task.runs[0]?.result;
    const sideEffectStarted = result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>).sideEffectStarted
      : undefined;
    if (task.attemptCount > 0 && sideEffectStarted !== false && !this.canContinueFromCheckpoint(task.action, result) && !allowVerifiedRetry) {
      throw new ConflictException('Kết quả action chưa rõ. Hãy kiểm tra TikTok và xác nhận thủ công trước khi chạy lại để tránh gửi trùng.');
    }
  }

  private async retryTikTokTask(
    organizationId: string,
    task: RetryableTikTokTask,
    userId?: string,
    allowVerifiedRetry = false,
  ) {
    let scheduledAt = new Date();
    const now = Date.now();
    const workflowId = `task/${task.id}/retry/${randomUUID()}`;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok/account/${task.accountId}`}))`;
      const current = await tx.task.findFirst({ where: { id: task.id, organizationId } });
      if (!current) throw new NotFoundException('Task not found');
      if (!['FAILED', 'REQUIRES_ACTION'].includes(current.status)) {
        throw new ConflictException('Campaign này đã thay đổi trạng thái. Hãy tải lại danh sách campaign.');
      }
      const activeTasks = await tx.task.findMany({
        where: {
          organizationId,
          accountId: current.accountId,
          platform: 'TIKTOK',
          status: { in: ['QUEUED', 'SCHEDULED', 'RUNNING'] },
          id: { not: task.id },
        },
        select: { scheduledAt: true, payload: true },
      });
      const queueTail = activeTasks.reduce(
        (tail, active) => Math.max(tail, this.estimatedTikTokTaskEnd(active, now)),
        now,
      );
      scheduledAt = new Date(queueTail);
      const actionRequiresApproval = requiresExternalApproval(current.action);
      const continuationPayload = this.continuationPayload(task, allowVerifiedRetry);
      const updated = await tx.task.updateMany({
        where: { id: task.id, organizationId, status: { in: ['FAILED', 'REQUIRES_ACTION'] } },
        data: {
          workflowId,
          ...(continuationPayload ? { payload: continuationPayload } : {}),
          attemptCount: 0,
          scheduledAt,
          status: scheduledAt.getTime() > now ? 'SCHEDULED' : 'QUEUED',
          approvalStatus: actionRequiresApproval ? 'APPROVED' : 'NOT_REQUIRED',
          ...(actionRequiresApproval ? { approvedByUserId: userId, approvedAt: new Date(now) } : {}),
          lastError: null,
          rejectedAt: null,
        },
      });
      if (updated.count !== 1) throw new ConflictException('Campaign đã thay đổi trạng thái. Hãy tải lại danh sách campaign.');
    });

    try {
      await this.temporal.startTask(task.id, workflowId, scheduledAt);
    } catch (error) {
      await this.prisma.task.update({
        where: { id: task.id },
        data: { lastError: `Workflow dispatch pending: ${error instanceof Error ? error.message : String(error)}` },
      });
    }
    return this.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  }

  private canContinueFromCheckpoint(action: string, result: Prisma.JsonValue | null | undefined): boolean {
    if (!['AUTO_COMMENT_TIKTOK_HOME', 'COMMENT_TIKTOK_VIDEOS', 'MESSAGE_TIKTOK_FOLLOWERS'].includes(action)) return false;
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
    if ((result as Record<string, unknown>).checkpointUncertain === true) return false;
    const report = (result as Record<string, unknown>).report;
    if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
    const entries = (report as Record<string, unknown>).entries;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    return entries.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const status = (entry as Record<string, unknown>).status;
      return status === 'SENT' || status === 'LIKED';
    });
  }

  private continuationPayload(task: RetryableTikTokTask, allowUncertainCheckpoint = false): Prisma.InputJsonValue | undefined {
    const payload = task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload)
      ? { ...(task.payload as Record<string, unknown>) }
      : undefined;
    const result = task.runs[0]?.result;
    if (!payload || !result || typeof result !== 'object' || Array.isArray(result)) return undefined;
    if (!allowUncertainCheckpoint && !this.canContinueFromCheckpoint(task.action, result)) return undefined;
    const report = (result as Record<string, unknown>).report as Record<string, unknown>;
    if (!report || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.entries)) return undefined;
    const entries = (report.entries as unknown[]).filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
      .filter(entry => entry.status === 'SENT' || entry.status === 'LIKED');
    if (entries.length === 0) return undefined;
    const completedVideoUrls = entries
      .map((entry) => typeof entry.videoUrl === 'string' ? entry.videoUrl : undefined)
      .filter((value): value is string => Boolean(value));
    const completedUsernames = entries
      .map((entry) => typeof entry.username === 'string' ? entry.username : undefined)
      .filter((value): value is string => Boolean(value));
    const priorCompleted = typeof payload.resumeCompletedCount === 'number' && Number.isFinite(payload.resumeCompletedCount)
      ? payload.resumeCompletedCount
      : 0;
    if (completedVideoUrls.length > 0 && ['AUTO_COMMENT_TIKTOK_HOME', 'COMMENT_TIKTOK_VIDEOS'].includes(task.action)) {
      const existing = Array.isArray(payload.excludeVideoUrls) ? payload.excludeVideoUrls.filter((value): value is string => typeof value === 'string') : [];
      const newlyCompleted = [...new Set(completedVideoUrls)].filter(videoUrl => !existing.includes(videoUrl));
      payload.excludeVideoUrls = [...new Set([...existing, ...completedVideoUrls])];
      payload.resumeCompletedCount = priorCompleted + newlyCompleted.length;
    }
    if (completedUsernames.length > 0 && task.action === 'MESSAGE_TIKTOK_FOLLOWERS') {
      const existing = Array.isArray(payload.excludeUsernames) ? payload.excludeUsernames.filter((value): value is string => typeof value === 'string') : [];
      const newlyCompleted = [...new Set(completedUsernames)].filter(username => !existing.includes(username));
      payload.excludeUsernames = [...new Set([...existing, ...completedUsernames])];
      payload.resumeCompletedCount = priorCompleted + newlyCompleted.length;
    }
    return payload as Prisma.InputJsonValue;
  }

  private async reconcileStaleBrowserRun<T extends RetryableTikTokTask>(organizationId: string, task: T): Promise<T> {
    if (task.platform !== 'TIKTOK' || task.status !== 'RUNNING') return task;
    const run = task.runs[0];
    if (!run?.startedAt || Date.now() - new Date(run.startedAt).getTime() < STALE_BROWSER_RUN_MS) return task;
    const result = run.result && typeof run.result === 'object' && !Array.isArray(run.result)
      ? run.result as Record<string, unknown>
      : {};
    const sideEffectStarted = result.sideEffectStarted === true;
    const nextStatus = sideEffectStarted ? 'REQUIRES_ACTION' : 'FAILED';
    const message = sideEffectStarted
      ? 'Browser đã hết thời hạn sau khi bắt đầu hành động; checkpoint đã được lưu. Hãy kiểm tra TikTok trước khi chạy tiếp để tránh gửi trùng.'
      : 'Browser đã hết thời hạn trước khi gửi; checkpoint đã được lưu và có thể tiếp tục phần còn lại.';
    const now = new Date();
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.task.updateMany({
        where: { id: task.id, organizationId, status: 'RUNNING' },
        data: { status: nextStatus, lastError: message },
      });
      if (claimed.count !== 1) return;
      await tx.taskRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { status: 'FAILED', finishedAt: now, errorCode: 'BROWSER_TASK_TIMEOUT', error: message },
      });
      await tx.platformAccount.updateMany({ where: { id: task.accountId, status: 'RUNNING' }, data: { status: 'READY' } });
      if (task.account.browserProfile?.id) {
        await tx.browserProfile.updateMany({ where: { id: task.account.browserProfile.id, status: 'LEASED' }, data: { status: 'AVAILABLE' } });
        await tx.browserSession.updateMany({
          where: { profileId: task.account.browserProfile.id, status: { in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'] } },
          data: { status: 'CLOSED', closedAt: now },
        });
      }
    });
    return { ...task, status: nextStatus, lastError: message, account: { ...task.account, status: 'READY' } };
  }

  private async approveTikTokTask(organizationId: string, id: string, accountId: string, userId?: string) {
    let scheduledAt = new Date();
    const now = Date.now();
    await this.prisma.$transaction(async (tx) => {
      // Approvals for one TikTok profile are serialized so two admins cannot
      // calculate the same queue position concurrently.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tiktok/account/${accountId}`}))`;
      const current = await tx.task.findFirst({ where: { id, organizationId } });
      if (!current) throw new NotFoundException('Task not found');
      if (current.campaignId) throw new BadRequestException('TikTok task không thuộc campaign Facebook.');
      if (current.approvalStatus !== 'PENDING') throw new ConflictException(`Task approval is already ${current.approvalStatus}`);

      const activeTasks = await tx.task.findMany({
        where: {
          organizationId,
          accountId: current.accountId,
          platform: 'TIKTOK',
          status: { in: ['QUEUED', 'SCHEDULED', 'RUNNING'] },
          id: { not: id },
        },
        select: { scheduledAt: true, payload: true },
      });
      const queueTail = activeTasks.reduce(
        (tail, active) => Math.max(tail, this.estimatedTikTokTaskEnd(active, now)),
        now,
      );
      scheduledAt = new Date(queueTail);
      const claimed = await tx.task.updateMany({
        where: { id, organizationId, approvalStatus: 'PENDING' },
        data: {
          approvalStatus: 'APPROVED',
          approvedByUserId: userId,
          approvedAt: new Date(now),
          scheduledAt,
          status: scheduledAt.getTime() > now ? 'SCHEDULED' : 'QUEUED',
          lastError: null,
        },
      });
      if (claimed.count !== 1) throw new ConflictException('Task approval changed. Tải lại danh sách campaign.');
    });

    try {
      const approved = await this.prisma.task.findUniqueOrThrow({ where: { id } });
      await this.temporal.startTask(approved.id, approved.workflowId!, scheduledAt);
    } catch (error) {
      await this.prisma.task.update({
        where: { id },
        data: { lastError: `Workflow dispatch pending: ${error instanceof Error ? error.message : String(error)}` },
      });
    }
    return this.prisma.task.findUniqueOrThrow({ where: { id } });
  }

  private estimatedTikTokTaskEnd(task: { scheduledAt: Date | null; payload: Prisma.JsonValue }, now: number): number {
    const start = Math.max(task.scheduledAt?.getTime() ?? now, now);
    const payload = task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload)
      ? task.payload as Record<string, unknown>
      : {};
    const intervalSeconds = this.positiveNumber(payload.intervalSeconds, 120);
    const videoCount = Array.isArray(payload.videoUrls)
      ? payload.videoUrls.length
      : this.positiveNumber(payload.maxVideos, 1);
    const actionCount = typeof payload.maxFollowers === 'number'
      ? this.positiveNumber(payload.maxFollowers, 1)
      : typeof payload.maxReplies === 'number'
      ? videoCount * this.positiveNumber(payload.maxReplies, 1)
      : typeof payload.maxLikes === 'number'
        ? videoCount * this.positiveNumber(payload.maxLikes, 1)
        : videoCount;
    const minimumDuration = payload.query ? 30 : 15;
    const durationSeconds = Math.max(minimumDuration, actionCount * intervalSeconds);
    return start + Math.min(durationSeconds, 24 * 60 * 60) * 1_000;
  }

  private async requestTaskBrowserStop(
    tx: Prisma.TransactionClient,
    accountId: string,
    profileId: string | undefined,
    now: Date,
  ): Promise<boolean> {
    if (!profileId) {
      await tx.platformAccount.updateMany({ where: { id: accountId, status: 'RUNNING' }, data: { status: 'READY' } });
      return false;
    }

    const sessions = await tx.browserSession.updateMany({
      where: { profileId, status: { in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'] } },
      data: { status: 'CLOSING', forceCloseRequestedAt: now },
    });
    if (sessions.count === 0) {
      // A worker restart can remove the browser session while leaving the task,
      // run, account and profile marked active. With no live session there is
      // nothing left to wait for, so release those records immediately.
      await tx.browserProfile.updateMany({ where: { id: profileId, status: { in: ['LEASED', 'SNAPSHOTTING'] } }, data: { status: 'AVAILABLE' } });
      await tx.platformAccount.updateMany({ where: { id: accountId, status: 'RUNNING' }, data: { status: 'READY' } });
    }
    return sessions.count > 0;
  }

  private positiveNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
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
