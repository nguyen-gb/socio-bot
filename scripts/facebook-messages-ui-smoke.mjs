// Browser UI fixture only: no real Facebook profile or message is contacted.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3000';
const accountId = '00000000-0000-4000-8000-000000000001';
const recipientId = '00000000-0000-4000-8000-000000000201';
const account = { id: accountId, username: 'Sender fixture', platform: 'FACEBOOK', status: 'READY' };
const groupUrl = 'https://www.facebook.com/groups/seafood/';
const profileUrl = 'https://www.facebook.com/consented.person/';
const group = { id: 'group', accountId, account, groupName: 'Chợ hải sản', groupUrl, status: 'JOINED', lastSyncedAt: new Date().toISOString() };
let recipients = [];
const writes = [], errors = [], warnings = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    let body = [];
    if (path === '/api/auth/me') body = { role: 'OWNER', email: 'messages-fixture@example.test' };
    if (path === '/api/control/accounts') body = [account];
    if (path === '/api/facebook/groups') body = [group];
    if (path === '/api/facebook/campaigns' || path === '/api/facebook/group-collections') body = [];
    if (path === '/api/facebook/opt-in-recipients' && method === 'GET') body = recipients;
    if (path === '/api/facebook/opt-in-recipients' && method === 'POST') {
      const input = request.postDataJSON(); writes.push({ method, path, input });
      recipients = [{ id: recipientId, ...input, revokedAt: null, lastMessagedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      body = recipients[0];
    }
    if (path === `/api/facebook/opt-in-recipients/${recipientId}` && method === 'DELETE') {
      writes.push({ method, path }); recipients = [{ ...recipients[0], revokedAt: new Date().toISOString() }]; body = { revoked: true };
    }
    if (path === `/api/facebook/opt-in-recipients/${recipientId}/reactivate` && method === 'POST') {
      const input = request.postDataJSON(); writes.push({ method, path, input }); recipients = [{ ...recipients[0], ...input, revokedAt: null }]; body = recipients[0];
    }
    if (path === '/api/facebook/groups/message' && method === 'POST') {
      const input = request.postDataJSON(); writes.push({ method, path, input }); body = { id: 'campaign' };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(base);
  await page.getByText('messages-fixture@example.test', { exact: true }).waitFor();
  await page.locator('nav').getByRole('button', { name: /Facebook/ }).click();
  await page.getByRole('tab', { name: /Người nhận đồng ý/ }).click();
  await page.getByRole('button', { name: 'Thêm người nhận', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên người nhận').fill('Khách đã đồng ý');
  await dialog.getByLabel('Link profile Facebook').fill(profileUrl);
  await dialog.getByLabel('Nhóm nguồn').click();
  await page.getByText('Chợ hải sản (1 profile)', { exact: true }).click();
  await dialog.getByLabel('Nguồn đồng ý').fill('Form đăng ký tư vấn');
  await dialog.getByLabel('Ghi chú / bằng chứng').fill('Mã form fixture-01');
  await dialog.getByRole('button', { name: 'Thêm người nhận', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(writes[0].input.groupUrl, groupUrl); assert.equal(writes[0].input.profileUrl, profileUrl);
  assert.match(writes[0].input.consentRecordedAt, /^\d{4}-\d{2}-\d{2}T/);

  await page.getByRole('button', { name: 'Nhắn người đồng ý', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên chiến dịch').fill('Chăm sóc khách đã đăng ký');
  await dialog.getByLabel('Nội dung tin nhắn').fill('Nội dung fixture đã được đồng ý nhận.');
  await dialog.getByLabel('Nhóm nguồn').click();
  await page.getByText('Chợ hải sản (1 người đã đồng ý)', { exact: true }).click();
  await dialog.getByText('Nội dung tin nhắn', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Lưu bản nháp', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const campaign = writes.find(write => write.path === '/api/facebook/groups/message');
  assert.deepEqual(campaign.input.groupUrls, [groupUrl]); assert.equal(campaign.input.maxRecipientsPerGroup, 10);
  assert.equal(campaign.input.cooldownDays, 30); assert.equal(campaign.input.intervalSeconds, 120);

  await page.getByRole('tab', { name: /Người nhận đồng ý/ }).click();
  await page.getByRole('button', { name: 'Thu hồi Khách đã đồng ý' }).click();
  await page.getByRole('button', { name: 'Thu hồi', exact: true }).click();
  await page.getByText('Đã thu hồi quyền nhắn tin', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Kích hoạt lại Khách đã đồng ý' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nguồn đồng ý').fill('Đồng ý lại qua form');
  await dialog.getByRole('button', { name: 'Kích hoạt lại', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(writes.at(-1).path, `/api/facebook/opt-in-recipients/${recipientId}/reactivate`);
  assert.equal(writes.at(-1).input.consentSource, 'Đồng ý lại qua form');
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some(warning => warning.includes('Instance created by `useForm` is not connected')), `Detached Form warning: ${warnings.join('\n')}`);
  console.log(JSON.stringify({ consentRequired: true, perGroupLimit: true, cooldown: true, campaignDraft: true, revokeAndReactivate: true, browserErrors: errors, detachedFormWarnings: 0 }));
} finally { await browser.close(); }
