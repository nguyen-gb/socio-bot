import { randomUUID } from 'node:crypto';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import { withDeadline } from '@socio/browser-runtime';

/** One interactive browser context, never tabs from another profile/session. */
export class RemoteBrowser {
  readonly pages = new Map<string, Page>();
  activeId = '';
  cdp!: CDPSession;
  private context: BrowserContext;
  private tail = Promise.resolve();
  private disposed = false;
  private timer?: ReturnType<typeof setInterval>;
  private lastState = '';
  private listeners = new Map<Page, () => void>();
  private onPage = (page: Page) => { this.track(page); void this.run(() => this.activate(page)).catch(() => undefined); };
  constructor(page: Page, private emit: (message: { type: string; [key: string]: unknown }) => void, private release: (cdp: CDPSession) => Promise<void>) { this.context = page.context(); }
  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => { if (this.disposed) throw new Error('Phiên đã đóng'); return work(); });
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
  async start(page: Page) {
    for (const tab of this.context.pages()) this.track(tab);
    this.context.on('page', this.onPage);
    await this.activate(page);
    this.timer = setInterval(() => { void this.run(() => this.state()).catch(() => undefined); }, 1000);
    this.timer.unref();
  }
  private track(page: Page): string {
    for (const [id, existing] of this.pages) if (existing === page) return id;
    const id = randomUUID(); this.pages.set(id, page);
    const closed = () => { this.pages.delete(id); this.listeners.delete(page); void this.run(async () => {
      if (this.activeId === id) await this.activate([...this.pages.values()].find(p => !p.isClosed()) ?? await this.context.newPage());
      else await this.state(true);
    }).catch(() => undefined); };
    this.listeners.set(page, closed); page.on('close', closed);
    return id;
  }
  async activate(page: Page) {
    if (page.isClosed()) return;
    const id = this.track(page);
    if (this.activeId === id) { await this.state(true); return; }
    if (this.cdp) {
      await this.release(this.cdp).catch(() => undefined);
      await withDeadline(this.cdp.detach(), 2000, 'Detach timed out').catch(() => undefined);
    }
    this.activeId = id;
    this.emit({ type: 'tabChanging', activeTabId: id });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.bringToFront();
    const cdp = await this.context.newCDPSession(page); this.cdp = cdp;
    cdp.on('Page.screencastFrame', event => {
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
      if (!this.disposed && this.cdp === cdp) this.emit({ type: 'frame', tabId: id, data: event.data, width: 1280, height: 720 });
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 72, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    await this.state(true);
  }
  async state(force = false) {
    const tabs = await Promise.all([...this.pages].filter(([, p]) => !p.isClosed()).map(async ([id, p]) => ({ id, url: p.url(), title: await withDeadline(p.title(), 1500, 'Title timed out').catch(() => '') })));
    const history = await this.cdp.send('Page.getNavigationHistory').catch(() => ({ currentIndex: 0, entries: [] }));
    const state = { type: 'browserState', activeTabId: this.activeId, tabs, canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1 };
    const encoded = JSON.stringify(state);
    if (force || encoded !== this.lastState) { this.lastState = encoded; this.emit(state); }
  }
  get activePage() { return this.pages.get(this.activeId); }
  async command(command: { type: string; url?: string; action?: string; tabId?: string }): Promise<boolean> {
    const page = this.activePage;
    if (command.type === 'browserState') { await this.state(true); return true; }
    if (command.type === 'newTab') {
      if (this.pages.size >= 20) throw new Error('Tối đa 20 tab trong một phiên');
      await this.activate(await this.context.newPage());
    } else if (command.type === 'selectTab' || command.type === 'closeTab') {
      const target = this.pages.get(command.tabId!);
      if (!target || target.isClosed()) throw new Error('Tab đã đóng hoặc không thuộc phiên này');
      if (command.type === 'selectTab') await this.activate(target);
      else {
        if (this.pages.size === 1) await this.activate(await this.context.newPage());
        else if (target === page) await this.activate([...this.pages.values()].find(p => p !== target && !p.isClosed())!);
        await target.close({ runBeforeUnload: false });
      }
    } else if (command.type === 'navigate' && page) {
      await page.goto(command.url!, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else if (command.type === 'navigation' && page) {
      const options = { waitUntil: 'domcontentloaded' as const, timeout: 20000 };
      if (command.action === 'back') await page.goBack(options);
      else if (command.action === 'forward') await page.goForward(options);
      else await page.reload(options);
    } else return false;
    await this.state(true); return true;
  }
  async dispose() {
    this.disposed = true; clearInterval(this.timer);
    this.context.off('page', this.onPage);
    for (const [page, listener] of this.listeners) page.off('close', listener);
    this.listeners.clear();
    if (this.cdp) await withDeadline(this.cdp.detach(), 2000, 'Detach timed out').catch(() => undefined);
  }
}
