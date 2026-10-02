import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { commentFacebookGroupPostsSchema, messageFacebookReactorsSchema, normalizeFacebookGroupUrl, normalizeFacebookPostUrl, normalizeFacebookProfileUrl, replyFacebookPostCommentsSchema, scanFacebookPostCommentsSchema, syncFacebookGroupsSchema, type CommentFacebookGroupPostsInput, type FacebookGroupCollectionInput, type FacebookOptInRecipientInput, type JoinFacebookGroupsInput, type MessageFacebookRecipientsInput, type MessageFacebookReactorsInput, type PostFacebookGroupsInput, type ReplyFacebookPostCommentsInput, type RetryFacebookCampaignInput, type ScanFacebookPostCommentsInput, type SyncFacebookGroupsInput } from '@socio/contracts';
import { Prisma, type TaskStatus } from '@socio/database';
import { PrismaService } from '../database/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { TemporalClientService } from '../temporal/temporal-client.service';
import { validateFacebookImages } from '../media/facebook-images';

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
interface MessageTarget { accountId: string; groupUrl: string }

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
    private readonly _tasks: TasksService,
    private readonly temporal: TemporalClientService,
  ) {}

  groups(organizationId: string) {
    return this.prisma.facebookGroupMembership.findMany({
      where: { organizationId }, include: { account: { select: { id: true, username: true } } },
      orderBy: [{ accountId: 'asc' }, { groupName: 'asc' }],
    });
  }

  groupCollections(organizationId: string) {
    return this.prisma.facebookGroupCollection.findMany({
      where: { organizationId },
      include: { items: { orderBy: [{ createdAt: 'asc' }, { groupUrl: 'asc' }] } },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createGroupCollection(organizationId: string, input: FacebookGroupCollectionInput) {
    await this.ensureCollectionGroupsExist(organizationId, input.groupUrls);
    try {
      return await this.prisma.facebookGroupCollection.create({
        data: {
          organizationId, name: input.name, description: input.description || null,
          items: { create: input.groupUrls.map(groupUrl => ({ groupUrl })) },
        },
        include: { items: { orderBy: [{ createdAt: 'asc' }, { groupUrl: 'asc' }] } },
      });
    } catch (error) {
      this.throwCollectionWriteError(error);
      throw error;
    }
  }

  async updateGroupCollection(organizationId: string, id: string, input: FacebookGroupCollectionInput) {
    const collection = await this.prisma.facebookGroupCollection.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (!collection) throw new NotFoundException('Không tìm thấy tập hợp nhóm');
    await this.ensureCollectionGroupsExist(organizationId, input.groupUrls);
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.facebookGroupCollection.update({ where: { id }, data: { name: input.name, description: input.description || null } });
        await tx.facebookGroupCollectionItem.deleteMany({ where: { collectionId: id } });
        await tx.facebookGroupCollectionItem.createMany({ data: input.groupUrls.map(groupUrl => ({ collectionId: id, groupUrl })) });
        return tx.facebookGroupCollection.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: [{ createdAt: 'asc' }, { groupUrl: 'asc' }] } } });
      });
    } catch (error) {
      this.throwCollectionWriteError(error);
      throw error;
    }
  }

  async deleteGroupCollection(organizationId: string, id: string) {
    const deleted = await this.prisma.facebookGroupCollection.deleteMany({ where: { id, organizationId } });
    if (!deleted.count) throw new NotFoundException('Không tìm thấy tập hợp nhóm');
    return { deleted: true };
  }

  optInRecipients(organizationId: string) {
    return this.prisma.facebookOptInRecipient.findMany({
      where: { organizationId }, orderBy: [{ revokedAt: 'asc' }, { groupUrl: 'asc' }, { displayName: 'asc' }],
    });
  }

  async createOptInRecipient(organizationId: string, input: FacebookOptInRecipientInput) {
    await this.ensureCollectionGroupsExist(organizationId, [input.groupUrl]);
    try {
      return await this.prisma.facebookOptInRecipient.create({ data: {
        organizationId, groupUrl: input.groupUrl, profileUrl: input.profileUrl, displayName: input.displayName,
        consentSource: input.consentSource, consentNote: input.consentNote || null, consentRecordedAt: new Date(input.consentRecordedAt),
      } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException('Người nhận này đã tồn tại trong nhóm');
      throw error;
    }
  }

  async updateOptInRecipient(organizationId: string, id: string, input: FacebookOptInRecipientInput, reactivate = false) {
    await this.ensureCollectionGroupsExist(organizationId, [input.groupUrl]);
    const updated = await this.prisma.facebookOptInRecipient.updateMany({
      where: { id, organizationId }, data: {
        groupUrl: input.groupUrl, profileUrl: input.profileUrl, displayName: input.displayName,
        consentSource: input.consentSource, consentNote: input.consentNote || null, consentRecordedAt: new Date(input.consentRecordedAt),
        ...(reactivate ? { revokedAt: null } : {}),
      },
    });
    if (!updated.count) throw new NotFoundException('Không tìm thấy người nhận');
    return this.prisma.facebookOptInRecipient.findFirstOrThrow({ where: { id, organizationId } });
  }

  async revokeOptInRecipient(organizationId: string, id: string) {
    const revoked = await this.prisma.facebookOptInRecipient.updateMany({ where: { id, organizationId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!revoked.count) throw new NotFoundException('Không tìm thấy người nhận đang hoạt động');
    return { revoked: true };
  }

  async campaigns(organizationId: string) {
    const campaigns = await this.prisma.facebookCampaign.findMany({ where: { organizationId }, include: campaignInclude, orderBy: { createdAt: 'desc' }, take: 50 });
    return campaigns.map(campaign => ({ ...campaign, tasks: campaign.tasks.map(task => ({ ...task, retrySafety: retrySafety(task) })) }));
  }

  async sync(organizationId: string, input: SyncFacebookGroupsInput) {
    input = syncFacebookGroupsSchema.parse(input);
    const existing = await this.existing(organizationId, input.idempotencyKey);
    if (existing) return existing;
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    return this.createSyncCampaign(organizationId, input, accounts.map(account => account.id));
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
    await validateFacebookImages(this.prisma, organizationId, input.mediaAssetIds);
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    let groupUrls: string[];
    let memberships: PostTarget[];
    let collectionSnapshot: { collectionIds: string[]; collectionNames: string[] } | undefined;
    if (input.selection !== 'ALL') {
      if (input.selection === 'CUSTOM') {
        if (!input.groupUrls?.length) throw new BadRequestException('Chọn ít nhất một nhóm đã đồng bộ');
        groupUrls = [...new Set(input.groupUrls)];
      } else {
        const collectionIds = [...new Set(input.collectionIds ?? [])];
        if (!collectionIds.length) throw new BadRequestException('Chọn ít nhất một tập hợp nhóm');
        const collections = await this.prisma.facebookGroupCollection.findMany({
          where: { organizationId, id: { in: collectionIds } },
          include: { items: { orderBy: [{ createdAt: 'asc' }, { groupUrl: 'asc' }] } },
        });
        if (collections.length !== collectionIds.length) throw new BadRequestException('Một số tập hợp không còn tồn tại. Hãy tải lại danh sách tập hợp.');
        const byId = new Map(collections.map(collection => [collection.id, collection]));
        const ordered = collectionIds.map(id => byId.get(id)!);
        groupUrls = [...new Set(ordered.flatMap(collection => collection.items.map(item => item.groupUrl)))];
        collectionSnapshot = { collectionIds, collectionNames: ordered.map(collection => collection.name) };
      }
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
    if (input.selection !== 'ALL' && distribution.unassigned.length) {
      throw new BadRequestException(`Không thể phân phối đủ ${groupUrls.length} nhóm với giới hạn ${input.maxGroupsPerAccount} nhóm/account. Hãy chọn thêm account, tăng giới hạn hoặc giảm số nhóm.`);
    }
    const targets = distribution.targets;
    if (!targets.length) throw new BadRequestException('Không có nhóm nào có thể phân phối cho các account đã chọn.');
    return this.createCampaign(organizationId, input, 'POST', targets, { groupUrls, ...collectionSnapshot });
  }

  async message(organizationId: string, input: MessageFacebookRecipientsInput) {
    const existing = await this.existing(organizationId, input.idempotencyKey);
    if (existing) return existing;
    await validateFacebookImages(this.prisma, organizationId, input.mediaAssetIds);
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    const selectedGroupUrls = input.groupUrls ?? [];
    const memberships = await this.prisma.facebookGroupMembership.findMany({
      where: {
        organizationId, accountId: { in: accounts.map(account => account.id) }, status: 'JOINED',
        ...(selectedGroupUrls.length ? { groupUrl: { in: selectedGroupUrls } } : {}),
      },
      select: { accountId: true, groupUrl: true }, orderBy: [{ groupUrl: 'asc' }, { accountId: 'asc' }],
    });
    const groupUrls = selectedGroupUrls.length ? selectedGroupUrls : [...new Set(memberships.map(membership => membership.groupUrl))];
    // Import successful recipients from older message campaigns into the
    // durable ledger before allocating this campaign. This keeps the new
    // no-duplicate rule effective even for messages sent before the ledger
    // table was introduced.
    await this.backfillMessageLedger(organizationId, groupUrls);
    const targets = distributeMessageTargets(groupUrls, memberships, input.maxRecipientsPerGroup);
    if (!targets.length) throw new BadRequestException('Các profile được chọn chưa tham gia nhóm nào đã chọn. Hãy đồng bộ nhóm trước.');
    return this.createMessageCampaign(organizationId, { ...input, groupUrls }, targets);
  }

  async messageReactors(organizationId: string, input: MessageFacebookReactorsInput) {
    input = messageFacebookReactorsSchema.parse(input);
    const existing = await this.existing(organizationId, input.idempotencyKey);
    if (existing) return existing;
    await validateFacebookImages(this.prisma, organizationId, input.mediaAssetIds);
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    if (!accounts.length) throw new BadRequestException('Không có account Facebook READY được chọn.');
    return this.createMessageReactorsCampaign(organizationId, input, accounts.map(account => account.id));
  }

  async scanComments(organizationId: string, input: ScanFacebookPostCommentsInput) {
    input = scanFacebookPostCommentsSchema.parse(input);
    const existing = await this.existing(organizationId, input.idempotencyKey);
    if (existing) return existing;
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    return this.createScanCommentsCampaign(organizationId, input, accounts.map(account => account.id));
  }

  async replyComments(organizationId: string, input: ReplyFacebookPostCommentsInput) {
    input = replyFacebookPostCommentsSchema.parse(input);
    const existing = await this.existing(organizationId, input.idempotencyKey);
    if (existing) return existing;
    await validateFacebookImages(this.prisma, organizationId, input.mediaAssetIds);
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    return this.createReplyCommentsCampaign(organizationId, input, accounts.map(account => account.id));
  }

  async commentGroupPosts(organizationId: string, input: CommentFacebookGroupPostsInput) {
    input = commentFacebookGroupPostsSchema.parse(input);
    const existing = await this.existing(organizationId, input.idempotencyKey);
    if (existing) return existing;
    await validateFacebookImages(this.prisma, organizationId, input.mediaAssetIds);
    const accounts = await this.selectedAccounts(organizationId, input.accountIds);
    const memberships = await this.prisma.facebookGroupMembership.findMany({
      where: { organizationId, accountId: { in: accounts.map(account => account.id) }, status: 'JOINED', groupUrl: { in: input.groupUrls } },
      select: { accountId: true, groupUrl: true }, orderBy: [{ groupUrl: 'asc' }, { accountId: 'asc' }],
    });
    const available = new Set(memberships.map(membership => membership.groupUrl));
    if (input.groupUrls.some(groupUrl => !available.has(groupUrl))) throw new BadRequestException('Một số nhóm được chọn chưa được profile tham gia hoặc chưa đồng bộ.');
    const targets = memberships.map(membership => ({ accountId: membership.accountId, groupUrl: membership.groupUrl }));
    if (!targets.length) throw new BadRequestException('Các profile được chọn chưa tham gia nhóm nào đã chọn. Hãy đồng bộ nhóm trước.');
    return this.createCommentGroupPostsCampaign(organizationId, input, targets);
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

  private async ensureCollectionGroupsExist(organizationId: string, groupUrls: string[]) {
    const groups = await this.prisma.facebookGroupMembership.findMany({
      where: { organizationId, groupUrl: { in: groupUrls } }, select: { groupUrl: true }, distinct: ['groupUrl'],
    });
    const available = new Set(groups.map(group => group.groupUrl));
    if (groupUrls.some(groupUrl => !available.has(groupUrl))) {
      throw new BadRequestException('Một số nhóm không còn trong danh sách đã đồng bộ. Hãy tải lại danh sách nhóm.');
    }
  }

  private throwCollectionWriteError(error: unknown): void {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Tên tập hợp đã tồn tại');
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw new NotFoundException('Không tìm thấy tập hợp nhóm');
    }
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
    postSnapshot?: { groupUrls: string[]; collectionIds?: string[]; collectionNames?: string[] },
  ) {
    if (targets.length > 500) throw new BadRequestException('Một chiến dịch tối đa 500 cặp account/nhóm. Hãy chia thành các chiến dịch nhỏ hơn.');
    const startsImmediately = kind === 'POST';
    const createdAt = new Date();
    const sequence = new Map<string, number>();
    const taskCreates = targets.map((target) => {
      const id = randomUUID();
      const index = sequence.get(target.accountId) ?? 0;
      sequence.set(target.accountId, index + 1);
      return {
        id, organizationId, accountId: target.accountId, idempotencyKey: `facebook:${id}`, workflowId: `task/${id}`,
        platform: 'FACEBOOK' as const, action: kind === 'JOIN' ? 'JOIN_FACEBOOK_GROUP' : 'POST_FACEBOOK_GROUP',
        payload: { groupUrl: target.groupUrl, ...('text' in input ? { text: input.text, mediaAssetIds: input.mediaAssetIds ?? [] } : {}) },
        maxAttempts: 1,
        status: startsImmediately ? 'SCHEDULED' as const : 'DRAFT' as const,
        approvalStatus: startsImmediately ? 'APPROVED' as const : 'PENDING' as const,
        ...(startsImmediately ? { approvedAt: createdAt, scheduledAt: new Date(createdAt.getTime() + index * input.intervalSeconds * 1000) } : {}),
      };
    });
    const data = {
      organizationId, idempotencyKey: input.idempotencyKey, name: input.name, kind,
      ...(startsImmediately ? { approvedAt: createdAt } : {}),
      payload: { intervalSeconds: input.intervalSeconds, ...('text' in input ? {
        text: input.text, mediaAssetIds: input.mediaAssetIds ?? [], selection: input.selection,
        maxGroupsPerAccount: input.maxGroupsPerAccount,
        ...(postSnapshot ? {
          groupUrls: postSnapshot.groupUrls,
          ...(postSnapshot.collectionIds ? { collectionIds: postSnapshot.collectionIds } : {}),
          ...(postSnapshot.collectionNames ? { collectionNames: postSnapshot.collectionNames } : {}),
        } : {}),
      } : {}) },
      tasks: { create: taskCreates },
    };
    try {
      const create = (database: Pick<PrismaService, 'facebookCampaign'>) => database.facebookCampaign.create({ data, include: campaignInclude });
      if (!startsImmediately) return await create(this.prisma);
      // Posts are dispatched immediately, but still use the same account locks
      // and active-task checks as the manual approval path.
      const created = await this.prisma.$transaction(async (tx) => {
        await this.ensureDispatchable(tx, organizationId, [...new Set(targets.map(target => target.accountId))]);
        return create(tx);
      });
      await this.dispatch(created.tasks.map(task => ({ id: task.id, workflowId: task.workflowId!, scheduledAt: task.scheduledAt! })));
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.existing(organizationId, input.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    }
  }

  private async createSyncCampaign(organizationId: string, input: SyncFacebookGroupsInput, accountIds: string[]) {
    try {
      return await this.prisma.facebookCampaign.create({
        data: {
          organizationId, idempotencyKey: input.idempotencyKey,
          name: input.scope === 'SELECTED' ? 'Đồng bộ nhóm đã chọn' : 'Đồng bộ tất cả nhóm Facebook',
          kind: 'SYNC', payload: { scope: input.scope ?? 'ALL', intervalSeconds: 60 },
          tasks: { create: accountIds.map(accountId => {
            const id = randomUUID();
            return {
              id, organizationId, accountId, idempotencyKey: `facebook:${id}`, workflowId: `task/${id}`,
              platform: 'FACEBOOK', action: 'SYNC_FACEBOOK_GROUPS', payload: {},
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

  private async createMessageCampaign(organizationId: string, input: MessageFacebookRecipientsInput, targets: MessageTarget[]) {
    try {
      return await this.prisma.facebookCampaign.create({
        data: {
          organizationId, idempotencyKey: input.idempotencyKey, name: input.name, kind: 'MESSAGE',
          payload: {
            text: input.text, mediaAssetIds: input.mediaAssetIds, groupUrls: input.groupUrls, maxRecipientsPerGroup: input.maxRecipientsPerGroup,
            intervalSeconds: input.intervalSeconds,
          },
          tasks: { create: targets.map(target => {
            const id = randomUUID();
            return {
              id, organizationId, accountId: target.accountId, idempotencyKey: `facebook:${id}`, workflowId: `task/${id}`,
              platform: 'FACEBOOK', action: 'MESSAGE_FACEBOOK_RECIPIENT',
              payload: { groupUrl: target.groupUrl, text: input.text, mediaAssetIds: input.mediaAssetIds },
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

  private async createMessageReactorsCampaign(organizationId: string, input: MessageFacebookReactorsInput, accountIds: string[]) {
    const postUrls = [...new Set([...(input.postUrls ?? []), ...(input.postUrl ? [input.postUrl] : [])])];
    if (!postUrls.length) throw new BadRequestException('Nhập ít nhất một URL bài viết Facebook');
    const allocations = distributeReplyCounts(accountIds, input.maxRecipientsPerPost);
    const taskAccounts = accountIds.flatMap(accountId => Array.from({ length: allocations.get(accountId) ?? 0 }, () => accountId));
    if (postUrls.length * taskAccounts.length > 500) throw new BadRequestException('Một chiến dịch tối đa 500 lượt nhắn. Hãy giảm số bài viết hoặc số người mỗi bài.');
    try {
      return await this.prisma.facebookCampaign.create({
        data: {
          organizationId, idempotencyKey: input.idempotencyKey, name: input.name, kind: 'MESSAGE_REACTORS',
          payload: { postUrl: postUrls[0], postUrls, recipientSource: input.recipientSource, text: input.text, mediaAssetIds: input.mediaAssetIds, maxRecipientsPerPost: input.maxRecipientsPerPost, intervalSeconds: input.intervalSeconds },
          tasks: { create: postUrls.flatMap(postUrl => taskAccounts.map(accountId => {
            const id = randomUUID();
            return {
              id, organizationId, accountId, idempotencyKey: `facebook:${id}`, workflowId: `task/${id}`,
              platform: 'FACEBOOK', action: 'MESSAGE_FACEBOOK_REACTOR', payload: { postUrl, recipientSource: input.recipientSource, text: input.text, mediaAssetIds: input.mediaAssetIds },
              maxAttempts: 1, status: 'DRAFT', approvalStatus: 'PENDING',
            };
          })) },
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

  private async backfillMessageLedger(organizationId: string, groupUrls: string[]): Promise<void> {
    const allowedGroups = new Set(groupUrls);
    const runs = await this.prisma.taskRun.findMany({
      where: { status: 'SUCCEEDED', task: { organizationId, action: { in: ['MESSAGE_FACEBOOK_RECIPIENT', 'MESSAGE_FACEBOOK_REACTOR'] } } },
      select: { taskId: true, result: true, task: { select: { accountId: true, payload: true } } },
    });
    for (const run of runs) {
      const result = run.result as Record<string, unknown> | null;
      const payload = run.task.payload as Record<string, unknown>;
      if (result?.messageStatus !== 'SENT' || typeof result.profileUrl !== 'string') continue;
      const rawGroupUrl = typeof result.groupUrl === 'string' ? result.groupUrl : typeof result.postUrl === 'string' ? result.postUrl : typeof payload.groupUrl === 'string' ? payload.groupUrl : payload.postUrl;
      if (typeof rawGroupUrl !== 'string') continue;
      const groupUrl = normalizeMessageScopeUrl(rawGroupUrl);
      if (!allowedGroups.has(groupUrl)) continue;
      const profileUrl = normalizeFacebookProfileUrl(result.profileUrl);
      await this.prisma.facebookMessageRecipient.upsert({
        where: { organizationId_groupUrl_profileUrl: { organizationId, groupUrl, profileUrl } },
        create: { organizationId, accountId: run.task.accountId, taskId: run.taskId, groupUrl, profileUrl, displayName: typeof result.displayName === 'string' ? result.displayName : null, status: 'SENT', sentAt: new Date() },
        update: { status: 'SENT', accountId: run.task.accountId, taskId: run.taskId, displayName: typeof result.displayName === 'string' ? result.displayName : undefined, sentAt: new Date() },
      });
    }
  }

  private async createScanCommentsCampaign(organizationId: string, input: ScanFacebookPostCommentsInput, accountIds: string[]) {
    const postUrls = [...new Set([...(input.postUrls ?? []), ...(input.postUrl ? [input.postUrl] : [])])];
    if (!postUrls.length) throw new BadRequestException('Nhập ít nhất một URL bài viết Facebook');
    // Keep the campaign bounded even when all READY profiles are selected.
    if (postUrls.length * accountIds.length > 500) {
      throw new BadRequestException('Một chiến dịch tối đa 500 cặp account/bài viết. Hãy giảm số bài viết hoặc số profile.');
    }
    try {
      return await this.prisma.facebookCampaign.create({
        data: {
          organizationId, idempotencyKey: input.idempotencyKey, name: input.name, kind: 'SCAN_COMMENTS',
          // Store both forms so old clients can still display the first URL,
          // while the full list remains available after the campaign finishes.
          payload: { postUrl: postUrls[0], postUrls, intervalSeconds: input.intervalSeconds },
          tasks: { create: accountIds.flatMap(accountId => postUrls.map(postUrl => {
            const id = randomUUID();
            return {
              id, organizationId, accountId, idempotencyKey: `facebook:${id}`, workflowId: `task/${id}`,
              platform: 'FACEBOOK', action: 'SCAN_FACEBOOK_POST_COMMENTS', payload: { postUrl },
              maxAttempts: 1, status: 'DRAFT', approvalStatus: 'PENDING',
            };
          })) },
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

  private async createReplyCommentsCampaign(organizationId: string, input: ReplyFacebookPostCommentsInput, accountIds: string[]) {
    const allocations = distributeReplyCounts(accountIds, input.maxReplies);
    const taskAccounts = accountIds.filter(accountId => (allocations.get(accountId) ?? 0) > 0);
    try {
      return await this.prisma.facebookCampaign.create({
        data: {
          organizationId, idempotencyKey: input.idempotencyKey, name: input.name, kind: 'REPLY_COMMENTS',
          payload: { postUrl: input.postUrl, text: input.text, mediaAssetIds: input.mediaAssetIds, maxReplies: input.maxReplies, intervalSeconds: input.intervalSeconds },
          tasks: { create: taskAccounts.map(accountId => {
            const id = randomUUID();
            return {
              id, organizationId, accountId, idempotencyKey: `facebook:${id}`, workflowId: `task/${id}`,
              platform: 'FACEBOOK', action: 'REPLY_FACEBOOK_POST_COMMENTS', payload: { postUrl: input.postUrl, text: input.text, mediaAssetIds: input.mediaAssetIds, maxReplies: allocations.get(accountId) },
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

  private async createCommentGroupPostsCampaign(organizationId: string, input: CommentFacebookGroupPostsInput, targets: Array<{ accountId: string; groupUrl: string }>) {
    if (targets.length > 500) throw new BadRequestException('Một chiến dịch tối đa 500 cặp profile/nhóm.');
    try {
      return await this.prisma.facebookCampaign.create({
        data: {
          organizationId, idempotencyKey: input.idempotencyKey, name: input.name, kind: 'COMMENT_GROUP_POSTS',
          payload: {
            groupUrls: input.groupUrls, text: input.text, mediaAssetIds: input.mediaAssetIds,
            daysRecent: input.daysRecent, minReactions: input.minReactions, maxReactions: input.maxReactions,
            minComments: input.minComments, maxComments: input.maxComments, maxPosts: input.maxPosts,
            intervalSeconds: input.intervalSeconds,
          },
          tasks: { create: targets.map(target => {
            const id = randomUUID();
            return {
              id, organizationId, accountId: target.accountId, idempotencyKey: `facebook:${id}`, workflowId: `task/${id}`,
              platform: 'FACEBOOK', action: 'COMMENT_FACEBOOK_GROUP_POSTS',
              payload: {
                groupUrl: target.groupUrl, text: input.text, mediaAssetIds: input.mediaAssetIds,
                daysRecent: input.daysRecent, minReactions: input.minReactions, maxReactions: input.maxReactions,
                minComments: input.minComments, maxComments: input.maxComments, maxPosts: input.maxPosts,
              },
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

export function distributeMessageTargets(groupUrls: string[], memberships: PostTarget[], maxRecipientsPerGroup: number): MessageTarget[] {
  const eligibleByGroup = new Map<string, string[]>();
  for (const membership of memberships) eligibleByGroup.set(membership.groupUrl, [...(eligibleByGroup.get(membership.groupUrl) ?? []), membership.accountId]);
  const targets: MessageTarget[] = [];
  for (const groupUrl of groupUrls) {
    const eligible = eligibleByGroup.get(groupUrl) ?? [];
    for (let index = 0; index < maxRecipientsPerGroup && eligible.length; index += 1) {
      targets.push({ accountId: eligible[index % eligible.length]!, groupUrl });
    }
  }
  if (targets.length > 200) throw new BadRequestException('Một chiến dịch nhắn tin tối đa 200 lượt. Hãy giảm số nhóm hoặc giới hạn mỗi nhóm.');
  return targets;
}

export function distributeReplyCounts(accountIds: string[], maxReplies: number): Map<string, number> {
  const counts = new Map<string, number>();
  const ids = [...new Set(accountIds)];
  if (!ids.length) return counts;
  for (let index = 0; index < maxReplies; index += 1) {
    const accountId = ids[index % ids.length]!;
    counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
  }
  return counts;
}

function normalizeMessageScopeUrl(value: string): string {
  try { return normalizeFacebookGroupUrl(value); }
  catch { return normalizeFacebookPostUrl(value); }
}
