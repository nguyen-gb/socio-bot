import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@socio/database';
import { FacebookService } from '../src/facebook/facebook.service';

// Real PostgreSQL transactions; the Temporal dispatcher is intentionally stubbed.
const env = readFileSync(resolve('../../.env'), 'utf8');
process.env.DATABASE_URL = env.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
const prisma = new PrismaClient();
const org = randomUUID(), accountId = randomUUID(), starts: unknown[][] = [];
const service = new FacebookService(prisma as never, {} as never, { startTask: async (...args: unknown[]) => { starts.push(args); } } as never);

async function campaign(statuses: string[]) {
  return prisma.facebookCampaign.create({ data: {
    organizationId: org, name: 'Temporary controls fixture', kind: 'JOIN', idempotencyKey: randomUUID(), approvedAt: new Date(), payload: { intervalSeconds: 60 },
    tasks: { create: statuses.map((status, index) => ({
      organizationId: org, accountId, platform: 'FACEBOOK', action: 'JOIN_FACEBOOK_GROUP', payload: { groupUrl: `https://www.facebook.com/groups/fixture${index}/` },
      idempotencyKey: randomUUID(), workflowId: `fixture/${randomUUID()}`, status: status as never, approvalStatus: 'APPROVED', maxAttempts: 1,
      attemptCount: status === 'REQUIRES_ACTION' ? 1 : 0,
      ...(status === 'REQUIRES_ACTION' ? { runs: { create: { status: 'FAILED', finishedAt: new Date(), result: { sideEffectStarted: index === 2 } } } } : {}),
    })) },
  }, include: { tasks: { orderBy: { createdAt: 'asc' }, include: { runs: true } } } });
}

async function main() {
  await prisma.organization.create({ data: { id: org, name: 'Temporary campaign controls smoke', slug: `controls-${org}` } });
  await prisma.platformAccount.create({ data: { id: accountId, organizationId: org, platform: 'FACEBOOK', username: 'Controls fixture', status: 'READY', browserProfile: { create: { organizationId: org, storageUri: 'fixture://never-opened', status: 'AVAILABLE' } } } });
  const first = await campaign(['REQUIRES_ACTION', 'SUCCEEDED', 'REQUIRES_ACTION']);
  const [safe, success, uncertain] = first.tasks;
  await assert.rejects(() => service.retry(randomUUID(), first.id, { taskIds: [safe.id], verifiedUnsentTaskIds: [] }), /not found/);
  await assert.rejects(() => service.retry(org, first.id, { taskIds: [success.id], verifiedUnsentTaskIds: [] }), /Chỉ chạy lại/);
  await assert.rejects(() => service.retry(org, first.id, { taskIds: [uncertain.id], verifiedUnsentTaskIds: [] }), /chưa rõ/);
  const duplicate = await Promise.allSettled([1, 2].map(() => service.retry(org, first.id, { taskIds: [safe.id], verifiedUnsentTaskIds: [] })));
  assert.equal(duplicate.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(starts.length, 1);
  const retried = await prisma.task.findUniqueOrThrow({ where: { id: safe.id }, include: { runs: true } });
  assert.equal(retried.attemptCount, 0); assert.equal(retried.runs.length, 1); assert.notEqual(retried.workflowId, safe.workflowId);
  assert.equal((await service.pause(org, first.id)).paused, 1);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: safe.id } })).status, 'PAUSED');
  assert.equal((await service.resume(org, first.id)).resumed, 1);
  await prisma.task.update({ where: { id: safe.id }, data: { status: 'SUCCEEDED' } });
  assert.equal((await service.retry(org, first.id, { taskIds: [uncertain.id], verifiedUnsentTaskIds: [uncertain.id] })).retried, 1);
  await prisma.task.update({ where: { id: uncertain.id }, data: { status: 'SUCCEEDED' } });
  const [a, b] = await Promise.all([campaign(['REQUIRES_ACTION']), campaign(['REQUIRES_ACTION'])]);
  const conflict = await Promise.allSettled([a, b].map(item => service.retry(org, item.id, { taskIds: [item.tasks[0].id], verifiedUnsentTaskIds: [] })));
  assert.equal(conflict.filter(result => result.status === 'fulfilled').length, 1, 'Account lock must reject concurrent campaigns');
  await service.cancel(org, a.id); await service.cancel(org, b.id);
  const stopped = await campaign(['RUNNING', 'SCHEDULED', 'SUCCEEDED']);
  assert.equal((await service.pause(org, stopped.id)).paused, 1);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: stopped.tasks[0].id } })).status, 'RUNNING');
  await assert.rejects(() => service.resume(org, stopped.id), /đang chạy/);
  await service.cancel(org, stopped.id);
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: stopped.tasks[1].id } })).status, 'CANCELLED');
  assert.equal((await prisma.task.findUniqueOrThrow({ where: { id: success.id } })).status, 'SUCCEEDED');
  console.log('PASS: real PostgreSQL pause/resume/retry/cancel; history preservation; duplicate-click serialization; cross-campaign account locks; workspace scope; success preservation; uncertain-send confirmation. Temporal starts stubbed; no browser or Facebook actions.');
}

void (async () => {
try { await main(); }
finally {
  await prisma.$transaction(async tx => {
    await tx.task.deleteMany({ where: { organizationId: org } });
    await tx.facebookCampaign.deleteMany({ where: { organizationId: org } });
    await tx.platformAccount.deleteMany({ where: { organizationId: org } });
    await tx.organization.deleteMany({ where: { id: org } });
  });
  await prisma.$disconnect();
  console.log('Temporary fixture organization removed; existing workspace/profile/campaign data untouched.');
}
})().catch(error => { console.error(error); process.exitCode = 1; });
