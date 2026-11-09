// One search, no retries. Uses a separate local profile and the actual runtime.
const { mkdir, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { BrowserRuntime } = require('../packages/browser-runtime/dist/browser-runtime.js');

async function main() {
  const outputRoot = resolve(__dirname, '../.local/google-search-smoke');
  await mkdir(outputRoot, { recursive: true });
  const run = await mkdtemp(join(outputRoot, 'run-'));
  const runtime = new BrowserRuntime(run, 1, randomBytes(32));
  const report = { at: new Date().toISOString(), mode: 'auto', localeMode: process.argv.includes('--configured-locale') ? 'configured' : 'native', headless: process.argv.includes('--headless'), network: 'direct', outcome: 'error' };
  try {
    const { page } = await runtime.openProfile({
      profileId: 'profile', headless: report.headless, channel: 'chrome',
      emulateFingerprint: true, fingerprint: { mode: 'auto', localeMode: report.localeMode,
        ...(report.localeMode === 'configured' ? { locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' } : {}) },
      viewport: null, ephemeral: false,
    });
    const response = await page.goto('https://www.google.com/search?q=playwright+documentation', { waitUntil: 'domcontentloaded' });
    // Allow results to appear, without reloading or resubmitting the search.
    await page.locator('a h3, form[action*="sorry"], iframe[src*="recaptcha"], form[action*="consent"]').first()
      .waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
    report.status = response?.status();
    report.url = page.url();
    report.title = await page.title();
    report.resultCount = await page.locator('a h3:visible').count();
    const saved = JSON.parse(await readFile(join(run, 'profile/fingerprint-emulation.json'), 'utf8'));
    const expected = saved.desktop.bundle.fingerprint;
    report.device = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        cpu: navigator.hardwareConcurrency, memory: navigator.deviceMemory,
        screen: { width: screen.width, height: screen.height },
        userAgent: navigator.userAgent,
        renderer: gl?.getParameter(0x9246),
      };
    }, undefined, undefined, false);
    report.fingerprintApplied = report.device.cpu === expected.navigator.hardwareConcurrency
      && report.device.memory === expected.navigator.deviceMemory
      && report.device.screen.width === expected.screen.width
      && report.device.screen.height === expected.screen.height
      && report.device.userAgent === expected.navigator.userAgent
      && (!report.device.renderer || report.device.renderer === expected.videoCard.renderer);
    const challenged = /\/sorry\//.test(report.url)
      || await page.locator('iframe[src*="recaptcha"]:visible, form[action*="sorry"]:visible').count() > 0;
    report.outcome = challenged ? 'challenge'
      : /consent\.google\./.test(report.url) ? 'consent'
      : report.status === 200 && report.resultCount > 0 ? 'results' : 'inconclusive';
    await page.screenshot({ path: join(run, 'page.png') });
  } catch (error) {
    report.error = String(error);
  } finally {
    await runtime.closeAll();
    await writeFile(join(run, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, artifacts: run }, null, 2));
  }
  if (report.outcome !== 'results' || !report.fingerprintApplied) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
