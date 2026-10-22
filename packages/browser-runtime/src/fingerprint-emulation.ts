import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { BrowserContext, Route } from 'playwright';
import type { BrowserColorScheme, BrowserViewport } from './browser-runtime';

const FILE_NAME = 'fingerprint-emulation.json';
const execute = promisify(execFile);
const activeInitScripts = new WeakMap<BrowserContext, object[]>();

interface ClientHintsConfig {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  mobile: boolean;
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  model: string;
  uaFullVersion: string;
}

export interface FingerprintFeatureToggles {
  canvas: boolean;
  webgl: boolean;
  gpu: boolean;
  userAgent: boolean;
  clientHints: boolean;
}

const DISABLED_FEATURES: FingerprintFeatureToggles = {
  canvas: false,
  webgl: false,
  gpu: false,
  userAgent: false,
  clientHints: false,
};

export interface FingerprintEmulationConfig {
  version: 2;
  createdAt: string;
  seed: string;
  locale: string;
  languages: string[];
  timezoneId: string;
  viewport: BrowserViewport;
  colorScheme: BrowserColorScheme;
  deviceScaleFactor: number;
  features: FingerprintFeatureToggles;
  canvas: { signature: string; noise: [number, number, number] };
  webgl: { vendor: string; renderer: string };
  gpu: { vendor: string; architecture: string; device: string; description: string };
  userAgent: string;
  clientHints: ClientHintsConfig;
}

export interface FingerprintEmulationOverrides {
  locale?: string;
  languages?: string[];
  timezoneId?: string;
  viewport?: BrowserViewport;
  colorScheme?: BrowserColorScheme;
  deviceScaleFactor?: number;
  features?: Partial<FingerprintFeatureToggles>;
  canvas?: { signature: string; noise: [number, number, number] };
  webgl?: { vendor: string; renderer: string };
  gpu?: { vendor: string; architecture: string; device: string; description: string };
  userAgent?: string;
  clientHints?: ClientHintsConfig;
}

export interface FingerprintEnvironmentDefaults {
  locale?: string;
  timezoneId?: string;
  viewport?: BrowserViewport | null;
  colorScheme?: BrowserColorScheme;
}

interface DevicePreset {
  webglVendor: string;
  webglRenderer: string;
  gpuVendor: string;
  gpuArchitecture: string;
  gpuDevice: string;
}

const WINDOWS_PRESETS: readonly DevicePreset[] = [
  { webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)', gpuVendor: 'intel', gpuArchitecture: 'gen-9', gpuDevice: '0x3e92' },
  { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)', gpuVendor: 'nvidia', gpuArchitecture: 'ampere', gpuDevice: '0x2503' },
  { webglVendor: 'Google Inc. (AMD)', webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)', gpuVendor: 'amd', gpuArchitecture: 'rdna-2', gpuDevice: '0x73ff' },
];

const LINUX_PRESETS: readonly DevicePreset[] = [
  { webglVendor: 'Google Inc. (Intel)', webglRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)', gpuVendor: 'intel', gpuArchitecture: 'gen-9', gpuDevice: '0x3e92' },
  { webglVendor: 'Google Inc. (NVIDIA)', webglRenderer: 'ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6)', gpuVendor: 'nvidia', gpuArchitecture: 'ampere', gpuDevice: '0x2503' },
];

