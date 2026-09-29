import assert from 'node:assert/strict';
import test from 'node:test';
import { distributeMessageTargets, distributePostTargets, distributeReplyCounts, FacebookService, retrySafety } from './facebook.service';

const account = (id: string) => ({ id, username: id, browserProfile: { sessions: [] }, proxyBinding: null });

test('sync creates an approval-controlled Facebook campaign for all or selected profiles', async () => {
  const ids = [1, 2].map(i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  let created: any;
  const prisma = { platformAccount: { findMany: async (query: any) => {
    assert.equal(query.where.organizationId, 'org'); assert.equal(query.where.platform, 'FACEBOOK'); assert.equal(query.where.status, 'READY');
    return ids.filter(id => !query.where.id || query.where.id.in.includes(id)).map(account);
  } }, facebookCampaign: {
    findUnique: async () => null,
    create: async (input: any) => { created = input.data; return { id: 'campaign', ...input.data }; },
  } };
  const service = new FacebookService(prisma as never, {} as never, {} as never);
  const all = await service.sync('org', { scope: 'ALL', accountIds: [], idempotencyKey: 'sync-all-key' });
  assert.equal(all.kind, 'SYNC'); assert.equal(created.name, 'Đồng bộ tất cả nhóm Facebook');
  assert.deepEqual(created.tasks.create.map((task: any) => task.accountId), ids);
  assert.ok(created.tasks.create.every((task: any) => task.action === 'SYNC_FACEBOOK_GROUPS' && task.status === 'DRAFT' && task.approvalStatus === 'PENDING'));
  const selected = await service.sync('org', { scope: 'SELECTED', accountIds: [ids[1]!], idempotencyKey: 'sync-selected-key' });
  assert.equal(selected.kind, 'SYNC'); assert.deepEqual(created.tasks.create.map((task: any) => task.accountId), [ids[1]]);
  await assert.rejects(service.sync('org', { scope: 'SELECTED', accountIds: [], idempotencyKey: 'invalid-sync-key' }), /Chọn ít nhất một/);
});
function setup(ids = ['a', 'b']) {
  let data: any;
  let campaign: any;
  const starts: any[] = [];
  const createCampaign = async (input: any) => {
    data = input.data;
    campaign = {
      ...data,
      id: 'campaign',
      approvedAt: data.approvedAt ?? null,
      pausedAt: null,
      cancelledAt: null,
      tasks: data.tasks.create.map((task: any) => ({ ...task, account: account(task.accountId), runs: [] })),
    };
    return campaign;
  };
  const prisma: any = {
    platformAccount: { findMany: async (input: any) => { assert.equal(input.where.organizationId, 'org'); assert.equal(input.where.platform, 'FACEBOOK'); const selected = input.where.id?.in ? ids.filter(id => input.where.id.in.includes(id)) : ids; return selected.map(account); } },
    facebookGroupMembership: { findMany: async (input: any) => {
      assert.equal(input.where.organizationId, 'org');
      const selectedIds = input.where.accountId?.in ?? [input.where.accountId];
      const urls = input.where.groupUrl?.in ?? ['1', '2', '3'].map(id => `https://www.facebook.com/groups/${id}/`);
      return selectedIds.flatMap((accountId: string) => urls.map((groupUrl: string) => ({ accountId, groupUrl })));
    } },
    facebookCampaign: { findUnique: async () => null, findFirst: async () => campaign, create: createCampaign, findUniqueOrThrow: async () => campaign },
    facebookGroupCollection: { findMany: async () => [] },
    facebookOptInRecipient: { findMany: async () => [] },
    task: { findMany: async () => [], count: async () => 0, updateMany: async () => ({ count: 1 }) },
  };
  prisma.$transaction = async (callback: (tx: any) => unknown) => callback({
    $executeRaw: async () => 0,
    platformAccount: prisma.platformAccount,
    facebookCampaign: { create: createCampaign, updateMany: async () => ({ count: 1 }) },
    task: { count: async () => 0, updateMany: async () => ({ count: 1 }) },
  });
  const temporal = { startTask: async (...args: any[]) => { starts.push(args); } };
  return { service: new FacebookService(prisma as never, {} as never, temporal as never), prisma, starts, data: () => data };
}
test('join snapshots every account/link pair as un-dispatched draft with no retries', async () => {
  const context = setup();
  await context.service.join('org', { name: 'Join', idempotencyKey: 'test-key', accountIds: [], groupUrls: ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'], intervalSeconds: 60 });
  const jobs = context.data().tasks.create;
  assert.equal(jobs.length, 4);
  for (const job of jobs) { assert.equal(job.status, 'DRAFT'); assert.equal(job.approvalStatus, 'PENDING'); assert.equal(job.maxAttempts, 1); }
  assert.equal(context.starts.length, 0);
});

test('photo campaign validates workspace ownership and freezes images in every task', async () => {
  const context = setup();
  const mediaAssetIds = ['00000000-0000-4000-8000-000000000001'];
  const prisma = context.prisma as any;
  prisma.mediaAsset = { count: async (input: any) => {
    assert.equal(input.where.organizationId, 'org');
    assert.equal(input.where.status, 'READY');
    assert.deepEqual(input.where.id.in, mediaAssetIds);
    assert.deepEqual(input.where.contentType.in, ['image/jpeg', 'image/png', 'image/webp']);
    assert.equal(input.where.sizeBytes.lte, 10 * 1024 * 1024);
    return 1;
  } };
  const input = { name: 'Images', idempotencyKey: 'photo-key', accountIds: [], selection: 'ALL' as const, maxGroupsPerAccount: 2, text: '', mediaAssetIds, intervalSeconds: 60 };
  await context.service.post('org', input);
  assert.deepEqual(context.data().payload.mediaAssetIds, mediaAssetIds);
  for (const task of context.data().tasks.create) {
    assert.deepEqual(task.payload.mediaAssetIds, mediaAssetIds);
    assert.equal(task.status, 'SCHEDULED');
    assert.equal(task.approvalStatus, 'APPROVED');
  }
  assert.ok(context.data().approvedAt);
  prisma.mediaAsset.count = async () => 0;
  await assert.rejects(context.service.post('org', input), /Ảnh phải thuộc workspace/);
});
test('post distributes unique groups round-robin with an independent per-account maximum', async () => {
  const context = setup();
  await context.service.post('org', { name: 'Post', idempotencyKey: 'test-key', accountIds: [], selection: 'ALL', maxGroupsPerAccount: 2, text: 'Frozen post', intervalSeconds: 60 });
  const jobs = context.data().tasks.create;
  assert.deepEqual(jobs.map((job: any) => [job.accountId, job.payload.groupUrl]), [
    ['a', 'https://www.facebook.com/groups/1/'],
    ['b', 'https://www.facebook.com/groups/2/'],
    ['a', 'https://www.facebook.com/groups/3/'],
  ]);
  assert.ok(jobs.every((job: any) => job.payload.text === 'Frozen post' && job.status === 'SCHEDULED' && job.approvalStatus === 'APPROVED')); assert.equal(context.starts.length, 3);
  assert.equal(context.data().payload.maxGroupsPerAccount, 2);
});
test('post ALL includes all joined groups for selected account', async () => {
  const context = setup(['a']);
  await context.service.post('org', { name: 'Post', idempotencyKey: 'test-key', accountIds: ['a'], selection: 'ALL', maxGroupsPerAccount: 5, text: 'Post', intervalSeconds: 60 });
  assert.equal(context.data().tasks.create.length, 3);
  assert.equal(context.starts.length, 3);
});

test('post CUSTOM uses inventory mapping without imposing a membership-status gate', async () => {
  const context = setup(['a', 'b', 'c']);
  const urls = ['https://www.facebook.com/groups/a-only/', 'https://www.facebook.com/groups/b-only/', 'https://www.facebook.com/groups/shared/'];
  context.prisma.facebookGroupMembership.findMany = async (input: any) => {
    assert.equal(input.where.organizationId, 'org'); assert.equal(input.where.status, undefined);
    assert.deepEqual(input.where.accountId.in, ['a', 'b', 'c']);
    assert.deepEqual(input.where.groupUrl.in, urls);
    return [{ accountId: 'a', groupUrl: urls[0]! }, { accountId: 'a', groupUrl: urls[2]! },
      { accountId: 'b', groupUrl: urls[1]! }, { accountId: 'b', groupUrl: urls[2]! }];
  };
  await context.service.post('org', { name: 'Custom', idempotencyKey: 'custom-key', accountIds: ['a', 'b', 'c'], selection: 'CUSTOM', groupUrls: [...urls, urls[0]!], maxGroupsPerAccount: 2, text: 'Explicit post', intervalSeconds: 60 });
  const jobs = context.data().tasks.create;
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.filter((job: any) => job.accountId === 'a').map((job: any) => job.payload.groupUrl), [urls[0], urls[2]]);
  assert.deepEqual(jobs.filter((job: any) => job.accountId === 'b').map((job: any) => job.payload.groupUrl), [urls[1]]);
  assert.equal(jobs.filter((job: any) => job.accountId === 'c').length, 0);
  assert.ok(jobs.every((job: any) => job.status === 'SCHEDULED' && job.approvalStatus === 'APPROVED' && job.action === 'POST_FACEBOOK_GROUP' && job.payload.text === 'Explicit post'));
  assert.deepEqual(context.data().payload.groupUrls, urls);
  assert.equal(context.data().payload.selection, 'CUSTOM');
  assert.equal(context.starts.length, 3);
});
test('CUSTOM rejects missing groups and insufficient per-account capacity before writes', async () => {
  const context = setup();
  const base = { name: 'Custom', idempotencyKey: 'custom-key', accountIds: [], selection: 'CUSTOM' as const, maxGroupsPerAccount: 2, text: 'Post', intervalSeconds: 60 };
  await assert.rejects(context.service.post('org', base), /ít nhất một nhóm/);
  const big = setup(['a', 'b']);
  await assert.rejects(big.service.post('org', { ...base, groupUrls: Array.from({ length: 5 }, (_, i) => `https://www.facebook.com/groups/${i}/`) }), /Không thể phân phối đủ 5 nhóm/);
  assert.equal(context.data(), undefined);
  assert.equal(big.data(), undefined);
});
test('CUSTOM rejects groups absent from selected profiles inventory without writes', async () => {
  const context = setup(['a']);
  context.prisma.facebookGroupMembership.findMany = async () => [];
  await assert.rejects(context.service.post('org', { name: 'Custom', idempotencyKey: 'custom-key', accountIds: ['a'], selection: 'CUSTOM', groupUrls: ['https://www.facebook.com/groups/not-joined/'], maxGroupsPerAccount: 2, text: 'Post', intervalSeconds: 60 }), /không có trong danh sách/);
  assert.equal(context.data(), undefined);
});

test('COLLECTIONS unions overlapping collections, snapshots them and distributes each group once', async () => {
  const context = setup(['a', 'b']);
  const firstId = '00000000-0000-4000-8000-000000000011';
  const secondId = '00000000-0000-4000-8000-000000000012';
  const one = 'https://www.facebook.com/groups/one/';
  const shared = 'https://www.facebook.com/groups/shared/';
  const two = 'https://www.facebook.com/groups/two/';
  context.prisma.facebookGroupCollection.findMany = async (input: any) => {
    assert.equal(input.where.organizationId, 'org');
    assert.deepEqual(input.where.id.in, [firstId, secondId]);
    return [
      { id: secondId, name: 'Quần áo', items: [{ groupUrl: shared }, { groupUrl: two }] },
      { id: firstId, name: 'Hải sản', items: [{ groupUrl: one }, { groupUrl: shared }] },
    ];
  };
  await context.service.post('org', { name: 'Theo ngành', idempotencyKey: 'collections-key', accountIds: [], selection: 'COLLECTIONS', collectionIds: [firstId, secondId, firstId], maxGroupsPerAccount: 2, text: 'Bài theo tập hợp', intervalSeconds: 60 });
  assert.deepEqual(context.data().payload.groupUrls, [one, shared, two]);
  assert.deepEqual(context.data().payload.collectionIds, [firstId, secondId]);
  assert.deepEqual(context.data().payload.collectionNames, ['Hải sản', 'Quần áo']);
  assert.equal(context.data().tasks.create.length, 3);
  assert.equal(context.starts.length, 3);
});

test('COLLECTIONS rejects missing or inaccessible collections before campaign creation', async () => {
  const context = setup(['a']);
  const collectionId = '00000000-0000-4000-8000-000000000011';
  await assert.rejects(context.service.post('org', { name: 'Missing', idempotencyKey: 'collections-key', accountIds: [], selection: 'COLLECTIONS', collectionIds: [collectionId], maxGroupsPerAccount: 2, text: 'Post', intervalSeconds: 60 }), /không còn tồn tại/);
  assert.equal(context.data(), undefined);
});

test('group collection CRUD is workspace-scoped and only accepts synchronized group URLs', async () => {
  const url = 'https://www.facebook.com/groups/seafood/';
  let createdData: any;
  const tx: any = {
    facebookGroupCollection: {
      update: async (input: any) => input,
      findUniqueOrThrow: async () => ({ id: 'collection', name: 'Hải sản mới', items: [{ groupUrl: url }] }),
    },
    facebookGroupCollectionItem: { deleteMany: async () => ({ count: 1 }), createMany: async () => ({ count: 1 }) },
  };
  const prisma: any = {
    facebookGroupMembership: { findMany: async (input: any) => input.where.organizationId === 'org' ? [{ groupUrl: url }] : [] },
    facebookGroupCollection: {
      create: async (input: any) => { createdData = input.data; return { id: 'collection', ...input.data, items: [{ groupUrl: url }] }; },
      findFirst: async (input: any) => input.where.organizationId === 'org' ? { id: input.where.id } : null,
      deleteMany: async (input: any) => ({ count: input.where.organizationId === 'org' ? 1 : 0 }),
    },
    $transaction: async (callback: any) => callback(tx),
  };
  const service = new FacebookService(prisma, {} as never, {} as never);
  await service.createGroupCollection('org', { name: 'Hải sản', description: '', groupUrls: [url] });
  assert.equal(createdData.organizationId, 'org');
  assert.deepEqual(createdData.items.create, [{ groupUrl: url }]);
  assert.equal((await service.updateGroupCollection('org', 'collection', { name: 'Hải sản mới', description: 'Mô tả', groupUrls: [url] })).name, 'Hải sản mới');
  assert.deepEqual(await service.deleteGroupCollection('org', 'collection'), { deleted: true });
  await assert.rejects(service.updateGroupCollection('other', 'collection', { name: 'Sai workspace', description: '', groupUrls: [url] }), /Không tìm thấy/);
  await assert.rejects(service.createGroupCollection('other', { name: 'Không hợp lệ', description: '', groupUrls: [url] }), /không còn trong danh sách/);
});

test('message campaign splits each group\'s requested attempts across its joined profiles', async () => {
  const context = setup(['a', 'b']);
  const groupOne = 'https://www.facebook.com/groups/one/';
  const groupTwo = 'https://www.facebook.com/groups/two/';
  await context.service.message('org', {
    name: 'Chăm sóc khách hàng', idempotencyKey: 'message-key', accountIds: [], text: 'Tin nhắn', mediaAssetIds: [],
    groupUrls: [groupOne, groupTwo], maxRecipientsPerGroup: 2, intervalSeconds: 120,
  });
  const tasks = context.data().tasks.create;
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map((task: any) => task.accountId), ['a', 'b', 'a', 'b']);
  assert.deepEqual(tasks.map((task: any) => task.payload.groupUrl), [groupOne, groupOne, groupTwo, groupTwo]);
  assert.ok(tasks.every((task: any) => !('profileUrl' in task.payload) && !('recipientId' in task.payload)));
  assert.ok(tasks.every((task: any) => task.action === 'MESSAGE_FACEBOOK_RECIPIENT' && task.status === 'DRAFT' && task.maxAttempts === 1));
  assert.equal(context.data().payload.maxRecipientsPerGroup, 2);
});

test('message target distribution splits ten attempts five-five between two joined profiles', () => {
  const groupUrl = 'https://www.facebook.com/groups/one/';
  const targets = distributeMessageTargets([groupUrl], [
    { accountId: 'a', groupUrl }, { accountId: 'b', groupUrl },
  ], 10);
  assert.equal(targets.length, 10);
  assert.equal(targets.filter(target => target.accountId === 'a').length, 5);
  assert.equal(targets.filter(target => target.accountId === 'b').length, 5);
});

test('message campaign uses every joined group when no group is selected', async () => {
  const context = setup(['a']);
  await context.service.message('org', {
    name: 'Tất cả nhóm', idempotencyKey: 'message-all-groups', accountIds: [], text: 'Tin nhắn', mediaAssetIds: [], maxRecipientsPerGroup: 1, intervalSeconds: 120,
  });
  const tasks = context.data().tasks.create;
  assert.deepEqual(tasks.map((task: any) => task.payload.groupUrl), [
    'https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/', 'https://www.facebook.com/groups/3/',
  ]);
  assert.deepEqual(context.data().payload.groupUrls, tasks.map((task: any) => task.payload.groupUrl));
});

test('comment scan campaign creates one approval task per selected READY profile', async () => {
  const context = setup(['a', 'b']);
  const campaign = await context.service.scanComments('org', {
    name: 'Quét bình luận', idempotencyKey: 'scan-comments-key', accountIds: [],
    postUrl: 'https://www.facebook.com/groups/123/posts/456', intervalSeconds: 60,
  });
  const tasks = context.data().tasks.create;
  assert.equal(campaign.kind, 'SCAN_COMMENTS');
  assert.equal(context.data().payload.postUrl, 'https://www.facebook.com/groups/123/posts/456');
  assert.deepEqual(tasks.map((task: any) => task.accountId), ['a', 'b']);
  assert.ok(tasks.every((task: any) => task.action === 'SCAN_FACEBOOK_POST_COMMENTS' && task.payload.postUrl === 'https://www.facebook.com/groups/123/posts/456' && task.status === 'DRAFT' && task.approvalStatus === 'PENDING' && task.maxAttempts === 1));
});

test('comment reply campaign splits the configured total evenly across profiles', async () => {
  const context = setup(['a', 'b']);
  const campaign = await context.service.replyComments('org', {
    name: 'Rep bình luận', idempotencyKey: 'reply-comments-key', accountIds: [],
    postUrl: 'https://www.facebook.com/groups/123/posts/456', text: 'Cảm ơn bạn', maxReplies: 10, intervalSeconds: 120,
  });
  const tasks = context.data().tasks.create;
  assert.equal(campaign.kind, 'REPLY_COMMENTS');
  assert.deepEqual(tasks.map((task: any) => task.payload.maxReplies), [5, 5]);
  assert.ok(tasks.every((task: any) => task.action === 'REPLY_FACEBOOK_POST_COMMENTS' && task.status === 'DRAFT' && task.approvalStatus === 'PENDING' && task.maxAttempts === 1));
  assert.deepEqual([...distributeReplyCounts(['a', 'b', 'c'], 5).entries()], [['a', 2], ['b', 2], ['c', 1]]);
});

test('opt-in recipient records are workspace scoped and revocation is retained', async () => {
  const groupUrl = 'https://www.facebook.com/groups/one/';
  const profileUrl = 'https://www.facebook.com/person.one/';
  let record: any;
  const prisma: any = {
    facebookGroupMembership: { findMany: async () => [{ groupUrl }] },
    facebookOptInRecipient: {
      create: async (input: any) => (record = { id: 'recipient', ...input.data }),
      updateMany: async (input: any) => input.where.organizationId === 'org' ? (Object.assign(record, input.data), { count: 1 }) : ({ count: 0 }),
      findFirstOrThrow: async () => record,
    },
  };
  const service = new FacebookService(prisma, {} as never, {} as never);
  const input = { groupUrl, profileUrl, displayName: 'Person', consentSource: 'Form', consentNote: '', consentRecordedAt: '2026-09-26T00:00:00.000Z' };
  await service.createOptInRecipient('org', input);
  assert.equal(record.organizationId, 'org'); assert.ok(record.consentRecordedAt instanceof Date);
  assert.deepEqual(await service.revokeOptInRecipient('org', 'recipient'), { revoked: true }); assert.ok(record.revokedAt instanceof Date);
  await assert.rejects(service.updateOptInRecipient('other', 'recipient', input), /Không tìm thấy/);
  await service.updateOptInRecipient('org', 'recipient', { ...input, consentSource: 'Đồng ý lại' }, true);
  assert.equal(record.revokedAt, null); assert.equal(record.consentSource, 'Đồng ý lại');
});

test('round-robin distribution is deterministic, balanced and respects group eligibility', () => {
  const accounts = ['a', 'b', 'c', 'd'];
  const groups = Array.from({ length: 10 }, (_, index) => `g${index + 1}`);
  const memberships = groups.flatMap(groupUrl => accounts.map(accountId => ({ accountId, groupUrl })));
  const first = distributePostTargets(accounts, groups, memberships, 3);
  const second = distributePostTargets(accounts, groups, memberships, 3);
  assert.deepEqual(first, second);
  assert.deepEqual(first.targets.map(target => target.accountId), ['a', 'b', 'c', 'd', 'a', 'b', 'c', 'd', 'a', 'b']);
  assert.deepEqual(Object.fromEntries(accounts.map(id => [id, first.targets.filter(target => target.accountId === id).length])), { a: 3, b: 3, c: 2, d: 2 });
  assert.deepEqual(first.unassigned, []);

  const constrained = distributePostTargets(['a', 'b'], ['shared', 'only-b'], [
    { accountId: 'b', groupUrl: 'only-b' }, { accountId: 'a', groupUrl: 'shared' }, { accountId: 'b', groupUrl: 'shared' },
  ], 1);
  assert.deepEqual(constrained.targets, [{ accountId: 'a', groupUrl: 'shared' }, { accountId: 'b', groupUrl: 'only-b' }]);
});
test('reject unavailable explicit accounts and oversized campaigns without writes', async () => {
  const context = setup(['a']);
  await assert.rejects(() => context.service.join('org', { name: 'Join', idempotencyKey: 'test-key', accountIds: ['a', 'missing'], groupUrls: ['https://www.facebook.com/groups/1/'], intervalSeconds: 60 }), /READY/);
  const big = setup(Array.from({ length: 6 }, (_, index) => `a${index}`));
  await assert.rejects(() => big.service.join('org', { name: 'Join', idempotencyKey: 'test-key', accountIds: [], groupUrls: Array.from({ length: 100 }, (_, index) => `https://www.facebook.com/groups/${index}/`), intervalSeconds: 60 }), /500/);
  assert.equal(big.data(), undefined);
});

test('approval schedules spacing independently for each account and dispatches only after transaction', async () => {
  const writes: any[] = []; const starts: any[] = []; let committed = false;
  const jobs = ['a', 'a', 'b', 'b'].map((accountId, index) => ({ id: `job${index}`, workflowId: `task/job${index}`, accountId, approvalStatus: 'PENDING' }));
  const campaign = { id: 'campaign', approvedAt: null, payload: { intervalSeconds: 60 }, tasks: jobs };
  const tx = { $executeRaw: async () => 0, platformAccount: { findMany: async () => ['a', 'b'].map(account) }, facebookCampaign: { updateMany: async () => ({ count: 1 }) }, task: { count: async () => 0, updateMany: async (input: any) => { writes.push(input); return { count: 1 }; } } };
  const prisma = {
    facebookCampaign: { findFirst: async (input: any) => { assert.equal(input.where.organizationId, 'org'); return campaign; }, findUniqueOrThrow: async () => campaign },
    task: { count: async () => 0 }, platformAccount: { findMany: async () => ['a', 'b'].map(account) },
    $transaction: async (callback: any) => { const value = await callback(tx); committed = true; return value; },
  };
  const service = new FacebookService(prisma as never, {} as never, { startTask: async (...args: any[]) => { assert.equal(committed, true); starts.push(args); } } as never);
  await service.approve('org', 'campaign', 'admin');
  assert.equal(starts.length, 4); assert.equal(writes[0].data.status, 'SCHEDULED'); assert.equal(writes[0].data.approvalStatus, 'APPROVED');
  assert.equal(starts[1][2].getTime() - starts[0][2].getTime(), 60000);
  assert.equal(starts[2][2].getTime(), starts[0][2].getTime());
  assert.equal(starts[3][2].getTime() - starts[2][2].getTime(), 60000);
});
test('cancel only touches not-started tasks in the workspace', async () => {
  let where: any;
  const prisma: any = { $executeRaw: async () => 0, facebookCampaign: { findFirst: async () => ({ id: 'campaign' }), update: async () => ({}) }, task: { updateMany: async (input: any) => { where = input.where; return { count: 2 }; } }, $transaction: async (callback: any) => callback(prisma) };
  const service = new FacebookService(prisma as never, {} as never, {} as never);
  assert.equal((await service.cancel('org', 'campaign')).cancelled, 2);
  assert.equal(where.organizationId, 'org'); assert.equal(where.campaignId, 'campaign'); assert.ok(!where.status.in.includes('RUNNING'));
});

function controls(statuses: string[]) {
  const jobs = statuses.map((status, index) => ({ id: `job-${index}`, organizationId: 'org', campaignId: 'campaign', accountId: 'a', workflowId: `old-${index}`, status, approvalStatus: 'APPROVED', attemptCount: status === 'REQUIRES_ACTION' ? 1 : 0, runs: [{ result: { sideEffectStarted: false } }] }));
  const campaign: any = { id: 'campaign', organizationId: 'org', approvedAt: new Date(), pausedAt: null, cancelledAt: null, payload: { intervalSeconds: 60 }, tasks: jobs };
  const starts: any[] = [], writes: any[] = [];
  const tx: any = {
    $executeRaw: async () => 0,
    facebookCampaign: { findFirst: async (input: any) => input.where.organizationId === 'org' && input.where.id === 'campaign' ? campaign : null, update: async (input: any) => Object.assign(campaign, input.data) },
    platformAccount: { findMany: async () => [account('a')] },
    task: {
      count: async () => jobs.filter(job => ['QUEUED', 'SCHEDULED', 'RUNNING'].includes(job.status)).length,
      updateMany: async (input: any) => { writes.push(input); const rows = jobs.filter(job => (!input.where.id || input.where.id === job.id) && (typeof input.where.status === 'string' ? input.where.status === job.status : input.where.status.in.includes(job.status))); rows.forEach(job => Object.assign(job, input.data)); return { count: rows.length }; },
    },
    $transaction: async (callback: any) => callback(tx),
  };
  return { service: new FacebookService(tx as never, {} as never, { startTask: async (...args: any[]) => starts.push(args) } as never), campaign, jobs, starts, writes, tx };
}

test('pause freezes pending work but does not interrupt a running Facebook write', async () => {
  const context = controls(['RUNNING', 'SCHEDULED', 'QUEUED', 'SUCCEEDED']);
  assert.equal((await context.service.pause('org', 'campaign')).paused, 2);
  assert.deepEqual(context.jobs.map(job => job.status), ['RUNNING', 'PAUSED', 'PAUSED', 'SUCCEEDED']);
  assert.ok(context.campaign.pausedAt);
  assert.equal(context.starts.length, 0);
  await assert.rejects(() => context.service.resume('org', 'campaign'), /đang chạy/);
});

test('resume dispatches only paused tasks with new workflow IDs and per-account spacing', async () => {
  const context = controls(['SCHEDULED', 'QUEUED', 'SUCCEEDED']);
  await context.service.pause('org', 'campaign');
  assert.equal((await context.service.resume('org', 'campaign')).resumed, 2);
  assert.equal(context.campaign.pausedAt, null);
  assert.equal(context.starts.length, 2);
  assert.notEqual(context.starts[0][1], 'old-0');
  assert.equal(context.starts[1][2].getTime() - context.starts[0][2].getTime(), 60000);
  assert.equal(context.jobs[2].status, 'SUCCEEDED');
  await assert.rejects(() => context.service.resume('org', 'campaign'), /tạm dừng/);
});

test('retry preserves success/history, resets only the selected stopped task and cannot be repeated', async () => {
  const context = controls(['REQUIRES_ACTION', 'SUCCEEDED']);
  const history = context.jobs[0].runs;
  assert.equal((await context.service.retry('org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: [] })).retried, 1);
  assert.equal(context.jobs[0].attemptCount, 0);
  assert.equal(context.jobs[0].status, 'SCHEDULED');
  assert.notEqual(context.jobs[0].workflowId, 'old-0');
  assert.equal(context.jobs[0].runs, history);
  assert.equal(context.jobs[1].status, 'SUCCEEDED');
  await assert.rejects(() => context.service.retry('org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: [] }), /Chỉ chạy lại/);
  assert.equal(context.starts.length, 1);
});

test('ambiguous Facebook send requires explicit confirmation and workspace ownership', async () => {
  const context = controls(['REQUIRES_ACTION']);
  context.jobs[0].runs[0].result.sideEffectStarted = true;
  await assert.rejects(() => context.service.retry('org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: [] }), /chưa rõ/);
  await assert.rejects(() => context.service.retry('other-org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: ['job-0'] }), /not found/);
  await assert.rejects(() => context.service.retry('org', 'campaign', { taskIds: ['other-task'], verifiedUnsentTaskIds: [] }), /không thuộc/);
  assert.equal(context.starts.length, 0);
  assert.equal((await context.service.retry('org', 'campaign', { taskIds: ['job-0'], verifiedUnsentTaskIds: ['job-0'] })).retried, 1);
});

test('cancel is permanent; includes paused/manual tasks and preserves running/completed work', async () => {
  const context = controls(['PAUSED', 'REQUIRES_ACTION', 'RUNNING', 'SUCCEEDED']);
  assert.equal((await context.service.cancel('org', 'campaign')).cancelled, 2);
  assert.ok(context.campaign.cancelledAt);
  assert.deepEqual(context.jobs.map(job => job.status), ['CANCELLED', 'CANCELLED', 'RUNNING', 'SUCCEEDED']);
  await assert.rejects(() => context.service.pause('org', 'campaign'), /chưa hủy/);
  await assert.rejects(() => context.service.retry('org', 'campaign', { taskIds: ['job-1'], verifiedUnsentTaskIds: [] }), /đã hủy/);
});

test('missing evidence and legacy login failure are not assumed safe to resend', () => {
  assert.equal(retrySafety({ status: 'REQUIRES_ACTION', attemptCount: 1, runs: [{ errorCode: 'LOGIN_REQUIRED' }] }), 'VERIFY');
  assert.equal(retrySafety({ status: 'REQUIRES_ACTION', attemptCount: 1, runs: [{ result: { sideEffectStarted: false } }] }), 'SAFE');
  assert.equal(retrySafety({ status: 'SUCCEEDED', attemptCount: 1, runs: [] }), 'BLOCKED');
});
