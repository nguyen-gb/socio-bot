import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url));
const { chromium } = require('playwright');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3000';
const accounts = ['01', '02'].map((suffix) => ({ id: `00000000-0000-4000-8000-0000000000${suffix}`, username: `Fixture ${suffix}`, platform: 'FACEBOOK', status: 'READY' }));
const groups = accounts.flatMap((account) => [1, 2].map((id) => ({ id: `${account.id}-${id}`, accountId: account.id, account, groupUrl: `https://www.facebook.com/groups/${id}/`, groupName: `Fixture group ${id}`, status: 'JOINED', lastSyncedAt: new Date().toISOString() })));
groups.push(...accounts.map((account, index) => ({ id: `unique-${index}`, accountId: account.id, account, groupUrl: `https://www.facebook.com/groups/${index ? 'b-only' : 'a-only'}/`, groupName: `Fixture ${index ? 'B-only' : 'A-only'}`, status: 'JOINED', lastSyncedAt: new Date().toISOString() })));
groups.push({ id: 'pending', accountId: accounts[0].id, account: accounts[0], groupUrl: 'https://www.facebook.com/groups/pending/', groupName: 'Fixture pending', status: 'PENDING', lastSyncedAt: new Date().toISOString() });
groups[0].groupName = 'View group'; // Prefer the real name from the other profile in the shared-group picker.
for (const [id, groupName] of [['777', 'View group'], ['888', ''], ['999', undefined]]) {
  groups.push({ id, accountId: accounts[0].id, account: accounts[0], groupUrl: `https://www.facebook.com/groups/${id}/`, groupName, status: 'JOINED', lastSyncedAt: new Date().toISOString() });
}
const campaigns = []; const mutations = []; const errors = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = [];
    if (path === '/api/control/accounts') body = accounts;
    if (path === '/api/auth/me') body = { role: 'OWNER', email: 'fixture@example.test' };
    if (path === '/api/facebook/groups') body = groups;
    if (path === '/api/facebook/campaigns') body = campaigns;
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON(); mutations.push({ path, input });
      if (/\/groups\/(join|post)$/.test(path)) {
        const chosen = input.accountIds.length ? accounts.filter((account) => input.accountIds.includes(account.id)) : accounts;
        let assigned;
        if (path.endsWith('join')) assigned = chosen.flatMap(account => input.groupUrls.map(groupUrl => ({ account, groupUrl })));
        else {
          const groupUrls = input.selection === 'CUSTOM' ? input.groupUrls : [...new Set(groups.filter(group => group.status === 'JOINED' && chosen.some(account => account.id === group.accountId)).map(group => group.groupUrl))];
          const counts = new Map(chosen.map(account => [account.id, 0])); let cursor = 0;
          assigned = groupUrls.flatMap(groupUrl => {
            for (let offset = 0; offset < chosen.length; offset += 1) {
              const index = (cursor + offset) % chosen.length, account = chosen[index];
              if ((counts.get(account.id) ?? 0) < input.maxGroupsPerAccount && groups.some(group => group.accountId === account.id && group.groupUrl === groupUrl)) {
                counts.set(account.id, (counts.get(account.id) ?? 0) + 1); cursor = (index + 1) % chosen.length;
                return [{ account, groupUrl }];
              }
            }
            return [];
          });
        }
        const targets = assigned.map(({ account, groupUrl }) => ({ id: crypto.randomUUID(), status: 'DRAFT', approvalStatus: 'PENDING', payload: { groupUrl }, account, runs: [] }));
        body = { id: crypto.randomUUID(), name: input.name, kind: path.endsWith('join') ? 'JOIN' : 'POST', createdAt: new Date().toISOString(), payload: input, tasks: targets }; campaigns.unshift(body);
      } else if (path.endsWith('/approve')) { const campaign = campaigns.find((item) => path.includes(item.id)); campaign.approvedAt = new Date().toISOString(); campaign.tasks.forEach((job) => { job.status = 'SCHEDULED'; job.approvalStatus = 'APPROVED'; }); body = campaign; }
      else if (path.endsWith('/pause')) { const campaign = campaigns.find(item => path.includes(item.id)); campaign.pausedAt = new Date().toISOString(); campaign.tasks.filter(job => ['SCHEDULED', 'QUEUED'].includes(job.status)).forEach(job => { job.status = 'PAUSED'; }); body = { paused: 3 }; }
      else if (path.endsWith('/resume')) { const campaign = campaigns.find(item => path.includes(item.id)); campaign.pausedAt = null; campaign.tasks.filter(job => job.status === 'PAUSED').forEach(job => { job.status = 'SCHEDULED'; }); body = { resumed: 3 }; }
      else if (path.endsWith('/retry')) { const campaign = campaigns.find(item => path.includes(item.id)); campaign.tasks.filter(job => input.taskIds.includes(job.id)).forEach(job => { job.status = 'SCHEDULED'; }); body = { retried: input.taskIds.length }; }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // SSR navigation exists before hydration; wait for client auth query first.
  await page.getByText('fixture@example.test', { exact: true }).waitFor();
  await page.locator('nav').getByRole('button', { name: /Facebook/ }).click();
  await page.locator('.content[data-view="facebook"]').waitFor();
  await page.getByRole('button', { name: /Tham gia nhóm/ }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên chiến dịch').fill('Fixture join campaign');
  await dialog.getByLabel('Link nhóm').fill('https://www.facebook.com/groups/123/\nhttps://www.facebook.com/groups/456/');
  await dialog.getByRole('button', { name: 'Lưu bản nháp' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(mutations[0].input.accountIds.length, 0); assert.equal(mutations[0].input.groupUrls.length, 2);
  assert.equal(mutations.filter((item) => item.path.endsWith('/approve')).length, 0);
  await page.getByRole('button', { name: 'Duyệt', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('Thao tác này gửi yêu cầu').waitFor();
  await dialog.getByRole('button', { name: 'Duyệt & chạy', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(mutations.filter((item) => item.path.endsWith('/approve')).length, 1);
  const joined = campaigns[0];
  joined.tasks[0].status = 'RUNNING';
  await page.getByRole('button', { name: 'Làm mới chiến dịch' }).click();
  await page.getByRole('button', { name: 'Dừng Fixture join campaign', exact: true }).click();
  await page.getByText('Đang dừng', { exact: true }).waitFor();
  assert.equal(joined.tasks[0].status, 'RUNNING');
  assert.ok(await page.getByRole('button', { name: 'Tiếp tục Fixture join campaign', exact: true }).isDisabled());
  joined.tasks[0].status = 'SUCCEEDED';
  await page.getByRole('button', { name: 'Làm mới chiến dịch' }).click();
  await page.getByText('Đã dừng', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Tiếp tục Fixture join campaign', exact: true }).click();
  await page.getByText('Đã lên lịch', { exact: true }).waitFor();
  joined.tasks[1].status = 'REQUIRES_ACTION'; joined.tasks[1].retrySafety = 'SAFE'; joined.tasks[1].runs = [{ result: { sideEffectStarted: false } }];
  joined.tasks[2].status = 'REQUIRES_ACTION'; joined.tasks[2].retrySafety = 'VERIFY'; joined.tasks[2].runs = [{ result: { sideEffectStarted: true } }];
  joined.tasks[3].status = 'SUCCEEDED';
  await page.getByRole('button', { name: 'Làm mới chiến dịch' }).click();
  await page.getByRole('button', { name: 'Chạy lại Fixture join campaign', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByText('1 tác vụ được chọn.', { exact: false }).waitFor();
  assert.ok(await dialog.locator('tbody input[type="checkbox"]:disabled').count());
  await dialog.getByRole('button', { name: 'Chạy lại tác vụ đã chọn' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const retried = mutations.find(item => item.path.endsWith('/retry')).input;
  assert.deepEqual(retried.taskIds, [joined.tasks[1].id]); assert.deepEqual(retried.verifiedUnsentTaskIds, []);
  assert.equal(joined.tasks[0].status, 'SUCCEEDED');
  joined.tasks[1].status = 'SUCCEEDED';
  await page.getByRole('button', { name: 'Làm mới chiến dịch' }).click();
  await page.getByRole('button', { name: 'Chạy lại Fixture join campaign', exact: true }).click();
  dialog = page.getByRole('dialog');
  assert.ok(await dialog.getByRole('button', { name: 'Chạy lại tác vụ đã chọn' }).isDisabled());
  await dialog.getByRole('checkbox', { name: /Tôi đã kiểm tra trên Facebook/ }).check();
  await dialog.locator('tbody tr[data-row-key] input[type="checkbox"]').first().check();
  await dialog.getByRole('button', { name: 'Chạy lại tác vụ đã chọn' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(mutations.filter(item => item.path.endsWith('/retry')).at(-1).input.verifiedUnsentTaskIds, [joined.tasks[2].id]);
  await page.getByRole('button', { name: 'Soạn bài nhóm' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên chiến dịch').fill('Fixture post campaign');
  await dialog.getByLabel('Nội dung bài viết').fill('Fixture post text');
  await dialog.getByLabel('Tối đa số nhóm / account', { exact: true }).fill('1');
  await dialog.getByLabel('Account', { exact: true }).click();
  await page.getByText('Fixture 01', { exact: true }).last().click();
  await dialog.getByLabel('Tên chiến dịch').click();
  await dialog.getByRole('button', { name: 'Lưu bản nháp' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const post = mutations.find((item) => item.path.endsWith('/post')).input;
  assert.equal(post.selection, 'ALL'); assert.equal(post.maxGroupsPerAccount, 1); assert.equal(post.accountIds.length, 1);
  await page.getByRole('button', { name: 'Soạn bài nhóm', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên chiến dịch').fill('Fixture custom groups');
  await dialog.getByLabel('Nội dung bài viết').fill('Fixture explicit group post');
  await dialog.getByLabel('Nhóm đăng bài').click();
  await page.locator('.ant-select-dropdown:visible').getByText('Tự chọn trong nhóm đã đồng bộ', { exact: true }).click();
  await dialog.getByLabel('Nhóm đã đồng bộ', { exact: true }).click();
  for (const id of ['777', '888', '999']) await page.locator('.ant-select-dropdown:visible').getByText(`${id} (1 profile)`, { exact: true }).waitFor();
  assert.equal(await page.locator('.ant-select-dropdown:visible').getByText('View group', { exact: true }).count(), 0);
  await dialog.getByLabel('Tên chiến dịch').click();
  await dialog.getByRole('button', { name: 'Lưu bản nháp' }).click();
  await dialog.getByText('Chọn ít nhất một nhóm đã đồng bộ', { exact: true }).waitFor();
  const groupPicker = dialog.getByLabel('Nhóm đã đồng bộ', { exact: true });
  await groupPicker.fill('A-only');
  await page.locator('.ant-select-dropdown:visible').getByText('Fixture A-only (1 profile)', { exact: true }).click();
  await groupPicker.fill('B-only');
  await page.locator('.ant-select-dropdown:visible').getByText('Fixture B-only (1 profile)', { exact: true }).click();
  await dialog.getByLabel('Tên chiến dịch').click();
  await dialog.getByLabel('Account', { exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').getByText('Fixture 01', { exact: true }).click();
  await dialog.getByLabel('Tên chiến dịch').click();
  await page.locator('.ant-select-dropdown').filter({ hasText: 'Fixture 01' }).waitFor({ state: 'hidden' });
  await dialog.locator('.ant-select-selection-item').filter({ hasText: 'Fixture B-only' }).waitFor({ state: 'hidden' });
  await groupPicker.fill('B-only');
  await page.locator('.ant-select-dropdown:visible').getByText('Không có nhóm phù hợp. Hãy đồng bộ nhóm cho profile đã chọn.', { exact: true }).waitFor();
  assert.equal(await page.locator('.ant-select-dropdown:visible').getByRole('option').count(), 0);
  await groupPicker.fill('pending');
  await page.locator('.ant-select-dropdown:visible').getByText('Fixture pending (1 profile)', { exact: true }).waitFor();
  await groupPicker.fill('groups/1/');
  await page.locator('.ant-select-dropdown:visible').getByText('1 (1 profile)', { exact: true }).click();
  await dialog.getByLabel('Tên chiến dịch').click();
  await dialog.getByRole('button', { name: 'Lưu bản nháp' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const custom = mutations.at(-1).input;
  assert.equal(custom.selection, 'CUSTOM');
  assert.deepEqual(custom.accountIds, [accounts[0].id]);
  assert.deepEqual(custom.groupUrls, ['https://www.facebook.com/groups/a-only/', 'https://www.facebook.com/groups/1/']);
  assert.equal(Object.hasOwn(custom, 'limit'), false);
  assert.equal(custom.maxGroupsPerAccount, 5);
  assert.equal(campaigns[0].tasks.length, 2);
  await page.getByRole('tab', { name: /^Nhóm đã tham gia/ }).click();
  for (const id of ['777', '888', '999']) {
    await page.getByLabel('Tìm nhóm', { exact: true }).fill(id);
    await page.locator('.group-link').filter({ hasText: new RegExp(`^${id}$`) }).waitFor();
  }
  await page.getByRole('tab', { name: /^Chiến dịch/ }).click();
  await mkdir(new URL('../.local/screenshots/', import.meta.url), { recursive: true });
  await page.waitForTimeout(3200); // Let success toasts close before visual review.
  await page.screenshot({ path: new URL('../.local/screenshots/facebook-desktop.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Chọn khu vực quản trị').selectOption('facebook');
  await page.getByRole('button', { name: 'Soạn bài nhóm', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nhóm đăng bài').click();
  await page.locator('.ant-select-dropdown:visible').getByText('Tự chọn trong nhóm đã đồng bộ', { exact: true }).click();
  assert.ok(await dialog.getByLabel('Nhóm đã đồng bộ').isVisible());
  await dialog.getByLabel('Nhóm đã đồng bộ').fill('group 1');
  await page.locator('.ant-select-dropdown:visible').getByText('Fixture group 1 (2 profile)', { exact: true }).click();
  await dialog.getByLabel('Nhóm đã đồng bộ').press('Escape');
  await dialog.getByLabel('Nhóm đã đồng bộ').scrollIntoViewIfNeeded();
  const box = await dialog.boundingBox(); assert.ok(box.width <= 390);
  await page.waitForTimeout(400);
  await page.screenshot({ path: new URL('../.local/screenshots/facebook-mobile.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: synced-group picker, separate ALL/CUSTOM source and per-account maximum, missing-name IDs, search/profile-change pruning, pending group selectable, pause/resume/retry/approval. All API mutations intercepted; no Facebook writes.');
} finally { await browser.close(); }
