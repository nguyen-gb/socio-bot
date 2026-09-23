import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url));
const { chromium } = require('playwright');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3000';
const shots = new URL('../.local/screenshots/', import.meta.url);
await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [], warnings = [], mutations = [];
let role = 'OWNER', failCreate = false, failRead = false;
const accounts = [
  { id: 'fixture-a', username: 'Mai Nguyễn', platform: 'FACEBOOK', status: 'READY', browserProfile: { hasCookies: true, hasPassword: true }, proxyBinding: { proxy: { id: 'fixture-proxy', name: 'Singapore 01', status: 'HEALTHY' } } },
  { id: 'fixture-b', username: 'Minh Trần', platform: 'FACEBOOK', status: 'LOGIN_REQUIRED', browserProfile: {} },
];
const proxies = [{ id: 'fixture-proxy', name: 'Singapore 01', protocol: 'HTTP', host: 'proxy.example.test', port: 8080, status: 'HEALTHY', latencyMs: 142, hasAuthentication: true, accountBindings: accounts.map(account => ({ account })) }];
const tasks = [{ id: 'fixture-task', account: accounts[1], action: 'JOIN_FACEBOOK_GROUP', status: 'REQUIRES_ACTION', approvalStatus: 'APPROVED', createdAt: new Date().toISOString(), lastError: 'Cần đăng nhập hoặc hoàn tất xác minh.', campaignId: 'fixture-campaign' }];
const schedules = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'warning' || /Warning|deprecated|hydration|same key|unique.*key/i.test(event.text())) warnings.push(event.text()); });
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
    let body = [], code = 200;
    if (path === '/api/auth/me') body = { role, email: 'fixture@example.test' };
    if (path === '/api/control/accounts') body = accounts;
    if (path === '/api/control/proxies') body = proxies;
    if (path === '/api/control/schedules') body = schedules;
    if (path === '/api/control/tasks') body = tasks;
    if (path.endsWith('/credentials')) body = path.includes('/accounts/') ? { login: 'mai@example.test', password: 'fixture-password', cookies: 'c_user=fixture; xs=fixture' } : { username: 'proxy-user', password: 'proxy-password' };
    if (path.includes('/login-sessions/') && method === 'GET') body = { id: 'fixture-session', status: 'CLOSED', accessUrl: null, expiresAt: new Date().toISOString() };
    if (method !== 'GET') {
      const input = req.postData() ? req.postDataJSON() : undefined;
      mutations.push({ path, method, input });
      if (failCreate) { code = 400; body = { message: 'Không thể lưu dữ liệu thử nghiệm.' }; }
      else if (path === '/api/control/accounts' && method === 'POST') { body = { id: 'fixture-new', username: input.username, platform: input.platform, status: 'CREATED' }; accounts.push(body); }
      else if (path.startsWith('/api/control/accounts/') && method === 'PATCH') { body = accounts.find(account => path.endsWith(account.id)); body.username = input.username; }
      else if (path === '/api/control/proxies' && method === 'POST') { body = { ...input, id: 'fixture-proxy-new', status: 'CREATED' }; proxies.push(body); }
      else if (path === '/api/control/schedules' && method === 'POST') { body = { ...input, id: 'fixture-schedule', action: input.action.action, account: accounts[0], enabled: true }; schedules.push(body); }
      else body = { ok: true };
    }
    if (failRead && path === '/api/control/accounts' && method === 'GET') { code = 503; body = { message: 'Không thể kết nối API thử nghiệm.' }; }
    await route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const nav = async name => { await page.locator('nav').getByRole('button', { name, exact: true }).click(); };
  const screenshot = async name => { await page.screenshot({ path: fileURLToPath(new URL(name, shots)), fullPage: true }); };
  const fits = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Document must not overflow horizontally');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByText('fixture@example.test', { exact: true }).waitFor();
  await screenshot('dashboard-overview.png');
  await nav('Profiles');
  assert.equal(new URL(page.url()).hash, '#accounts');
  await page.getByLabel('Tìm profile').fill('Singapore');
  await page.locator('#accounts tbody tr').filter({ hasText: 'Minh Trần' }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#accounts tbody tr[data-row-key]').count(), 1);
  await page.getByLabel('Tìm profile').fill('');
  await page.getByLabel('Lọc trạng thái profile').click();
  await page.locator('.ant-select-dropdown:visible').getByText('Cần đăng nhập', { exact: true }).click();
  await page.locator('#accounts tbody tr').filter({ hasText: 'Mai Nguyễn' }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#accounts tbody tr[data-row-key]').count(), 1);
  await page.getByLabel('Lọc trạng thái profile').click();
  await page.locator('.ant-select-dropdown:visible').getByText('Mọi trạng thái', { exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden' });
  await screenshot('dashboard-profiles.png');
  await page.getByRole('button', { name: 'Thêm profile', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên hiển thị').fill('Profile mới');
  await dialog.getByLabel('Email / username / số điện thoại').fill('new@example.test');
  await dialog.getByLabel('Mật khẩu', { exact: true }).fill('fixture-password');
  await dialog.getByLabel('Cookie', { exact: true }).fill('c_user=fixture; xs=fixture');
  await dialog.getByLabel('Mở browser ngay sau khi tạo').uncheck();
  await screenshot('dashboard-profile-modal.png');
  await dialog.getByRole('button', { name: 'Tạo profile', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(mutations.at(-1).input.authentication.login, 'new@example.test');
  assert.equal(Object.hasOwn(mutations.at(-1).input, 'proxyId'), false, 'Creating without proxy must omit the field');
  assert.equal(Object.hasOwn(mutations.at(-1).input, 'externalId'), false, 'Creating without external id must omit the field');
  assert.ok(!mutations.some(item => item.path.includes('login-sessions')), 'Creating without opening must not start browser');
  const row = page.locator('#accounts tbody tr').filter({ hasText: 'Mai Nguyễn' });
  await row.getByRole('button', { name: 'Sửa profile', exact: true }).click();
  dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('Email / username / số điện thoại').inputValue(), 'mai@example.test');
  assert.equal(await dialog.getByLabel('Mật khẩu', { exact: true }).inputValue(), 'fixture-password');
  await dialog.getByLabel('Tên hiển thị').fill('Mai Nguyễn cập nhật');
  await dialog.getByRole('button', { name: 'Lưu thay đổi' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(Object.hasOwn(mutations.at(-1).input, 'authentication'), false, 'Renaming must not resubmit unchanged login fields');
  assert.equal(Object.hasOwn(mutations.at(-1).input, 'platform'), false, 'Renaming must not resubmit unchanged platform');
  await row.getByRole('button', { name: 'Xóa profile', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy', exact: true }).click();
  assert.ok(!mutations.some(item => item.method === 'DELETE'));
  await nav('Proxy');
  await screenshot('dashboard-proxies.png');
  await page.getByRole('button', { name: 'Sửa hoặc gán profile', exact: true }).click();
  dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('Username', { exact: true }).inputValue(), 'proxy-user');
  assert.equal(await dialog.getByLabel('Password', { exact: true }).inputValue(), 'proxy-password');
  assert.equal(await dialog.locator('.ant-select-selection-item').filter({ hasText: /Mai Nguyễn|Minh Trần/ }).count(), 2);
  await screenshot('dashboard-proxy-modal.png');
  await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
  await nav('Lịch chạy');
  await page.getByRole('button', { name: 'Tạo lịch', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên lịch', { exact: true }).fill('Kiểm tra mỗi giờ');
  await dialog.getByLabel('Profile cho lịch').click();
  await page.locator('.ant-select-dropdown:visible').getByText(/Mai Nguyễn cập nhật/).click();
  await dialog.getByRole('button', { name: 'Tạo lịch', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Xóa lịch', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Giữ lại', exact: true }).click();
  await nav('Tác vụ');
  await page.getByLabel('Lọc trạng thái tác vụ').click();
  await page.locator('.ant-select-dropdown:visible').getByText('Cần thao tác', { exact: true }).click();
  await page.locator('#tasks').getByText('Tham gia nhóm', { exact: true }).waitFor();
  await nav('Profiles');
  await nav('Proxy');
  await page.goBack();
  await page.locator('.content[data-view="accounts"]').waitFor();
  await page.reload();
  await page.locator('.content[data-view="accounts"]').waitFor();
  await page.getByRole('button', { name: 'Thêm profile', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên hiển thị').fill('Lỗi giả lập');
  await dialog.getByLabel('Mở browser ngay sau khi tạo').uncheck();
  failCreate = true;
  await dialog.getByRole('button', { name: 'Tạo profile', exact: true }).click();
  await page.locator('.socio-toast').filter({ hasText: 'Không thể lưu dữ liệu thử nghiệm.' }).waitFor();
  assert.ok(await dialog.isVisible(), 'Failed mutation must keep form open');
  failCreate = false;
  await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
  await page.getByRole('button', { name: 'Thêm proxy', exact: true }).count();
  for (const width of [768, 390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    for (const view of ['overview', 'accounts', 'proxies', 'facebook', 'schedules', 'media', 'tasks']) {
      await page.getByLabel('Chọn khu vực quản trị').selectOption(view);
      await fits();
    }
    await page.getByLabel('Chọn khu vực quản trị').selectOption('accounts');
    await page.getByRole('button', { name: 'Thêm profile', exact: true }).click();
    dialog = page.getByRole('dialog');
    assert.ok((await dialog.boundingBox()).width <= width);
    await dialog.getByLabel('Cookie', { exact: true }).scrollIntoViewIfNeeded();
    await dialog.getByLabel('Cookie', { exact: true }).fill('c_user=fixture');
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await fits();
    if (width === 390) await screenshot('dashboard-mobile-profiles.png');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  role = 'VIEWER';
  await page.reload();
  await page.getByText('Chỉ xem', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Thêm profile', exact: true }).isDisabled());
  assert.ok(await page.getByRole('button', { name: 'Mở browser', exact: true }).first().isDisabled());
  await nav('Facebook');
  assert.ok(await page.getByRole('button', { name: 'Soạn bài nhóm' }).isDisabled());
  role = 'OWNER'; failRead = true;
  await page.reload();
  await page.getByText('Không thể kết nối API thử nghiệm.', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByText('Lỗi tải dữ liệu', { exact: true }).waitFor();
  failRead = false;
  await page.goto(`${base}/sessions/fixture-session`);
  await page.getByText('Phiên trình duyệt đã kết thúc', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Đóng browser', exact: true }).isDisabled());
  assert.equal(await page.locator('.browser-loading .ant-spin').count(), 0);
  await screenshot('dashboard-session-ended.png');
  await page.goto(`${base}/login`);
  await page.getByRole('heading', { name: 'Chào mừng trở lại' }).waitFor();
  await page.waitForFunction(() => Object.keys(document.getElementById('email')).some(key => key.startsWith('__reactFiber')));
  await screenshot('dashboard-login.png');
  await page.setViewportSize({ width: 360, height: 800 });
  await fits();
  assert.ok(await page.getByLabel('Mật khẩu', { exact: true }).isVisible());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter(warning => /hydration|tree hydrated|deprecated|same key|unique.*key/i.test(warning)), []);
  console.log('PASS: navigation/back/reload; profile create/edit/prefill; proxy credentials/multiple profiles; schedule modal/delete confirmation; task filter; toast errors; 7 views at 768/390/360px; viewer permissions; API error; ended browser; login. All API calls intercepted.');
  if (warnings.length) console.log('UI warnings:', [...new Set(warnings)].join('\n'));
} finally { await browser.close(); }
