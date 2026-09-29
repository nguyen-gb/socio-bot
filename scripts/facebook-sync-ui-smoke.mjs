// Browser UI fixture only: no real profiles or campaigns are run.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3105';
const accounts = [1, 2].map(i => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, username: `Sync profile ${i}`, platform: 'FACEBOOK', status: 'READY' }));
const requests = [], errors = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body = [];
    if (path === '/api/auth/me') body = { role: 'OWNER', email: 'sync-fixture@example.test' };
    if (path === '/api/control/accounts') body = accounts;
    if (path === '/api/facebook/groups') body = [{ id: 'group-manual', accountId: accounts[0].id, account: accounts[0], groupName: 'Nhóm đã tham gia thủ công', groupUrl: 'https://www.facebook.com/groups/manual/', status: 'JOINED', lastSyncedAt: new Date().toISOString() }];
    if (route.request().method() === 'POST') {
      assert.equal(path, '/api/facebook/groups/sync');
      const input = route.request().postDataJSON(); requests.push(input);
      body = { count: input.scope === 'ALL' ? accounts.length : input.accountIds.length };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(base);
  await page.getByText('sync-fixture@example.test', { exact: true }).waitFor();
  await page.locator('nav').getByRole('button', { name: /Facebook/ }).click();
  await page.getByRole('button', { name: 'Đồng bộ nhóm', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByText('Tất cả profile Facebook sẵn sàng (2)', { exact: true }).waitFor();
  await dialog.getByLabel('Phạm vi đồng bộ').click();
  await page.getByTitle('Chọn profile cụ thể', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Đồng bộ', exact: true }).click();
  await dialog.getByText('Chọn ít nhất một profile để đồng bộ', { exact: true }).waitFor();
  assert.equal(requests.length, 0);
  await dialog.getByLabel('Profile cần đồng bộ').click();
  await page.getByTitle('Sync profile 2', { exact: true }).click();
  await dialog.getByText('Phạm vi đồng bộ', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Đồng bộ', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(requests[0].scope, 'SELECTED'); assert.deepEqual(requests[0].accountIds, [accounts[1].id]);
  await page.getByText('Nhóm đã tham gia thủ công', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Đồng bộ nhóm', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Đồng bộ', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(requests[1].scope, 'ALL'); assert.deepEqual(requests[1].accountIds, []);
  assert.notEqual(requests[0].idempotencyKey, requests[1].idempotencyKey);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ selectedProfile: true, emptySelectionBlocked: true, allProfiles: true, manualGroupShownWithoutCampaign: true, browserErrors: errors }));
} finally { await browser.close(); }
