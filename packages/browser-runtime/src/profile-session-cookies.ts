import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sealSecret, unsealSecret } from '@socio/object-storage';
import type { BrowserContext } from 'playwright';

type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
type LocalStorageEntry = StorageState['origins'][number]['localStorage'][number];
type StorageStateOrigin = StorageState['origins'][number] & {
  indexedDB?: unknown[];
  opfs?: unknown[];
};
type ExtendedStorageState = Omit<StorageState, 'origins'> & {
  origins: StorageStateOrigin[];
};
type StorageStateInput = Exclude<Parameters<BrowserContext['setStorageState']>[0], string>;

interface SessionStorageEntry {
  name: string;
  value: string;
}

interface SavedSessionOrigin {
  origin: string;
  localStorage: LocalStorageEntry[];
  sessionStorage?: SessionStorageEntry[];
  indexedDB?: unknown[];
  opfs?: unknown[];
}

interface SavedSessionCookies {
  version: 1 | 2 | 3;
  profileId: string;
  cookies: Cookie[];
  origins?: SavedSessionOrigin[];
}

export interface ProfileSessionStateOptions {
  /**
   * Explicit first-party origin allowlist. All origin storage persistence is
   * disabled when this is omitted, so callers do not accidentally persist
   * third-party state or secrets from arbitrary pages.
   */
  stateOrigins?: readonly string[];
  /** @deprecated Use stateOrigins. Kept for sidecar/runtime compatibility. */
  localStorageOrigins?: readonly string[];
  /**
   * Restore IndexedDB/OPFS from the encrypted sidecar when the Chromium
   * profile itself is unavailable. A complete profile snapshot already
   * contains these stores, so normal profile restores do not need the
   * destructive setStorageState operation.
   */
  restoreStructuredOriginState?: boolean;
  /**
   * Session storage is scoped to a browser tab and often contains short-lived
   * protocol/IM state. Replaying it after a browser restart can poison the
   * site's bootstrap (for example TikTok's web IM SDK), so it is opt-in.
   */
  persistSessionStorage?: boolean;
}

