import 'reflect-metadata';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { signRemoteSessionToken } from '@socio/remote-session-auth';
import { RemoteSessionGateway } from '../src/remote-session/remote-session.gateway';

const secret = 'remote-browser-fixture-secret-32-characters';
const sessionId = '00000000-0000-4000-8000-000000000199';
const config = (port: number) => ({ get: (key: string) => ({ remoteSessionPort: port, remoteSessionSecret: secret, redisUrl: 'redis://127.0.0.1:6379', remoteSessionRedisRelay: true })[key] });
async function main() {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const owner = new RemoteSessionGateway(config(39136) as never), relay = new RemoteSessionGateway(config(39137) as never);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    let loads = 0;
    await context.route('**/*', route => {
      loads++;
      const name = new URL(route.request().url()).pathname.slice(1) || 'one';
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<title>Fixture ${name}</title><style>body{margin:0;background:#f2f5f1;height:2200px;font-family:Arial}header{padding:32px;background:#205c50;color:white}main{padding:32px}button{position:absolute;left:520px;top:300px;width:200px;height:50px}a{display:inline-block;margin:20px}</style><header><h1>Remote browser · ${name}</h1><p>Local fixture — no real account or external requests</p></header><main><a href="https://remote.test/two">Next page</a><a href="https://remote.test/popup" target="_blank">Open popup</a><button onclick="window.clicks=(window.clicks||0)+1;this.textContent='Clicked '+window.clicks">Click target</button></main>` });
    });
    const original = await context.newPage(); await original.goto('https://remote.test/one');
    await owner.start(); await relay.start(); await owner.register(sessionId, original);
    const signed = signRemoteSessionToken(sessionId, secret, 600);
    const ui = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors: string[] = [], messages: any[] = [];
    ui.on('pageerror', error => errors.push(error.message));
    ui.on('websocket', socket => { if (socket.url().includes(':39137/')) socket.on('framereceived', frame => { const value = JSON.parse(frame.payload.toString()); if (value.type !== 'frame') messages.push(value); }); });
    await ui.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: sessionId, status: 'RUNNING', expiresAt: new Date(Date.now() + 600000).toISOString(), accessUrl: `ws://127.0.0.1:39137/sessions/${sessionId}?token=${signed.token}` }) }));
    await ui.goto(`http://localhost:3000/sessions/${sessionId}`);
    const viewport = ui.getByRole('application'), address = ui.getByRole('textbox', { name: 'Địa chỉ trang web' });
    await ui.getByRole('tab', { name: 'Fixture one', exact: true }).waitFor();
    await viewport.locator('img').waitFor();
    assert.equal(await address.inputValue(), 'https://remote.test/one');
    await address.fill('https://remote.test/two'); await address.press('Enter');
    await ui.getByRole('tab', { name: 'Fixture two', exact: true }).waitFor();
    await ui.getByRole('button', { name: 'Quay lại trang trước' }).click();
    await ui.getByRole('tab', { name: 'Fixture one', exact: true }).waitFor();
    await ui.getByRole('button', { name: 'Tiến tới trang sau' }).click();
    await ui.getByRole('tab', { name: 'Fixture two', exact: true }).waitFor();
    const previousLoads = loads;
    await ui.getByRole('button', { name: 'Tải lại trang', exact: true }).click();
    await original.waitForFunction(() => document.readyState === 'complete');
    await ui.waitForTimeout(300); assert.ok(loads > previousLoads);
    await ui.getByRole('button', { name: 'Mở tab mới' }).click();
    await ui.getByRole('tab', { name: 'Tab mới', exact: true }).waitFor();
    await address.fill('https://remote.test/second'); await address.press('Enter');
    await ui.getByRole('tab', { name: 'Fixture second', exact: true }).waitFor();
    const second = context.pages().find(page => page.url().endsWith('/second'))!;
    assert.ok(second);
    await ui.getByRole('tab', { name: 'Fixture two', exact: true }).click();
    await ui.waitForFunction(() => (document.querySelector('input[aria-label="Địa chỉ trang web"]') as HTMLInputElement).value.endsWith('/two'));
    await ui.getByRole('button', { name: 'Đóng tab Fixture two', exact: true }).click();
    await ui.getByRole('tab', { name: 'Fixture two', exact: true }).waitFor({ state: 'detached' });
    assert.equal(original.isClosed(), true);
    assert.equal(second.isClosed(), false);
    // A page-created popup must show up as a real tab and become controllable.
    await second.getByRole('link', { name: 'Open popup' }).click();
    await ui.getByRole('tab', { name: 'Fixture popup', exact: true }).waitFor();
    await ui.getByRole('button', { name: 'Đóng tab Fixture popup', exact: true }).click();
    await ui.getByRole('tab', { name: 'Fixture popup', exact: true }).waitFor({ state: 'detached' });
    await viewport.locator('img').waitFor();
    // Check that reconnect replays the static frame and tab/URL state.
    await ui.getByRole('button', { name: 'Kết nối lại màn hình', exact: true }).click();
    await ui.getByText('Đã kết nối', { exact: true }).waitFor();
    await viewport.locator('img').waitFor();
    await mkdir('../../artifacts', { recursive: true });
    await ui.screenshot({ path: '../../artifacts/remote-browser-normal.png', fullPage: true });

    await ui.getByRole('button', { name: 'Toàn màn hình', exact: true }).click();
    await ui.waitForFunction(() => !!document.fullscreenElement);
    await ui.getByRole('button', { name: 'Thoát toàn màn hình', exact: true }).waitFor();
    const rect = (await viewport.boundingBox())!;
    const scale = Math.min(rect.width / 1280, rect.height / 720);
    const x = rect.x + (rect.width - 1280 * scale) / 2 + 620 * scale;
    const y = rect.y + (rect.height - 720 * scale) / 2 + 325 * scale;
    await ui.mouse.click(x, y);
    await second.waitForFunction(() => (window as any).clicks === 1, undefined, { timeout: 5000 });
    await ui.mouse.wheel(0, 250);
    await second.waitForFunction(() => scrollY > 100);
    await ui.screenshot({ path: '../../artifacts/remote-browser-fullscreen.png' });
    const fullBounds = await ui.locator('.remote-actions').boundingBox();
    assert.ok(fullBounds && fullBounds.y + fullBounds.height <= 1101, 'Actions must remain visible in fullscreen');
    await ui.getByRole('button', { name: 'Thoát toàn màn hình', exact: true }).click();
    await ui.waitForFunction(() => !document.fullscreenElement);
    await ui.setViewportSize({ width: 390, height: 844 });
    await ui.screenshot({ path: '../../artifacts/remote-browser-mobile.png', fullPage: true });
    assert.ok(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow on mobile');
    assert.ok(await ui.locator('.remote-actions').evaluate(el => parseFloat(getComputedStyle(el).paddingLeft) >= 12));
    await address.fill('javascript:alert(1)'); await address.press('Enter');
    await ui.getByText('Nhập địa chỉ HTTP/HTTPS hợp lệ, không chứa username/password.').waitFor();
    assert.equal(second.url(), 'https://remote.test/second');
    await ui.getByRole('button', { name: 'Đóng tab Fixture second', exact: true }).click();
    await ui.getByRole('tab', { name: 'Tab mới', exact: true }).waitFor();
    assert.equal(context.pages().length, 1, 'Closing last tab keeps browser session alive');
    assert.deepEqual(errors, []);
    assert.ok(messages.some(m => m.type === 'browserState' && m.tabs.length === 2));
    console.log('PASS: real UI → WebSocket/Redis → Chromium: URL, back/forward/reload, create/select/close tabs, popup, close original/last tab, reconnect, fullscreen click/scroll coordinates, responsive padding and unsafe URL rejection. Fixture only; no real profiles touched.');
  } finally {
    await owner.unregister(sessionId);
    await browser.close();
    await Promise.all([owner.onModuleDestroy(), relay.onModuleDestroy()]);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
