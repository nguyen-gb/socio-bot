import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const mutations = [], errors = [];
  let status = 'RUNNING';
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    let body = [];
    if (url.pathname === '/api/auth/me') body = { role: 'OWNER', email: 'fixture@example.test' };
    if (url.pathname.includes('/login-sessions/')) {
      if (request.method() === 'DELETE') {
        mutations.push(url.searchParams.get('force'));
        status = url.searchParams.get('force') === 'true' ? 'CLOSED' : 'CLOSING';
      }
      body = { id: 'fixture-session', status, accessUrl: null, expiresAt: new Date(Date.now() + 60000).toISOString() };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${base}/sessions/fixture-session`);
  await page.getByRole('button', { name: 'Đóng browser', exact: true }).click();
  // Dismiss the success toast before clicking the top-right force-close action.
  await page.locator('.socio-toast .ant-notification-notice-close').click();
  await page.getByRole('button', { name: 'Ép đóng browser', exact: true }).click();
  await page.getByText('Phiên trình duyệt đã kết thúc', { exact: true }).waitFor();
  assert.deepEqual(mutations, [null, 'true']);
  const closeButton = page.getByRole('button').filter({ hasText: 'Đóng browser' });
  assert.equal(await closeButton.isDisabled(), true);
  assert.deepEqual(errors, []);
  const disconnectMessage = 'Mất kết nối màn hình browser. Hệ thống sẽ thử kết nối lại.';
  for (const scenario of ['user-close', 'server-close', 'external-close', 'network-drop', 'close-failed']) {
    const screen = await browser.newPage();
    let phase = 'RUNNING';
    const sockets = [], notifications = [];
    screen.on('pageerror', error => errors.push(error.message));
    await screen.route('**/api/**', async route => {
      const request = route.request();
      if (request.method() === 'DELETE') {
        if (scenario === 'close-failed') {
          await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Fixture close failed' }) });
          return;
        }
        // Keep the status stale briefly: the socket closes before polling sees
        // CLOSING, which previously produced an erroneous disconnect toast.
        sockets.at(-1)?.close({ code: 1011, reason: 'Transport closed' });
        await new Promise(resolve => setTimeout(resolve, 300));
        phase = 'CLOSING';
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: `fixture-${scenario}`, status: phase, accessUrl: `ws://fixture.test/${scenario}`, expiresAt: new Date(Date.now() + 60000).toISOString() }) });
    });
    await screen.routeWebSocket('ws://fixture.test/**', socket => { sockets.push(socket); });
    await screen.addInitScript(() => {
      window.fixtureNotices = [];
      new MutationObserver(() => {
        for (const notice of document.querySelectorAll('.socio-toast')) window.fixtureNotices.push(notice.textContent);
      }).observe(document, { childList: true, subtree: true });
    });
    await screen.goto(`${base}/sessions/fixture-${scenario}`);
    await screen.getByText('Đã kết nối', { exact: true }).waitFor();
    if (scenario === 'user-close' || scenario === 'close-failed') await screen.getByRole('button', { name: 'Đóng browser', exact: true }).click();
    else {
      if (scenario === 'external-close') phase = 'CLOSING';
      sockets[0].close({ code: scenario === 'server-close' ? 1000 : 1011, reason: scenario === 'server-close' ? 'Session closed' : 'Unexpected disconnect' });
    }
    if (scenario === 'network-drop') {
      await screen.getByText(disconnectMessage, { exact: true }).waitFor();
      await screen.waitForFunction(() => document.body.textContent.includes('Đã kết nối'));
      assert.ok(sockets.length >= 2, 'unexpected disconnect must reconnect');
    } else if (scenario === 'close-failed') {
      await screen.getByText('Fixture close failed', { exact: true }).waitFor();
      await screen.getByText('Đã kết nối', { exact: true }).waitFor();
      assert.ok(sockets.length >= 2, 'failed close must restore the remote connection');
    } else {
      await screen.getByText('Đang đóng browser', { exact: true }).waitFor();
      await new Promise(resolve => setTimeout(resolve, 1500));
      assert.equal(sockets.length, 1, `${scenario} must not reconnect`);
    }
    notifications.push(...await screen.evaluate(() => window.fixtureNotices));
    if (scenario !== 'network-drop') assert.ok(!notifications.some(text => text.includes(disconnectMessage)), `${scenario} must not show a disconnect error`);
    await screen.close();
  }
  assert.deepEqual(errors, []);
  console.log('PASS: close/force close; user close, server Session closed and external CLOSING do not warn or reconnect; genuine network loss warns/reconnects; failed close restores connection. HTTP/WebSocket requests mocked; no Facebook activity.');
} finally { await browser.close(); }
