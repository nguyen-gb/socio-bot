"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var BrowserTaskActivities_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserTaskActivities = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const activity_1 = require("@temporalio/activity");
const common_2 = require("@temporalio/common");
const contracts_1 = require("@socio/contracts");
const browser_runtime_1 = require("@socio/browser-runtime");
const database_1 = require("@socio/database");
const facebook_adapter_1 = require("@socio/facebook-adapter");
const platform_core_1 = require("@socio/platform-core");
const web_platform_adapters_1 = require("@socio/web-platform-adapters");
const prisma_service_1 = require("../database/prisma.service");
const profile_lease_service_1 = require("../leases/profile-lease.service");
const runtime_providers_1 = require("../runtime/runtime.providers");
const profile_snapshots_service_1 = require("../storage/profile-snapshots.service");
const task_artifacts_service_1 = require("../storage/task-artifacts.service");
const worker_registry_service_1 = require("../worker-registry/worker-registry.service");
const secrets_service_1 = require("../secrets/secrets.service");
const object_storage_providers_1 = require("../storage/object-storage.providers");
const task_images_1 = require("../storage/task-images");
const platform_login_1 = require("./platform-login");
let BrowserTaskActivities = BrowserTaskActivities_1 = class BrowserTaskActivities {
    prisma;
    leases;
    registry;
    snapshots;
    artifacts;
    secrets;
    config;
    runtime;
    objects;
    adapters;
    logger = new common_1.Logger(BrowserTaskActivities_1.name);
    constructor(prisma, leases, registry, snapshots, artifacts, secrets, config, runtime, objects) {
        this.prisma = prisma;
        this.leases = leases;
        this.registry = registry;
        this.snapshots = snapshots;
        this.artifacts = artifacts;
        this.secrets = secrets;
        this.config = config;
        this.runtime = runtime;
        this.objects = objects;
        const facebook = new facebook_adapter_1.FacebookAdapter();
        this.adapters = new platform_core_1.PlatformAdapterRegistry([
            facebook,
            new web_platform_adapters_1.InstagramAdapter(),
            new web_platform_adapters_1.XAdapter(),
            new web_platform_adapters_1.TikTokAdapter(),
        ]);
    }
    async materializeScheduledTask(input) {
        const schedule = await this.prisma.schedule.findUnique({
            where: { id: input.scheduleId },
            include: { account: true },
        });
        if (!schedule || !schedule.enabled)
            return null;
        const idempotencyKey = `schedule:${schedule.id}:${input.runKey}`.slice(0, 128);
        const publish = (0, contracts_1.requiresExternalApproval)(schedule.action);
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
                payload: schedule.payload,
                priority: schedule.priority,
                maxAttempts: publish ? 1 : schedule.maxAttempts,
                status: publish ? 'DRAFT' : 'QUEUED',
                approvalStatus: publish ? 'PENDING' : 'NOT_REQUIRED',
            },
            update: {},
        });
        return { taskId: task.id, dispatch: !publish };
    }
    async executeBrowserTask(input) {
        activity_1.Context.current().heartbeat({ stage: 'loading_task' });
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
        if (!task)
            throw common_2.ApplicationFailure.nonRetryable('Task not found', 'NOT_FOUND');
        const workflowId = input.workflowId ?? activity_1.Context.current().info.workflowExecution?.workflowId;
        if (workflowId && task.workflowId !== workflowId)
            return { ok: false, data: { skipped: true, reason: 'stale_workflow' } };
        const profile = task.account.browserProfile;
        if (task.status === 'CANCELLED')
            return { ok: false, data: { cancelled: true } };
        if (task.status === 'SUCCEEDED')
            return { ok: true, data: { alreadyCompleted: true } };
        if (task.status === 'PAUSED' || task.status !== 'RUNNING' && (task.campaign?.pausedAt || task.campaign?.cancelledAt))
            return { ok: false, data: { paused: true } };
        const externalAction = (0, contracts_1.requiresExternalApproval)(task.action);
        if (externalAction && task.approvalStatus !== 'APPROVED') {
            return { ok: false, data: { requiresAction: true, reason: 'External action has not been approved' } };
        }
        if (externalAction && (task.attemptCount > 0 || task.status === 'RUNNING')) {
            const markUncertain = async () => {
                const marked = await this.prisma.task.updateMany({ where: { id: task.id, ...(task.workflowId ? { workflowId: task.workflowId } : {}), status: { notIn: ['SUCCEEDED', 'CANCELLED'] } }, data: { status: 'REQUIRES_ACTION', lastError: 'Kết quả lần chạy trước chưa chắc chắn; kiểm tra Facebook trước khi gửi lại.' } });
                if (marked.count !== 1)
                    return;
                await this.prisma.platformAccount.updateMany({ where: { id: task.accountId, status: 'RUNNING' }, data: { status: 'ERROR' } });
                if (profile)
                    await this.prisma.browserProfile.updateMany({ where: { id: profile.id, status: 'LEASED' }, data: { status: 'AVAILABLE' } });
            };
            // Only release stale database state after acquiring the actual profile lease.
            if (profile)
                await this.leases.withLease(profile.id, markUncertain);
            else
                await markUncertain();
            return { ok: false, data: { requiresAction: true, reason: 'Uncertain previous attempt; automatic retry disabled' } };
        }
        if (!externalAction && activity_1.Context.current().info.attempt > task.maxAttempts) {
            const message = `Tác vụ vượt quá giới hạn ${task.maxAttempts.toString()} lần thử.`;
            await this.prisma.task.updateMany({
                where: { id: task.id, status: { in: ['QUEUED', 'SCHEDULED', 'RUNNING'] } },
                data: { status: 'FAILED', lastError: message },
            });
            throw common_2.ApplicationFailure.nonRetryable(message, 'MAX_ATTEMPTS_EXCEEDED');
        }
        if (!profile) {
            throw common_2.ApplicationFailure.nonRetryable('Account has no browser profile', 'PROFILE_NOT_FOUND');
        }
        const action = contracts_1.platformActionSchema.parse({
            platform: task.platform,
            accountId: task.accountId,
            action: task.action,
            payload: task.payload,
        });
        const adapter = this.adapters.get(action.platform);
        if (!adapter) {
            throw common_2.ApplicationFailure.nonRetryable(`No adapter registered for ${action.platform}`, 'ADAPTER_NOT_FOUND');
        }
        return this.leases.withLease(profile.id, async () => {
            const current = await this.prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: { campaign: true, account: { include: { proxyBinding: { include: { proxy: true } }, browserProfile: { include: { sessions: { where: { status: { in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'] } }, take: 1 } } } } } } });
            if (workflowId && current.workflowId !== workflowId)
                return { ok: false, data: { skipped: true, reason: 'stale_workflow' } };
            if (current.status === 'CANCELLED')
                return { ok: false, data: { cancelled: true } };
            if (current.status === 'PAUSED' || current.campaign?.pausedAt || current.campaign?.cancelledAt)
                return { ok: false, data: { paused: true } };
            const facebookBrowserAction = ['SYNC_FACEBOOK_GROUPS', 'JOIN_FACEBOOK_GROUP', 'POST_FACEBOOK_GROUP', 'MESSAGE_FACEBOOK_RECIPIENT', 'MESSAGE_FACEBOOK_REACTOR', 'SCAN_FACEBOOK_POST_COMMENTS', 'REPLY_FACEBOOK_POST_COMMENTS'].includes(action.action);
            if (facebookBrowserAction && current.account.status !== 'READY') {
                await this.prisma.task.update({ where: { id: task.id }, data: { status: 'REQUIRES_ACTION', lastError: 'Account không ở trạng thái READY; hãy đăng nhập hoặc xử lý xác minh trước.' } });
                return { ok: false, data: { requiresAction: true, reason: 'Account is not READY' } };
            }
            if (facebookBrowserAction && (current.account.browserProfile?.sessions.length || current.account.proxyBinding && current.account.proxyBinding.proxy.status !== 'HEALTHY')) {
                const reason = 'Browser đang mở hoặc proxy chưa HEALTHY. Đóng browser và kiểm tra proxy trước khi chạy.';
                await this.prisma.task.update({ where: { id: task.id }, data: { status: 'REQUIRES_ACTION', lastError: reason } });
                return { ok: false, data: { requiresAction: true, reason } };
            }
            const run = await this.prisma.$transaction(async (tx) => {
                const claim = await tx.task.updateMany({
                    where: { id: task.id, ...(task.workflowId ? { workflowId: task.workflowId } : {}), status: { in: externalAction ? ['QUEUED', 'SCHEDULED'] : ['QUEUED', 'SCHEDULED', 'FAILED', 'RUNNING'] }, ...(externalAction ? { approvalStatus: 'APPROVED', attemptCount: 0 } : {}) },
                    data: { status: 'RUNNING', attemptCount: { increment: 1 } },
                });
                if (claim.count !== 1)
                    return null;
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
            if (!run)
                return { ok: false, data: { cancelled: true, reason: 'Task state changed before execution' } };
            const activityContext = activity_1.Context.current();
            const heartbeat = setInterval(() => activityContext.heartbeat({ stage: 'processing_task', taskId: task.id }), 10_000);
            let sideEffectStarted = false;
            let authenticated = false;
            let browserSessionId;
            let browserCloseWaitCompleted = false;
            const waitForBrowserClose = async () => {
                if (browserCloseWaitCompleted)
                    return;
                const delayMs = this.config.get('browserCloseDelayMs', { infer: true });
                if (delayMs > 0)
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                browserCloseWaitCompleted = true;
            };
            try {
                const browserSession = await this.prisma.browserSession.create({ data: {
                        profileId: profile.id, workerId: this.registry.workerId, mode: 'AUTOMATION', status: 'STARTING',
                        expiresAt: new Date(Date.now() + 6 * 60_000),
                    } });
                browserSessionId = browserSession.id;
                activity_1.Context.current().heartbeat({ stage: 'restoring_profile_snapshot' });
                await this.snapshots.restore(current.account.browserProfile ?? profile);
                activity_1.Context.current().heartbeat({ stage: 'opening_browser' });
                let result;
                const harPath = await this.artifacts.temporaryPath('.har');
                try {
                    result = await this.runtime.withProfile({
                        profileId: profile.id,
                        ownerId: browserSession.id,
                        proxy: await toRuntimeProxy(current.account.proxyBinding?.proxy, this.secrets),
                        headless: this.config.get('browserHeadless', { infer: true }),
                        channel: this.config.get('browserChannel', { infer: true }),
                        locale: this.config.get('browserLocale', { infer: true }),
                        timezoneId: this.config.get('browserTimezoneId', { infer: true }),
                        recordHarPath: harPath,
                        // Keep the browser alive until the action result and task run have
                        // been durably persisted. Closing inside withProfile() can abort
                        // a still-settling Facebook UI action while the task is RUNNING.
                        closeOnComplete: false,
                    }, async (session) => {
                        const opened = await this.prisma.browserSession.updateMany({ where: { id: browserSession.id, status: 'STARTING' }, data: { status: 'RUNNING', processId: session.processId, lastActiveAt: new Date() } });
                        if (opened.count !== 1)
                            throw new Error('Browser đã được yêu cầu đóng');
                        activity_1.Context.current().heartbeat({
                            stage: 'executing_action',
                            slot: session.slot,
                        });
                        const consoleLines = [];
                        const recordConsole = (message) => {
                            if (consoleLines.length >= 2_000)
                                return;
                            consoleLines.push(`${new Date().toISOString()} ${message.type()} ${redactLog(message.text())}`);
                        };
                        session.page.on('console', recordConsole);
                        await (0, browser_runtime_1.withDeadline)(session.context.tracing.start({
                            screenshots: true,
                            snapshots: true,
                            sources: true,
                        }), 10_000, 'Trace startup timed out');
                        let retainTrace = false;
                        await this.artifacts
                            .captureScreenshot(task.id, run.id, session.page, 'BEFORE_SCREENSHOT')
                            .catch(() => undefined);
                        try {
                            let blocked;
                            if (action.platform === 'FACEBOOK' && facebookBrowserAction) {
                                const loginSettings = (0, platform_login_1.profileLoginSettings)(current.account.browserProfile?.metadata);
                                const credentials = loginSettings.credentialsRef ? await this.secrets.profileCredentials(loginSettings.credentialsRef) : undefined;
                                await (0, platform_login_1.initializePlatformSession)(session, 'FACEBOOK', credentials);
                                if (await (0, platform_login_1.isPlatformChallenged)(session)) {
                                    blocked = { ok: false, data: { requiresAction: true, accountChallenged: true, reason: 'Facebook yêu cầu xác minh/CAPTCHA. Hãy thao tác thủ công.' } };
                                }
                                if (!blocked && !(await (0, platform_login_1.isPlatformAuthenticated)(session, 'FACEBOOK'))) {
                                    throw new platform_core_1.LoginRequiredError('Không xác nhận được phiên đăng nhập Facebook. Hãy mở browser để đăng nhập hoặc kiểm tra cookie.');
                                }
                                authenticated = !blocked;
                            }
                            const actionSession = {
                                ...session,
                                accountUsername: current.account.username ?? undefined,
                                accountExternalId: current.account.externalId ?? undefined,
                                reserveMessageRecipient: ['MESSAGE_FACEBOOK_RECIPIENT', 'MESSAGE_FACEBOOK_REACTOR'].includes(action.action)
                                    ? async (recipient) => this.reserveMessageRecipient({
                                        organizationId: current.organizationId,
                                        accountId: current.accountId,
                                        taskId: current.id,
                                        ...recipient,
                                    })
                                    : undefined,
                                releaseMessageRecipient: ['MESSAGE_FACEBOOK_RECIPIENT', 'MESSAGE_FACEBOOK_REACTOR'].includes(action.action)
                                    ? async (recipient) => this.releaseMessageRecipient({
                                        organizationId: current.organizationId,
                                        taskId: current.id,
                                        ...recipient,
                                    })
                                    : undefined,
                                resolveMediaAssets: async (ids) => {
                                    const approvedMediaIds = 'mediaAssetIds' in action.payload ? action.payload.mediaAssetIds : [];
                                    if (!['POST_FACEBOOK_GROUP', 'MESSAGE_FACEBOOK_RECIPIENT', 'MESSAGE_FACEBOOK_REACTOR', 'REPLY_FACEBOOK_POST_COMMENTS'].includes(action.action) || ids.some((id) => !approvedMediaIds.includes(id))) {
                                        throw new Error('Ảnh không thuộc nội dung tác vụ đã duyệt');
                                    }
                                    return (0, task_images_1.loadTaskImages)(this.prisma, this.objects, task.organizationId, ids);
                                },
                                beforeExternalAction: async () => {
                                    session.signal?.throwIfAborted();
                                    const state = await this.prisma.browserSession.findUnique({ where: { id: browserSession.id }, select: { status: true } });
                                    if (state?.status !== 'RUNNING')
                                        throw new Error('Browser đã được yêu cầu đóng; dừng trước khi gửi');
                                    // Persist BEFORE clicking: even a crash during the click is uncertain.
                                    sideEffectStarted = true;
                                    await this.prisma.taskRun.update({ where: { id: run.id }, data: { result: { sideEffectStarted: true } } });
                                    session.signal?.throwIfAborted();
                                },
                            };
                            const actionResult = blocked ?? await adapter.execute(action, actionSession);
                            if (!actionResult.ok) {
                                retainTrace = true;
                                await this.artifacts
                                    .captureFailure(task.id, run.id, session.page)
                                    .catch(() => undefined);
                            }
                            return actionResult;
                        }
                        catch (error) {
                            retainTrace = true;
                            await this.artifacts
                                .captureFailure(task.id, run.id, session.page)
                                .catch(() => undefined);
                            throw error;
                        }
                        finally {
                            await this.artifacts
                                .captureScreenshot(task.id, run.id, session.page, 'AFTER_SCREENSHOT')
                                .catch(() => undefined);
                            if (retainTrace) {
                                await this.artifacts
                                    .captureTrace(task.id, run.id, session.context)
                                    .catch(() => undefined);
                            }
                            else {
                                await (0, browser_runtime_1.withDeadline)(session.context.tracing.stop(), 5_000, 'Trace cleanup timed out').catch(() => undefined);
                            }
                            session.page.off('console', recordConsole);
                            await this.artifacts
                                .captureConsoleLog(task.id, run.id, consoleLines)
                                .catch(() => undefined);
                        }
                    });
                }
                finally {
                    await this.artifacts
                        .captureHar(task.id, run.id, harPath)
                        .catch(() => undefined);
                    // The action has returned at this point, so release Chromium before
                    // archiving the profile. Keeping the browser open while tar/lstat
                    // reads the profile lets Windows hold profile.tar.gz handles and can
                    // make the task appear stuck or fail with ENOTEMPTY/EPERM.
                    if (browserSessionId && this.runtime.closeProfile) {
                        await waitForBrowserClose();
                        await this.runtime.closeProfile(profile.id, browserSessionId).catch(() => undefined);
                    }
                    activity_1.Context.current().heartbeat({ stage: 'saving_profile_snapshot' });
                    try {
                        await this.snapshots.capture(profile.id);
                    }
                    catch (snapshotError) {
                        // Snapshot cleanup/antivirus races on Windows must not overwrite the
                        // actual Facebook action result. The browser session is already
                        // closed here; make the profile available for a retry and preserve
                        // the task outcome instead of turning a successful/verified action
                        // into a misleading REQUIRES_ACTION failure.
                        await this.prisma.browserProfile.update({
                            where: { id: profile.id },
                            data: { status: 'AVAILABLE' },
                        }).catch(() => undefined);
                        this.logger.warn(`Profile snapshot skipped for ${profile.id}: ${snapshotError instanceof Error ? snapshotError.message : String(snapshotError)}`);
                    }
                }
                if (result.data?.loginRequired === true)
                    throw new platform_core_1.LoginRequiredError();
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
                            result: { ...(result.data ?? {}), sideEffectStarted },
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
            }
            catch (error) {
                const loginRequired = error instanceof platform_core_1.LoginRequiredError;
                const unsupported = error instanceof platform_core_1.UnsupportedPlatformActionError;
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
            }
            finally {
                clearInterval(heartbeat);
                if (browserSessionId) {
                    // withProfile() is configured to defer closing for campaign work so
                    // persistence and confirmation finish before Chromium is torn down.
                    if (this.runtime.closeProfile) {
                        await waitForBrowserClose();
                        await this.runtime.closeProfile(profile.id, browserSessionId).catch(() => undefined);
                    }
                    await this.prisma.browserSession.update({ where: { id: browserSessionId }, data: { status: 'CLOSED', closedAt: new Date() } });
                }
            }
        }, { waitTimeoutMs: 10 * 60_000, onWait: () => activity_1.Context.current().heartbeat({ stage: 'waiting_profile', taskId: task.id }) });
    }
    async persistFacebookResult(task, result) {
        const data = result.data ?? {};
        if (task.action === 'SYNC_FACEBOOK_GROUPS' && (result.ok || data.syncSource === 'JOINED_GROUPS_PAGE') && Array.isArray(data.groups)) {
            const groups = data.groups;
            await this.prisma.$transaction(async (tx) => {
                // A dynamically-loaded list is not proof that an unobserved group was left.
                // Check composer availability on the target page before posting instead.
                for (const group of groups) {
                    const groupUrl = (0, contracts_1.normalizeFacebookGroupUrl)(group.groupUrl);
                    await tx.facebookGroupMembership.upsert({
                        where: { accountId_groupUrl: { accountId: task.accountId, groupUrl } },
                        create: { organizationId: task.organizationId, accountId: task.accountId, groupUrl, groupName: group.groupName, status: 'JOINED' },
                        update: { ...(group.groupName ? { groupName: group.groupName } : {}), status: 'JOINED', lastSyncedAt: new Date() },
                    });
                }
            }, { timeout: 60_000 });
        }
        const payload = task.payload;
        if (['JOIN_FACEBOOK_GROUP', 'POST_FACEBOOK_GROUP'].includes(task.action) && typeof data.membershipStatus === 'string' && typeof payload.groupUrl === 'string') {
            const groupUrl = (0, contracts_1.normalizeFacebookGroupUrl)(payload.groupUrl);
            await this.prisma.facebookGroupMembership.upsert({
                where: { accountId_groupUrl: { accountId: task.accountId, groupUrl } },
                create: { organizationId: task.organizationId, accountId: task.accountId, groupUrl, groupName: typeof data.groupName === 'string' ? data.groupName : null, status: data.membershipStatus },
                update: { status: data.membershipStatus, lastSyncedAt: new Date() },
            });
        }
        if (task.action === 'POST_FACEBOOK_GROUP' && result.ok && typeof payload.groupUrl === 'string') {
            await this.prisma.facebookGroupMembership.updateMany({ where: { accountId: task.accountId, organizationId: task.organizationId, groupUrl: (0, contracts_1.normalizeFacebookGroupUrl)(payload.groupUrl) }, data: { lastPostAt: new Date() } });
        }
        if (['MESSAGE_FACEBOOK_RECIPIENT', 'MESSAGE_FACEBOOK_REACTOR'].includes(task.action) && result.ok && data.messageStatus === 'SENT' && typeof data.profileUrl === 'string') {
            const model = this.prisma.facebookMessageRecipient;
            if (model) {
                const groupUrl = this.normalizeMessageScopeUrl(typeof payload.groupUrl === 'string' ? payload.groupUrl : typeof payload.postUrl === 'string' ? payload.postUrl : typeof data.postUrl === 'string' ? data.postUrl : '');
                const profileUrl = (0, contracts_1.normalizeFacebookProfileUrl)(data.profileUrl);
                await model.upsert({
                    where: { organizationId_groupUrl_profileUrl: { organizationId: task.organizationId, groupUrl, profileUrl } },
                    create: { organizationId: task.organizationId, accountId: task.accountId, taskId: task.id, groupUrl, profileUrl, displayName: typeof data.displayName === 'string' ? data.displayName : null, status: 'SENT', sentAt: new Date() },
                    update: { accountId: task.accountId, taskId: task.id, displayName: typeof data.displayName === 'string' ? data.displayName : undefined, status: 'SENT', sentAt: new Date() },
                });
            }
        }
    }
    async reserveMessageRecipient(input) {
        const model = this.prisma.facebookMessageRecipient;
        if (!model)
            return true;
        const groupUrl = this.normalizeMessageScopeUrl(input.groupUrl);
        const profileUrl = (0, contracts_1.normalizeFacebookProfileUrl)(input.profileUrl);
        const existing = await model.findUnique({ where: { organizationId_groupUrl_profileUrl: { organizationId: input.organizationId, groupUrl, profileUrl } } });
        if (existing) {
            if (existing.taskId === input.taskId && existing.status === 'RESERVED')
                return true;
            // A reservation left behind by a crashed worker is reclaimable after an
            // hour; SENT rows are permanent and always excluded.
            if (existing.status === 'RESERVED' && Date.now() - new Date(existing.reservedAt).getTime() > 60 * 60 * 1000) {
                const claimed = await model.updateMany({ where: { id: existing.id, status: 'RESERVED', reservedAt: existing.reservedAt }, data: { accountId: input.accountId, taskId: input.taskId, displayName: input.displayName, reservedAt: new Date() } });
                return claimed.count === 1;
            }
            return false;
        }
        try {
            await model.create({ data: { organizationId: input.organizationId, accountId: input.accountId, taskId: input.taskId, groupUrl, profileUrl, displayName: input.displayName, status: 'RESERVED' } });
            return true;
        }
        catch (error) {
            if (error instanceof database_1.Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
                return false;
            throw error;
        }
    }
    async releaseMessageRecipient(input) {
        const model = this.prisma.facebookMessageRecipient;
        if (!model)
            return;
        await model.deleteMany({ where: { organizationId: input.organizationId, taskId: input.taskId, groupUrl: this.normalizeMessageScopeUrl(input.groupUrl), profileUrl: (0, contracts_1.normalizeFacebookProfileUrl)(input.profileUrl), status: 'RESERVED' } });
    }
    normalizeMessageScopeUrl(value) {
        try {
            return (0, contracts_1.normalizeFacebookGroupUrl)(value);
        }
        catch {
            return (0, contracts_1.normalizeFacebookPostUrl)(value);
        }
    }
};
exports.BrowserTaskActivities = BrowserTaskActivities;
exports.BrowserTaskActivities = BrowserTaskActivities = BrowserTaskActivities_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(7, (0, common_1.Inject)(runtime_providers_1.BROWSER_RUNTIME)),
    __param(8, (0, common_1.Inject)(object_storage_providers_1.OBJECT_STORAGE)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, profile_lease_service_1.ProfileLeaseService, worker_registry_service_1.WorkerRegistryService, profile_snapshots_service_1.ProfileSnapshotsService, task_artifacts_service_1.TaskArtifactsService, secrets_service_1.SecretsService, config_1.ConfigService, Function, Object])
], BrowserTaskActivities);
function redactLog(value) {
    return value
        .slice(0, 4_000)
        .replace(/(authorization|cookie|token|password|secret)(["'\s:=]+)[^\s,;]+/gi, '$1$2[REDACTED]');
}
async function toRuntimeProxy(proxy, secrets) {
    if (!proxy)
        return undefined;
    const credentials = proxy.credentialsRef
        ? await secrets.proxyCredentials(proxy.credentialsRef)
        : undefined;
    return {
        server: `${proxy.protocol.toLowerCase()}://${proxy.host}:${proxy.port.toString()}`,
        username: credentials?.username,
        password: credentials?.password,
    };
}
//# sourceMappingURL=browser-task.activities.js.map