const VIEWPORTS: readonly BrowserViewport[] = [
  { width: 1365, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

function digest(seed: string, label: string): string {
  return createHash('sha256').update(`socio-fingerprint-v2:${seed}:${label}`).digest('hex');
}

function pick<T>(values: readonly T[], entropy: string, offset = 0): T {
  const value = Number.parseInt(entropy.slice(offset, offset + 8), 16);
  return values[value % values.length]!;
}

function languageBundle(locale: string): string[] {
  const base = locale.split('-')[0] ?? locale;
  // Keep Vietnamese profiles entirely Vietnamese. In particular, do not add
  // the browser's usual English fallback to Accept-Language or navigator.
  if (base.toLowerCase() === 'vi') return [locale, 'vi'].filter((value, index, values) => values.indexOf(value) === index);
  return [locale, base, 'en-US'].filter((value, index, values) => values.indexOf(value) === index);
}

function mergeFeatures(value?: Partial<FingerprintFeatureToggles>): FingerprintFeatureToggles {
  return { ...DISABLED_FEATURES, ...(value ?? {}) };
}

function createConfig(
  defaults: FingerprintEnvironmentDefaults,
  chromeMajor: number,
  overrides?: FingerprintEmulationOverrides,
): FingerprintEmulationConfig {
  const seed = randomBytes(16).toString('hex');
  const entropy = digest(seed, 'device');
  const windows = process.platform === 'win32';
  const preset = pick(windows ? WINDOWS_PRESETS : LINUX_PRESETS, entropy);
  const viewport = defaults.viewport ?? pick(VIEWPORTS, entropy, 8);
  const colorScheme = defaults.colorScheme ?? (Number.parseInt(entropy.slice(16, 18), 16) % 5 === 0 ? 'dark' : 'light');
  const fullVersion = `${chromeMajor}.0.0.0`;
  const platform = windows ? 'Windows' : 'Linux';
  const userAgent = windows
    ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`
    : `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Safari/537.36`;
  const brands = [
    { brand: 'Not_A Brand', version: '24' },
    { brand: 'Chromium', version: String(chromeMajor) },
    { brand: 'Google Chrome', version: String(chromeMajor) },
  ];
  const canvasNoise: [number, number, number] = [
    Number.parseInt(entropy.slice(18, 20), 16) % 2,
    Number.parseInt(entropy.slice(20, 22), 16) % 2,
    Number.parseInt(entropy.slice(22, 24), 16) % 2,
  ];
  if (canvasNoise.every((value) => value === 0)) canvasNoise[2] = 1;
  const locale = defaults.locale ?? Intl.getCanonicalLocales(new Intl.DateTimeFormat().resolvedOptions().locale)[0] ?? 'en-US';
  const timezoneId = defaults.timezoneId ?? new Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const generated: FingerprintEmulationConfig = {
    version: 2,
    createdAt: new Date().toISOString(),
    seed,
    locale,
    languages: languageBundle(locale),
    timezoneId,
    viewport: { ...viewport },
    colorScheme,
    deviceScaleFactor: 1,
    features: { ...DISABLED_FEATURES },
    canvas: {
      signature: digest(seed, 'canvas').slice(0, 32),
      noise: canvasNoise,
    },
    webgl: { vendor: preset.webglVendor, renderer: preset.webglRenderer },
    gpu: { vendor: preset.gpuVendor, architecture: preset.gpuArchitecture, device: preset.gpuDevice, description: preset.webglRenderer },
    userAgent,
    clientHints: {
      brands,
      fullVersionList: brands.map((brand) => ({ ...brand, version: brand.brand === 'Not_A Brand' ? '24.0.0.0' : fullVersion })),
      mobile: false,
      platform,
      platformVersion: windows ? '19.0.0' : '6.8.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      uaFullVersion: fullVersion,
    },
  };
  return mergeFingerprintConfig(generated, overrides);
}

function validateConfig(value: unknown): FingerprintEmulationConfig {
  const raw = value as Partial<FingerprintEmulationConfig> | null;
  const config = raw && !Array.isArray(raw.languages)
    ? { ...raw, languages: [raw.locale ?? 'en-US'] }
    : raw;
  if (!config || config.version !== 2 || typeof config.createdAt !== 'string'
    || typeof config.seed !== 'string' || !/^[0-9a-f]{32}$/.test(config.seed)
    || typeof config.locale !== 'string' || !Array.isArray(config.languages) || config.languages.some((language) => typeof language !== 'string')
    || typeof config.timezoneId !== 'string'
    || !config.viewport || !Number.isInteger(config.viewport.width) || !Number.isInteger(config.viewport.height)
    || !['light', 'dark', 'no-preference'].includes(String(config.colorScheme))
    || typeof config.deviceScaleFactor !== 'number' || !config.canvas
    || typeof config.canvas.signature !== 'string' || !Array.isArray(config.canvas.noise)
    || !config.webgl || typeof config.webgl.vendor !== 'string' || typeof config.webgl.renderer !== 'string'
    || !config.gpu || typeof config.gpu.vendor !== 'string' || typeof config.gpu.architecture !== 'string'
    || typeof config.gpu.device !== 'string' || typeof config.gpu.description !== 'string'
    || typeof config.userAgent !== 'string' || !config.clientHints
    || !Array.isArray(config.clientHints.brands) || !Array.isArray(config.clientHints.fullVersionList)
    || typeof config.clientHints.mobile !== 'boolean' || typeof config.clientHints.platform !== 'string') {
    throw new Error(`Invalid ${FILE_NAME}`);
  }
  Intl.getCanonicalLocales(config.locale);
  new Intl.DateTimeFormat('en-US', { timeZone: config.timezoneId });
  return { ...config, features: mergeFeatures(config.features) } as FingerprintEmulationConfig;
}

function mergeFingerprintConfig(
  base: FingerprintEmulationConfig,
  overrides?: FingerprintEmulationOverrides,
): FingerprintEmulationConfig {
  if (!overrides) {
    const allowedLanguages = languageBundle(base.locale);
    const storedLanguages = base.languages.filter((language) => allowedLanguages.includes(language));
    return {
      ...base,
      languages: storedLanguages.length ? storedLanguages : allowedLanguages,
      features: mergeFeatures(base.features),
    };
  }
  const locale = overrides.locale ?? base.locale;
  const languages = overrides.languages?.length
    ? languageBundle(locale).filter((language) => overrides.languages!.includes(language))
    : languageBundle(locale);
  return {
    ...base,
    ...overrides,
    locale,
    languages: languages.length ? languages : languageBundle(locale),
    features: mergeFeatures(overrides.features ?? base.features),
    viewport: overrides.viewport ? { ...base.viewport, ...overrides.viewport } : base.viewport,
    canvas: overrides.canvas ? { ...base.canvas, ...overrides.canvas } : base.canvas,
    webgl: overrides.webgl ? { ...base.webgl, ...overrides.webgl } : base.webgl,
    gpu: overrides.gpu ? { ...base.gpu, ...overrides.gpu } : base.gpu,
    clientHints: overrides.clientHints ? { ...base.clientHints, ...overrides.clientHints } : base.clientHints,
  };
}

export async function loadFingerprintEmulation(
  profilePath: string,
  defaults: FingerprintEnvironmentDefaults,
  overrides?: FingerprintEmulationOverrides,
): Promise<FingerprintEmulationConfig> {
  const destination = join(profilePath, FILE_NAME);
  try {
    const stored = validateConfig(JSON.parse(await readFile(destination, 'utf8')));
    return mergeFingerprintConfig(stored, overrides);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const config = createConfig(defaults, await detectChromeMajor(), overrides);
  const temporary = join(profilePath, `${FILE_NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return config;
}

async function detectChromeMajor(): Promise<number> {
  const configured = Number(process.env.BROWSER_FINGERPRINT_CHROME_MAJOR);
  if (Number.isInteger(configured) && configured >= 100 && configured <= 999) return configured;
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' && process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined,
    process.platform === 'win32' && process.env['PROGRAMFILES(X86)']
      ? join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      : undefined,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome' : undefined,
    process.platform === 'linux' ? '/usr/bin/google-chrome-stable' : undefined,
  ].filter((value): value is string => Boolean(value));
  for (const executable of candidates) {
    try {
      const { stdout, stderr } = await execute(executable, ['--version'], { windowsHide: true, timeout: 5_000 });
      const match = /(?:Chrome|Chromium)\s+(\d+)\./i.exec(`${stdout} ${stderr}`);
      if (match) return Number(match[1]);
    } catch {
      // Try the next normal Chrome installation path.
    }
  }
  // Conservative reduced-UA fallback used only when the installed browser
  // version cannot be queried (for example in a restricted container).
  return 155;
}

export function fingerprintLaunchOptions(config: FingerprintEmulationConfig) {
  return {
    ...(config.features.userAgent ? { userAgent: config.userAgent } : {}),
    locale: config.locale,
    timezoneId: config.timezoneId,
    viewport: config.viewport,
    colorScheme: config.colorScheme,
    deviceScaleFactor: config.deviceScaleFactor,
    isMobile: false,
    hasTouch: false,
  } as const;
}

export async function installFingerprintEmulation(context: BrowserContext, config: FingerprintEmulationConfig): Promise<void> {
  const brandsHeader = config.clientHints.brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(', ');
  const headers: Record<string, string> = {
    'accept-language': config.languages.map((language, index) => index === 0 ? language : `${language};q=${Math.max(0.1, 1 - index * 0.1).toFixed(1)}`).join(','),
  };
  if (config.features.clientHints) {
    headers['sec-ch-ua'] = brandsHeader;
    headers['sec-ch-ua-mobile'] = config.clientHints.mobile ? '?1' : '?0';
    headers['sec-ch-ua-platform'] = `"${config.clientHints.platform}"`;
  }
  await context.setExtraHTTPHeaders({
    ...headers,
  });
  const initSource = `(${applyPageFingerprint.toString()})(${JSON.stringify(config)})`;
  const installClientHints = async (page: ReturnType<BrowserContext['pages']>[number]) => {
    if (!config.features.userAgent && !config.features.clientHints) return;
    const cdp = await context.newCDPSession(page);
    await cdp.send('Page.enable');
    const nativeUserAgent = await page.evaluate(() => navigator.userAgent).catch(() => config.userAgent);
    await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: config.features.userAgent ? config.userAgent : nativeUserAgent,
        acceptLanguage: config.languages.join(','),
        platform: config.clientHints.platform === 'Windows' ? 'Win32' : 'Linux x86_64',
        ...(config.features.clientHints ? { userAgentMetadata: {
          brands: config.clientHints.brands,
          fullVersionList: config.clientHints.fullVersionList,
          fullVersion: config.clientHints.uaFullVersion,
          platform: config.clientHints.platform,
          platformVersion: config.clientHints.platformVersion,
          architecture: config.clientHints.architecture,
          model: config.clientHints.model,
          mobile: config.clientHints.mobile,
          bitness: config.clientHints.bitness,
          wow64: false,
        } } : {}),
    });
  };
  await Promise.all(context.pages().map(installClientHints));
  context.on('page', (page) => { void installClientHints(page); });
  const routeRegistration = await (context as unknown as {
    route(url: string, handler: (route: Route) => Promise<void>): Promise<object>;
  }).route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') {
      await route.continue();
      return;
    }
    try {
      const response = await route.fetch();
      const contentType = response.headers()['content-type'] ?? '';
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        await route.fulfill({ response });
        return;
      }
      const body = await response.body();
      const html = body.toString('utf8');
      const script = `<script>${initSource}</script>`;
      const head = /<head(?:\s[^>]*)?>/i.exec(html);
      const root = /<html(?:\s[^>]*)?>/i.exec(html);
      const insertion = head ?? root;
      const injected = insertion
        ? `${html.slice(0, insertion.index + insertion[0].length)}${script}${html.slice(insertion.index + insertion[0].length)}`
        : `${script}${html}`;
      await route.fulfill({ response, body: injected });
    } catch {
      await route.continue();
    }
  });
  // Patchright returns a Disposable registration. Retain it for the lifetime
  // of the context; dropping it lets the library remove the route.
  activeInitScripts.set(context, [routeRegistration]);
}

