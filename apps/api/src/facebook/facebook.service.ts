import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { JoinFacebookGroupsInput, PostFacebookGroupsInput, RetryFacebookCampaignInput } from '@socio/contracts';
import { Prisma, type TaskStatus } from '@socio/database';
import { PrismaService } from '../database/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { TemporalClientService } from '../temporal/temporal-client.service';

const campaignInclude = {
  tasks: {
    include: { account: { select: { id: true, username: true, status: true } }, runs: { orderBy: { startedAt: 'desc' as const }, take: 1 } },
    orderBy: { createdAt: 'asc' as const },
  },
};

export function retrySafety(task: { status: string; attemptCount: number; runs: Array<{ errorCode?: string | null; result?: unknown }> }): 'SAFE' | 'VERIFY' | 'BLOCKED' {
  if (!['FAILED', 'REQUIRES_ACTION'].includes(task.status)) return 'BLOCKED';
  const run = task.runs[0], result = run?.result as Record<string, unknown> | undefined;
  if (task.attemptCount === 0 || result?.sideEffectStarted === false) return 'SAFE';
  return 'VERIFY';
}

interface PostTarget { accountId: string; groupUrl: string }

export function distributePostTargets(
  accountIds: string[],
  groupUrls: string[],
  memberships: PostTarget[],
  maxGroupsPerAccount: number,
): { targets: PostTarget[]; unassigned: string[] } {
  const eligibleByGroup = new Map<string, Set<string>>();
  for (const membership of memberships) {
    const eligible = eligibleByGroup.get(membership.groupUrl) ?? new Set<string>();
    eligible.add(membership.accountId);
    eligibleByGroup.set(membership.groupUrl, eligible);
  }
  const counts = new Map(accountIds.map(accountId => [accountId, 0]));
  const assignments: Array<PostTarget & { order: number }> = [], unassigned: Array<{ groupUrl: string; order: number }> = [];
  let cursor = 0;
  // Assign groups with fewer eligible accounts first so a flexible group does
  // not consume the only slot capable of handling a constrained group.
  const orderedGroups = groupUrls.map((groupUrl, order) => ({ groupUrl, order }))
    .sort((left, right) => (eligibleByGroup.get(left.groupUrl)?.size ?? 0) - (eligibleByGroup.get(right.groupUrl)?.size ?? 0) || left.order - right.order);
  for (const { groupUrl, order } of orderedGroups) {
    const eligible = eligibleByGroup.get(groupUrl);
    let selectedIndex = -1;
    for (let offset = 0; offset < accountIds.length; offset += 1) {
      const index = (cursor + offset) % accountIds.length;
      const accountId = accountIds[index]!;
      if (eligible?.has(accountId) && (counts.get(accountId) ?? 0) < maxGroupsPerAccount) {
        selectedIndex = index;
        break;
      }
    }
    if (selectedIndex < 0) {
      unassigned.push({ groupUrl, order });
      continue;
    }
    const accountId = accountIds[selectedIndex]!;
    assignments.push({ accountId, groupUrl, order });
    counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
    cursor = (selectedIndex + 1) % accountIds.length;
  }
  return {
    targets: assignments.sort((left, right) => left.order - right.order).map(({ accountId, groupUrl }) => ({ accountId, groupUrl })),
    unassigned: unassigned.sort((left, right) => left.order - right.order).map(item => item.groupUrl),
  };
}

