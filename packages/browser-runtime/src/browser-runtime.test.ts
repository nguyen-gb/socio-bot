import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserRuntime } from './browser-runtime';
import { LocalObjectStorage, ProfileSnapshotStore } from '@socio/object-storage';
import { BrowserProcessRegistry } from './browser-process';

test('hung cookie save is force-closed by verified PID while another browser stays alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-hung-browser-'));
  const runtime = new BrowserRuntime(root, 2, Buffer.alloc(32, 7), 100);
  try {
    const [first, same] = await Promise.all([runtime.openProfile({ profileId: 'hung' }), runtime.openProfile({ profileId: 'hung' })]);
    assert.equal(first, same, 'Concurrent opens reuse one browser');
    const other = await runtime.openProfile({ profileId: 'unrelated' });
    assert.ok(first.processId && other.processId && first.processId !== other.processId);
    const record = JSON.parse(await readFile(join(root, '.processes', 'hung.json'), 'utf8'));
    assert.equal(record.pid, first.processId);
    first.context.cookies = () => new Promise(() => {});
    await first.close();
    assert.equal(runtime.activeSessionCount, 1);
    assert.throws(() => process.kill(first.processId!, 0));
    await other.page.goto('data:text/html,<title>still alive</title>');
    assert.equal(await other.page.title(), 'still alive');
    const reopened = await runtime.openProfile({ profileId: 'hung', slotTimeoutMs: 1000 });
    assert.notEqual(reopened.processId, first.processId);
    await reopened.close();
  } finally { await runtime.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('force close interrupts a pending task and persisted identity rejects a reused PID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-force-browser-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7), 200);
  try {
    const session = await runtime.openProfile({ profileId: 'fixture' });
    const registry = new BrowserProcessRegistry(root);
    const record = JSON.parse(await readFile(join(root, '.processes', 'fixture.json'), 'utf8'));
    await assert.rejects(registry.terminate({ ...record, started: 'wrong-generation' }), /identity changed/);
    assert.equal(session.page.isClosed(), false);
    const work = runtime.withProfile({ profileId: 'fixture' }, () => new Promise(() => {}));
    const failed = assert.rejects(work, /force closed/);
    await runtime.forceCloseProfile('fixture');
    await failed;
    assert.equal(runtime.activeSessionCount, 0);
    assert.throws(() => process.kill(session.processId!, 0));
  } finally { await runtime.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('task deadline bounds a stuck callback and recovers the slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-task-timeout-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  try {
    await assert.rejects(runtime.withProfile({ profileId: 'fixture', executionTimeoutMs: 100 }, () => new Promise(() => {})), /task timed out/);
    assert.equal(runtime.activeSessionCount, 0);
    const recovered = await runtime.openProfile({ profileId: 'fixture', slotTimeoutMs: 1000 });
    await recovered.close();
  } finally { await runtime.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('persistent Chromium profile survives a close and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-browser-runtime-'));
  const profileId = '00000000-0000-4000-8000-000000000222';
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  const harPath = join(root, 'runtime.har');
  const tracePath = join(root, 'runtime-trace.zip');
  try {
    const first = await runtime.openProfile({
      profileId,
      headless: true,
      recordHarPath: harPath,
    });
    await first.context.tracing.start({ screenshots: true, snapshots: true });
    await first.page.goto('data:text/html,<title>first</title>');
    await first.context.addCookies([
      {
        name: 'session-auth',
        value: 'secret-session-fixture',
        domain: '.example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: 'session-test',
        value: 'persisted',
        url: 'https://example.com',
        expires: Math.floor(Date.now() / 1_000) + 3_600,
      },
    ]);
    await first.context.tracing.stop({ path: tracePath });
    await first.close();
    assert.ok((await stat(tracePath)).size > 0);
    assert.ok((await stat(harPath)).size > 0);
    const sealed = await readFile(join(root, profileId, 'session-cookies.enc'), 'utf8');
    assert.match(sealed, /^sealed:v1:/);
    assert.equal(sealed.includes('secret-session-fixture'), false);

    const second = await runtime.openProfile({ profileId, headless: true });
    const cookies = await second.context.cookies('https://example.com');
    assert.equal(cookies.find((cookie) => cookie.name === 'session-test')?.value, 'persisted');
    assert.equal(cookies.find((cookie) => cookie.name === 'session-auth')?.value, 'secret-session-fixture');
    assert.equal(cookies.find((cookie) => cookie.name === 'session-auth')?.expires, -1);
    assert.equal(cookies.find((cookie) => cookie.name === 'session-auth')?.httpOnly, true);
    await second.context.clearCookies();
    await second.close();
    const third = await runtime.openProfile({ profileId, headless: true });
    assert.equal((await third.context.cookies('https://example.com')).length, 0, 'Logout must not resurrect older session cookies');
    await third.close();
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('session cookies survive an encrypted snapshot restore into a different profile root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-cookie-snapshot-'));
  const key = Buffer.alloc(32, 9);
  const profileId = '00000000-0000-4000-8000-000000000333';
  const source = new BrowserRuntime(join(root, 'source'), 1, key);
  const restored = new BrowserRuntime(join(root, 'restored'), 1, key);
  const objects = new LocalObjectStorage(join(root, 'objects'));
  try {
    const first = await source.openProfile({ profileId, headless: true });
    await first.context.addCookies([{ name: 'c_user', value: 'synthetic-user', domain: '.facebook.com', path: '/' }]);
    await first.close();
    const snapshot = await new ProfileSnapshotStore(objects, join(root, 'source'), join(root, 'tmp'), key).snapshot(profileId, 1);
    await new ProfileSnapshotStore(objects, join(root, 'restored'), join(root, 'tmp'), key).restore(profileId, snapshot.storageUri);
    const second = await restored.openProfile({ profileId, headless: true });
    assert.equal((await second.context.cookies('https://www.facebook.com/')).find(c => c.name === 'c_user')?.value, 'synthetic-user');
    await second.close();
  } finally {
    await source.closeAll();
    await restored.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupted encrypted cookie state fails closed and releases the browser slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-cookie-corruption-'));
  const profileId = '00000000-0000-4000-8000-000000000444';
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 11));
  try {
    const first = await runtime.openProfile({ profileId, headless: true });
    await first.context.addCookies([{ name: 'fixture', value: 'secret', url: 'https://example.com' }]);
    await first.close();
    const file = join(root, profileId, 'session-cookies.enc');
    const original = await readFile(file, 'utf8');
    await writeFile(file, 'not-valid-encrypted-state');
    await assert.rejects(() => runtime.openProfile({ profileId, headless: true }), /sealed secret/);
    assert.equal(runtime.activeSessionCount, 0);
    await writeFile(file, original);
    const recovered = await runtime.openProfile({ profileId, headless: true, slotTimeoutMs: 1000 });
    assert.equal((await recovered.context.cookies('https://example.com')).find(c => c.name === 'fixture')?.value, 'secret');
    await Promise.all([recovered.close(), recovered.close()]);
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
