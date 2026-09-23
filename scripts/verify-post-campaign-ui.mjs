// Read-only campaign verification through the live UI and API; never dispatches tasks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const campaignId = process.argv[2];
if (!campaignId || !/^[a-f0-9-]{36}$/.test(campaignId)) throw new Error('Supply campaign UUID');
const { chromium } = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url))('playwright');
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const password = env.match(/^BOOTSTRAP_ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
const base = 'http://localhost:3000', errors = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const login = await context.request.post(`${base}/api/auth/login`, { headers: { origin: base }, data: { email: 'owner@socio.local', password } });
  assert.ok(login.ok(), `Login: ${login.status()}`);
  const response = await context.request.get(`${base}/api/facebook/campaigns`);
  assert.ok(response.ok());
  const campaign = (await response.json()).find(row => row.id === campaignId);
  assert.ok(campaign?.tasks.length);
  assert.ok(campaign.tasks.every(task => task.status === 'SUCCEEDED'), 'All campaign tasks must be complete');
  const page = await context.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#facebook`, { waitUntil: 'domcontentloaded' });
  await page.locator('nav').getByRole('button', { name: /Facebook/ }).click();
  const row = page.locator(`tr[data-row-key="${campaignId}"]`);
  await row.getByText('Hoàn tất', { exact: true }).waitFor();
  await row.locator('button.ant-table-row-expand-icon').click();
  const details = row.locator('xpath=following-sibling::tr[1]');
  const pending = campaign.tasks.filter(task => task.runs[0]?.result?.publicationStatus === 'PENDING_APPROVAL').length;
  assert.equal(await details.getByText('Bài chờ duyệt', { exact: true }).count(), pending);
  assert.equal(await row.getByRole('button', { name: /^Chạy lại/ }).count(), 0);
  assert.deepEqual(errors, []);
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL(`../artifacts/post-campaign-${campaignId}.png`, import.meta.url)), fullPage: true });
  console.log(JSON.stringify({ campaign: campaign.name, completed: campaign.tasks.length, pendingApproval: pending, uiErrors: errors, duplicateRetryButton: false }));
} finally { await browser.close(); }
