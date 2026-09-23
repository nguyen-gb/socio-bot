import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const settings = Object.fromEntries((await readFile(new URL('../.env', import.meta.url), 'utf8'))
  .split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).trim().replace(/^"|"$/g, '')];
  }));
process.env.DATABASE_URL = settings.DATABASE_URL;
const { PrismaClient } = createRequire(new URL('../packages/database/package.json', import.meta.url))('@prisma/client');
const prisma = new PrismaClient();
const web = process.env.WEB_URL ?? 'http://localhost:3000';
let cookie, accountId, proxyId;
async function call(path, method = 'GET', body, status = 200) {
  const response = await fetch(`${web}/api/${path}`, {
    method, headers: { origin: web, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, status, `${method} ${path} returned ${response.status}`);
  if (path === 'auth/login') cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return response.json();
}
try {
  await call('auth/login', 'POST', { email: 'owner@socio.local', password: settings.BOOTSTRAP_ADMIN_PASSWORD });
  const authentication = { login: 'fixture@example.test', password: 'fixture-password', cookies: 'c_user=fixture; xs=fixture' };
  const account = await call('control/accounts', 'POST', { username: `Profile update fixture ${randomUUID()}`, platform: 'FACEBOOK', authentication }, 201);
  accountId = account.id;
  const proxy = await call('control/proxies', 'POST', { name: `Profile update proxy ${randomUUID()}`, protocol: 'HTTP', host: '127.0.0.1', port: 65432, accountIds: [] }, 201);
  proxyId = proxy.id;
  // Only our newly created fixture is marked READY; no existing profiles are altered.
  await prisma.platformAccount.update({ where: { id: accountId }, data: { status: 'READY' } });
  const original = await prisma.browserProfile.findUniqueOrThrow({ where: { accountId } });
  for (const body of [{ username: 'Renamed fixture' }, { proxyId }, { proxyId: null },
    { username: 'Full form fixture', proxyId, platform: 'FACEBOOK', authentication }]) {
    const result = await call(`control/accounts/${accountId}`, 'PATCH', body);
    assert.equal(result.status, 'READY');
    const profile = await prisma.browserProfile.findUniqueOrThrow({ where: { accountId } });
    assert.equal(profile.storageUri, original.storageUri);
    assert.deepEqual(profile.metadata, original.metadata);
    assert.equal(profile.status, original.status);
  }
  const changed = await call(`control/accounts/${accountId}`, 'PATCH', { authentication: { ...authentication, password: 'changed-fixture-password' } });
  assert.equal(changed.status, 'LOGIN_REQUIRED');
  console.log('PASS: real Next → API → PostgreSQL keeps READY/profile metadata/storage for name/proxy/full-form edits; changed password requires login. No browser opened or Facebook action started.');
} finally {
  try {
    if (accountId) await call(`control/accounts/${accountId}`, 'DELETE');
    if (proxyId) await call(`control/proxies/${proxyId}`, 'DELETE');
    if (cookie) await call('auth/logout', 'POST');
  } finally { await prisma.$disconnect(); }
}