function normalizeOrigins(origins: readonly string[] | undefined): Set<string> {
  return new Set((origins ?? []).map((value) => {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error(`Invalid session state origin: ${value}`); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Session state origin must use http or https: ${value}`);
    }
    return url.origin;
  }));
}

function configuredOrigins(options: ProfileSessionStateOptions): Set<string> {
  return normalizeOrigins([
    ...(options.stateOrigins ?? []),
    ...(options.localStorageOrigins ?? []),
  ]);
}

function savedOrigins(state: SavedSessionCookies, allowed: Set<string>): SavedSessionOrigin[] {
  if (state.version === 1) return [];
  if (!Array.isArray(state.origins)) throw new Error('Invalid profile session origin state');
  return state.origins
    .filter((entry) => allowed.has(entry.origin))
    .map((entry) => {
      if (!Array.isArray(entry.localStorage)) throw new Error('Invalid profile session localStorage state');
      const sessionStorage = entry.sessionStorage === undefined
        ? undefined
        : entry.sessionStorage.map((item) => {
          if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') {
            throw new Error('Invalid profile session sessionStorage entry');
          }
          return { name: item.name, value: item.value };
        });
      if (entry.indexedDB !== undefined && !Array.isArray(entry.indexedDB)) {
        throw new Error('Invalid profile session IndexedDB state');
      }
      if (entry.opfs !== undefined && !Array.isArray(entry.opfs)) {
        throw new Error('Invalid profile session OPFS state');
      }
      return {
        origin: entry.origin,
        localStorage: entry.localStorage.map((item) => {
          if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') {
            throw new Error('Invalid profile session localStorage entry');
          }
          return { name: item.name, value: item.value };
        }),
        ...(sessionStorage ? { sessionStorage } : {}),
        ...(entry.indexedDB !== undefined ? { indexedDB: entry.indexedDB } : {}),
        ...(entry.opfs !== undefined ? { opfs: entry.opfs } : {}),
      };
    });
}

function cookieKey(cookie: Cookie): string {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
}

function mergeCookies(current: Cookie[], saved: Cookie[]): Cookie[] {
  const merged = new Map(current.map((cookie) => [cookieKey(cookie), cookie] as const));
  for (const cookie of saved) merged.set(cookieKey(cookie), cookie);
  return [...merged.values()];
}

function hasStructuredOriginState(origin: SavedSessionOrigin): boolean {
  return origin.indexedDB !== undefined || origin.opfs !== undefined;
}

async function captureSessionStorage(
  context: BrowserContext,
  allowed: Set<string>,
): Promise<Map<string, SessionStorageEntry[]>> {
  const captured = new Map<string, SessionStorageEntry[]>();
  for (const page of context.pages()) {
    try {
      const origin = new URL(page.url()).origin;
      if (!allowed.has(origin)) continue;
      const entries = await page.evaluate(() => Object.entries(window.sessionStorage)
        .map(([name, value]) => ({ name, value })));
      const merged = new Map((captured.get(origin) ?? []).map((entry) => [entry.name, entry.value] as const));
      for (const entry of entries) merged.set(entry.name, entry.value);
      captured.set(origin, [...merged.entries()].map(([name, value]) => ({ name, value })));
    } catch {
      // A page can close or move to an opaque origin while the browser is
      // shutting down. The persistent profile and other open pages remain
      // valid; skip only that page's ephemeral sessionStorage.
    }
  }
  return captured;
}

// Chromium does not restore session cookies after a clean shutdown. Keep the
// session sidecar encrypted so it fills that gap while the full profile
// snapshot remains the source of truth for durable browser data.
export class ProfileSessionCookies {
  constructor(private readonly encryptionKey: Buffer) {
    if (encryptionKey.length !== 32) throw new Error('Profile cookie encryption key must be exactly 32 bytes');
  }

  async restore(
    profilePath: string,
    profileId: string,
    context: BrowserContext,
    options: ProfileSessionStateOptions = {},
  ): Promise<void> {
    let sealed: string;
    try {
      sealed = await readFile(join(profilePath, 'session-cookies.enc'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const state = unsealSecret<SavedSessionCookies>(sealed, this.encryptionKey);
    if (![1, 2, 3].includes(state.version) || state.profileId !== profileId || !Array.isArray(state.cookies)) {
      throw new Error('Invalid profile session cookie state');
    }

    const allowedOrigins = configuredOrigins(options);
    const origins = savedOrigins(state, allowedOrigins);
    const structuredOrigins = origins.filter(hasStructuredOriginState);
    if (options.restoreStructuredOriginState && structuredOrigins.length) {
      // setStorageState is the Playwright-supported way to recreate IndexedDB
      // and OPFS. It clears the context's current origin storage, so merge the
      // currently visible state first and use it only for sidecar-only profile
      // recovery. A normal profile snapshot already contains these stores.
      const current = await context.storageState({ indexedDB: true, opfs: true }) as unknown as ExtendedStorageState;
      const currentOrigins = new Map(current.origins.map((entry) => [entry.origin, entry] as const));
      for (const saved of structuredOrigins) {
        const currentOrigin = currentOrigins.get(saved.origin);
        currentOrigins.set(saved.origin, {
          origin: saved.origin,
          localStorage: saved.localStorage,
          ...(saved.indexedDB !== undefined ? { indexedDB: saved.indexedDB } : currentOrigin?.indexedDB !== undefined ? { indexedDB: currentOrigin.indexedDB } : {}),
          ...(saved.opfs !== undefined ? { opfs: saved.opfs } : currentOrigin?.opfs !== undefined ? { opfs: currentOrigin.opfs } : {}),
        });
      }
      await context.setStorageState({
        cookies: mergeCookies(current.cookies, state.cookies),
        origins: [...currentOrigins.values()],
      } as StorageStateInput);
    } else if (state.cookies.length) {
      await context.addCookies(state.cookies);
    }

    if (allowedOrigins.size) {
      // Install this before any page navigation so an application can read
      // its own restored state during startup. Session storage is deliberately
      // reset once per tab by default: it is ephemeral browser state, unlike
      // cookies/localStorage/IndexedDB/OPFS, and stale values can make an IM
      // SDK reject an otherwise valid authenticated cookie session.
      await context.addInitScript((saved) => {
        const current = saved.origins.find((entry) => entry.origin === window.location.origin);
        if (!saved.origins.some((entry) => entry.origin === window.location.origin)) return;
        try {
          if (saved.persistSessionStorage) {
            if (current) {
              for (const item of current.sessionStorage ?? []) window.sessionStorage.setItem(item.name, item.value);
            }
          } else if (window.sessionStorage.getItem(saved.resetMarker) !== '1') {
            // A marker makes the reset one-time for this tab. Same-origin
            // navigations keep normal app session state after bootstrap.
            window.sessionStorage.clear();
            window.sessionStorage.setItem(saved.resetMarker, '1');
          }
          if (current) {
            for (const item of current.localStorage) window.localStorage.setItem(item.name, item.value);
          }
        } catch {
          // Storage can be temporarily unavailable in a restricted frame;
          // never prevent the site's own document from loading.
        }
      }, {
        origins: [...allowedOrigins].map(origin => ({
          origin,
          localStorage: origins.find(entry => entry.origin === origin)?.localStorage ?? [],
          ...(options.persistSessionStorage
            ? { sessionStorage: origins.find(entry => entry.origin === origin)?.sessionStorage ?? [] }
            : {}),
        })),
        persistSessionStorage: options.persistSessionStorage === true,
        resetMarker: '__socio_session_bootstrap_v1',
      });
    }
  }

  async save(
    profilePath: string,
    profileId: string,
    context: BrowserContext,
    signal?: AbortSignal,
    options: ProfileSessionStateOptions = {},
  ): Promise<void> {
    const allowedOrigins = configuredOrigins(options);
    const storageState = allowedOrigins.size
      ? await context.storageState({ indexedDB: true, opfs: true }) as unknown as ExtendedStorageState
      : undefined;
    const sessionStorage = options.persistSessionStorage && allowedOrigins.size
      ? await captureSessionStorage(context, allowedOrigins)
      : new Map<string, SessionStorageEntry[]>();
    const cookies = (await context.cookies()).filter(cookie => cookie.expires === -1);
    const stateByOrigin = new Map((storageState?.origins ?? []).map((entry) => [entry.origin, entry] as const));
    const originNames = new Set([
      ...stateByOrigin.keys(),
      ...sessionStorage.keys(),
    ]);
    const origins = [...originNames]
      .filter((origin) => allowedOrigins.has(origin))
      .map((origin) => {
        const entry = stateByOrigin.get(origin);
        return {
          origin,
          localStorage: entry?.localStorage.map((item) => ({ name: item.name, value: item.value })) ?? [],
          sessionStorage: sessionStorage.get(origin) ?? [],
          indexedDB: entry?.indexedDB ?? [],
          opfs: entry?.opfs ?? [],
        };
      });
    signal?.throwIfAborted();
    const sealed = sealSecret({ version: 3, profileId, cookies, origins } satisfies SavedSessionCookies, this.encryptionKey);
    const destination = join(profilePath, 'session-cookies.enc');
    const temporary = join(profilePath, `session-cookies-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, sealed, { mode: 0o600 });
      signal?.throwIfAborted();
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
