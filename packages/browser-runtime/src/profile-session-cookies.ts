import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { sealSecret, unsealSecret } from '@socio/object-storage';
import type { BrowserContext } from 'playwright';

type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];
interface SavedSessionCookies {
  version: 1;
  profileId: string;
  cookies: Cookie[];
}

// Chromium does not restore session cookies after a clean shutdown. Keep them
// encrypted inside the profile so the existing encrypted snapshot includes them.
export class ProfileSessionCookies {
  constructor(private readonly encryptionKey: Buffer) {
    if (encryptionKey.length !== 32) throw new Error('Profile cookie encryption key must be exactly 32 bytes');
  }

  async restore(profilePath: string, profileId: string, context: BrowserContext): Promise<void> {
    let sealed: string;
    try {
      sealed = await readFile(join(profilePath, 'session-cookies.enc'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const state = unsealSecret<SavedSessionCookies>(sealed, this.encryptionKey);
    if (state.version !== 1 || state.profileId !== profileId || !Array.isArray(state.cookies)) {
      throw new Error('Invalid profile session cookie state');
    }
    if (state.cookies.length) await context.addCookies(state.cookies);
  }

  async save(profilePath: string, profileId: string, context: BrowserContext, signal?: AbortSignal): Promise<void> {
    const cookies = (await context.cookies()).filter(cookie => cookie.expires === -1);
    signal?.throwIfAborted();
    const sealed = sealSecret({ version: 1, profileId, cookies } satisfies SavedSessionCookies, this.encryptionKey);
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
