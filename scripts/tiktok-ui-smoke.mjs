import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ headless: true });
const writes = [], errors = [];
const accounts = [
  { id: 'tt-ready', username: 'TikTok ready', platform: 'TIKTOK', status: 'READY' },
  { id: 'tt-search', username: 'TikTok search', platform: 'TIKTOK', status: 'LOGIN_REQUIRED' },
];
const videoRows = [
  { videoUrl: 'https://www.tiktok.com/@creator/video/1', videoId: '1', title: 'Video áo khoác mùa đông', username: '@creator', profileUrl: 'https://www.tiktok.com/@creator', likes: 1200, views: 34000, comments: 44, statsSource: 'TIKTOK_VIDEO_STATS' },
  { videoUrl: 'https://www.tiktok.com/@creator/video/2', videoId: '2', title: 'Video phối đồ', username: '@creator', likes: 540, views: 9000, comments: 12, statsSource: 'TIKTOK_VIDEO_STATS' },
];
const tasks = [
  { id: 'search-1', action: 'SEARCH_TIKTOK_VIDEOS', status: 'SUCCEEDED', approvalStatus: 'APPROVED', createdAt: new Date().toISOString(), account: accounts[1], payload: { name: 'Search áo khoác', query: 'áo khoác', maxVideos: 10 }, runs: [{ result: { count: 2, videos: videoRows } }] },
  { id: 'pending-1', action: 'AUTO_COMMENT_TIKTOK_HOME', status: 'DRAFT', approvalStatus: 'PENDING', createdAt: new Date().toISOString(), account: accounts[0], payload: { name: 'Comment chờ duyệt', text: 'Bài fixture', maxVideos: 2 }, runs: [] },
];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = [], status = 200;
    if (path === '/api/auth/me') body = { role: 'OWNER', email: 'tiktok-fixture@example.test' };
    if (path === '/api/control/accounts') body = accounts;
    if (path === '/api/media') body = [{ id: 'media-1', fileName: 'fixture.png', contentType: 'image/png', status: 'READY' }];
    if (path === '/api/control/tasks' && request.method() === 'GET') body = tasks;
    if (path === '/api/tasks' && request.method() === 'POST') {
      const input = request.postDataJSON();
      const created = { id: `created-${writes.length}`, action: input.action.action, status: 'DRAFT', approvalStatus: 'PENDING', createdAt: new Date().toISOString(), account: accounts.find(account => account.id === input.action.accountId) ?? accounts[0], payload: input.action.payload, runs: [] };
      tasks.unshift(created); writes.push({ path, input }); body = { id: created.id };
    }
    if (path.includes('/approve') && request.method() === 'POST') {
      writes.push({ path }); const id = path.split('/')[3]; const task = tasks.find(item => item.id === id); if (task) { task.status = 'SCHEDULED'; task.approvalStatus = 'APPROVED'; } body = task ?? { ok: true };
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${base}/#tiktok`, { waitUntil: 'domcontentloaded' });
  await page.getByText('tiktok-fixture@example.test', { exact: true }).waitFor();
  await page.getByText('TikTok', { exact: true }).first().waitFor();
  assert.ok(await page.locator('.content[data-view="tiktok"]').count());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.getByRole('button', { name: 'Xem báo cáo', exact: true }).click();
  const report = page.getByRole('dialog');
  await report.getByText('2 video đã được lưu trong campaign', { exact: true }).waitFor();
  const selectionAction = report.getByRole('button', { name: 'Hành động trên video đã chọn', exact: true });
  assert.ok(await selectionAction.isVisible());
  assert.equal(await report.locator('.tiktok-selection-toolbar').count(), 1);
  assert.equal(await report.locator('.ant-modal-footer .tiktok-selection-toolbar').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  assert.ok(await selectionAction.isVisible());
  assert.equal(await report.locator('.tiktok-selection-toolbar').evaluate(element => getComputedStyle(element).flexDirection), 'column');
  await report.getByRole('button', { name: 'Đóng' }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Duyệt & xếp hàng', exact: true }).click();
  await page.getByRole('button', { name: 'Duyệt & xếp hàng', exact: true }).last().click();
  await page.waitForTimeout(200);
  assert.ok(writes.some(write => String(write.path).includes('/approve')));
  await page.getByRole('button', { name: 'Search video', exact: true }).click();
  const dialog = page.locator('.tiktok-create-modal');
  await dialog.getByText('Thiết lập Search video', { exact: true }).waitFor();
  await dialog.locator('input').nth(1).fill('Search fixture');
  await dialog.locator('input').nth(2).fill('áo khoác');
  await dialog.getByRole('button', { name: 'Search video', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.ok(writes.some(write => write.path === '/api/tasks'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await mkdir('.local/screenshots', { recursive: true });
  await page.screenshot({ path: '.local/screenshots/tiktok-mobile.png', fullPage: true });
  console.log('PASS: TikTok dashboard, report modal, approval, Search dialog, create flow and mobile no-overflow.');
} finally { await browser.close(); }
