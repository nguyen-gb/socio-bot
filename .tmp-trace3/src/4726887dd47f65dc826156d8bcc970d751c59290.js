"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserRuntime = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const playwright_1 = require("playwright");
const slot_pool_1 = require("./slot-pool");
const profile_session_cookies_1 = require("./profile-session-cookies");
const browser_process_1 = require("./browser-process");
const deadline_1 = require("./deadline");
class BrowserRuntime {
    profileRoot;
    closeTimeoutMs;
    slots;
    sessions = new Map();
    cookies;
    processes;
    opening = new Map();
    constructor(profileRoot, capacity, encryptionKey, closeTimeoutMs = 8_000) {
        this.profileRoot = profileRoot;
        this.closeTimeoutMs = closeTimeoutMs;
        this.slots = new slot_pool_1.SlotPool(capacity);
        this.cookies = new profile_session_cookies_1.ProfileSessionCookies(encryptionKey);
        this.processes = new browser_process_1.BrowserProcessRegistry(profileRoot);
    }
    get activeSessionCount() {
        return this.sessions.size;
    }
    async openProfile(options) {
        const current = this.sessions.get(options.profileId);
        if (current) {
            if (options.ownerId && current.record.ownerId !== options.ownerId)
                throw new Error('Browser belongs to another session');
            return current.promise;
        }
        const pending = this.opening.get(options.profileId);
        if (pending)
            return pending;
        const promise = this.launch(options);
        this.opening.set(options.profileId, promise);
        try {
            return await promise;
        }
        finally {
            this.opening.delete(options.profileId);
        }
    }
    async launch(options) {
        const lease = await this.slots.acquire(options.slotTimeoutMs);
        const profilePath = (0, node_path_1.resolve)(this.profileRoot, options.profileId);
        let context;
        let record;
        try {
            record = await this.processes.begin(options.profileId, options.ownerId);
            await (0, promises_1.mkdir)(profilePath, { recursive: true });
            const viewport = options.viewport ?? null;
            context = await playwright_1.chromium.launchPersistentContext(profilePath, {
                args: [`--socio-session-token=${record.token}`],
                // Headless Chromium hides native scrollbars by default. Remote users
                // need visible, draggable thumbs just like in a normal browser.
                ignoreDefaultArgs: ['--hide-scrollbars'],
                timeout: 45_000,
                headless: options.headless ?? true,
                channel: options.channel,
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
                proxy: options.proxy,
                recordHar: options.recordHarPath
                    ? { path: options.recordHarPath, content: 'omit', mode: 'minimal' }
                    : undefined,
            });
            await this.processes.identify(record);
            context.setDefaultTimeout(15_000);
            context.setDefaultNavigationTimeout(45_000);
            await (0, deadline_1.withDeadline)(this.cookies.restore(profilePath, options.profileId, context), 10_000, 'Cookie restore timed out');
        }
        catch (error) {
            try {
                if (record)
                    await this.processes.terminate(record);
            }
            finally {
                lease.release();
            }
            throw error;
        }
        const abort = new AbortController();
        const promise = this.createManagedSession(options.profileId, context, lease, record, abort);
        const active = { context, lease, promise, record, abort, persistenceAbort: new AbortController() };
        this.sessions.set(options.profileId, active);
        context.once('close', () => {
            abort.abort(new Error('Browser was closed'));
            // Keep the slot until controlled close/force-close has verified termination.
            if (!this.sessions.get(options.profileId)?.closing && !this.sessions.get(options.profileId)?.forcing) {
                void this.forceCloseProfile(options.profileId, record.ownerId).catch(() => undefined);
            }
        });
        try {
            return await promise;
        }
        catch (error) {
            await this.forceCloseProfile(options.profileId, options.ownerId);
            throw error;
        }
    }
    async withProfile(options, callback) {
        const session = await this.openProfile(options);
        let onAbort;
        try {
            const aborted = new Promise((_, reject) => {
                onAbort = () => reject(session.signal?.reason ?? new Error('Browser closed'));
                session.signal?.addEventListener('abort', onAbort, { once: true });
                if (session.signal?.aborted)
                    onAbort();
            });
            return await (0, deadline_1.withDeadline)(Promise.race([callback(session), aborted]), options.executionTimeoutMs ?? 5 * 60_000, 'Browser task timed out; browser will be terminated');
        }
        finally {
            if (onAbort)
                session.signal?.removeEventListener('abort', onAbort);
            if (options.closeOnComplete !== false)
                await session.close();
        }
    }
    async closeProfile(profileId, ownerId) {
        const active = this.sessions.get(profileId);
        if (!active) {
            const pending = this.opening.get(profileId);
            if (pending) {
                await pending.catch(() => undefined);
                return this.closeProfile(profileId, ownerId);
            }
            return;
        }
        if (ownerId && active.record.ownerId !== ownerId)
            return;
        if (active.forcing)
            return active.forcing;
        if (!active.closing) {
            active.abort.abort(new Error('Browser is closing'));
            active.closing = (async () => {
                try {
                    await (0, deadline_1.withDeadline)((async () => {
                        await this.cookies.save((0, node_path_1.resolve)(this.profileRoot, profileId), profileId, active.context, active.persistenceAbort.signal);
                        await active.context.close();
                    })(), this.closeTimeoutMs, 'Browser close timed out');
                    await this.processes.forget(active.record);
                    this.release(profileId, active);
                }
                catch {
                    await this.forceCloseProfile(profileId, active.record.ownerId);
                }
            })();
        }
        await active.closing;
    }
    async forceCloseProfile(profileId, ownerId) {
        const active = this.sessions.get(profileId);
        if (!active) {
            // Do not race an in-progress launch; its own startup timeout is bounded.
            const pending = this.opening.get(profileId);
            if (pending) {
                await pending.catch(() => undefined);
                return this.forceCloseProfile(profileId, ownerId);
            }
            return this.processes.recover(profileId, ownerId);
        }
        if (ownerId && active.record.ownerId !== ownerId)
            return;
        if (!active.forcing)
            active.forcing = (async () => {
                active.abort.abort(new Error('Browser was force closed'));
                active.persistenceAbort.abort(new Error('Browser cookie save cancelled'));
                await this.processes.terminate(active.record);
                this.release(profileId, active);
            })();
        try {
            await active.forcing;
        }
        catch (error) {
            active.forcing = undefined;
            throw error;
        }
    }
    async closeAll() {
        await Promise.allSettled([...this.sessions.keys()].map((profileId) => this.closeProfile(profileId)));
    }
    async createManagedSession(profileId, context, lease, record, abort) {
        const pages = context.pages();
        const page = pages[0] ?? (await (0, deadline_1.withDeadline)(context.newPage(), 10_000, 'Browser page startup timed out'));
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
    release(profileId, expected) {
        const active = this.sessions.get(profileId);
        if (!active || active !== expected)
            return;
        this.sessions.delete(profileId);
        active.lease.release();
    }
}
exports.BrowserRuntime = BrowserRuntime;
//# sourceMappingURL=browser-runtime.js.map