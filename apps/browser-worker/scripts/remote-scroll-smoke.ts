import 'reflect-metadata';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { signRemoteSessionToken } from '@socio/remote-session-auth';
import { RemoteSessionGateway } from '../src/remote-session/remote-session.gateway';

const secret = 'remote-scroll-fixture-secret-at-least-32-characters';
const sessionId = '00000000-0000-4000-8000-000000000188';
const config = (port: number) => ({ get: (key: string) => ({ remoteSessionPort: port, remoteSessionSecret: secret, redisUrl: 'redis://127.0.0.1:6379', remoteSessionRedisRelay: true })[key] });
async function main() {
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const owner = new RemoteSessionGateway(config(39126) as never);
  const relay = new RemoteSessionGateway(config(39127) as never);
  try {
    const remote = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await remote.setContent(`<style>body{margin:0;height:3500px;background:linear-gradient(white,#aaa)}#nested{position:absolute;left:80px;top:80px;width:320px;height:240px;overflow:scroll;overscroll-behavior:contain}#inside{width:900px;height:1000px;background:linear-gradient(#5b9,#aef)}::-webkit-scrollbar{width:16px;height:16px}::-webkit-scrollbar-thumb{background:#555}::-webkit-scrollbar-track{background:#ddd}button{position:absolute;left:500px;top:80px;width:150px;height:50px}</style><div id="nested" tabindex="0"><div id="inside">Nested scroll fixture</div></div><button onclick="window.clicks=(window.clicks||0)+1">Click fixture</button><script>window.events=[];addEventListener('mousedown',e=>window.events.push(['down',e.buttons]));addEventListener('mouseup',e=>window.events.push(['up',e.buttons]));</script>`);
    await owner.start(); await relay.start();
    await owner.register(sessionId, remote);
    const signed = signRemoteSessionToken(sessionId, secret, 600);
    const ui = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [], commands: any[] = [];
    ui.on('pageerror', error => errors.push(error.message));
    ui.on('websocket', socket => socket.on('framesent', frame => { commands.push(JSON.parse(frame.payload.toString())); }));
    await ui.route('**/api/**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: sessionId, status: 'RUNNING', expiresAt: new Date(Date.now() + 600000).toISOString(), accessUrl: `ws://127.0.0.1:39127/sessions/${sessionId}?token=${signed.token}` }) }));
    await ui.goto(`http://localhost:3000/sessions/${sessionId}`);
    // Request a fresh screencast after the relay subscriber is attached.
    await ui.getByText('Đã kết nối', { exact: true }).waitFor({ timeout: 15000 });
    await remote.evaluate(() => { document.body.style.background = '#eef'; });
    const viewport = ui.getByRole('application');
    await viewport.locator('img').waitFor({ timeout: 10000 });
    await viewport.scrollIntoViewIfNeeded();
    const rect = await viewport.boundingBox(); assert.ok(rect);
    const point = (x: number, y: number) => ({ x: rect.x + x / 1280 * rect.width, y: rect.y + y / 720 * rect.height });
    const move = async (x: number, y: number) => { const p = point(x, y); await ui.mouse.move(p.x, p.y); };
    const wait = async (fn: () => boolean, label: string) => { try { await remote.waitForFunction(fn, undefined, { timeout: 5000 }); } catch { throw new Error(label); } };

    const localY = await ui.evaluate(() => scrollY);
    await move(200, 160); await ui.mouse.wheel(45, 180);
    await wait(() => { const n = document.querySelector('#nested')!; return n.scrollTop > 100 && n.scrollLeft > 20; }, 'Nested diagonal wheel did not scroll');
    assert.equal(await remote.evaluate(() => scrollY), 0, 'Nested wheel must not scroll outer remote page');
    assert.equal(await ui.evaluate(() => scrollY), localY, 'Wheel must not scroll local dashboard');
    await ui.mouse.wheel(0, -180);
    await wait(() => document.querySelector('#nested')!.scrollTop === 0, 'Wheel up failed');

    // DOM_DELTA_LINE from mouse drivers and DOM_DELTA_PAGE from accessibility tools.
    await viewport.dispatchEvent('wheel', { clientX: point(200, 160).x, clientY: point(200, 160).y, deltaY: 2, deltaMode: 1 });
    await wait(() => document.querySelector('#nested')!.scrollTop > 0, 'Line wheel failed');
    await remote.evaluate(() => { document.querySelector('#nested')!.scrollTop = 0; });
    await viewport.dispatchEvent('wheel', { clientX: point(200, 160).x, clientY: point(200, 160).y, deltaY: 1, deltaMode: 2 });
    await wait(() => document.querySelector('#nested')!.scrollTop > 400, 'Page wheel failed');

    await remote.evaluate(() => { const n = document.querySelector('#nested')!; n.scrollTop = 0; n.scrollLeft = 0; });
    await move(392, 96); await ui.mouse.down();
    const end = point(392, 250); await ui.mouse.move(end.x, end.y, { steps: 12 }); await ui.mouse.up();
    try { await wait(() => document.querySelector('#nested')!.scrollTop > 200, 'Scrollbar thumb drag failed'); }
    catch (error) {
      console.log(JSON.stringify({ commands: commands.slice(-20), scroll: await remote.locator('#nested').evaluate(n => ({ top: n.scrollTop, left: n.scrollLeft, client: n.clientWidth, offset: (n as HTMLElement).offsetWidth })) }));
      await remote.screenshot({ path: '../../artifacts/remote-scroll-fixture.png' });
      throw error;
    }

    await move(900, 500); await ui.mouse.wheel(0, 240);
    await wait(() => scrollY > 100, 'Outer page wheel failed');
    await remote.evaluate(() => { window.scrollTo(0, 0); (document.activeElement as HTMLElement)?.blur(); });
    const background = point(900, 400); await ui.mouse.click(background.x, background.y);
    await ui.keyboard.press('PageDown'); await wait(() => scrollY > 100, 'PageDown failed');
    await remote.waitForTimeout(350);
    await ui.keyboard.press('Home'); await wait(() => scrollY === 0, 'Home failed');
    await remote.waitForTimeout(350);
    await ui.keyboard.press('End'); await wait(() => scrollY > 2000, 'End failed');
    await remote.waitForTimeout(350);
    await ui.keyboard.press('Home'); await wait(() => scrollY === 0, 'Home reset failed');
    // Native keyboard scrolling is animated; let Home finish before ArrowDown.
    await remote.waitForTimeout(350);
    await ui.keyboard.press('ArrowDown'); await wait(() => scrollY > 0, 'ArrowDown failed');
    await remote.evaluate(() => window.scrollTo(0, 0));

    const button = point(560, 100); await ui.mouse.click(button.x, button.y);
    await wait(() => (window as any).clicks === 1, 'Click regression/double submission');
    await move(560, 100); await ui.mouse.down();
    await ui.mouse.move(rect.x + rect.width + 20, rect.y + 100); await ui.mouse.up();
    await wait(() => (window as any).events.at(-1)?.[0] === 'up', 'Release outside viewport failed');
    await move(560, 100); await ui.mouse.down();
    await wait(() => (window as any).events.at(-1)?.[0] === 'down', 'Drag start failed');
    await ui.evaluate(() => window.dispatchEvent(new Event('blur')));
    await wait(() => (window as any).events.at(-1)?.[0] === 'up', 'Window blur did not release mouse');
    await ui.mouse.up();

    await move(560, 100); await ui.mouse.down();
    await wait(() => (window as any).events.at(-1)?.[0] === 'down', 'Disconnect drag start failed');
    await ui.close();
    await wait(() => (window as any).events.at(-1)?.[0] === 'up', 'Disconnect over Redis relay did not release mouse');
    assert.deepEqual(errors, []);
    assert.ok(commands.some(c => c.type === 'wheel') && commands.some(c => c.type === 'mouse'));
    console.log('PASS: live Next UI → WebSocket → Redis relay → owner gateway → real Chromium: nested/outer/diagonal scroll, pixel/line/page wheel, scrollbar drag, keyboard navigation, single click, pointer capture, blur/disconnect release. No Facebook/account data used.');
  } finally {
    await browser.close();
    await owner.unregister(sessionId);
    await Promise.all([owner.onModuleDestroy(), relay.onModuleDestroy()]);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
