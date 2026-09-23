import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const settings = Object.fromEntries((await readFile(new URL('../.env', import.meta.url), 'utf8')).split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, '')]; }));
process.env.DATABASE_URL = settings.DATABASE_URL;
const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const api = 'http://localhost:3001/api'; const web = 'http://localhost:3000';
const loginResponse = await fetch(`${api}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@socio.local', password: settings.BOOTSTRAP_ADMIN_PASSWORD }) });
assert.equal(loginResponse.status, 201);
const login = await loginResponse.json();
const headers = { authorization: `Bearer ${login.accessToken}` };
const principal = await (await fetch(`${api}/auth/me`, { headers })).json();
const accountIds = [randomUUID(), randomUUID()]; const campaignIds = []; const fixtureWorkerId = randomUUID();
async function call(path, body, expected = 201) {
  const response = await fetch(`${web}/api/facebook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: web, cookie: `socio_access=${login.accessToken}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
}
try {
  assert.equal((await fetch(`${api}/facebook/groups`)).status, 401);
  // Verify the real Next allowlist, authentication, and backend route mapping.
  // Use a nonexistent campaign so these requests can never start a workflow.
  const missingCampaignId = randomUUID();
  for (const action of ['approve', 'cancel', 'pause', 'resume', 'retry']) {
    const result = await call(`campaigns/${missingCampaignId}/${action}`, action === 'retry' ? { taskIds: [randomUUID()] } : {}, 404);
    assert.equal(result.message, 'Campaign not found', `${action} must reach the backend, not fail at the Next allowlist`);
  }
  for (const id of accountIds) {
    await prisma.platformAccount.create({ data: { id, organizationId: principal.organizationId, platform: 'FACEBOOK', status: 'READY', username: 'Facebook smoke fixture (temporary)', browserProfile: { create: { organizationId: principal.organizationId, storageUri: `file:///fixture/${id}`, status: 'AVAILABLE' } } } });
    await prisma.facebookGroupMembership.createMany({ data: [1, 2, 3].map((number) => ({ organizationId: principal.organizationId, accountId: id, groupUrl: `https://www.facebook.com/groups/${number}/`, groupName: `Smoke fixture ${number}`, status: 'JOINED' })) });
  }
  const common = { name: 'Temporary Facebook smoke draft', accountIds, intervalSeconds: 60 };
  await call('groups/join', { ...common, idempotencyKey: randomUUID(), groupUrls: ['https://evil.test/groups/1/'] }, 400);
  await call('groups/join', { ...common, accountIds: [randomUUID()], idempotencyKey: randomUUID(), groupUrls: ['https://www.facebook.com/groups/1/'] }, 400);
  const joinInput = { ...common, idempotencyKey: randomUUID(), groupUrls: ['https://m.facebook.com/groups/1/?ref=x', 'https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/2/'] };
  const joined = await call('groups/join', joinInput); campaignIds.push(joined.id);
  assert.equal(joined.tasks.length, 4); assert.ok(joined.tasks.every((job) => job.status === 'DRAFT' && job.approvalStatus === 'PENDING' && job.maxAttempts === 1));
  assert.equal((await call('groups/join', joinInput)).id, joined.id);
  const limited = await call('groups/post', { ...common, idempotencyKey: randomUUID(), text: 'Fixture never published', selection: 'ALL', maxGroupsPerAccount: 2 }); campaignIds.push(limited.id);
  assert.equal(limited.tasks.length, 3);
  const all = await call('groups/post', { ...common, accountIds: [accountIds[0]], idempotencyKey: randomUUID(), text: 'Fixture all never published', selection: 'ALL', maxGroupsPerAccount: 5 }); campaignIds.push(all.id);
  assert.equal(all.tasks.length, 3);
  await prisma.facebookGroupMembership.createMany({ data: [
    { organizationId: principal.organizationId, accountId: accountIds[0], groupUrl: 'https://www.facebook.com/groups/9001/', status: 'JOINED' },
    { organizationId: principal.organizationId, accountId: accountIds[1], groupUrl: 'https://www.facebook.com/groups/9002/', status: 'JOINED' },
    { organizationId: principal.organizationId, accountId: accountIds[0], groupUrl: 'https://www.facebook.com/groups/9003/', status: 'PENDING' },
  ] });
  await call('groups/post', { ...common, idempotencyKey: randomUUID(), text: 'Fixture custom never published', selection: 'CUSTOM', maxGroupsPerAccount: 5 }, 400);
  await call('groups/post', { ...common, idempotencyKey: randomUUID(), text: 'Fixture custom never published', selection: 'CUSTOM', maxGroupsPerAccount: 5, groupUrls: ['https://evil.test/groups/1/'] }, 400);
  for (const url of ['https://www.facebook.com/groups/9004/']) {
    await call('groups/post', { ...common, idempotencyKey: randomUUID(), text: 'Fixture never published', selection: 'CUSTOM', maxGroupsPerAccount: 5, groupUrls: [url] }, 400);
  }
  const pendingGroupDraft = await call('groups/post', { ...common, idempotencyKey: randomUUID(), text: 'Pending group fixture never published', selection: 'CUSTOM', maxGroupsPerAccount: 5, groupUrls: ['https://www.facebook.com/groups/9003/'] });
  campaignIds.push(pendingGroupDraft.id);
  assert.equal(pendingGroupDraft.tasks.length, 1);
  assert.equal(pendingGroupDraft.tasks[0].accountId, accountIds[0]);
  await call('groups/post', { ...common, accountIds: [accountIds[0]], idempotencyKey: randomUUID(), text: 'Fixture never published', selection: 'CUSTOM', maxGroupsPerAccount: 5, groupUrls: ['https://www.facebook.com/groups/9002/'] }, 400);
  const custom = await call('groups/post', { ...common, idempotencyKey: randomUUID(), text: 'Fixture explicit never published', selection: 'CUSTOM', maxGroupsPerAccount: 5, groupUrls: [
    'https://m.facebook.com/groups/9001/?ref=fixture', 'https://www.facebook.com/groups/9001/', 'https://facebook.com/groups/9002/', 'https://www.facebook.com/groups/1/',
  ] }); campaignIds.push(custom.id);
  assert.equal(custom.tasks.length, 3, 'Each selected group must be assigned to exactly one eligible profile');
  assert.equal(custom.payload.selection, 'CUSTOM');
  assert.deepEqual(custom.payload.groupUrls, ['https://www.facebook.com/groups/9001/', 'https://www.facebook.com/groups/9002/', 'https://www.facebook.com/groups/1/']);
  assert.deepEqual(custom.tasks.filter(job => job.accountId === accountIds[0]).map(job => job.payload.groupUrl).sort(), ['https://www.facebook.com/groups/1/', 'https://www.facebook.com/groups/9001/']);
  assert.deepEqual(custom.tasks.filter(job => job.accountId === accountIds[1]).map(job => job.payload.groupUrl), ['https://www.facebook.com/groups/9002/']);
  assert.ok(custom.tasks.every(job => job.action === 'POST_FACEBOOK_GROUP' && job.status === 'DRAFT' && job.approvalStatus === 'PENDING'));
  const taskResponse = await fetch(`${api}/tasks/${joined.tasks[0].id}/approve`, { method: 'POST', headers }); assert.equal(taskResponse.status, 400);
  for (const campaignId of campaignIds) await call(`campaigns/${campaignId}/cancel`, {});
  assert.equal(await prisma.taskRun.count({ where: { task: { accountId: { in: accountIds } } } }), 0);
  assert.equal(await prisma.task.count({ where: { accountId: { in: accountIds }, status: { not: 'CANCELLED' } } }), 0);
  const profile = await prisma.browserProfile.findUniqueOrThrow({ where: { accountId: accountIds[0] } });
  await prisma.workerNode.create({ data: { id: fixtureWorkerId, name: `fixture-${fixtureWorkerId}`, hostname: 'fixture', capacity: 1 } });
  const browserSession = await prisma.browserSession.create({ data: { profileId: profile.id, workerId: fixtureWorkerId, status: 'RUNNING', mode: 'LOGIN', expiresAt: new Date(Date.now() + 60000) } });
  for (const force of [false, true]) {
    const response = await fetch(`${web}/api/login-sessions/${browserSession.id}${force ? '?force=true' : ''}`, { method: 'DELETE', headers: { origin: web, cookie: `socio_access=${login.accessToken}` } });
    assert.equal(response.status, 200, await response.text());
    const state = await prisma.browserSession.findUniqueOrThrow({ where: { id: browserSession.id } });
    assert.equal(state.status, 'CLOSING');
    assert.equal(!!state.forceCloseRequestedAt, force, 'Next must forward the force-close flag');
  }
  console.log('PASS: actual local API + BFF + PostgreSQL: ALL/CUSTOM source, round-robin per-account cap, pending status does not block posting drafts, unknown/other-profile groups rejected, auth/approval/cancellation. No tasks executed.');
} finally {
  await prisma.$transaction(async (tx) => {
    await tx.browserSession.deleteMany({ where: { profile: { accountId: { in: accountIds }, organizationId: principal.organizationId } } });
    await tx.workerNode.deleteMany({ where: { id: fixtureWorkerId } });
    await tx.task.deleteMany({ where: { accountId: { in: accountIds }, organizationId: principal.organizationId } });
    await tx.facebookCampaign.deleteMany({ where: { id: { in: campaignIds }, organizationId: principal.organizationId } });
    await tx.platformAccount.deleteMany({ where: { id: { in: accountIds }, organizationId: principal.organizationId } });
  });
  await prisma.$disconnect();
  await fetch(`${api}/auth/logout`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: login.refreshToken }) });
  console.log('Temporary fixture accounts/groups/tasks/campaigns cleaned up; existing workspace data preserved.');
}
