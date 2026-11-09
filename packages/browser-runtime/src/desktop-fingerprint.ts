import { FingerprintGenerator, type BrowserFingerprintWithHeaders } from 'fingerprint-generator';
import { FingerprintInjector } from 'fingerprint-injector';
import type { BrowserContext, Page } from 'playwright';
import type { FingerprintEmulationConfig } from './fingerprint-emulation';
import { withDeadline } from './deadline';

export interface DesktopFingerprint {
  schema: 2;
  provider: 'apify-2.1.89';
  bundle: BrowserFingerprintWithHeaders;
  coverage: {
    applied: readonly string[];
    native: readonly string[];
    unsupported: readonly string[];
  };
}

let generator: FingerprintGenerator | undefined;
const registrations = new WeakMap<BrowserContext, unknown[]>();
const COVERAGE: DesktopFingerprint['coverage'] = {
  applied: ['navigator', 'userAgentData', 'screen', 'window', 'intl', 'webgl', 'codecs', 'battery'],
  native: ['canvas', 'history', 'sharedArrayBuffer', 'plugins', 'fonts', 'mediaDevices', 'webrtc', 'webgpu'],
  unsupported: ['workerInjection', 'tls', 'http2Transport'],
};

function safeInjectableScript(bundle: BrowserFingerprintWithHeaders): string {
  const generated = new FingerprintInjector().getInjectableScript(bundle);
  // The upstream injector randomizes history.length each time a script is
  // generated and hides SharedArrayBuffer even on a cross-origin-isolated page.
  // Both differ from stock Chrome behavior. Keep those browser-owned surfaces
  // native while retaining every supported Apify device override.
  const historyPattern = /\s*overrideInstancePrototype\(window\.history,\s*\{\s*length: historyLength,\s*\}\);/;
  const staticPattern = /\s*overrideStatic\(\);/;
  if (!historyPattern.test(generated) || !staticPattern.test(generated)) {
    throw new Error('Unsupported Apify injector source; safety adapter must be reviewed');
  }
  return generated.replace(historyPattern, '').replace(staticPattern, '');
}

function validateGeneratedBundle(bundle: BrowserFingerprintWithHeaders): void {
  const fingerprint = bundle?.fingerprint;
  const navigator = fingerprint?.navigator;
  const screen = fingerprint?.screen;
  const videoCard = fingerprint?.videoCard;
  const validCodecs = (value: unknown) => value && typeof value === 'object'
    && Object.values(value as Record<string, unknown>).every(item => typeof item === 'string');
  if (!fingerprint || !navigator || !screen || !videoCard
    || typeof navigator.userAgent !== 'string'
    || !Array.isArray(navigator.languages) || navigator.languages.length < 1
    || !Number.isInteger(navigator.hardwareConcurrency) || navigator.hardwareConcurrency < 1
    || (navigator.deviceMemory != null && (!Number.isFinite(navigator.deviceMemory) || navigator.deviceMemory <= 0))
    || !Number.isFinite(screen.devicePixelRatio) || screen.devicePixelRatio <= 0
    || !Number.isInteger(screen.width) || !Number.isInteger(screen.height)
    || screen.width < 320 || screen.height < 240
    || typeof videoCard.vendor !== 'string' || typeof videoCard.renderer !== 'string'
    || !validCodecs(fingerprint.audioCodecs) || !validCodecs(fingerprint.videoCodecs)
    || !Array.isArray(fingerprint.fonts)
    || fingerprint.pluginsData == null || typeof fingerprint.pluginsData !== 'object'
    || fingerprint.multimediaDevices == null || typeof fingerprint.multimediaDevices !== 'object') {
    throw new Error('Invalid saved desktop fingerprint; refusing to silently change device identity');
  }
}

/** Generate once; browser upgrades update identity version, never resample hardware. */
export function prepareDesktopFingerprint(config: FingerprintEmulationConfig): FingerprintEmulationConfig {
  if (config.mode !== 'auto') return config;
  generator ??= new FingerprintGenerator();
  const operatingSystem = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const desktop = config.desktop ?? {
    schema: 2 as const,
    provider: 'apify-2.1.89' as const,
    coverage: COVERAGE,
    bundle: generator.getFingerprint({
      browsers: [{ name: 'chrome', minVersion: 120 }],
      operatingSystems: [operatingSystem], devices: ['desktop'],
      locales: [...config.languages], strict: true,
      screen: { minWidth: 1280, maxWidth: 2560, minHeight: 720, maxHeight: 1600 },
      mockWebRTC: false,
    }),
  };
  const storedSchema = Number((desktop as unknown as { schema?: unknown }).schema);
  const migratedDesktop: DesktopFingerprint = storedSchema === 1
    ? { ...desktop, schema: 2, coverage: COVERAGE } as DesktopFingerprint
    : desktop as DesktopFingerprint;
  if (migratedDesktop.schema !== 2 || migratedDesktop.provider !== 'apify-2.1.89' || !migratedDesktop.bundle?.fingerprint) {
    throw new Error('Unsupported saved desktop fingerprint schema/provider');
  }
  const bundle = structuredClone(migratedDesktop.bundle);
  validateGeneratedBundle(bundle);
  const { navigator, screen } = bundle.fingerprint;
  const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  if (navigator.userAgentData?.platform !== platform || config.clientHints.platform !== platform) {
    throw new Error('Invalid saved desktop fingerprint; refusing to silently change device identity');
  }
  // The dataset supplies correlated hardware; its historical browser version is
  // not the version of the installed engine. Use the installed Chrome identity.
  navigator.userAgent = config.userAgent;
  navigator.appVersion = config.userAgent.replace(/^Mozilla\//, '');
  navigator.userAgentData = { ...config.clientHints, platformVersion: navigator.userAgentData?.platformVersion || config.clientHints.platformVersion };
  navigator.language = config.locale;
  navigator.languages = [...config.languages];
  navigator.maxTouchPoints = 0;
  // Recorded screen samples sometimes include transient document heights.
  // Make layout, CSS media queries and JS dimensions describe the same viewport.
  const viewport = {
    width: Math.min(screen.availWidth || screen.width, screen.width),
    height: Math.max(600, Math.min(screen.availHeight || screen.height, screen.height) - 88),
  };
  Object.assign(screen, {
    innerWidth: viewport.width, innerHeight: viewport.height,
    clientWidth: viewport.width, clientHeight: viewport.height,
    outerWidth: viewport.width, outerHeight: viewport.height + 88,
    pageXOffset: 0, pageYOffset: 0, screenX: 0,
  });
  bundle.headers = {
    'user-agent': navigator.userAgent,
    'accept-language': config.languages.map((language, index) => index ? `${language};q=${(1 - index * 0.1).toFixed(1)}` : language).join(','),
    'sec-ch-ua': navigator.userAgentData.brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', '),
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${navigator.userAgentData.platform}"`,
  };
  return {
    ...config,
    desktop: { ...migratedDesktop, bundle, coverage: COVERAGE }, viewport,
    deviceScaleFactor: screen.devicePixelRatio,
    webgl: { ...bundle.fingerprint.videoCard },
    clientHints: navigator.userAgentData,
    // Apify emulates device surfaces; do not add the old inconsistent canvas
    // noise or a fabricated WebGPU adapter on top of it.
    features: { canvas: false, webgl: true, gpu: false, userAgent: true, clientHints: true },
  };
}