@Injectable()
export class FacebookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly temporal: TemporalClientService,
  ) {}

  groups(organizationId: string) {
    return this.prisma.facebookGroupMembership.findMany({
      where: { organizationId }, include: { account: { select: { id: true, username: true } } },
      orderBy: [{ accountId: 'asc' }, { groupName: 'asc' }], take: 5000,
    });
  }

  async campaigns(organizationId: string) {
    const campaigns = await this.prisma.facebookCampaign.findMany({ where: { organizationId }, include: campaignInclude, orderBy: { createdAt: 'desc' }, take: 50 });
    return campaigns.map(campaign => ({ ...campaign, tasks: campaign.tasks.map(task => ({ ...task, retrySafety: retrySafety(task) })) }));
  }

  async sync(organizationId: string, input: { accountIds: string[]; idempotencyKey: string }) {
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    const tasks = await Promise.all(accounts.map((account) => this.tasks.create(organizationId, {
      idempotencyKey: `${createHash('sha256').update(input.idempotencyKey).digest('hex')}:${account.id}`,
      action: { platform: 'FACEBOOK', accountId: account.id, action: 'SYNC_FACEBOOK_GROUPS', payload: {} },
      priority: 50, maxAttempts: 1,
    })));
    return { tasks, count: tasks.length };
  }

  async join(organizationId: string, input: JoinFacebookGroupsInput) {
    const existing = await this.existing(organizationId, input.idempotencyKey);
    if (existing) return existing;
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    const targets = accounts.flatMap((account) => input.groupUrls.map((groupUrl) => ({ accountId: account.id, groupUrl })));
    return this.createCampaign(organizationId, input, 'JOIN', targets);
  }

  async post(organizationId: string, input: PostFacebookGroupsInput) {
    const existing = await this.existing(organizationId, input.idempotencyKey);
    if (existing) return existing;
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    let groupUrls: string[];
    let memberships: PostTarget[];
    if (input.selection === 'CUSTOM') {
      if (!input.groupUrls?.length) throw new BadRequestException('Chọn ít nhất một nhóm đã đồng bộ');
      groupUrls = [...new Set(input.groupUrls)];
      memberships = await this.prisma.facebookGroupMembership.findMany({
        where: { organizationId, accountId: { in: accounts.map(account => account.id) }, groupUrl: { in: groupUrls } },
        select: { accountId: true, groupUrl: true }, orderBy: [{ accountId: 'asc' }, { groupUrl: 'asc' }],
      });
      const available = new Set(memberships.map(group => group.groupUrl));
      if (groupUrls.some(url => !available.has(url))) throw new BadRequestException('Một số nhóm được chọn không có trong danh sách của các profile đã chọn. Hãy tải lại danh sách nhóm.');
    } else {
      memberships = await this.prisma.facebookGroupMembership.findMany({
        where: { organizationId, accountId: { in: accounts.map(account => account.id) }, status: 'JOINED' },
        select: { accountId: true, groupUrl: true }, orderBy: [{ groupUrl: 'asc' }, { accountId: 'asc' }],
      });
      groupUrls = [...new Set(memberships.map(group => group.groupUrl))];
    }
    if (!memberships.length) throw new BadRequestException('Các account được chọn chưa có nhóm phù hợp. Hãy đồng bộ nhóm trước.');
    const distribution = distributePostTargets(accounts.map(account => account.id), groupUrls, memberships, input.maxGroupsPerAccount);
    if (input.selection === 'CUSTOM' && distribution.unassigned.length) {
      throw new BadRequestException(`Không thể phân phối đủ ${groupUrls.length} nhóm với giới hạn ${input.maxGroupsPerAccount} nhóm/account. Hãy chọn thêm account, tăng giới hạn hoặc giảm số nhóm.`);
    }
    const targets = distribution.targets;
    if (!targets.length) throw new BadRequestException('Không có nhóm nào có thể phân phối cho các account đã chọn.');
    return this.createCampaign(organizationId, input, 'POST', targets);
  }

  async approve(organizationId: string, id: string, userId?: string) {
    const campaign = await this.prisma.facebookCampaign.findFirst({ where: { id, organizationId }, include: { tasks: true } });
    if (!campaign) throw new NotFoundException('Campaign not found');
    const active = await this.prisma.task.count({ where: { organizationId, accountId: { in: campaign.tasks.map((task) => task.accountId) }, status: { in: ['QUEUED', 'SCHEDULED', 'RUNNING'] } } });
    if (active) throw new ConflictException('Account đang có tác vụ chờ/chạy. Chờ hoàn tất hoặc hủy chiến dịch cũ trước khi duyệt.');
    await this.selectedAccounts(organizationId, [...new Set(campaign.tasks.map((task) => task.accountId))]);
    const pending = campaign.tasks.filter((task) => task.approvalStatus === 'PENDING');
    if (!pending.length || campaign.approvedAt) throw new ConflictException('Chiến dịch không còn chờ duyệt');
    const intervalSeconds = Number((campaign.payload as Record<string, unknown>).intervalSeconds ?? 60);
    const now = Date.now();
    const sequence = new Map<string, number>();
    const dispatches = pending.map((task) => {
      const index = sequence.get(task.accountId) ?? 0;
      sequence.set(task.accountId, index + 1);
      return { task, scheduledAt: new Date(now + index * intervalSeconds * 1000) };
    });
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`facebook/campaign/${id}`}))`;
      await this.ensureDispatchable(tx, organizationId, pending.map(task => task.accountId));
      const claimed = await tx.facebookCampaign.updateMany({ where: { id, organizationId, approvedAt: null, cancelledAt: null, pausedAt: null }, data: { approvedAt: new Date(now) } });
      if (claimed.count !== 1) throw new ConflictException('Chiến dịch đã được duyệt');
      for (const { task, scheduledAt } of dispatches) {
        const claimedTask = await tx.task.updateMany({
          where: { id: task.id, approvalStatus: 'PENDING', status: 'DRAFT' },
          data: { approvalStatus: 'APPROVED', approvedAt: new Date(now), approvedByUserId: userId, scheduledAt, status: 'SCHEDULED', lastError: null },
        });
        if (claimedTask.count !== 1) throw new ConflictException('Một tác vụ đã thay đổi. Tải lại chiến dịch.');
      }
    });
    for (const { task, scheduledAt } of dispatches) {
      try { await this.temporal.startTask(task.id, task.workflowId!, scheduledAt); }
      catch (error) {
        await this.prisma.task.update({ where: { id: task.id }, data: { lastError: `Workflow dispatch pending: ${error instanceof Error ? error.message : String(error)}` } });
      }
    }
    return this.prisma.facebookCampaign.findUniqueOrThrow({ where: { id }, include: campaignInclude });
  }

  async cancel(organizationId: string, id: string) {
    return this.prisma.$transaction(async tx => {
      const campaign = await this.lockedCampaign(tx, organizationId, id);
      await tx.facebookCampaign.update({ where: { id }, data: { cancelledAt: campaign.cancelledAt ?? new Date(), pausedAt: null } });
      const result = await tx.task.updateMany({
        where: { campaignId: id, organizationId, status: { in: ['DRAFT', 'SCHEDULED', 'QUEUED', 'PAUSED', 'FAILED', 'REQUIRES_ACTION'] } },
        data: { status: 'CANCELLED', approvalStatus: 'REJECTED', rejectedAt: new Date() },
      });
      return { cancelled: result.count, message: 'Đã hủy phần chưa hoàn thành. Tác vụ đang chạy được kết thúc an toàn và không khởi chạy tác vụ kế tiếp.' };
    });
  }

  async pause(organizationId: string, id: string) {
    return this.prisma.$transaction(async tx => {
      const campaign = await this.lockedCampaign(tx, organizationId, id);
      if (!campaign.approvedAt || campaign.cancelledAt) throw new ConflictException('Chỉ dừng chiến dịch đã duyệt và chưa hủy');
      if (!campaign.tasks.some(task => ['RUNNING', 'SCHEDULED', 'QUEUED', 'PAUSED'].includes(task.status))) throw new ConflictException('Không còn tác vụ chờ hoặc đang chạy để dừng');
      await tx.facebookCampaign.update({ where: { id }, data: { pausedAt: campaign.pausedAt ?? new Date() } });
      const result = await tx.task.updateMany({ where: { campaignId: id, organizationId, status: { in: ['SCHEDULED', 'QUEUED'] } }, data: { status: 'PAUSED' } });
      return { paused: result.count, message: 'Đã dừng tác vụ kế tiếp. Tác vụ đang chạy sẽ kết thúc an toàn trước khi dừng hẳn.' };
    });
  }

  async resume(organizationId: string, id: string) {
    const dispatches = await this.prisma.$transaction(async tx => {
      const campaign = await this.lockedCampaign(tx, organizationId, id);
      if (!campaign.pausedAt || campaign.cancelledAt || !campaign.approvedAt) throw new ConflictException('Chiến dịch không ở trạng thái tạm dừng');
      const pending = campaign.tasks.filter(task => task.status === 'PAUSED');
      await this.ensureDispatchable(tx, organizationId, pending.map(task => task.accountId));
      if (campaign.tasks.some(task => task.status === 'RUNNING')) throw new ConflictException('Chờ tác vụ đang chạy kết thúc trước khi tiếp tục');
      const dispatches = await this.requeue(tx, campaign, pending);
      await tx.facebookCampaign.update({ where: { id }, data: { pausedAt: null } });
      return dispatches;
    });
    await this.dispatch(dispatches);
    return { resumed: dispatches.length };
  }

  async retry(organizationId: string, id: string, input: RetryFacebookCampaignInput) {
    const dispatches = await this.prisma.$transaction(async tx => {
      const campaign = await this.lockedCampaign(tx, organizationId, id);
      if (!campaign.approvedAt || campaign.cancelledAt || campaign.pausedAt) throw new ConflictException('Tiếp tục chiến dịch đã duyệt trước khi chạy lại; chiến dịch đã hủy không thể chạy lại');
      const ids = [...new Set(input.taskIds)];
      const selected = campaign.tasks.filter(task => ids.includes(task.id));
      if (selected.length !== ids.length) throw new BadRequestException('Tác vụ không thuộc chiến dịch này');
      if (input.verifiedUnsentTaskIds.some(taskId => !ids.includes(taskId))) throw new BadRequestException('Chỉ xác nhận các tác vụ được chọn');
      for (const task of selected) {
        const safety = retrySafety(task);
        if (safety === 'BLOCKED') throw new ConflictException('Chỉ chạy lại tác vụ lỗi hoặc cần thao tác; không chạy lại phần đã hoàn thành');
        if (safety === 'VERIFY' && !input.verifiedUnsentTaskIds.includes(task.id)) throw new ConflictException('Kết quả gửi chưa rõ. Kiểm tra trên Facebook và xác nhận tác vụ chưa gửi thành công trước khi chạy lại.');
      }
      await this.ensureDispatchable(tx, organizationId, selected.map(task => task.accountId));
      return this.requeue(tx, campaign, selected);
    });
    await this.dispatch(dispatches);
    return { retried: dispatches.length };
  }

  private async lockedCampaign(tx: Prisma.TransactionClient, organizationId: string, id: string) {
    // Serialize controls for the same campaign, including duplicate HTTP requests.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`facebook/campaign/${id}`}))`;
    const campaign = await tx.facebookCampaign.findFirst({ where: { id, organizationId }, include: campaignInclude });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  private async ensureDispatchable(tx: Prisma.TransactionClient, organizationId: string, accountIds: string[]) {
    const ids = [...new Set(accountIds)].sort();
    if (!ids.length) return;
    for (const id of ids) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`facebook/account/${id}`}))`;
    const active = await tx.task.count({ where: { organizationId, accountId: { in: ids }, status: { in: ['QUEUED', 'SCHEDULED', 'RUNNING'] } } });
    if (active) throw new ConflictException('Profile còn tác vụ đang chạy/chờ. Chờ hoàn tất hoặc dừng chiến dịch khác trước.');
    await this.selectedAccounts(organizationId, ids, tx);
  }

  private async requeue(tx: Prisma.TransactionClient, campaign: { id: string; organizationId: string; payload: unknown }, tasks: Array<{ id: string; accountId: string; status: TaskStatus; workflowId: string | null; attemptCount: number }>) {
    const intervalSeconds = Number((campaign.payload as Record<string, unknown>).intervalSeconds ?? 60);
    const now = Date.now(), sequence = new Map<string, number>();
    const dispatches: Array<{ id: string; workflowId: string; scheduledAt: Date }> = [];
    for (const task of tasks) {
      const index = sequence.get(task.accountId) ?? 0; sequence.set(task.accountId, index + 1);
      const workflowId = `task/${task.id}/${randomUUID()}`, scheduledAt = new Date(now + index * intervalSeconds * 1000);
      const claimed = await tx.task.updateMany({ where: { id: task.id, organizationId: campaign.organizationId, campaignId: campaign.id, status: task.status, workflowId: task.workflowId, attemptCount: task.attemptCount, approvalStatus: 'APPROVED' }, data: { status: 'SCHEDULED', workflowId, scheduledAt, attemptCount: 0, lastError: null } });
      if (claimed.count !== 1) throw new ConflictException('Tác vụ đã thay đổi. Tải lại chiến dịch trước khi tiếp tục.');
      dispatches.push({ id: task.id, workflowId, scheduledAt });
    }
    return dispatches;
  }

  private async dispatch(tasks: Array<{ id: string; workflowId: string; scheduledAt: Date }>) {
    for (const task of tasks) {
      try { await this.temporal.startTask(task.id, task.workflowId, task.scheduledAt); }
      catch (error) { await this.prisma.task.updateMany({ where: { id: task.id, workflowId: task.workflowId, status: 'SCHEDULED' }, data: { lastError: `Workflow dispatch pending: ${error instanceof Error ? error.message : String(error)}` } }); }
    }
  }

  private existing(organizationId: string, idempotencyKey: string) {
    return this.prisma.facebookCampaign.findUnique({ where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } }, include: campaignInclude });
  }

  private async selectedAccounts(organizationId: string, accountIds: string[], database: Pick<PrismaService, 'platformAccount'> = this.prisma) {
    const ids = [...new Set(accountIds)];
    const accounts = await database.platformAccount.findMany({
      where: { organizationId, platform: 'FACEBOOK', status: 'READY', ...(ids.length ? { id: { in: ids } } : {}) },
      include: { browserProfile: { include: { sessions: { where: { status: { in: ['STARTING', 'RUNNING', 'AUTHENTICATED', 'IDLE', 'CLOSING'] } }, take: 1 } } }, proxyBinding: { include: { proxy: true } } },
      orderBy: { createdAt: 'asc' },
    });
    if (!accounts.length) throw new BadRequestException('Không có account Facebook READY');
    if (ids.length && accounts.length !== ids.length) throw new BadRequestException('Các account được chọn phải thuộc workspace, là Facebook và ở trạng thái READY');
    if (accounts.length > 100) throw new BadRequestException('Chọn tối đa 100 account cho một chiến dịch');
    for (const account of accounts) {
      if (!account.browserProfile || account.browserProfile.sessions.length) throw new ConflictException(`Đóng browser của ${account.username ?? account.id} trước khi chạy`);
      if (account.proxyBinding && account.proxyBinding.proxy.status !== 'HEALTHY') throw new ConflictException(`Kiểm tra lại proxy của ${account.username ?? account.id} trước khi chạy`);
    }
    return accounts;
  }

  private async createCampaign(
    organizationId: string,
    input: JoinFacebookGroupsInput | PostFacebookGroupsInput,
    kind: 'JOIN' | 'POST',
    targets: Array<{ accountId: string; groupUrl: string }>,
  ) {
    if (targets.length > 500) throw new BadRequestException('Một chiến dịch tối đa 500 cặp account/nhóm. Hãy chia thành các chiến dịch nhỏ hơn.');
    try {
      return await this.prisma.facebookCampaign.create({
        data: {
          organizationId, idempotencyKey: input.idempotencyKey, name: input.name, kind,
          payload: { intervalSeconds: input.intervalSeconds, ...('text' in input ? {
            text: input.text, selection: input.selection,
            maxGroupsPerAccount: input.maxGroupsPerAccount,
            ...(input.selection === 'CUSTOM' ? { groupUrls: [...new Set(input.groupUrls)] } : {}),
          } : {}) },
          tasks: { create: targets.map((target) => {
            const id = randomUUID();
            return {
              id, organizationId, accountId: target.accountId, idempotencyKey: `facebook:${id}`, workflowId: `task/${id}`,
              platform: 'FACEBOOK', action: kind === 'JOIN' ? 'JOIN_FACEBOOK_GROUP' : 'POST_FACEBOOK_GROUP',
              payload: { groupUrl: target.groupUrl, ...('text' in input ? { text: input.text } : {}) },
              maxAttempts: 1, status: 'DRAFT', approvalStatus: 'PENDING',
            };
          }) },
        }, include: campaignInclude,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.existing(organizationId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
  }
}