function applyPageFingerprint(emulation: FingerprintEmulationConfig): void {
    const define = (target: object, property: PropertyKey, value: unknown) => {
      try { Object.defineProperty(target, property, { configurable: true, enumerable: true, get: () => value }); }
      catch { /* Unsupported/non-configurable browser surface. */ }
    };
    if (emulation.features.userAgent) define(Navigator.prototype, 'userAgent', emulation.userAgent);
    if (emulation.features.userAgent) {
      const platform = emulation.clientHints.platform === 'Windows' ? 'Win32'
        : emulation.clientHints.platform === 'macOS' ? 'MacIntel'
          : emulation.clientHints.platform === 'Android' ? 'Linux armv8l' : 'Linux x86_64';
      define(Navigator.prototype, 'platform', platform);
    }
    define(Navigator.prototype, 'language', emulation.locale);
    define(Navigator.prototype, 'languages', [...emulation.languages]);
    const userAgentData = {
      brands: emulation.clientHints.brands,
      mobile: emulation.clientHints.mobile,
      platform: emulation.clientHints.platform,
      getHighEntropyValues: async (hints: string[]) => {
        const values: Record<string, unknown> = {};
        const source: Record<string, unknown> = {
          architecture: emulation.clientHints.architecture,
          bitness: emulation.clientHints.bitness,
          brands: emulation.clientHints.brands,
          fullVersionList: emulation.clientHints.fullVersionList,
          model: emulation.clientHints.model,
          mobile: emulation.clientHints.mobile,
          platform: emulation.clientHints.platform,
          platformVersion: emulation.clientHints.platformVersion,
          uaFullVersion: emulation.clientHints.uaFullVersion,
        };
        for (const hint of hints) if (hint in source) values[hint] = source[hint];
        return values;
      },
      toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
    };
    if (emulation.features.clientHints) define(Navigator.prototype, 'userAgentData', userAgentData);

    const canvasPrototype = emulation.features.canvas ? globalThis.CanvasRenderingContext2D?.prototype : undefined;
    if (canvasPrototype) {
      const original = canvasPrototype.getImageData;
      const [redNoise = 0, greenNoise = 0, blueNoise = 0] = emulation.canvas.noise;
      const signatureBytes = Array.from(emulation.canvas.signature).slice(0, 3).map((character) => character.charCodeAt(0) & 255);
      const getImageData = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof original>) {
        const image = original.apply(this, args);
        const channels = Math.min(image.data.length, 64);
        for (let index = 0; index < channels; index += 4) {
          image.data[index] = ((image.data[index] ?? 0) + redNoise) & 255;
          image.data[index + 1] = ((image.data[index + 1] ?? 0) + greenNoise) & 255;
          image.data[index + 2] = ((image.data[index + 2] ?? 0) + blueNoise) & 255;
        }
        return image;
      };
      try {
        Object.defineProperty(canvasPrototype, 'getImageData', {
          configurable: true,
          writable: true,
          value: getImageData,
        });
      } catch { /* Keep the native implementation on a locked-down realm. */ }

      const canvasElementPrototype = globalThis.HTMLCanvasElement?.prototype;
      if (canvasElementPrototype) {
        const originalToDataURL = canvasElementPrototype.toDataURL;
        const originalToBlob = canvasElementPrototype.toBlob;
        const noisyClone = (canvas: HTMLCanvasElement): HTMLCanvasElement => {
          if (canvas.width < 1 || canvas.height < 1) return canvas;
          const clone = document.createElement('canvas');
          clone.width = canvas.width;
          clone.height = canvas.height;
          const context = clone.getContext('2d');
          if (!context) return canvas;
          context.drawImage(canvas, 0, 0);
          const pixel = original.call(context, 0, 0, 1, 1);
          pixel.data[0] = ((pixel.data[0] ?? 0) + redNoise) & 255;
          pixel.data[1] = ((pixel.data[1] ?? 0) + greenNoise) & 255;
          pixel.data[2] = ((pixel.data[2] ?? 0) + blueNoise) & 255;
          context.putImageData(pixel, 0, 0);
          // Keep the first pixel's configured noise stable for compatibility,
          // while the profile signature still affects normal multi-pixel
          // canvas fingerprints and serialized output.
          if (canvas.width > 1 && canvas.height > 1) {
            const marker = original.call(context, canvas.width - 1, canvas.height - 1, 1, 1);
            marker.data[0] = ((marker.data[0] ?? 0) + (signatureBytes[0] ?? 0)) & 255;
            marker.data[1] = ((marker.data[1] ?? 0) + (signatureBytes[1] ?? 0)) & 255;
            marker.data[2] = ((marker.data[2] ?? 0) + (signatureBytes[2] ?? 0)) & 255;
            context.putImageData(marker, canvas.width - 1, canvas.height - 1);
          }
          return clone;
        };
        try {
          Object.defineProperty(canvasElementPrototype, 'toDataURL', {
            configurable: true,
            writable: true,
            value: function (this: HTMLCanvasElement, ...args: Parameters<typeof originalToDataURL>) {
              return originalToDataURL.apply(noisyClone(this), args);
            },
          });
          Object.defineProperty(canvasElementPrototype, 'toBlob', {
            configurable: true,
            writable: true,
            value: function (this: HTMLCanvasElement, ...args: Parameters<typeof originalToBlob>) {
              return originalToBlob.apply(noisyClone(this), args);
            },
          });
        } catch { /* Keep native serialization on a locked-down realm. */ }
      }
    }

    const patchWebGl = (prototype: object | undefined) => {
      if (!prototype) return;
      const typed = prototype as { getParameter?: (parameter: number) => unknown };
      const original = typed.getParameter;
      if (!original) return;
      const getParameter = function (this: object, parameter: number) {
        if (parameter === 0x9245) return emulation.webgl.vendor;
        if (parameter === 0x9246) return emulation.webgl.renderer;
        return original.call(this, parameter);
      };
      try {
        Object.defineProperty(prototype, 'getParameter', {
          configurable: true,
          writable: true,
          value: getParameter,
        });
      } catch { /* Keep the native implementation on a locked-down realm. */ }
    };
    if (emulation.features.webgl) {
      patchWebGl(globalThis.WebGLRenderingContext?.prototype);
      patchWebGl(globalThis.WebGL2RenderingContext?.prototype);
    }

    const nativeGpu = (navigator as Navigator & { gpu?: { requestAdapter?: (...args: unknown[]) => Promise<object | null> } }).gpu;
    if (emulation.features.gpu && nativeGpu?.requestAdapter) {
      const emulatedGpu = Object.create(nativeGpu) as typeof nativeGpu;
      const requestAdapter = async (...args: unknown[]) => {
        const adapter = await nativeGpu.requestAdapter!(...args);
        if (!adapter) return adapter;
        const info = { ...emulation.gpu };
        return new Proxy(adapter, {
          get(target, property, receiver) {
            if (property === 'info') return info;
            if (property === 'requestAdapterInfo') return async () => info;
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      };
      Object.defineProperty(emulatedGpu, 'requestAdapter', {
        configurable: true,
        value: requestAdapter,
      });
      define(Navigator.prototype, 'gpu', emulatedGpu);
    }
}