export function desktopLaunchOptions(config: FingerprintEmulationConfig) {
  const bundle = config.desktop!.bundle;
  const headers = { ...bundle.headers };
  if (config.localeMode === 'native') delete headers['accept-language'];
  return {
    userAgent: bundle.fingerprint.navigator.userAgent,
    locale: config.localeMode === 'configured' ? config.locale : undefined,
    timezoneId: config.localeMode === 'configured' ? config.timezoneId : undefined,
    viewport: config.viewport,
    screen: { width: bundle.fingerprint.screen.width, height: bundle.fingerprint.screen.height },
    deviceScaleFactor: config.deviceScaleFactor,
    colorScheme: config.colorScheme,
    extraHTTPHeaders: headers,
    isMobile: false,
    hasTouch: false,
  } as const;
}

/** CDP init scripts preserve the original document bytes and CSP. */
export async function installDesktopFingerprint(context: BrowserContext, config: FingerprintEmulationConfig): Promise<void> {
  const bundle = config.desktop!.bundle;
  if (config.localeMode === 'native') {
    const page = context.pages()[0] ?? await context.newPage();
    const native = await page.evaluate(() => ({ language: navigator.language, languages: [...navigator.languages] }));
    config.locale = native.language;
    config.languages = native.languages;
    bundle.fingerprint.navigator.language = native.language;
    bundle.fingerprint.navigator.languages = native.languages;
    bundle.headers['accept-language'] = native.languages.map((language, index) => index ? `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}` : language).join(',');
    await context.setExtraHTTPHeaders(bundle.headers);
  }
  const source = safeInjectableScript(bundle);
  // Patchright 1.64.1's public addInitScript installs an HTML injection route.
  // Its underlying context protocol still supports native document-start
  // scripts, including new pages and out-of-process frames. Keep this adapter
  // version-pinned and covered by real-browser tests; fail rather than silently
  // falling back to a different injection mechanism after an upgrade.
  const channel = (context as unknown as {
    _channel?: { addInitScript(params: { source: string }, options: { timeout: number }): Promise<{ disposable: unknown }> };
  })._channel;
  if (!channel?.addInitScript) throw new Error('Unsupported Patchright context protocol for desktop fingerprint');
  const scriptRegistration = await channel.addInitScript({ source }, { timeout: 10_000 });
  const pending = new WeakMap<Page, Promise<void>>();
  const install = (page: Page): Promise<void> => {
    let operation = pending.get(page);
    if (operation) return operation;
    operation = withDeadline((async () => {
      const cdp = await context.newCDPSession(page);
      const version = await cdp.send('Browser.getVersion');
      const actualMajor = /\/(\d+)\./.exec(version.product)?.[1];
      const claimedMajor = /Chrome\/(\d+)\./.exec(config.userAgent)?.[1];
      if (actualMajor !== claimedMajor) throw new Error(`Fingerprint Chrome ${claimedMajor} does not match installed Chrome ${actualMajor}`);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: config.userAgent,
        // CDP derives navigator.languages from this field. Passing HTTP q
        // weights leaks values such as "de;q=0.9" into the JS language list.
        // Chrome adds request weighting itself; keep this value as pure tags.
        acceptLanguage: config.languages.join(','),
        platform: bundle.fingerprint.navigator.platform,
        userAgentMetadata: { ...config.clientHints, fullVersion: config.clientHints.uaFullVersion, wow64: false },
      });
      await cdp.send('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: bundle.fingerprint.navigator.hardwareConcurrency });
    })(), 10_000, 'Desktop fingerprint setup timed out');
    pending.set(page, operation);
    return operation;
  };
  context.on('page', page => { void install(page).catch(() => { void page.close().catch(() => {}); }); });
  await Promise.all(context.pages().map(install));
  // Identity headers are context launch options and the script is registered
  // at context scope before any caller can navigate. No request interception:
  // awaiting a new tab's CDP attachment inside its navigation can deadlock.
  registrations.set(context, [scriptRegistration]);
}
