// Browser UI fixture only: no real profiles, groups or Facebook posts are touched.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3105';
const profileIds = [1, 2].map(i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
const collectionId = '00000000-0000-4000-8000-000000000101';
const accounts = profileIds.map((id, index) => ({ id, username: `Profile ${index + 1}`, platform: 'FACEBOOK', status: 'READY' }));
const urls = ['https://www.facebook.com/groups/seafood/', 'https://www.facebook.com/groups/market/'];
const groups = [
  { id: 'g1', accountId: profileIds[0], account: accounts[0], groupName: 'Chợ hải sản', groupUrl: urls[0], status: 'JOINED', lastSyncedAt: new Date().toISOString() },
  { id: 'g2', accountId: profileIds[1], account: accounts[1], groupName: 'Chợ hải sản', groupUrl: urls[0], status: 'JOINED', lastSyncedAt: new Date().toISOString() },
  { id: 'g3', accountId: profileIds[0], account: accounts[0], groupName: 'Rao vặt tổng hợp', groupUrl: urls[1], status: 'JOINED', lastSyncedAt: new Date().toISOString() },
];
let collections = [];
const writes = [], errors = [], warnings = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    let body = [];
    if (path === '/api/auth/me') body = { role: 'OWNER', email: 'collections-fixture@example.test' };
    if (path === '/api/control/accounts') body = accounts;
    if (path === '/api/facebook/groups') body = groups;
    if (path === '/api/facebook/campaigns') body = [];
    if (path === '/api/facebook/group-collections' && method === 'GET') body = collections;
    if (path === '/api/facebook/group-collections' && method === 'POST') {
      const input = request.postDataJSON(); writes.push({ method, path, input });
      collections = [{ id: collectionId, ...input, items: input.groupUrls.map(groupUrl => ({ groupUrl })), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
      body = collections[0];
    }
    if (path === `/api/facebook/group-collections/${collectionId}` && method === 'PATCH') {
      const input = request.postDataJSON(); writes.push({ method, path, input });
      collections = [{ ...collections[0], ...input, items: input.groupUrls.map(groupUrl => ({ groupUrl })), updatedAt: new Date().toISOString() }];
      body = collections[0];
    }
    if (path === `/api/facebook/group-collections/${collectionId}` && method === 'DELETE') {
      writes.push({ method, path }); collections = []; body = { deleted: true };
    }
    if (path === '/api/facebook/groups/post' && method === 'POST') {
      const input = request.postDataJSON(); writes.push({ method, path, input }); body = { id: 'campaign' };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(base);
  await page.getByText('collections-fixture@example.test', { exact: true }).waitFor();
  await page.locator('nav').getByRole('button', { name: /Facebook/ }).click();
  await page.getByRole('tab', { name: /Tập hợp nhóm/ }).click();
  await page.getByRole('button', { name: 'Tạo tập hợp', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên tập hợp').fill('Hải sản');
  await dialog.getByLabel('Mô tả').fill('Các nhóm phù hợp sản phẩm hải sản');
  await dialog.getByLabel('Nhóm trong tập hợp').click();
  await page.getByText('Chợ hải sản (2 profile)', { exact: true }).click();
  await dialog.getByText('Tên tập hợp', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Tạo tập hợp', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(writes[0].method, 'POST'); assert.deepEqual(writes[0].input.groupUrls, [urls[0]]);
  await page.getByText('Hải sản', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Sửa Hải sản' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên tập hợp').fill('Hải sản miền Nam');
  await dialog.getByLabel('Nhóm trong tập hợp').click();
  await page.getByText('Rao vặt tổng hợp (1 profile)', { exact: true }).click();
  await dialog.getByText('Tên tập hợp', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(writes[1].method, 'PATCH'); assert.deepEqual(writes[1].input.groupUrls.sort(), [...urls].sort());

  await page.getByRole('button', { name: 'Soạn bài nhóm', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên chiến dịch').fill('Đăng theo tập hợp');
  await dialog.getByLabel('Nội dung bài viết').fill('Bài kiểm thử, không đăng thật.');
  await dialog.getByLabel('Nhóm đăng bài').click();
  await page.getByTitle('Chọn theo tập hợp nhóm', { exact: true }).click();
  await dialog.getByLabel('Tập hợp nhóm').click();
  await page.getByTitle('Hải sản miền Nam (2 nhóm)', { exact: true }).click();
  await dialog.getByText('Nhóm đăng bài', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Đăng bài ngay', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const post = writes.find(write => write.path === '/api/facebook/groups/post');
  assert.equal(post.input.selection, 'COLLECTIONS'); assert.deepEqual(post.input.collectionIds, [collectionId]); assert.equal(post.input.groupUrls, undefined);

  await page.getByRole('tab', { name: /Tập hợp nhóm/ }).click();
  await page.getByRole('button', { name: 'Xóa Hải sản miền Nam' }).click();
  await page.getByRole('button', { name: 'Xóa tập hợp', exact: true }).click();
  await page.getByText('Đã xóa tập hợp nhóm', { exact: true }).waitFor();
  assert.equal(writes.at(-1).method, 'DELETE');
  assert.deepEqual(errors, []);
  assert.ok(!warnings.some(warning => warning.includes('Instance created by `useForm` is not connected')), `Detached Form warning: ${warnings.join('\n')}`);
  console.log(JSON.stringify({ create: true, edit: true, delete: true, collectionPosting: true, deduplicatedSelection: true, browserErrors: errors, detachedFormWarnings: 0 }));
} finally { await browser.close(); }
