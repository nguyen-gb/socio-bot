import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Context } from '@temporalio/activity';
import { PrismaClient } from '@socio/database';
import { BrowserRuntime } from '@socio/browser-runtime';
import { BrowserTaskActivities } from '../src/activities/browser-task.activities';
import { BrowserControlService } from '../src/runtime/browser-control.service';

async function main() {
  process.env.DATABASE_URL = readFileSync(resolve('../../.env'), 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
  const prisma = new PrismaClient(), originalContext = Context.current;
  const root = await mkdtemp(join(tmpdir(), 'socio-group-flow-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 5));
  const org = randomUUID(), workerId = randomUUID(), profileId = randomUUID(), accountId = randomUUID();
  const control = new BrowserControlService(prisma as never, { workerId } as never, runtime);
  try {
    await prisma.organization.create({ data: { id: org, name: 'Group flow fixture', slug: `fixture-${org}` } });
    await prisma.workerNode.create({ data: { id: workerId, name: `fixture-${workerId}`, hostname: 'fixture', capacity: 1, status: 'READY' } });
    await prisma.platformAccount.create({ data: { id: accountId, organizationId: org, platform: 'FACEBOOK', status: 'READY', browserProfile: { create: { id: profileId, organizationId: org, storageUri: 'fixture://no-snapshot' } } } });
    await control.start();
    for (const scenario of ['already-admin', 'delayed-success', 'navigation-failed', 'force-close', 'post-delivery-retry', 'post-public-response']) {
      const posting = scenario.startsWith('post-');
      const workflowId = `fixture/${randomUUID()}`;
      const task = await prisma.task.create({ data: { organizationId: org, accountId, platform: 'FACEBOOK', action: posting ? 'POST_FACEBOOK_GROUP' : 'JOIN_FACEBOOK_GROUP', payload: { groupUrl: 'https://www.facebook.com/groups/123456/', ...(posting ? { text: 'Fixture post' } : {}) }, idempotencyKey: randomUUID(), workflowId, status: 'QUEUED', approvalStatus: 'APPROVED', maxAttempts: 1 } });
      Context.current = () => ({ heartbeat: () => {}, info: { attempt: posting ? 2 : 1, workflowExecution: { workflowId } } }) as unknown as Context;
      const service = new BrowserTaskActivities(prisma as never,
        { withLease: async (_: string, callback: () => Promise<unknown>) => callback() } as never,
        { workerId } as never, { restore: async () => {}, capture: async () => {} } as never,
        { temporaryPath: async () => join(root, `${randomUUID()}.har`), captureScreenshot: async () => {}, captureFailure: async () => {}, captureTrace: async () => {}, captureConsoleLog: async () => {}, captureHar: async () => {} } as never,
        {} as never, { get: () => true } as never,
        { withProfile: (options: any, callback: any) => runtime.withProfile({ ...options, executionTimeoutMs: 30_000 }, async session => {
          await session.context.addCookies([{ name: 'c_user', value: 'fixture-only', domain: '.facebook.com', path: '/' }]);
          await session.context.route('**/*', async route => {
            if (new URL(route.request().url()).pathname === '/api/graphql/') {
              await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { story_create: { publishing_flow: 'FALLBACK', post_id: null, story: { url: 'https://www.facebook.com/groups/123456/permalink/789/', to: { id: '123456' }, if_viewer_can_learn_more_about_pending_post: null }, group_feed_story_edge: { node: { post_id: '789', comet_sections: { content: { story: { message: { text: 'Fixture post' } } } } } } } } }) });
              return;
            }
            const group = new URL(route.request().url()).pathname.includes('/groups/');
            if (group && scenario === 'navigation-failed') { await route.abort('timedout'); return; }
            if (group && scenario === 'force-close') {
              await prisma.browserSession.updateMany({ where: { profileId, status: 'RUNNING' }, data: { status: 'CLOSING', forceCloseRequestedAt: new Date() } });
              return; // Leave navigation pending until the independent control loop kills Chromium.
            }
            const body = scenario === 'already-admin'
              ? '<nav role="navigation">Fixture account</nav><div role="navigation" aria-label="Group navigation"><div role="navigation" aria-label="Admin tools"><a href="/groups/123456/admin_assistant/">Admin Assist</a><a href="/groups/123456/pending_posts/">Pending posts</a><a href="/groups/123456/admin_activities/">Activity log</a></div></div><main role="main"><h1>Test</h1><button>Write something...</button></main>'
              : posting ? `<nav role="navigation">Fixture account</nav><main role="main"><button onclick="document.querySelector('[role=dialog]').hidden=false;setTimeout(()=>document.querySelector('#editor').hidden=false,500)">Write something</button><div role="dialog" hidden><div id="editor" hidden><div role="textbox" contenteditable="true"></div></div><button onclick="window.clicks=(window.clicks||0)+1;document.querySelector('[role=dialog]').hidden=true;const p=document.createElement('p');p.textContent='Your post is pending';document.body.append(p)">Post</button></div></main>` : '<nav role="navigation">Fixture account</nav><main role="main"><button onclick="setTimeout(()=>this.textContent=\'Cancel request\',2000)">Join group</button></main>';
            const requestBody = new URLSearchParams({ fb_api_req_friendly_name: 'ComposerStoryCreateMutation', variables: JSON.stringify({ input: { audience: { to_id: '123456' }, actor_id: 'fixture-only', message: { text: 'Fixture post' } } }) }).toString();
            const publicBody = body.replace("const p=document.createElement('p');p.textContent='Your post is pending';document.body.append(p)", `fetch('/api/graphql/',{method:'POST',body:${JSON.stringify(requestBody).replaceAll('"', '&quot;')}});const p=document.createElement('div');p.setAttribute('aria-posinset','1');p.textContent='Fixture post';document.querySelector('main').append(p)`)
              .replace('<div role="textbox"', '<div oninput="document.querySelector(\'#mentions\').hidden=false" role="textbox"')
              + '<div id="mentions" role="listbox" aria-label="Mentions suggestions" hidden style="position:fixed;inset:0;z-index:100;background:white"><div role="option">Tested</div></div><script>document.addEventListener("keydown",event=>{if(event.key==="Escape")document.querySelector("#mentions").hidden=true})</script>';
            await route.fulfill({ contentType: 'text/html; charset=utf-8', body: scenario === 'post-public-response' ? publicBody : body });
          });
          const result = await callback(session);
          if (posting) assert.equal(await session.page.evaluate('window.clicks'), 1);
          return result;
        }) } as never);
      await service.executeBrowserTask({ taskId: task.id, workflowId });
      const actual = await prisma.task.findUniqueOrThrow({ where: { id: task.id }, include: { runs: true, account: true } });
      assert.equal(actual.status, scenario === 'already-admin' || scenario === 'delayed-success' || posting ? 'SUCCEEDED' : 'REQUIRES_ACTION', scenario);
      assert.equal(actual.account.status, 'READY', `A confirmed login remains READY after ${scenario}`);
      assert.equal((actual.runs[0]?.result as any)?.sideEffectStarted, scenario === 'delayed-success' || posting);
      if (posting) assert.equal((actual.runs[0]?.result as any)?.publicationStatus, scenario === 'post-public-response' ? 'PUBLISHED' : 'PENDING_APPROVAL');
      if (scenario === 'post-public-response') {
        assert.equal((actual.runs[0]?.result as any)?.confirmationSource, 'CREATION_RESPONSE');
        assert.equal((actual.runs[0]?.result as any)?.postUrl, 'https://www.facebook.com/groups/123456/permalink/789/');
      }
      if (scenario === 'already-admin') {
        assert.equal((actual.runs[0]?.result as any)?.membershipStatus, 'JOINED');
        assert.equal((actual.runs[0]?.result as any)?.alreadyJoined, true);
        assert.equal((actual.runs[0]?.result as any)?.groupRole, 'ADMIN_OR_MODERATOR');
      }
      assert.equal(runtime.activeSessionCount, 0);
      assert.equal(await prisma.browserSession.count({ where: { profileId, status: { in: ['RUNNING', 'STARTING', 'CLOSING'] } } }), 0);
    }
    console.log('PASS: actual browser task activity + PostgreSQL + Chromium: existing admin returns JOINED without sending; delayed join; navigation failure preserves READY; force close; unclaimed delivery retry posts exactly once after editor hydration; pending approval; mentions overlay dismissed before public roleless post, confirmed from creation response with permalink. All network requests intercepted; no Facebook writes.');
  } finally {
    Context.current = originalContext;
    await control.onModuleDestroy();
    await prisma.task.deleteMany({ where: { organizationId: org } });
    await prisma.browserSession.deleteMany({ where: { workerId } });
    await prisma.platformAccount.deleteMany({ where: { organizationId: org } });
    await prisma.workerNode.deleteMany({ where: { id: workerId } });
    await prisma.organization.deleteMany({ where: { id: org } });
    await prisma.$disconnect();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
