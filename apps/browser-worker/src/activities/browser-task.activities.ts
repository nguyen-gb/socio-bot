import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import {
  platformActionSchema,
  normalizeFacebookGroupUrl,
  requiresExternalApproval,
  type ActionResult,
  type ExecuteTaskWorkflowInput,
  type MaterializedScheduledTask,
  type MaterializeScheduledTaskInput,
} from '@socio/contracts';
import { withDeadline, type BrowserRuntime, type RuntimeProxy } from '@socio/browser-runtime';
import { Prisma } from '@socio/database';
import { FacebookAdapter } from '@socio/facebook-adapter';
import {
  LoginRequiredError,
  PlatformAdapterRegistry,
  type PlatformAdapter,
  UnsupportedPlatformActionError,
} from '@socio/platform-core';
import {
  InstagramAdapter,
  TikTokAdapter,
  XAdapter,
} from '@socio/web-platform-adapters';
import type { WorkerEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { ProfileLeaseService } from '../leases/profile-lease.service';
import { BROWSER_RUNTIME } from '../runtime/runtime.providers';
import { ProfileSnapshotsService } from '../storage/profile-snapshots.service';
import { TaskArtifactsService } from '../storage/task-artifacts.service';
import { WorkerRegistryService } from '../worker-registry/worker-registry.service';
import { SecretsService } from '../secrets/secrets.service';
import { initializePlatformSession, isPlatformAuthenticated, isPlatformChallenged, profileLoginSettings } from './platform-login';

@Injectable()
export class BrowserTaskActivities {
  private readonly adapters: PlatformAdapterRegistry;

  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: ProfileLeaseService,
    private readonly registry: WorkerRegistryService,
    private readonly snapshots: ProfileSnapshotsService,
    private readonly artifacts: TaskArtifactsService,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService<WorkerEnvironment, true>,
    @Inject(BROWSER_RUNTIME) private readonly runtime: BrowserRuntime,
  ) {
    const facebook = new FacebookAdapter();
    this.adapters = new PlatformAdapterRegistry([
      facebook,
      new InstagramAdapter(),
      new XAdapter(),
      new TikTokAdapter(),
    ]);
  }

  async materializeScheduledTask(
    input: MaterializeScheduledTaskInput,
  ): Promise<MaterializedScheduledTask | null> {
    const schedule = await this.prisma.schedule.findUnique({
      where: { id: input.scheduleId },
      include: { account: true },
    });
    if (!schedule || !schedule.enabled) return null;

    const idempotencyKey = `schedule:${schedule.id}:${input.runKey}`.slice(0, 128);
    const publish = requiresExternalApproval(schedule.action);
    const task = await this.prisma.task.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: schedule.organizationId,
          idempotencyKey,
        },
      },
      create: {
        organizationId: schedule.organizationId,
        accountId: schedule.accountId,
        idempotencyKey,
        workflowId: input.runKey,
        platform: schedule.account.platform,
        action: schedule.action,
        payload: schedule.payload as Prisma.InputJsonValue,
        priority: schedule.priority,
        maxAttempts: publish ? 1 : schedule.maxAttempts,
        status: publish ? 'DRAFT' : 'QUEUED',
        approvalStatus: publish ? 'PENDING' : 'NOT_REQUIRED',
      },
      update: {},
    });
    return { taskId: task.id, dispatch: !publish };
  }

  async executeBrowserTask(
    input: ExecuteTaskWorkflowInput,
  ): Promise<ActionResult> {
    Context.current().heartbeat({ stage: 'loading_task' });
    const task = await this.prisma.task.findUnique({
      where: { id: input.taskId },
      include: {
        campaign: true,
        account: {
          include: {
            browserProfile: true,
            proxyBinding: { include: { proxy: true } },
          },
        },
      },
    });
    if (!task) throw ApplicationFailure.nonRetryable('Task not found', 'NOT_FOUND');
    const workflowId = input.workflowId ?? Context.current().info.workflowExecution?.workflowId;
    if (workflowId && task.workflowId !== workflowId) return { ok: false, data: { skipped: true, reason: 'stale_workflow' } };
    const profile = task.account.browserProfile;
    if (task.status === 'CANCELLED') return { ok: false, data: { cancelled: true } };
    if (task.status === 'SUCCEEDED') return { ok: true, data: { alreadyCompleted: true } };
    if (task.status === 'PAUSED' || task.status !== 'RUNNING' && (task.campaign?.pausedAt || task.campaign?.cancelledAt)) return { ok: false, data: { paused: true } };
    const externalAction = requiresExternalApproval(task.action);
    if (externalAction && task.approvalStatus !== 'APPROVED') {
      return { ok: false, data: { requiresAction: true, reason: 'External action has not been approved' } };
    }
    if (externalAction && (task.attemptCount > 0 || task.status === 'RUNNING')) {
      const markUncertain = async () => {
        const marked = await this.prisma.task.updateMany({ where: { id: task.id, ...(task.workflowId ? { workflowId: task.workflowId } : {}), status: { notIn: ['SUCCEEDED', 'CANCELLED'] } }, data: { status: 'REQUIRES_ACTION', lastError: 'Kết quả lần chạy trước chưa chắc chắn; kiểm tra Facebook trước khi gửi lại.' } });
        if (marked.count !== 1) return;
        await this.prisma.platformAccount.updateMany({ where: { id: task.accountId, status: 'RUNNING' }, data: { status: 'ERROR' } });
        if (profile) await this.prisma.browserProfile.updateMany({ where: { id: profile.id, status: 'LEASED' }, data: { status: 'AVAILABLE' } });
      };
      // Only release stale database state after acquiring the actual profile lease.
      if (profile) await this.leases.withLease(profile.id, markUncertain);
      else await markUncertain();
      return { ok: false, data: { requiresAction: true, reason: 'Uncertain previous attempt; automatic retry disabled' } };
    }
    if (!externalAction && Context.current().info.attempt > task.maxAttempts) {
      throw ApplicationFailure.nonRetryable(
        `Task exceeded its maximum of ${task.maxAttempts.toString()} attempts`,
        'MAX_ATTEMPTS_EXCEEDED',
      );
    }

    if (!profile) {
      throw ApplicationFailure.nonRetryable(
        'Account has no browser profile',
        'PROFILE_NOT_FOUND',
      );
    }

    const action = platformActionSchema.parse({
      platform: task.platform,
      accountId: task.accountId,
      action: task.action,
      payload: task.payload,
    });
    const adapter = this.adapters.get(action.platform);
    if (!adapter) {
      throw ApplicationFailure.nonRetryable(
        `No adapter registered for ${action.platform}`,
        'ADAPTER_NOT_FOUND',
      );
    }

    return this.leases.withLease(profile.id, async () => {
    const current = await this.prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: { campaign: true, account: { include: { proxyBinding: { include: { proxy: true } }, browserProfile: { include: { sessions: { where: { status: { in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'] } }, take: 1 } } } } } } });
    if (workflowId && current.workflowId !== workflowId) return { ok: false, data: { skipped: true, reason: 'stale_workflow' } };
    if (current.status === 'CANCELLED') return { ok: false, data: { cancelled: true } };
    if (current.status === 'PAUSED' || current.campaign?.pausedAt || current.campaign?.cancelledAt) return { ok: false, data: { paused: true } };
    if (action.action.includes('FACEBOOK_GROUP') && current.account.status !== 'READY') {
      await this.prisma.task.update({ where: { id: task.id }, data: { status: 'REQUIRES_ACTION', lastError: 'Account không ở trạng thái READY; hãy đăng nhập hoặc xử lý xác minh trước.' } });
      return { ok: false, data: { requiresAction: true, reason: 'Account is not READY' } };
    }
    if (action.action.includes('FACEBOOK_GROUP') && (current.account.browserProfile?.sessions.length || current.account.proxyBinding && current.account.proxyBinding.proxy.status !== 'HEALTHY')) {
      const reason = 'Browser đang mở hoặc proxy chưa HEALTHY. Đóng browser và kiểm tra proxy trước khi chạy.';
      await this.prisma.task.update({ where: { id: task.id }, data: { status: 'REQUIRES_ACTION', lastError: reason } });
      return { ok: false, data: { requiresAction: true, reason } };
    }
    const run = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.task.updateMany({
        where: { id: task.id, ...(task.workflowId ? { workflowId: task.workflowId } : {}), status: { in: externalAction ? ['QUEUED', 'SCHEDULED'] : ['QUEUED', 'SCHEDULED', 'FAILED', 'RUNNING'] }, ...(externalAction ? { approvalStatus: 'APPROVED', attemptCount: 0 } : {}) },
        data: { status: 'RUNNING', attemptCount: { increment: 1 } },
      });
      if (claim.count !== 1) return null;
      await tx.platformAccount.update({
        where: { id: task.accountId },
        data: { status: 'RUNNING' },
      });
      await tx.browserProfile.update({
        where: { id: profile.id },
        data: { status: 'LEASED' },
      });
      return tx.taskRun.create({ data: { taskId: task.id, workerId: this.registry.workerId, status: 'RUNNING', result: { sideEffectStarted: false } } });
    });
    if (!run) return { ok: false, data: { cancelled: true, reason: 'Task state changed before execution' } };
    const activityContext = Context.current();
    const heartbeat = setInterval(() => activityContext.heartbeat({ stage: 'processing_task', taskId: task.id }), 10_000);
    let sideEffectStarted = false;
    let authenticated = false;
    let browserSessionId: string | undefined;
    try {
      const browserSession = await this.prisma.browserSession.create({ data: {
        profileId: profile.id, workerId: this.registry.workerId, mode: 'AUTOMATION', status: 'STARTING',
        expiresAt: new Date(Date.now() + 6 * 60_000),
      } });
      browserSessionId = browserSession.id;
      Context.current().heartbeat({ stage: 'restoring_profile_snapshot' });
      await this.snapshots.restore(current.account.browserProfile ?? profile);
      Context.current().heartbeat({ stage: 'opening_browser' });
      let result: ActionResult;
      const harPath = await this.artifacts.temporaryPath('.har');
      try {
        result = await this.runtime.withProfile(
          {
            profileId: profile.id,
            ownerId: browserSession.id,
            proxy: await toRuntimeProxy(
              current.account.proxyBinding?.proxy,
              this.secrets,
            ),
            headless: this.config.get('browserHeadless', { infer: true }),
            recordHarPath: harPath,
          },
          async (session) => {
            const opened = await this.prisma.browserSession.updateMany({ where: { id: browserSession.id, status: 'STARTING' }, data: { status: 'RUNNING', processId: session.processId, lastActiveAt: new Date() } });
            if (opened.count !== 1) throw new Error('Browser đã được yêu cầu đóng');
            Context.current().heartbeat({
              stage: 'executing_action',
              slot: session.slot,
            });
            const consoleLines: string[] = [];
            const recordConsole = (message: { type(): string; text(): string }) => {
              if (consoleLines.length >= 2_000) return;
              consoleLines.push(
                `${new Date().toISOString()} ${message.type()} ${redactLog(message.text())}`,
              );
            };
            session.page.on('console', recordConsole);
            await withDeadline(session.context.tracing.start({
              screenshots: true,
              snapshots: true,
              sources: true,
            }), 10_000, 'Trace startup timed out');
            let retainTrace = false;
            await this.artifacts
              .captureScreenshot(task.id, run.id, session.page, 'BEFORE_SCREENSHOT')
              .catch(() => undefined);
            try {
              let blocked: ActionResult | undefined;
              if (action.platform === 'FACEBOOK' && action.action.includes('FACEBOOK_GROUP')) {
                const loginSettings = profileLoginSettings(current.account.browserProfile?.metadata);
                const credentials = loginSettings.credentialsRef ? await this.secrets.profileCredentials(loginSettings.credentialsRef) : undefined;
                await initializePlatformSession(session, 'FACEBOOK', credentials);
                if (await isPlatformChallenged(session)) {
                  blocked = { ok: false, data: { requiresAction: true, accountChallenged: true, reason: 'Facebook yêu cầu xác minh/CAPTCHA. Hãy thao tác thủ công.' } };
                }
                if (!blocked && !(await isPlatformAuthenticated(session, 'FACEBOOK'))) {
                  throw new LoginRequiredError('Không xác nhận được phiên đăng nhập Facebook. Hãy mở browser để đăng nhập hoặc kiểm tra cookie.');
                }
                authenticated = !blocked;
              }
              const actionResult = blocked ?? await adapter.execute(action, { ...session, beforeExternalAction: async () => {
                session.signal?.throwIfAborted();
                const state = await this.prisma.browserSession.findUnique({ where: { id: browserSession.id }, select: { status: true } });
                if (state?.status !== 'RUNNING') throw new Error('Browser đã được yêu cầu đóng; dừng trước khi gửi');
                // Persist BEFORE clicking: even a crash during the click is uncertain.
                sideEffectStarted = true;
                await this.prisma.taskRun.update({ where: { id: run.id }, data: { result: { sideEffectStarted: true } } });
                session.signal?.throwIfAborted();
              } });
              if (!actionResult.ok) {
                retainTrace = true;
                await this.artifacts
                  .captureFailure(task.id, run.id, session.page)
                  .catch(() => undefined);
              }
              return actionResult;
            } catch (error) {
              retainTrace = true;
              await this.artifacts
                .captureFailure(task.id, run.id, session.page)
                .catch(() => undefined);
              throw error;
            } finally {
              await this.artifacts
                .captureScreenshot(task.id, run.id, session.page, 'AFTER_SCREENSHOT')
                .catch(() => undefined);
              if (retainTrace) {
                await this.artifacts
                  .captureTrace(task.id, run.id, session.context)
                  .catch(() => undefined);
              } else {
                await withDeadline(session.context.tracing.stop(), 5_000, 'Trace cleanup timed out').catch(() => undefined);
              }
              session.page.off('console', recordConsole);
              await this.artifacts
                .captureConsoleLog(task.id, run.id, consoleLines)
                .catch(() => undefined);
            }
          },
        );
      } finally {
        await this.artifacts
          .captureHar(task.id, run.id, harPath)
          .catch(() => undefined);
        Context.current().heartbeat({ stage: 'saving_profile_snapshot' });
        await this.snapshots.capture(profile.id);
      }
      if (result.data?.loginRequired === true) throw new LoginRequiredError();
      await this.persistFacebookResult(task, result);
      const requiresAction = result.data?.requiresAction === true;
      const reason = typeof result.data?.reason === 'string' ? result.data.reason : task.action === 'SYNC_FACEBOOK_GROUPS' && result.data?.complete === false ? 'Đồng bộ chưa đọc hết danh sách nhóm; hãy kiểm tra browser hoặc đồng bộ lại trước khi chọn tất cả nhóm.' : null;

      await this.prisma.$transaction([
        this.prisma.task.update({
          where: { id: task.id },
          data: { status: requiresAction ? 'REQUIRES_ACTION' : result.ok ? 'SUCCEEDED' : 'FAILED', lastError: reason },
        }),
        this.prisma.taskRun.update({
          where: { id: run.id },
          data: {
            status: result.ok ? 'SUCCEEDED' : 'FAILED',
            result: { ...(result.data ?? {}), sideEffectStarted } as Prisma.InputJsonValue,
            finishedAt: new Date(),
          },
        }),
        this.prisma.platformAccount.update({
          where: { id: task.accountId },
          data: { status: result.data?.accountChallenged === true ? 'CHALLENGED' : result.ok || requiresAction ? 'READY' : 'ERROR' },
        }),
        this.prisma.browserProfile.update({
          where: { id: profile.id },
          data: { status: 'AVAILABLE' },
        }),
      ]);
      return result;
    } catch (error) {
      const loginRequired = error instanceof LoginRequiredError;
      const unsupported = error instanceof UnsupportedPlatformActionError;
      const message = error instanceof Error ? error.message : String(error);

      await this.prisma.$transaction([
        this.prisma.task.update({
          where: { id: task.id },
          data: {
            status: loginRequired || externalAction ? 'REQUIRES_ACTION' : 'FAILED',
            lastError: message,
          },
        }),
        this.prisma.taskRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            error: message,
            result: { sideEffectStarted },
            errorCode: loginRequired
              ? 'LOGIN_REQUIRED'
              : unsupported
                ? 'UNSUPPORTED_ACTION'
                : 'EXECUTION_ERROR',
            finishedAt: new Date(),
          },
        }),
        this.prisma.platformAccount.update({
          where: { id: task.accountId },
          data: { status: loginRequired ? 'LOGIN_REQUIRED' : authenticated ? 'READY' : 'ERROR' },
        }),
        this.prisma.browserProfile.update({
          where: { id: profile.id },
          data: { status: 'AVAILABLE' },
        }),
      ]);

      if (loginRequired || unsupported || externalAction) {
        return { ok: false, data: { reason: message, requiresAction: true } };
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (browserSessionId) await this.prisma.browserSession.update({ where: { id: browserSessionId }, data: { status: 'CLOSED', closedAt: new Date() } });
    }
    }, { waitTimeoutMs: 10 * 60_000, onWait: () => Context.current().heartbeat({ stage: 'waiting_profile', taskId: task.id }) });
  }

  private async persistFacebookResult(
    task: { organizationId: string; accountId: string; action: string; payload: unknown },
    result: ActionResult,
  ) {
    const data = result.data ?? {};
    if (task.action === 'SYNC_FACEBOOK_GROUPS' && result.ok && Array.isArray(data.groups)) {
      const groups = data.groups as Array<{ groupUrl: string; groupName: string }>;
      await this.prisma.$transaction(async (tx) => {
        // A dynamically-loaded list is not proof that an unobserved group was left.
        // Check composer availability on the target page before posting instead.
        for (const group of groups) {
          const groupUrl = normalizeFacebookGroupUrl(group.groupUrl);
          await tx.facebookGroupMembership.upsert({
            where: { accountId_groupUrl: { accountId: task.accountId, groupUrl } },
            create: { organizationId: task.organizationId, accountId: task.accountId, groupUrl, groupName: group.groupName, status: 'JOINED' },
            update: { groupName: group.groupName, status: 'JOINED', lastSyncedAt: new Date() },
          });
        }
      }, { timeout: 60_000 });
    }
    const payload = task.payload as Record<string, unknown>;
    if (['JOIN_FACEBOOK_GROUP', 'POST_FACEBOOK_GROUP'].includes(task.action) && typeof data.membershipStatus === 'string' && typeof payload.groupUrl === 'string') {
      const groupUrl = normalizeFacebookGroupUrl(payload.groupUrl);
      await this.prisma.facebookGroupMembership.upsert({
        where: { accountId_groupUrl: { accountId: task.accountId, groupUrl } },
        create: { organizationId: task.organizationId, accountId: task.accountId, groupUrl, groupName: typeof data.groupName === 'string' ? data.groupName : null, status: data.membershipStatus },
        update: { status: data.membershipStatus, lastSyncedAt: new Date() },
      });
    }
    if (task.action === 'POST_FACEBOOK_GROUP' && result.ok && typeof payload.groupUrl === 'string') {
      await this.prisma.facebookGroupMembership.updateMany({ where: { accountId: task.accountId, organizationId: task.organizationId, groupUrl: normalizeFacebookGroupUrl(payload.groupUrl) }, data: { lastPostAt: new Date() } });
    }
  }
}

function redactLog(value: string): string {
  return value
    .slice(0, 4_000)
    .replace(/(authorization|cookie|token|password|secret)(["'\s:=]+)[^\s,;]+/gi, '$1$2[REDACTED]');
}

async function toRuntimeProxy(
  proxy:
    | {
        protocol: 'HTTP' | 'HTTPS' | 'SOCKS5';
        host: string;
        port: number;
        credentialsRef: string | null;
      }
    | null
    | undefined,
  secrets: SecretsService,
): Promise<RuntimeProxy | undefined> {
  if (!proxy) return undefined;
  const credentials = proxy.credentialsRef
    ? await secrets.proxyCredentials(proxy.credentialsRef)
    : undefined;
  return {
    server: `${proxy.protocol.toLowerCase()}://${proxy.host}:${proxy.port.toString()}`,
    username: credentials?.username,
    password: credentials?.password,
  };
}
