// UI-only fixtures: all API requests are intercepted; no campaign is dispatched.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3105';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const account = { id: '00000000-0000-4000-8000-000000000001', username: 'Profile thử nghiệm', platform: 'FACEBOOK', status: 'READY' };
const assets = [], campaigns = [], errors = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = [];
    if (/\/api\/media\/.+\/content$/.test(path)) return route.fulfill({ contentType: 'image/png', body: png });
    if (path === '/api/auth/me') data = { role: 'OWNER', email: 'fixture@example.test' };
    if (path === '/api/control/accounts') data = [account];
    if (path === '/api/facebook/campaigns') data = campaigns;
    if (path === '/api/media') {
      if (route.request().method() === 'POST') {
        await new Promise(resolve => setTimeout(resolve, 250));
        data = { id: crypto.randomUUID(), fileName: `Ảnh ${assets.length + 1}.png`, contentType: 'image/png', sizeBytes: String(png.length), status: 'READY' };
        assets.push(data);
      } else data = assets;
    }
    if (path === '/api/facebook/groups/post') {
      const payload = route.request().postDataJSON();
      data = { id: crypto.randomUUID(), kind: 'POST', name: payload.name, approvedAt: new Date().toISOString(), createdAt: new Date().toISOString(), payload,
        tasks: [{ id: crypto.randomUUID(), status: 'SCHEDULED', approvalStatus: 'APPROVED', payload: { groupUrl: 'https://www.facebook.com/groups/123/' }, account, runs: [] }] };
      campaigns.push(data);
    }
    assert.ok(!path.endsWith('/approve'), 'UI smoke must never approve a campaign');
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(base);
  await page.getByText('fixture@example.test', { exact: true }).waitFor();
  await page.locator('nav').getByRole('button', { name: /Facebook/ }).click();
  await page.getByRole('button', { name: 'Soạn bài nhóm', exact: true }).click();
  let dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('input[type=file]').isVisible(), false, 'Native file input stays hidden');
  await dialog.getByLabel('Tên chiến dịch').fill('Chiến dịch ảnh thử nghiệm');
  await dialog.getByRole('button', { name: 'Đăng bài ngay' }).click();
  await dialog.getByText('Nhập nội dung hoặc chọn ít nhất một ảnh', { exact: true }).waitFor();
  await dialog.locator('input[type=file]').setInputFiles([{ name: 'one.png', mimeType: 'image/png', buffer: png }, { name: 'two.png', mimeType: 'image/png', buffer: png }]);
  await dialog.getByRole('button', { name: 'Bỏ ảnh 2', exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[role=dialog] img')].filter(img => img.complete && img.naturalWidth > 0).length === 2);
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: new URL('../artifacts/facebook-images-compose.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await dialog.getByRole('button', { name: 'Bỏ ảnh 1', exact: true }).click();
  assert.equal(await dialog.locator('img').count(), 1);
  await dialog.getByRole('button', { name: 'Đăng bài ngay' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(campaigns[0].payload.mediaAssetIds, [assets[1].id]);
  assert.equal(campaigns[0].payload.text ?? '', '');
  await page.getByText('Đã lên lịch', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Soạn bài nhóm', exact: true }).click();
  dialog = page.getByRole('dialog');
  assert.equal(await dialog.locator('img').count(), 0, 'New draft must not inherit old images');
  await dialog.getByRole('combobox', { name: 'Chọn ảnh từ thư viện' }).click();
  await page.getByTitle('Ảnh 1.png', { exact: true }).click();
  await dialog.getByText('Ảnh đính kèm', { exact: true }).click();
  await page.locator('.ant-select-dropdown:visible').waitFor({ state: 'hidden' });
  await dialog.getByRole('button', { name: 'Bỏ ảnh 1', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: new URL('../artifacts/facebook-images-mobile.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ uploaded: assets.length, imageOnlyPost: true, removedImage: true, noApprovalStep: true, libraryReuse: true, browserErrors: errors }));
} finally { await browser.close(); }
