import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { PlatformSession } from '@socio/platform-core';
import { SlotPool, type SlotLease } from './slot-pool';
import { ProfileSessionCookies } from './profile-session-cookies';
import { BrowserProcessRegistry, type BrowserProcessRecord } from './browser-process';
import { withDeadline } from './deadline';

export interface RuntimeProxy {
  server: string;
  username?: string;
  password?: string;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface OpenProfileOptions {
  profileId: string;
  ownerId?: string;
  proxy?: RuntimeProxy;
  headless?: boolean;
  /** Optional installed browser channel, for example `chrome` or `msedge`. */
  channel?: string;
  locale?: string;
  timezoneId?: string;
  /** `null` follows the native browser window size, like a normal Chrome window. */
  viewport?: BrowserViewport | null;
  slotTimeoutMs?: number;
  recordHarPath?: string;
  executionTimeoutMs?: number;
  /** Keep the session alive until the caller has persisted the task result. */
  closeOnComplete?: boolean;
  /** Use a clean, non-persistent user-data directory and remove it on close. */
  ephemeral?: boolean;
  /** Send the standard Do Not Track preference without changing browser identity. */
  privacyMode?: boolean;
}

export interface ManagedBrowserSession extends PlatformSession {
  context: BrowserContext;
  page: Page;
  slot: number;
  processId?: number;
  signal?: AbortSignal;
  close(): Promise<void>;
}

interface ActiveSession {
  context: BrowserContext;
  profilePath: string;
  ephemeral: boolean;
  lease: SlotLease;
  promise: Promise<ManagedBrowserSession>;
  closing?: Promise<void>;
  record: BrowserProcessRecord;
  abort: AbortController;
  forcing?: Promise<void>;
  persistenceAbort: AbortController;
}

export class BrowserRuntime {
  private readonly slots: SlotPool;
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly cookies: ProfileSessionCookies;
  private readonly processes: BrowserProcessRegistry;
  private readonly opening = new Map<string, Promise<ManagedBrowserSession>>();

  constructor(
    private readonly profileRoot: string,
    capacity: number,
    encryptionKey: Buffer,
    private readonly closeTimeoutMs = 8_000,
  ) {
    this.slots = new SlotPool(capacity);
    this.cookies = new ProfileSessionCookies(encryptionKey);
    this.processes = new BrowserProcessRegistry(profileRoot);
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  async openProfile(options: OpenProfileOptions): Promise<ManagedBrowserSession> {
    const current = this.sessions.get(options.profileId);
    if (current) {
      if (options.ownerId && current.record.ownerId !== options.ownerId) throw new Error('Browser belongs to another session');
      return current.promise;
    }
    const pending = this.opening.get(options.profileId);
    if (pending) return pending;
    const promise = this.launch(options);
    this.opening.set(options.profileId, promise);
    try { return await promise; }
    finally { this.opening.delete(options.profileId); }
  }

  private async launch(options: OpenProfileOptions): Promise<ManagedBrowserSession> {
    const lease = await this.slots.acquire(options.slotTimeoutMs);
    const profilePath = resolve(this.profileRoot, options.profileId);
    let context: BrowserContext | undefined;
    let record: BrowserProcessRecord | undefined;
    try {
      record = await this.processes.begin(options.profileId, options.ownerId);
      await mkdir(profilePath, { recursive: true });
      const viewport = options.viewport ?? null;
      const headless = options.headless ?? true;
      context = await chromium.launchPersistentContext(profilePath, {
        args: [
          `--socio-session-token=${record.token}`,
          // With viewport:null, this gives headed local runs the same initial
          // window behavior as a manually opened Chrome window. It is not
          // used in headless/container runs.
          ...(!headless ? ['--start-maximized'] : []),
        ],
        // Headless Chromium hides native scrollbars by default. Remote users
        // need visible, draggable thumbs just like in a normal browser.
        ignoreDefaultArgs: ['--hide-scrollbars'],
        timeout: 45_000,
        headless,
        channel: options.channel,
        // Playwright otherwise adds --no-sandbox by default. Keep the real
        // Chromium sandbox enabled so headed Chrome does not show the
        // unsupported command-line flag warning and retains normal isolation.
        chromiumSandbox: true,
        // Keep the page surface close to a regular Chrome window. Do not
        // override user-agent or webdriver signals to evade CAPTCHA.
        viewport,
        ...(viewport ? { deviceScaleFactor: 1 } : {}),
        isMobile: false,
        hasTouch: false,
        colorScheme: 'light',
        reducedMotion: 'no-preference',
        locale: options.locale,
        timezoneId: options.timezoneId,
        // Do not inject a DNT header. Chrome does not send it by default, and
        // forcing a privacy header makes the anonymous search profile less
        // like an ordinary user-created Chrome profile without reliably
        // preventing tracking.
        proxy: options.proxy,
        recordHar: options.recordHarPath
          ? { path: options.recordHarPath, content: 'omit', mode: 'minimal' }
          : undefined,
      });
      await this.processes.identify(record);
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(45_000);
      if (!options.ephemeral) {
        await withDeadline(this.cookies.restore(profilePath, options.profileId, context), 10_000, 'Cookie restore timed out');
      }
    } catch (error) {
      try {
        if (record) await this.processes.terminate(record);
      } finally {
        lease.release();
        if (options.ephemeral) await this.removeEphemeralProfile(profilePath);
      }
      throw error;
    }

    const abort = new AbortController();
    const promise = this.createManagedSession(options.profileId, context, lease, record, abort);
    const active = {
      context,
      profilePath,
      ephemeral: options.ephemeral === true,
      lease,
      promise,
      record,
      abort,
      persistenceAbort: new AbortController(),
    };
    this.sessions.set(options.profileId, active);
    context.once('close', () => {
      abort.abort(new Error('Browser was closed'));
      // Keep the slot until controlled close/force-close has verified termination.
      if (!this.sessions.get(options.profileId)?.closing && !this.sessions.get(options.profileId)?.forcing) {
        void this.forceCloseProfile(options.profileId, record.ownerId).catch(() => undefined);
      }
    });
    try { return await promise; }
    catch (error) { await this.forceCloseProfile(options.profileId, options.ownerId); throw error; }
  }

  async withProfile<T>(
    options: OpenProfileOptions,
    callback: (session: ManagedBrowserSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.openProfile(options);
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(session.signal?.reason ?? new Error('Browser closed'));
        session.signal?.addEventListener('abort', onAbort, { once: true });
        if (session.signal?.aborted) onAbort();
      });
      return await withDeadline(Promise.race([callback(session), aborted]), options.executionTimeoutMs ?? 5 * 60_000, 'Browser task timed out; browser will be terminated');
    } finally {
      if (onAbort) session.signal?.removeEventListener('abort', onAbort);
      if (options.closeOnComplete !== false) await session.close();
    }
  }

