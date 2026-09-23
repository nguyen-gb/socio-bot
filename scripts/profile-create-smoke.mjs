import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const password = env.match(/^BOOTSTRAP_ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
const base = process.env.UI_TEST_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const accountIds = [], errors = [];
let proxyId;
let loggedIn = false;
const suffix = randomUUID();
async function api(path, method, data, expected = 200) {
  const response = await context.request.fetch(`${base}${path}`, { method, headers: { origin: base }, ...(data !== undefined ? { data } : {}) });
  const payload = await response.json();
  assert.equal(response.status(), expected, JSON.stringify(payload));
  return payload;
}
try {
  await api('/api/auth/login', 'POST', { email: 'owner@socio.local', password });
  loggedIn = true;
  const compatibility = await api('/api/control/accounts', 'POST', { username: `Null fields fixture ${suffix}`, proxyId: null, externalId: null }, 201);
  accountIds.push(compatibility.id);
  assert.equal(compatibility.proxyBinding, null);
  assert.equal(compatibility.externalId, null);
  const proxyName = `Profile create fixture ${suffix}`;
  const proxy = await api('/api/control/proxies', 'POST', { name: proxyName, protocol: 'HTTP', host: '127.0.0.1', port: 65432, accountIds: [] }, 201);
  proxyId = proxy.id;
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#accounts`, { waitUntil: 'domcontentloaded' });
  for (const chooseThenClear of [false, true]) {
    await page.getByRole('button', { name: 'Thêm profile', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Tên hiển thị').fill(`Direct profile fixture ${suffix} ${chooseThenClear}`);
    await dialog.getByLabel('Mở browser ngay sau khi tạo').uncheck();
    if (chooseThenClear) {
      await dialog.getByLabel('Proxy', { exact: true }).click();
      await page.locator('.ant-select-dropdown:visible').getByText(`${proxyName} · 127.0.0.1:65432`, { exact: true }).click();
      await dialog.getByLabel('Proxy', { exact: true }).hover();
      await dialog.locator('.ant-select-clear').click();
    }
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/control/accounts' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Tạo profile', exact: true }).click();
    const response = await responsePromise;
    const payload = await response.json();
    assert.equal(response.status(), 201, JSON.stringify(payload));
    accountIds.push(payload.id);
    const sent = response.request().postDataJSON();
    assert.equal(Object.hasOwn(sent, 'proxyId'), false);
    assert.equal(Object.hasOwn(sent, 'externalId'), false);
    assert.equal(payload.proxyBinding, null);
    assert.equal(payload.browserProfile.status, 'AVAILABLE');
    assert.equal(payload.browserProfile.sessions.length, 0);
    await dialog.waitFor({ state: 'hidden' });
  }
  await api(`/api/control/accounts/${accountIds[1]}`, 'PATCH', { proxyId });
  const unassigned = await api(`/api/control/accounts/${accountIds[1]}`, 'PATCH', { proxyId: null });
  assert.equal(unassigned.proxyBinding, null, 'Clearing a proxy in edit must still remove the binding');
  assert.deepEqual(errors, []);
  console.log('PASS: actual UI → Next → API → PostgreSQL creates profiles without proxy/external ID; selecting then clearing proxy succeeds; legacy null payload succeeds; editing can remove proxy. No profile browsers opened or Facebook actions.');
} finally {
  try {
    for (const id of accountIds) await api(`/api/control/accounts/${id}`, 'DELETE');
    if (proxyId) await api(`/api/control/proxies/${proxyId}`, 'DELETE');
    if (loggedIn) await api('/api/auth/logout', 'POST');
  } finally { await browser.close(); }
}
