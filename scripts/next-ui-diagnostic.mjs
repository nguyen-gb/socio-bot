import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/browser-runtime/package.json', import.meta.url));
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', event => { if (['error', 'warning'].includes(event.type())) console.log(event.type(), event.text()); });
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  await page.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(route.request().url().endsWith('/auth/me') ? { role: 'OWNER', email: 'fixture@example.test' } : []) }));
  await page.goto('http://localhost:3000');
  await page.getByText('fixture@example.test', { exact: true }).waitFor();
  await page.waitForTimeout(1000);
  console.log('NEXT DEV UI', await page.evaluate(() => [...document.querySelectorAll('nextjs-portal')].map(portal => portal.shadowRoot?.querySelector('[data-issues-open]')?.textContent ?? 'No issue badge').join('\n')));
  const issues = page.getByRole('button', { name: /issues/i });
  if (await issues.count()) { await issues.first().click(); await page.waitForTimeout(500); console.log('NEXT ISSUES', await page.evaluate(() => [...document.querySelectorAll('nextjs-portal')].map(portal => portal.shadowRoot?.querySelector('[role="dialog"]')?.innerText).join('\n'))); }
} finally { await browser.close(); }
