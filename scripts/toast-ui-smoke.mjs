import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const base = 'http://localhost:3000';
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  let failure = true, queryFailure = false;
  const accounts = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    let body = [], status = 200;
    if (path === '/api/auth/me') body = { role: 'OWNER', email: 'fixture@example.test' };
    if (path === '/api/auth/login') { status = 401; body = { message: 'Sai thông tin đăng nhập fixture' }; }
    if (path === '/api/control/accounts') {
      if (req.method() === 'POST') {
        if (failure) { status = 400; body = { message: 'Không thể tạo profile fixture' }; }
        else { body = { id: crypto.randomUUID(), username: req.postDataJSON().username, platform: 'FACEBOOK', status: 'NEW' }; accounts.push(body); status = 201; }
      } else if (queryFailure) { status = 503; body = { message: 'Không thể tải dữ liệu fixture' }; }
      else body = accounts;
    }
    if (path.includes('/login-sessions/')) body = { id: 'fixture-session', status: 'RUNNING', accessUrl: 'ws://fixture.test/session', expiresAt: new Date(Date.now() + 600000).toISOString() };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const toast = text => page.locator('.socio-toast').filter({ hasText: text });
  await page.goto(`${base}/login`);
  await page.getByLabel('Email', { exact: true }).fill('fixture@example.test');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('fixture-password-123');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await toast('Sai thông tin đăng nhập fixture').waitFor();
  assert.equal(await page.locator('.ant-alert').count(), 0);
  await page.goto(`${base}/#accounts`);
  await page.getByText('fixture@example.test', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Thêm profile', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên hiển thị').fill('Toast profile fixture');
  await dialog.getByLabel('Mở browser ngay sau khi tạo').uncheck();
  await dialog.getByRole('button', { name: 'Tạo profile', exact: true }).click();
  await toast('Không thể tạo profile fixture').waitFor();
  assert.equal(await dialog.getByLabel('Tên hiển thị').inputValue(), 'Toast profile fixture');
  assert.equal(await dialog.locator('.ant-alert').count(), 0);
  failure = false;
  await dialog.getByRole('button', { name: 'Tạo profile', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Tạo profile', exact: true }).click();
  await toast('Đã tạo profile').waitFor();
  await dialog.waitFor({ state: 'hidden' });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/toast-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/toast-mobile.png' });
  const bounds = await toast('Đã tạo profile').boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
  await page.setViewportSize({ width: 1440, height: 1000 });
  queryFailure = true;
  await page.reload();
  const loadToast = toast('Không thể tải dữ liệu fixture');
  await loadToast.waitFor();
  await loadToast.locator('.ant-notification-notice-close').click();
  await loadToast.waitFor({ state: 'hidden' });
  // Refetch the same failing query through the refresh action, without a new toast.
  const refresh = page.getByRole('button', { name: /Làm mới/ }).first();
  if (await refresh.count()) { await refresh.click(); await page.waitForTimeout(1500); }
  assert.equal(await loadToast.count(), 0);
  queryFailure = false;

  await page.addInitScript(() => {
    const NativeSocket = window.WebSocket;
    class FixtureSocket {
      static OPEN = 1; readyState = 1;
      constructor(url, protocols) {
        if (!String(url).includes('fixture.test')) return new NativeSocket(url, protocols);
        setTimeout(() => { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'frame', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1kAAAAASUVORK5CYII=', width: 1280, height: 720 }) }); }, 100);
      }
      send() {} close() { this.readyState = 3; }
    }
    window.WebSocket = FixtureSocket;
  });
  await page.goto(`${base}/sessions/fixture-session`);
  await page.getByRole('application').locator('img').waitFor();
  const url = page.getByRole('textbox', { name: 'Địa chỉ trang web' });
  await url.fill('javascript:alert(1)'); await url.press('Enter');
  await toast('Nhập địa chỉ HTTP/HTTPS hợp lệ').waitFor();
  await page.getByRole('button', { name: 'Toàn màn hình', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.contains(document.getElementById('socio-toast-root')));
  await url.fill('file:///fixture'); await url.press('Enter');
  assert.ok(await page.locator(':fullscreen .socio-toast').count());
  await page.screenshot({ path: 'artifacts/toast-fullscreen.png' });
  await page.getByRole('button', { name: 'Thoát toàn màn hình', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('socio-toast-root')?.parentElement === document.body);
  assert.deepEqual(errors, []);
  console.log('PASS: login/action errors and profile success use toast; form values preserved; polling errors deduplicated; mobile fits; existing/new toasts visible in fullscreen and restored on exit. All APIs and remote socket mocked.');
} catch (error) {
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    console.log(await page.locator('body').innerText());
  }
  throw error;
} finally { await browser.close(); }