  async closeProfile(profileId: string, ownerId?: string): Promise<void> {
    const active = this.sessions.get(profileId);
    if (!active) {
      const pending = this.opening.get(profileId);
      if (pending) { await pending.catch(() => undefined); return this.closeProfile(profileId, ownerId); }
      return;
    }
    if (ownerId && active.record.ownerId !== ownerId) return;
    if (active.forcing) return active.forcing;
    if (!active.closing) {
      active.abort.abort(new Error('Browser is closing'));
      active.closing = (async () => {
        try {
          await withDeadline((async () => {
            if (!active.ephemeral) {
              await this.cookies.save(active.profilePath, profileId, active.context, active.persistenceAbort.signal);
            }
            await active.context.close();
            if (active.ephemeral) await this.removeEphemeralProfile(active.profilePath);
          })(), this.closeTimeoutMs, 'Browser close timed out');
          await this.processes.forget(active.record);
          this.release(profileId, active);
        } catch {
          await this.forceCloseProfile(profileId, active.record.ownerId);
        }
      })();
    }
    await active.closing;
  }

  async forceCloseProfile(profileId: string, ownerId?: string): Promise<void> {
    const active = this.sessions.get(profileId);
    if (!active) {
      // Do not race an in-progress launch; its own startup timeout is bounded.
      const pending = this.opening.get(profileId);
      if (pending) { await pending.catch(() => undefined); return this.forceCloseProfile(profileId, ownerId); }
      return this.processes.recover(profileId, ownerId);
    }
    if (ownerId && active.record.ownerId !== ownerId) return;
    if (!active.forcing) active.forcing = (async () => {
      active.abort.abort(new Error('Browser was force closed'));
      active.persistenceAbort.abort(new Error('Browser cookie save cancelled'));
      await this.processes.terminate(active.record);
      if (active.ephemeral) await this.removeEphemeralProfile(active.profilePath);
      this.release(profileId, active);
    })();
    try { await active.forcing; }
    catch (error) { active.forcing = undefined; throw error; }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions.keys()].map((profileId) => this.closeProfile(profileId)),
    );
  }

  private async createManagedSession(
    profileId: string,
    context: BrowserContext,
    lease: SlotLease,
    record: BrowserProcessRecord,
    abort: AbortController,
  ): Promise<ManagedBrowserSession> {
    const pages = context.pages();
    const page = pages[0] ?? (await withDeadline(context.newPage(), 10_000, 'Browser page startup timed out'));

    return {
      context,
      page,
      profileId,
      slot: lease.slot,
      processId: record.pid,
      signal: abort.signal,
      close: () => this.sessions.get(profileId)?.record === record ? this.closeProfile(profileId, record.ownerId) : Promise.resolve(),
    };
  }

  private release(profileId: string, expected: ActiveSession): void {
    const active = this.sessions.get(profileId);
    if (!active || active !== expected) return;
    this.sessions.delete(profileId);
    active.lease.release();
  }

  private async removeEphemeralProfile(profilePath: string): Promise<void> {
    await rm(profilePath, { recursive: true, force: true });
  }
}
