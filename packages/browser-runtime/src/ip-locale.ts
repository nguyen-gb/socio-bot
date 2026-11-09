import { request } from 'playwright';
import type { RuntimeProxy } from './browser-runtime';

export interface BrowserLocaleEnvironment {
  locale: string;
  languages: string[];
  timezoneId: string;
  source: 'proxy-ip' | 'default';
}

interface IpLocation {
  countryCode: string;
  timezoneId: string;
}

export function parseIpLocationResponse(value: unknown): IpLocation {
  const response = value as {
    success?: unknown;
    data?: { countryCode?: unknown; timezone?: { time_zone?: unknown } };
    countryCode?: unknown;
    timezone?: { time_zone?: unknown };
  };
  const data = response?.data ?? response;
  if (response?.success === false
    || typeof data?.countryCode !== 'string'
    || typeof data?.timezone?.time_zone !== 'string') {
    throw new Error('IP geolocation response is incomplete');
  }
  new Intl.DateTimeFormat('en-US', { timeZone: data.timezone.time_zone });
  return { countryCode: data.countryCode, timezoneId: data.timezone.time_zone };
}

const COUNTRY_LOCALES: Readonly<Record<string, string>> = {
  AE: 'ar-AE', AR: 'es-AR', AT: 'de-AT', AU: 'en-AU', BE: 'nl-BE',
  BR: 'pt-BR', CA: 'en-CA', CH: 'de-CH', CL: 'es-CL', CN: 'zh-CN',
  CO: 'es-CO', CZ: 'cs-CZ', DE: 'de-DE', DK: 'da-DK', ES: 'es-ES',
  FI: 'fi-FI', FR: 'fr-FR', GB: 'en-GB', GR: 'el-GR', HK: 'zh-HK',
  HU: 'hu-HU', ID: 'id-ID', IE: 'en-IE', IL: 'he-IL', IN: 'hi-IN',
  IT: 'it-IT', JP: 'ja-JP', KR: 'ko-KR', MX: 'es-MX', MY: 'ms-MY',
  NL: 'nl-NL', NO: 'nb-NO', NZ: 'en-NZ', PH: 'en-PH', PL: 'pl-PL',
  PT: 'pt-PT', RO: 'ro-RO', RU: 'ru-RU', SA: 'ar-SA', SE: 'sv-SE',
  SG: 'en-SG', TH: 'th-TH', TR: 'tr-TR', TW: 'zh-TW', UA: 'uk-UA',
  US: 'en-US', VN: 'vi-VN', ZA: 'en-ZA',
};

function canonicalLocale(value: string): string {
  return Intl.getCanonicalLocales(value)[0] ?? value;
}

export function languagesForLocale(value: string): string[] {
  const locale = new Intl.Locale(canonicalLocale(value));
  const script = locale.script ? `${locale.language}-${locale.script}` : undefined;
  return [locale.toString(), script, locale.language]
    .filter((item): item is string => Boolean(item))
    .filter((item, index, items) => items.indexOf(item) === index);
}

export function localeForCountry(countryCode: string): string {
  const region = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) throw new Error('IP geolocation returned an invalid country code');
  const known = COUNTRY_LOCALES[region];
  if (known) return known;
  const likely = new Intl.Locale(`und-${region}`).maximize();
  return canonicalLocale(`${likely.language}-${region}`);
}

function defaultEnvironment(defaults: { locale?: string; timezoneId?: string }): BrowserLocaleEnvironment {
  const locale = canonicalLocale(defaults.locale ?? new Intl.DateTimeFormat().resolvedOptions().locale ?? 'en-US');
  const timezoneId = defaults.timezoneId
    ?? new Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? 'UTC';
  new Intl.DateTimeFormat('en-US', { timeZone: timezoneId });
  return { locale, languages: languagesForLocale(locale), timezoneId, source: 'default' };
}

async function lookupThroughProxy(proxy: RuntimeProxy): Promise<IpLocation> {
  const context = await request.newContext({
    proxy,
    extraHTTPHeaders: { accept: 'application/json' },
  });
  try {
    const endpoint = process.env.BROWSER_IP_GEOLOCATION_URL ?? 'https://api.ipwho.org/me';
    const response = await context.get(endpoint, { timeout: 8_000, failOnStatusCode: true });
    return parseIpLocationResponse(await response.json());
  } finally {
    await context.dispose();
  }
}

/** Resolve and validate the locale environment through the proxy itself. */
export async function resolveProxyLocale(proxy: RuntimeProxy): Promise<BrowserLocaleEnvironment> {
  const location = await lookupThroughProxy(proxy);
  const locale = localeForCountry(location.countryCode);
  return {
    locale,
    languages: languagesForLocale(locale),
    timezoneId: location.timezoneId,
    source: 'proxy-ip',
  };
}

/**
 * Resolve locale through the same proxy used by Chromium. No-proxy sessions
 * deliberately use worker defaults and make no external geolocation request.
 * Lookup failures also fall back so a third-party outage cannot block login.
 */
export async function resolveBrowserLocale(
  proxy: RuntimeProxy | undefined,
  defaults: { locale?: string; timezoneId?: string },
  lookup: (proxy: RuntimeProxy) => Promise<IpLocation> = lookupThroughProxy,
): Promise<BrowserLocaleEnvironment> {
  const fallback = defaultEnvironment(defaults);
  if (!proxy) return fallback;
  try {
    const location = lookup === lookupThroughProxy
      ? undefined
      : await lookup(proxy);
    if (!location) return await resolveProxyLocale(proxy);
    const locale = localeForCountry(location.countryCode);
    return {
      locale,
      languages: languagesForLocale(locale),
      timezoneId: location.timezoneId,
      source: 'proxy-ip',
    };
  } catch {
    return fallback;
  }
}
