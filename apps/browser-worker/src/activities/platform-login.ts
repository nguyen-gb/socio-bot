import type { ManagedBrowserSession } from '@socio/browser-runtime';
import { gotoPlatformPage } from '@socio/platform-core';
import type { BrowserContext } from 'playwright';
import type { ProfileCredentials } from '../secrets/secrets.service';
import { classifyChallengePage } from './challenge-signals';

export const PLATFORM_LOGIN = {
  FACEBOOK: { home: 'https://www.facebook.com/', login: 'https://www.facebook.com/login/', authCookies: ['c_user'] },
  INSTAGRAM: { home: 'https://www.instagram.com/', login: 'https://www.instagram.com/accounts/login/', authCookies: ['sessionid'] },
  X: { home: 'https://x.com/home', login: 'https://x.com/i/flow/login', authCookies: ['auth_token'] },
  TIKTOK: { home: 'https://www.tiktok.com/', login: 'https://www.tiktok.com/login', authCookies: ['sessionid', 'sessionid_ss'] },
} as const;
export type SupportedPlatform = keyof typeof PLATFORM_LOGIN;
type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];

export function profileLoginSettings(value: unknown): { credentialsRef?: string } {
  const metadata = asRecord(value);
  return typeof metadata.credentialsRef === 'string' ? { credentialsRef: metadata.credentialsRef } : {};
}

async function hasAuthCookie(session: ManagedBrowserSession, platform: SupportedPlatform): Promise<boolean> {
  const settings = PLATFORM_LOGIN[platform];
  return (await session.context.cookies(settings.home)).some(cookie => settings.authCookies.includes(cookie.name as never) && !!cookie.value);
}

