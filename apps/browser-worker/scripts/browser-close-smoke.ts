import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@socio/database';
import { BrowserRuntime, withDeadline } from '@socio/browser-runtime';
import { BrowserControlService } from '../src/runtime/browser-control.service';

async function main() {
  const env = readFileSync(resolve('../../.env'), 'utf8');
  process.env.DATABASE_URL = env.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
  const prisma = new PrismaClient();
  const root = await mkdtemp(join(tmpdir(), 'socio-close-control-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 12), 200);
  const org = randomUUID(), workerId = randomUUID(), profileId = randomUUID();
  const control = new BrowserControlService(prisma as never, { workerId } as never, runtime);
  try {
    await prisma.organization.create({ data: { id: org, name: 'Temporary browser close fixture', slug: `close-${org}` } });
    await prisma.workerNode.create({ data: { id: workerId, name: `fixture-${workerId}`, hostname: 'fixture', capacity: 1, status: 'READY' } });
    await prisma.platformAccount.create({ data: { organizationId: org, platform: 'FACEBOOK', browserProfile: { create: { id: profileId, organizationId: org, storageUri: 'fixture://never-facebook' } } } });
    await control.start();
    for (const force of [false, true]) {
      const row = await prisma.browserSession.create({ data: { profileId, workerId, mode: 'AUTOMATION', status: 'STARTING', expiresAt: new Date(Date.now() + 60_000) } });
      const browser = await runtime.openProfile({ profileId, ownerId: row.id });
      await browser.page.goto('data:text/html,<title>close fixture</title>');
      await prisma.browserSession.update({ where: { id: row.id }, data: { status: 'RUNNING', processId: browser.processId } });
      browser.context.cookies = () => new Promise(() => {});
      await prisma.browserSession.update({ where: { id: row.id }, data: { status: 'CLOSING', forceCloseRequestedAt: force ? new Date() : null } });
      await withDeadline((async () => { while (runtime.activeSessionCount) await new Promise(resolve => setTimeout(resolve, 100)); })(), 15_000, 'Watchdog failed to close hung browser');
      assert.throws(() => process.kill(browser.processId!, 0));
      await prisma.browserSession.update({ where: { id: row.id }, data: { status: 'CLOSED', closedAt: new Date() } });
    }
    const newer = await runtime.openProfile({ profileId, ownerId: 'new-session' });
    await runtime.forceCloseProfile(profileId, 'old-session');
    assert.equal(newer.page.isClosed(), false, 'An old close request cannot kill a new browser');
    await newer.close();
    await control.onModuleDestroy();
    const stale = await prisma.browserSession.create({ data: { profileId, workerId, mode: 'LOGIN', status: 'RUNNING', expiresAt: new Date(Date.now() + 60000) } });
    const orphan = await runtime.openProfile({ profileId, ownerId: stale.id });
    await prisma.browserSession.update({ where: { id: stale.id }, data: { processId: orphan.processId } });
    const restarted = new BrowserRuntime(root, 1, Buffer.alloc(32, 12));
    const recovery = new BrowserControlService(prisma as never, { workerId } as never, restarted);
    try {
      await recovery.start();
      assert.equal((await prisma.browserSession.findUniqueOrThrow({ where: { id: stale.id } })).status, 'CRASHED');
      assert.throws(() => process.kill(orphan.processId!, 0));
    } finally { await recovery.onModuleDestroy(); }
    console.log('PASS: real PostgreSQL request polling closes hung Chromium, graceful timeout escalates, explicit force kills exact PID, profile reopens, stale session request leaves new browser alive. No Facebook requests.');
  } finally {
    await control.onModuleDestroy();
    await prisma.browserSession.deleteMany({ where: { workerId } });
    await prisma.platformAccount.deleteMany({ where: { organizationId: org } });
    await prisma.workerNode.deleteMany({ where: { id: workerId } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
