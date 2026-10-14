import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sealSecret, unsealSecret } from '@socio/object-storage';
import type { BrowserContext } from 'playwright';

type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];
type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;
type LocalStorageEntry = StorageState['origins'][number]['localStorage'][number];

interface SavedSessionOrigin {
  origin: string;
  localStorage: LocalStorageEntry[];
}

interface SavedSessionCookies {
  version: 1 | 2;
  profileId: string;
  cookies: Cookie[];
  origins?: SavedSessionOrigin[];
}

export interface ProfileSessionStateOptions {
  /**
   * Explicit first-party origin allowlist. LocalStorage persistence is
   * disabled when this is omitted, so callers do not accidentally persist
   * third-party state or secrets from arbitrary pages.
   */
  localStorageOrigins?: readonly string[];
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

function savedOrigins(state: SavedSessionCookies, allowed: Set<string>): SavedSessionOrigin[] {
  if (state.version === 1) return [];
  if (!Array.isArray(state.origins)) throw new Error('Invalid profile session localStorage state');
  return state.origins
    .filter((entry) => allowed.has(entry.origin))
    .map((entry) => {
      if (!Array.isArray(entry.localStorage)) throw new Error('Invalid profile session localStorage state');
      return {
        origin: entry.origin,
        localStorage: entry.localStorage.map((item) => {
          if (!item || typeof item.name !== 'string' || typeof item.value !== 'string') {
            throw new Error('Invalid profile session localStorage entry');
          }
          return { name: item.name, value: item.value };
        }),
      };
    });
}

// Chromium does not restore session cookies after a clean shutdown. Keep them
// encrypted inside the profile so the existing encrypted snapshot includes
// session cookies and any explicitly allowlisted localStorage state.
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
    if (![1, 2].includes(state.version) || state.profileId !== profileId || !Array.isArray(state.cookies)) {
      throw new Error('Invalid profile session cookie state');
    }
    if (state.cookies.length) await context.addCookies(state.cookies);

    const origins = savedOrigins(state, normalizeOrigins(options.localStorageOrigins));
    if (origins.length) {
      // Install this before any page navigation so an application can read
      // its own restored state during startup. This is state restoration, not
      // browser fingerprint modification.
      await context.addInitScript((saved) => {
        const current = saved.find((entry) => entry.origin === window.location.origin);
        if (!current) return;
        for (const item of current.localStorage) window.localStorage.setItem(item.name, item.value);
      }, origins);
    }
  }

  async save(
    profilePath: string,
    profileId: string,
    context: BrowserContext,
    signal?: AbortSignal,
    options: ProfileSessionStateOptions = {},
  ): Promise<void> {
    const allowedOrigins = normalizeOrigins(options.localStorageOrigins);
    const storageState = allowedOrigins.size ? await context.storageState() : undefined;
    const cookies = (await context.cookies()).filter(cookie => cookie.expires === -1);
    const origins = storageState?.origins
      .filter((entry) => allowedOrigins.has(entry.origin))
      .map((entry) => ({
        origin: entry.origin,
        localStorage: entry.localStorage.map((item) => ({ name: item.name, value: item.value })),
      })) ?? [];
    signal?.throwIfAborted();
    const sealed = sealSecret({ version: 2, profileId, cookies, origins } satisfies SavedSessionCookies, this.encryptionKey);
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
