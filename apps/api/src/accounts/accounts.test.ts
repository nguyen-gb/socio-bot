import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountsService } from './accounts.service';

const credentials = { login: 'fixture@example.test', password: 'fixture-password', cookies: 'c_user=fixture; xs=fixture' };
function setup(status = 'READY', stored: typeof credentials | null = credentials) {
  const account: any = { id: 'account', organizationId: 'org', platform: 'FACEBOOK', status,
    browserProfile: { id: 'profile', status: 'AVAILABLE', sessions: [], metadata: stored ? { credentialsRef: 'sealed-fixture', hasPassword: true, hasCookies: true } : {} }, proxyBinding: null };
  const writes: any[] = [], profileWrites: any[] = [], bindings: any[] = [];
  const tx = {
    platformAccount: { update: async ({ data }: any) => { writes.push(data); Object.assign(account, Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))); } },
    browserProfile: { update: async ({ data }: any) => { profileWrites.push(data); Object.assign(account.browserProfile, data); } },
    accountProxyBinding: { upsert: async (input: any) => bindings.push(input), deleteMany: async (input: any) => bindings.push(input) },
  };
  const prisma = {
    platformAccount: { findFirst: async ({ where }: any) => { assert.equal(where.organizationId, 'org'); return account; } },
    proxy: { findFirst: async () => ({ id: 'proxy', status: 'HEALTHY' }) },
    $transaction: async (callback: any) => callback(tx),
  };
  const vault = { profileCredentials: () => stored ?? {}, seal: () => 'new-sealed-fixture' };
  return { service: new AccountsService(prisma as never, vault as never), account, writes, profileWrites, bindings };
}

test('name/proxy edits preserve every existing status and profile metadata', async () => {
  for (const status of ['CREATED', 'READY', 'LOGIN_REQUIRED', 'CHALLENGED', 'ERROR', 'RUNNING', 'EXPIRED', 'DISABLED']) {
    for (const input of [{ username: 'New name' }, { proxyId: 'proxy' }, { proxyId: null },
      { username: 'New name', proxyId: 'proxy', platform: 'FACEBOOK' as const, authentication: { ...credentials } }]) {
      const context = setup(status);
      const result = await context.service.update('org', 'account', input);
      assert.equal(result.status, status);
      assert.equal(Object.hasOwn(context.writes[0], 'status'), false);
      assert.equal(context.profileWrites.length, 0);
      assert.equal(context.account.browserProfile.metadata.credentialsRef, 'sealed-fixture');
    }
  }
});
test('unchanged empty authentication and normalized prefilled fields do not reset status', async () => {
  const empty = setup('READY', null);
  await empty.service.update('org', 'account', { platform: 'FACEBOOK', authentication: {}, username: 'New name' });
  assert.equal(empty.account.status, 'READY');
  const filled = setup();
  await filled.service.update('org', 'account', { authentication: { ...credentials, login: ` ${credentials.login} `, cookies: ` ${credentials.cookies} ` } });
  assert.equal(filled.account.status, 'READY');
  assert.equal(filled.profileWrites.length, 0);
});
test('actual password/cookie changes or clearing credentials require login again', async () => {
  for (const authentication of [{ ...credentials, password: 'new-password' }, { ...credentials, cookies: 'c_user=new' }, {}]) {
    const context = setup();
    await context.service.update('org', 'account', { authentication });
    assert.equal(context.account.status, 'LOGIN_REQUIRED');
    assert.equal(context.profileWrites.length, 1);
  }
});
test('changing platform requires login again, merely resending platform does not', async () => {
  const context = setup();
  await context.service.update('org', 'account', { platform: 'INSTAGRAM' });
  assert.equal(context.account.status, 'LOGIN_REQUIRED');
});
test('editing with an active browser remains blocked without writes', async () => {
  const context = setup();
  context.account.browserProfile.sessions = [{ status: 'RUNNING' }];
  await assert.rejects(context.service.update('org', 'account', { username: 'New name' }), /Close the browser/);
  assert.equal(context.writes.length, 0);
});