export async function isPlatformChallenged(
  session: ManagedBrowserSession,
  platform?: SupportedPlatform,
): Promise<boolean> {
  const url = session.page.url();
  // Route-only checks are fast and work even if the tab is no longer usable.
  if (classifyChallengePage({ url })) return true;
  try {
    // Query visible elements directly: the first matching element may be
    // hidden while another CAPTCHA iframe/dialog is visible.
    const widgetSelectors = [
      'iframe[src*="captcha" i]:visible',
      'iframe[src*="recaptcha" i]:visible',
      'iframe[src*="hcaptcha" i]:visible',
      'iframe[src*="challenges.cloudflare.com" i]:visible',
      'input[name="captcha_response"]:visible',
      '[class*="bdturing" i]:visible',
      '[id*="bdturing" i]:visible',
      ...(platform === 'TIKTOK' ? [
        '[data-e2e*="captcha" i]:visible',
        '[data-e2e*="bdturing" i]:visible',
      ] : []),
    ];
    const visibleWidget = await session.page.locator(widgetSelectors.join(',')).first().isVisible();
    if (visibleWidget) return true;
  } catch { /* A closed page cannot be inspected; never classify as verified. */ }
  try {
    const snapshot = await session.page.evaluate((platformName?: string) => {
      const visible = (element: Element) => {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const foregroundText = [...document.querySelectorAll('h1,h2,[role="alert"],[role="dialog"]')]
        .filter(visible).slice(0, 8).map(element => (element as HTMLElement).innerText || '').join(' ').slice(0, 1200);
      const visibleChallengeText = platformName === 'TIKTOK'
        ? [...document.querySelectorAll<HTMLElement>([
          '[data-e2e*="captcha" i]',
          '[data-e2e*="verify" i]',
          '[class*="captcha" i]',
          '[class*="verify" i]',
          '[class*="bdturing" i]',
          '[id*="captcha" i]',
          '[id*="verify" i]',
          '[id*="bdturing" i]',
        ].join(','))]
          .filter(visible)
          .slice(0, 8)
          .map(element => `${element.innerText || ''} ${element.getAttribute('aria-label') || ''}`)
          .join(' ')
          .trim()
          .slice(0, 1200)
        : '';
      return { title: document.title, foregroundText, visibleChallengeText, bodyText: document.body?.innerText?.trim().slice(0, 401) ?? '' };
    }, platform);
    return classifyChallengePage({ url, ...snapshot }) !== null;
  } catch {
    return false;
  }
}

export async function isPlatformAuthenticated(session: ManagedBrowserSession, platform: SupportedPlatform): Promise<boolean> {
  let url: URL;
  try { url = new URL(session.page.url()); } catch { return false; }
  const baseHost = new URL(PLATFORM_LOGIN[platform].home).hostname.replace(/^www\./, '');
  if (url.hostname !== baseHost && !url.hostname.endsWith(`.${baseHost}`)) return false;
  if (/\/(login|checkpoint|challenge|captcha)(\/|$)/i.test(url.pathname) || await isPlatformChallenged(session, platform)) return false;
  if (!(await hasAuthCookie(session, platform))) return false;
  if (await session.page.locator('input[type="password"]:visible').first().isVisible()) return false;
  if (platform === 'FACEBOOK') {
    if (await session.page.locator('input[name="email"]:visible,input[name="pass"]:visible').first().isVisible()) return false;
    // Do not mistake an imported c_user on an unloaded/login page for a valid session.
    return session.page.locator('[role="navigation"]:visible').first().isVisible();
  }
  return true;
}

export async function initializePlatformSession(
  session: ManagedBrowserSession,
  platform: SupportedPlatform,
  credentials?: ProfileCredentials,
): Promise<void> {
  const settings = PLATFORM_LOGIN[platform];
  if (!settings) throw new Error(`Unsupported login platform: ${String(platform)}`);
  // Prefer the latest browser session over potentially stale imported credentials.
  // Legacy snapshots have no session-cookie sidecar, so seed missing auth cookies.
  let importedCookies = false;
  if (credentials?.cookies && !(await hasAuthCookie(session, platform))) {
    try { await session.context.addCookies(parseCookieInput(credentials.cookies, settings.home)); importedCookies = true; }
    catch { /* Invalid imports must not prevent password/manual fallback. */ }
  }
  await gotoPlatformPage(
    session.page,
    settings.home,
    platform === 'TIKTOK' ? settings.login : undefined,
  );
  await waitForLoginPage(session, platform);
  if (await isPlatformChallenged(session, platform) || await isPlatformAuthenticated(session, platform)) return;
  if (credentials?.cookies && !importedCookies) {
    try {
      const cookies = parseCookieInput(credentials.cookies, settings.home);
      await session.context.addCookies(cookies);
      await gotoPlatformPage(
        session.page,
        settings.home,
        platform === 'TIKTOK' ? settings.login : undefined,
      );
      await waitForLoginPage(session, platform);
    } catch { /* A stale/invalid import must not suppress password/manual fallback. */ }
    if (await isPlatformChallenged(session, platform) || await isPlatformAuthenticated(session, platform)) return;
  }
  if (credentials?.login && credentials.password) {
    if (!session.page.url().includes('/login')) {
      await gotoPlatformPage(session.page, settings.login);
    }
    await attemptPasswordLogin(platform, session, { login: credentials.login, password: credentials.password });
    await waitForLoginPage(session, platform);
  }
}

async function waitForLoginPage(session: ManagedBrowserSession, platform: SupportedPlatform): Promise<void> {
  if (platform !== 'FACEBOOK') { await session.page.waitForTimeout(1500); return; }
  await session.page.locator('[role="navigation"]:visible,input[name="email"]:visible,input[name="pass"]:visible,iframe[src*="captcha"]:visible,input[name="captcha_response"]:visible')
    .first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
}

async function attemptPasswordLogin(platform: SupportedPlatform, session: ManagedBrowserSession, credentials: { login: string; password: string }): Promise<void> {
  const page = session.page;
  try {
    if (platform === 'FACEBOOK') {
      await page.locator('input[name="email"]').fill(credentials.login);
      await page.locator('input[name="pass"]').fill(credentials.password);
      await page.locator('button[name="login"]').click();
    } else if (platform === 'INSTAGRAM') {
      await page.locator('input[name="username"]').fill(credentials.login);
      await page.locator('input[name="password"]').fill(credentials.password);
      await page.locator('button[type="submit"]').click();
    } else if (platform === 'X') {
      const login = page.locator('input[autocomplete="username"]').first();
      await login.waitFor({ state: 'visible', timeout: 15_000 });
      await login.fill(credentials.login);
      await login.press('Enter');
      const password = page.locator('input[name="password"]').first();
      await password.waitFor({ state: 'visible', timeout: 15_000 });
      await password.fill(credentials.password);
      await password.press('Enter');
    } else {
      const login = page.locator('input[name="username"],input[type="text"]').first();
      await login.waitFor({ state: 'visible', timeout: 15_000 });
      await login.fill(credentials.login);
      await page.locator('input[type="password"]').first().fill(credentials.password);
      await page.locator('input[type="password"]').first().press('Enter');
    }
  } catch { /* Leave challenge/unrecognized forms for the operator. */ }
}

export function parseCookieInput(input: string, targetUrl: string): BrowserCookie[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Cookie input is empty');
  if (!trimmed.startsWith('[')) return trimmed.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=');
    if (separator <= 0) throw new Error('Invalid cookie header');
    return { name: part.slice(0, separator).trim(), value: part.slice(separator + 1).trim(), url: targetUrl };
  });
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('Cookie JSON must be a non-empty array');
  const targetHost = new URL(targetUrl).hostname;
  return parsed.map(entry => {
    const cookie = asRecord(entry);
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string') throw new Error('Every cookie requires string name and value');
    const domain = typeof cookie.domain === 'string' ? cookie.domain : undefined;
    if (domain) {
      const normalized = domain.replace(/^\./, '').toLowerCase();
      if (targetHost !== normalized && !targetHost.endsWith(`.${normalized}`)) throw new Error(`Cookie domain ${domain} does not match ${targetHost}`);
    }
    const sameSite = cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax' || cookie.sameSite === 'None' ? cookie.sameSite : undefined;
    return {
      name: cookie.name, value: cookie.value,
      ...(domain ? { domain, path: typeof cookie.path === 'string' ? cookie.path : '/' } : { url: targetUrl }),
      ...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
      ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
      ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
      ...(sameSite ? { sameSite } : {}),
    } satisfies BrowserCookie;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
