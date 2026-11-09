import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserRuntime } from './browser-runtime';
import { LocalObjectStorage, ProfileSnapshotStore } from '@socio/object-storage';
import { BrowserProcessRegistry } from './browser-process';
import { fingerprintLaunchOptions, loadFingerprintEmulation } from './fingerprint-emulation';
import { localeForCountry, parseIpLocationResponse, resolveBrowserLocale } from './ip-locale';

test('IP locale follows the proxy country and exact IANA timezone', async () => {
  assert.deepEqual(parseIpLocationResponse({
    success: true,
    data: { countryCode: 'DE', timezone: { time_zone: 'Europe/Berlin' } },
  }), { countryCode: 'DE', timezoneId: 'Europe/Berlin' });
  const proxy = { server: 'http://proxy.example:8080', username: 'user', password: 'secret' };
  const resolved = await resolveBrowserLocale(proxy, {
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  }, async (receivedProxy) => {
    assert.equal(receivedProxy, proxy);
    return { countryCode: 'DE', timezoneId: 'Europe/Berlin' };
  });
  assert.deepEqual(resolved, {
    locale: 'de-DE',
    languages: ['de-DE', 'de'],
    timezoneId: 'Europe/Berlin',
    source: 'proxy-ip',
  });
  assert.equal(localeForCountry('VN'), 'vi-VN');
});

test('IP locale uses worker defaults without proxy and on lookup failure', async () => {
  let lookups = 0;
  const defaults = { locale: 'th-TH', timezoneId: 'Asia/Bangkok' };
  const direct = await resolveBrowserLocale(undefined, defaults, async () => {
    lookups += 1;
    throw new Error('must not run');
  });
  assert.equal(lookups, 0);
  assert.deepEqual(direct, {
    locale: 'th-TH', languages: ['th-TH', 'th'], timezoneId: 'Asia/Bangkok', source: 'default',
  });

  const fallback = await resolveBrowserLocale({ server: 'http://proxy.example:8080' }, defaults, async () => {
    throw new Error('provider unavailable');
  });
  assert.deepEqual(fallback, direct);
});

test('fingerprint bundle is complete, coherent and stable for each profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-fingerprint-'));
  try {
    const firstProfile = join(root, 'first');
    const secondProfile = join(root, 'second');
    await Promise.all([
      import('node:fs/promises').then(({ mkdir }) => mkdir(firstProfile, { recursive: true })),
      import('node:fs/promises').then(({ mkdir }) => mkdir(secondProfile, { recursive: true })),
    ]);
    const defaults = {
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
      viewport: { width: 1536, height: 864 },
      colorScheme: 'light' as const,
    };
    const first = await loadFingerprintEmulation(firstProfile, defaults);
    const reopened = await loadFingerprintEmulation(firstProfile, {
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    const second = await loadFingerprintEmulation(secondProfile, defaults);

    assert.deepEqual(reopened, first, 'A profile must reuse its original bundle');
    assert.notEqual(second.seed, first.seed, 'Profiles must have independent bundles');
    assert.equal(first.locale, 'vi-VN');
    assert.deepEqual(first.languages, ['vi-VN', 'vi']);
    assert.deepEqual(first.features, { canvas: false, webgl: true, gpu: false, userAgent: true, clientHints: true });
    assert.equal(first.timezoneId, 'Asia/Ho_Chi_Minh');
    assert.ok(first.desktop);
    assert.equal(first.desktop.schema, 2);
    assert.deepEqual(first.desktop.coverage.applied, ['navigator', 'userAgentData', 'screen', 'window', 'intl', 'webgl', 'codecs', 'battery']);
    assert.ok(first.desktop.coverage.native.includes('history'));
    assert.ok(first.desktop.coverage.native.includes('sharedArrayBuffer'));
    assert.ok(first.viewport.width <= first.desktop.bundle.fingerprint.screen.width);
    assert.equal(first.desktop.bundle.fingerprint.navigator.userAgent, first.userAgent);
    assert.match(first.userAgent, /Chrome\/\d+\.0\.0\.0/);
    assert.equal(first.clientHints.platform, process.platform === 'win32' ? 'Windows' : 'Linux');
    assert.equal(first.clientHints.brands.find(brand => brand.brand === 'Google Chrome')?.version,
      /Chrome\/(\d+)/.exec(first.userAgent)?.[1]);
    assert.ok(first.canvas.signature.length >= 24);
    assert.match(first.webgl.renderer, /ANGLE/);
    assert.ok(first.gpu.vendor.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('language fallback follows the selected locale without synthetic English', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-language-bundle-'));
  try {
    await Promise.all(['german', 'japanese', 'traditional-chinese', 'english'].map((profile) => mkdir(join(root, profile), { recursive: true })));
    const german = await loadFingerprintEmulation(join(root, 'german'), {
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
    });
    const japanese = await loadFingerprintEmulation(join(root, 'japanese'), {
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });
    const traditionalChinese = await loadFingerprintEmulation(join(root, 'traditional-chinese'), {
      locale: 'zh-Hant-TW',
      timezoneId: 'Asia/Taipei',
    });
    const english = await loadFingerprintEmulation(join(root, 'english'), {
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    assert.deepEqual(german.languages, ['de-DE', 'de']);
    assert.deepEqual(japanese.languages, ['ja-JP', 'ja']);
    assert.deepEqual(traditionalChinese.languages, ['zh-Hant-TW', 'zh-Hant', 'zh']);
    assert.deepEqual(english.languages, ['en-US', 'en']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auto locale is the source of truth for languages and timezone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-locale-source-'));
  try {
    const profile = join(root, 'profile');
    await mkdir(profile, { recursive: true });
    const config = await loadFingerprintEmulation(profile, {
      locale: 'en-US',
      timezoneId: 'UTC',
    }, {
      mode: 'auto',
      locale: 'en-US',
      languages: ['de-DE'],
      timezoneId: 'Europe/Berlin',
    });
    assert.deepEqual(config.languages, ['en-US', 'en']);
    assert.ok(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'].includes(config.timezoneId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auto profile settings keep a desktop bundle and refresh Chrome version fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-auto-profile-'));
  const profile = join(root, 'profile');
  try {
    await mkdir(profile, { recursive: true });
    const first = await loadFingerprintEmulation(profile, {
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
    }, {
      mode: 'auto',
      locale: 'vi-VN',
      languages: ['vi-VN', 'vi'],
      timezoneId: 'Asia/Ho_Chi_Minh',
    });
    assert.equal(first.clientHints.mobile, false);
    assert.equal(first.features.canvas, false);
    assert.equal(first.features.webgl, true);
    assert.equal(first.features.gpu, false);
    assert.equal(first.features.userAgent, true);
    assert.equal(first.features.clientHints, true);
    assert.ok(first.viewport.width >= 1_000);
    assert.ok(first.viewport.height >= 600);

    const stale = {
      ...first,
      userAgent: first.userAgent.replace(/Chrome\/\d+\.0\.0\.0/, 'Chrome/1.0.0.0'),
      clientHints: {
        ...first.clientHints,
        brands: first.clientHints.brands.map((brand) => ({ ...brand, version: brand.brand === 'Not:A-Brand' ? '8' : '1' })),
        fullVersionList: first.clientHints.fullVersionList.map((brand) => ({ ...brand, version: brand.brand === 'Not:A-Brand' ? '8.0.0.0' : '1.0.0.0' })),
        uaFullVersion: '1.0.0.0',
      },
    };
    await writeFile(join(profile, 'fingerprint-emulation.json'), `${JSON.stringify(stale)}\n`);
    const refreshed = await loadFingerprintEmulation(profile, {
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
    }, {
      mode: 'auto',
      locale: 'vi-VN',
      languages: ['vi-VN', 'vi'],
      timezoneId: 'Asia/Ho_Chi_Minh',
    });
    const major = /Chrome\/(\d+)\./.exec(refreshed.userAgent)?.[1];
    assert.ok(major && major !== '1');
    assert.match(refreshed.clientHints.uaFullVersion, /^\d+\.\d+\.\d+\.\d+$/);
    assert.equal(refreshed.clientHints.fullVersionList.find(brand => brand.brand === 'Google Chrome')?.version,
      refreshed.clientHints.uaFullVersion);
    assert.equal(refreshed.clientHints.mobile, false);
    assert.deepEqual(refreshed.viewport, first.viewport);
    assert.deepEqual(refreshed.gpu, first.gpu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native profile settings do not override locale or mobile surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-native-profile-'));
  try {
    const profile = join(root, 'profile');
    await mkdir(profile, { recursive: true });
    const native = await loadFingerprintEmulation(profile, {
      locale: 'vi-VN',
      timezoneId: 'Asia/Ho_Chi_Minh',
    }, {
      mode: 'native',
      localeMode: 'native',
      locale: 'vi-VN',
      languages: ['vi-VN', 'vi'],
      timezoneId: 'Asia/Ho_Chi_Minh',
    });
    const options = fingerprintLaunchOptions(native);
    assert.equal(native.localeMode, 'native');
    assert.equal(options.locale, undefined);
    assert.equal(options.timezoneId, undefined);
    assert.equal('viewport' in options, false);
    assert.equal('deviceScaleFactor' in options, false);
    assert.equal(options.isMobile, false);
    assert.equal(options.hasTouch, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser applies the locale environment already saved by a tested proxy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-proxy-locale-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 19));
  try {
    const session = await runtime.openProfile({
      profileId: 'proxy-locale',
      headless: true,
      emulateFingerprint: true,
      fingerprint: {
        mode: 'auto', localeMode: 'auto', locale: 'vi-VN',
        languages: ['vi-VN', 'vi'], timezoneId: 'Asia/Ho_Chi_Minh',
      },
      localeEnvironment: {
        locale: 'de-DE', languages: ['de-DE', 'de'], timezoneId: 'Europe/Berlin', source: 'proxy-ip',
      },
    });
    assert.equal(session.locale, 'de-DE');
    assert.equal(session.timezoneId, 'Europe/Berlin');
    assert.deepEqual(await session.page.evaluate(() => ({
      language: navigator.language,
      languages: [...navigator.languages],
      timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })), {
      language: 'de-DE', languages: ['de-DE', 'de'], timezoneId: 'Europe/Berlin',
    });
    const saved = JSON.parse(await readFile(join(root, 'proxy-locale', 'fingerprint-emulation.json'), 'utf8'));
    assert.equal(saved.localeMode, 'configured');
    assert.equal(saved.locale, 'de-DE');
    assert.equal(saved.timezoneId, 'Europe/Berlin');
    await session.close();
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('auto migrates legacy rendering overrides and persists the effective settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-fingerprint-migration-'));
  try {
    const initial = await loadFingerprintEmulation(root, {});
    const legacy = { ...initial, mode: undefined, desktop: undefined, features: { canvas: true, webgl: true, gpu: true, userAgent: true, clientHints: true } };
    await writeFile(join(root, 'fingerprint-emulation.json'), JSON.stringify(legacy));
    const migrated = await loadFingerprintEmulation(root, {}, { mode: 'auto', localeMode: 'native' });
    assert.equal(migrated.seed, initial.seed);
    assert.equal(migrated.mode, 'auto');
    assert.ok(migrated.desktop);
    assert.equal(migrated.features.userAgent, true);
    assert.equal(migrated.features.webgl, true);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'fingerprint-emulation.json'), 'utf8')), migrated);
    assert.deepEqual(await loadFingerprintEmulation(root, {}), migrated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auto upgrades a saved Apify schema without resampling its device', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-fingerprint-schema-'));
  try {
    const initial = await loadFingerprintEmulation(root, {}, { mode: 'auto' });
    const legacy = { ...initial, desktop: { ...initial.desktop, schema: 1, coverage: undefined } };
    await writeFile(join(root, 'fingerprint-emulation.json'), JSON.stringify(legacy));
    const upgraded = await loadFingerprintEmulation(root, {}, { mode: 'auto' });
    assert.equal(upgraded.desktop?.schema, 2);
    assert.equal(upgraded.desktop?.bundle.fingerprint.videoCard.renderer,
      initial.desktop?.bundle.fingerprint.videoCard.renderer);
    assert.equal(upgraded.desktop?.bundle.fingerprint.navigator.hardwareConcurrency,
      initial.desktop?.bundle.fingerprint.navigator.hardwareConcurrency);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auto injects its generated device across tabs and frames while preserving navigation and CSP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-native-navigation-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  const requests: string[] = [];
  const requestHeaders: Array<Record<string, string | string[] | undefined>> = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    requestHeaders.push(request.headers);
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/final' });
      response.end();
      return;
    }
    if (request.url === '/probe') {
      response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'nonce-probe'" });
      response.end(`<script nonce="probe">document.documentElement.dataset.device=JSON.stringify({cpu:navigator.hardwareConcurrency,memory:navigator.deviceMemory,width:screen.width,ua:navigator.userAgent})</script>`);
      return;
    }
    if (request.url === '/isolated') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      response.end('<!doctype html><title>isolated</title>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "script-src 'none'" });
    response.end('<!doctype html><title>native</title><script>document.title="CSP bypassed"</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const session = await runtime.openProfile({
      profileId: 'auto', headless: true, emulateFingerprint: true,
      fingerprint: { mode: 'auto', localeMode: 'native' },
    });
    await session.page.goto(`http://127.0.0.1:${address.port}/redirect`);
    assert.ok(session.page.url().endsWith('/final'), 'Browser must own the redirect chain');
    assert.equal(await session.page.title(), 'native', 'Inline scripts must remain blocked by CSP');
    const page = session.page as unknown as {
      evaluate<R>(fn: () => R, arg: undefined, options: undefined, isolatedContext: false): Promise<R>;
    };
    const observed = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgb(10, 20, 30)';
      context.fillRect(0, 0, 1, 1);
      const gl = document.createElement('canvas').getContext('webgl');
      gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        pixel: [...context.getImageData(0, 0, 1, 1).data],
        native: CanvasRenderingContext2D.prototype.getImageData.toString().includes('[native code]'),
        scripts: document.scripts.length,
        cpu: navigator.hardwareConcurrency,
        memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        width: screen.width,
        viewportWidth: innerWidth,
        cssWidth: matchMedia(`(width: ${innerWidth}px)`).matches,
        ua: navigator.userAgent,
        gpu: gl?.getParameter(0x9246),
      };
    }, undefined, undefined, false);
    assert.deepEqual(observed.pixel, [10, 20, 30, 255]);
    assert.equal(observed.native, true);
    assert.equal(observed.scripts, 1, 'No fingerprint script is inserted into HTML');
    const saved = JSON.parse(await readFile(join(root, 'auto', 'fingerprint-emulation.json'), 'utf8'));
    const device = saved.desktop.bundle.fingerprint;
    assert.equal(observed.cpu, device.navigator.hardwareConcurrency);
    assert.equal(observed.memory, device.navigator.deviceMemory);
    assert.equal(observed.width, device.screen.width);
    assert.equal(observed.viewportWidth, saved.viewport.width);
    assert.equal(observed.cssWidth, true);
    assert.equal(observed.ua, saved.userAgent);
    if (observed.gpu) assert.equal(observed.gpu, device.videoCard.renderer);
    assert.equal(requestHeaders[0]?.['user-agent'], saved.userAgent);
    assert.equal(requestHeaders[0]?.['sec-ch-ua-platform'], `"${saved.clientHints.platform}"`);
    const secondPage = await session.context.newPage();
    await secondPage.goto(`http://127.0.0.1:${address.port}/second`);
    const second = secondPage as unknown as typeof page;
    assert.equal(await second.evaluate(() => navigator.hardwareConcurrency, undefined, undefined, false), device.navigator.hardwareConcurrency);
    await secondPage.goto(`http://127.0.0.1:${address.port}/probe`);
    const expectedProbe = { cpu: device.navigator.hardwareConcurrency, memory: device.navigator.deviceMemory, width: device.screen.width, ua: saved.userAgent };
    const probe = async (target: typeof page) => JSON.parse(await target.evaluate(() => document.documentElement.dataset.device!, undefined, undefined, false));
    assert.deepEqual(await probe(second), expectedProbe, 'The first site script must see the generated device');
    await secondPage.evaluate((port) => {
      const frame = document.createElement('iframe');
      frame.src = `http://localhost:${port}/probe`;
      document.body.append(frame);
    }, address.port);
    await secondPage.frameLocator('iframe').locator('html[data-device]').waitFor();
    const frame = secondPage.frames().find(value => value.url().includes('localhost'))!;
    assert.deepEqual(await probe(frame as unknown as typeof page), expectedProbe, 'Cross-origin frame must see the same device');
    await session.close();
    const reopened = await runtime.openProfile({ profileId: 'auto', headless: true, emulateFingerprint: true, fingerprint: { mode: 'auto', localeMode: 'native' } });
    await reopened.page.goto(`http://127.0.0.1:${address.port}/probe`);
    assert.deepEqual(await probe(reopened.page as unknown as typeof page), expectedProbe, 'Reopening must reuse the device');
    const supported = await (reopened.page as unknown as typeof page).evaluate(async () => {
      const before = history.length;
      history.pushState({}, '', '#safe-history');
      const audio = document.createElement('audio');
      const video = document.createElement('video');
      const battery = await (navigator as Navigator & { getBattery?: () => Promise<Record<string, unknown>> }).getBattery?.();
      const uaData = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(values: string[]): Promise<Record<string, unknown>> } }).userAgentData;
      return {
        historyChanged: history.length === before + 1,
        mp3: audio.canPlayType('audio/mpeg'),
        h264: video.canPlayType('video/mp4; codecs="avc1.42E01E"'),
        battery: battery ? { charging: battery.charging, level: battery.level } : undefined,
        hints: await uaData?.getHighEntropyValues(['architecture', 'bitness', 'platformVersion', 'uaFullVersion']),
        plugins: navigator.plugins.length,
      };
    }, undefined, undefined, false);
    assert.equal(supported.historyChanged, true, 'History must retain native navigation behavior');
    assert.equal(supported.mp3, device.audioCodecs.mp3);
    assert.equal(supported.h264, device.videoCodecs.h264);
    if (supported.battery && device.battery) {
      assert.equal(supported.battery.charging, device.battery.charging);
      assert.equal(supported.battery.level, device.battery.level);
    }
    assert.equal(supported.hints?.architecture, saved.clientHints.architecture);
    assert.equal(supported.hints?.bitness, saved.clientHints.bitness);
    assert.equal(supported.hints?.platformVersion, saved.clientHints.platformVersion);
    assert.equal(supported.hints?.uaFullVersion, saved.clientHints.uaFullVersion);
    assert.ok(supported.plugins > 0, 'Chrome-native PDF plugins remain available');
    await reopened.page.goto(`http://127.0.0.1:${address.port}/isolated`);
    const isolated = await (reopened.page as unknown as typeof page).evaluate(() => ({
      isolated: crossOriginIsolated,
      sharedArrayBuffer: typeof SharedArrayBuffer,
    }), undefined, undefined, false);
    assert.deepEqual(isolated, { isolated: true, sharedArrayBuffer: 'function' },
      'Apify must not hide SharedArrayBuffer when stock Chrome exposes it');
    assert.equal(requests.filter(url => url === '/redirect').length, 1);
    assert.equal(requests.filter(url => url === '/final').length, 1);
  } finally {
    await runtime.closeAll();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Patchright applies the saved fingerprint bundle before page scripts run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-fingerprint-browser-'));
  const profileId = 'fingerprint-runtime';
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><html><head><title>fingerprint</title></head><body></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const session = await runtime.openProfile({
      profileId,
      headless: true,
      emulateFingerprint: true,
      locale: 'vi-VN',
      timezoneId: 'Asia/Bangkok',
      viewport: { width: 1280, height: 720 },
      colorScheme: 'dark',
      fingerprint: {
        features: { canvas: true, webgl: true, gpu: true, userAgent: true, clientHints: true },
      },
    });
    const config = JSON.parse(await readFile(join(root, profileId, 'fingerprint-emulation.json'), 'utf8'));
    await session.page.goto(`http://127.0.0.1:${address.port.toString()}/`);
    const mainWorldPage = session.page as unknown as {
      evaluate<R>(fn: () => Promise<R>, arg: undefined, options: undefined, isolatedContext: false): Promise<R>;
    };
    const observed = await mainWorldPage.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgb(10, 20, 30)';
      context.fillRect(0, 0, 1, 1);
      const pixels = context.getImageData(0, 0, 1, 1).data;
      const canvasDataUrl = canvas.toDataURL();
      const gl = document.createElement('canvas').getContext('webgl');
      const hints = await (navigator as Navigator & { userAgentData?: { brands: unknown; platform: string; getHighEntropyValues(values: string[]): Promise<unknown> } }).userAgentData?.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'platformVersion']);
      return {
        userAgent: navigator.userAgent,
        language: navigator.language,
        timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
        viewport: { width: innerWidth, height: innerHeight },
        dark: matchMedia('(prefers-color-scheme: dark)').matches,
        brands: (navigator as Navigator & { userAgentData?: { brands: unknown } }).userAgentData?.brands,
        hints,
        canvas: [...pixels],
        canvasDataUrl,
        webglVendor: gl?.getParameter(0x9245),
        webglRenderer: gl?.getParameter(0x9246),
      };
    }, undefined, undefined, false);
    const nativeCanvasDataUrl = await session.page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgb(10, 20, 30)';
      context.fillRect(0, 0, 1, 1);
      return canvas.toDataURL();
    });
    assert.equal(observed.userAgent, config.userAgent);
    assert.equal(observed.language, config.locale);
    assert.equal(observed.timezoneId, new Intl.DateTimeFormat('en-US', { timeZone: config.timezoneId }).resolvedOptions().timeZone);
    assert.deepEqual(observed.viewport, config.viewport);
    assert.equal(observed.dark, true);
    assert.deepEqual(observed.brands, config.clientHints.brands);
    if (observed.webglVendor !== null) {
      assert.equal(observed.webglVendor, config.webgl.vendor);
      assert.equal(observed.webglRenderer, config.webgl.renderer);
    }
    assert.deepEqual(observed.canvas.slice(0, 3), config.canvas.noise.map((value: number, index: number) => value + ([10, 20, 30][index] ?? 0)));
    assert.notEqual(observed.canvasDataUrl, nativeCanvasDataUrl);
    await session.close();
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('hung cookie save is force-closed by verified PID while another browser stays alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-hung-browser-'));
  const runtime = new BrowserRuntime(root, 2, Buffer.alloc(32, 7), 100);
  try {
    const [first, same] = await Promise.all([runtime.openProfile({ profileId: 'hung' }), runtime.openProfile({ profileId: 'hung' })]);
    assert.equal(first, same, 'Concurrent opens reuse one browser');
    const other = await runtime.openProfile({ profileId: 'unrelated' });
    assert.ok(first.processId && other.processId && first.processId !== other.processId);
    const record = JSON.parse(await readFile(join(root, '.processes', 'hung.json'), 'utf8'));
    assert.equal(record.pid, first.processId);
    first.context.cookies = () => new Promise(() => {});
    await first.close();
    assert.equal(runtime.activeSessionCount, 1);
    assert.throws(() => process.kill(first.processId!, 0));
    await other.page.goto('data:text/html,<title>still alive</title>');
    assert.equal(await other.page.title(), 'still alive');
    const reopened = await runtime.openProfile({ profileId: 'hung', slotTimeoutMs: 1000 });
    assert.notEqual(reopened.processId, first.processId);
    await reopened.close();
  } finally { await runtime.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('force close interrupts a pending task and persisted identity rejects a reused PID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-force-browser-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7), 200);
  try {
    const session = await runtime.openProfile({ profileId: 'fixture' });
    const registry = new BrowserProcessRegistry(root);
    const record = JSON.parse(await readFile(join(root, '.processes', 'fixture.json'), 'utf8'));
    await assert.rejects(registry.terminate({ ...record, started: 'wrong-generation' }), /identity changed/);
    assert.equal(session.page.isClosed(), false);
    const work = runtime.withProfile({ profileId: 'fixture' }, () => new Promise(() => {}));
    const failed = assert.rejects(work, /force closed/);
    await runtime.forceCloseProfile('fixture');
    await failed;
    assert.equal(runtime.activeSessionCount, 0);
    assert.throws(() => process.kill(session.processId!, 0));
  } finally { await runtime.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('force close releases the runtime even when process termination is already unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-force-unavailable-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7), 100);
  let originalTerminate: BrowserProcessRegistry['terminate'] | undefined;
  try {
    const session = await runtime.openProfile({ profileId: 'fixture' });
    const registry = (runtime as unknown as { processes: BrowserProcessRegistry }).processes;
    originalTerminate = registry.terminate.bind(registry);
    registry.terminate = (async () => { throw new Error('process inspection unavailable'); }) as BrowserProcessRegistry['terminate'];

    await assert.doesNotReject(runtime.forceCloseProfile('fixture'));
    assert.equal(runtime.activeSessionCount, 0);

    // The force request must not lose the process marker. A later recovery
    // pass can still terminate the exact token after inspection returns.
    registry.terminate = originalTerminate;
    await new BrowserProcessRegistry(root).recover('fixture');
    assert.throws(() => process.kill(session.processId!, 0));
  } finally {
    if (originalTerminate) {
      const registry = (runtime as unknown as { processes: BrowserProcessRegistry }).processes;
      registry.terminate = originalTerminate;
    }
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('profile recovery removes stale Chrome Singleton locks when no process owns the profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-stale-locks-'));
  const profile = join(root, 'fixture');
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(profile, { recursive: true }));
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await writeFile(join(profile, name), 'stale');
    }
    await new BrowserProcessRegistry(root).recover('fixture');
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await assert.rejects(stat(join(profile, name)), /ENOENT/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task deadline bounds a stuck callback and recovers the slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-task-timeout-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  try {
    await assert.rejects(runtime.withProfile({ profileId: 'fixture', executionTimeoutMs: 100 }, () => new Promise(() => {})), /task timed out/);
    assert.equal(runtime.activeSessionCount, 0);
    const recovered = await runtime.openProfile({ profileId: 'fixture', slotTimeoutMs: 1000 });
    await recovered.close();
  } finally { await runtime.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('deferred close keeps the browser alive until the caller persists task results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-deferred-close-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  try {
    const title = await runtime.withProfile({ profileId: 'fixture', headless: true, closeOnComplete: false }, async session => {
      await session.page.goto('data:text/html,<title>deferred</title>');
      return session.page.title();
    });
    assert.equal(title, 'deferred');
    assert.equal(runtime.activeSessionCount, 1);
    await runtime.closeProfile('fixture');
    assert.equal(runtime.activeSessionCount, 0);
  } finally { await runtime.closeAll(); await rm(root, { recursive: true, force: true }); }
});

test('ephemeral browser contexts never restore or persist profile cookies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-ephemeral-browser-'));
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  const profileId = 'ephemeral-search';
  try {
    const first = await runtime.openProfile({ profileId, ephemeral: true, headless: true });
    await first.context.addCookies([{ name: 'session-auth', value: 'must-not-persist', url: 'https://www.tiktok.com/' }]);
    await first.close();
    await assert.rejects(stat(join(root, profileId)), /ENOENT/);

    const second = await runtime.openProfile({ profileId, ephemeral: true, headless: true });
    assert.equal((await second.context.cookies('https://www.tiktok.com/')).some(cookie => cookie.name === 'session-auth'), false);
    await second.close();
    await assert.rejects(stat(join(root, profileId)), /ENOENT/);
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('persistent Chromium profile survives a close and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-browser-runtime-'));
  const profileId = '00000000-0000-4000-8000-000000000222';
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  const harPath = join(root, 'runtime.har');
  const tracePath = join(root, 'runtime-trace.zip');
  try {
    const first = await runtime.openProfile({
      profileId,
      headless: true,
      recordHarPath: harPath,
    });
    await first.context.tracing.start({ screenshots: true, snapshots: true });
    await first.page.goto('data:text/html,<title>first</title>');
    await first.context.addCookies([
      {
        name: 'session-auth',
        value: 'secret-session-fixture',
        domain: '.example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
      {
        name: 'session-test',
        value: 'persisted',
        url: 'https://example.com',
        expires: Math.floor(Date.now() / 1_000) + 3_600,
      },
    ]);
    await first.context.tracing.stop({ path: tracePath });
    await first.close();
    assert.ok((await stat(tracePath)).size > 0);
    assert.ok((await stat(harPath)).size > 0);
    const sealed = await readFile(join(root, profileId, 'session-cookies.enc'), 'utf8');
    assert.match(sealed, /^sealed:v1:/);
    assert.equal(sealed.includes('secret-session-fixture'), false);

    const second = await runtime.openProfile({ profileId, headless: true });
    const cookies = await second.context.cookies('https://example.com');
    assert.equal(cookies.find((cookie) => cookie.name === 'session-test')?.value, 'persisted');
    assert.equal(cookies.find((cookie) => cookie.name === 'session-auth')?.value, 'secret-session-fixture');
    assert.equal(cookies.find((cookie) => cookie.name === 'session-auth')?.expires, -1);
    assert.equal(cookies.find((cookie) => cookie.name === 'session-auth')?.httpOnly, true);
    await second.context.clearCookies();
    await second.close();
    const third = await runtime.openProfile({ profileId, headless: true });
    assert.equal((await third.context.cookies('https://example.com')).length, 0, 'Logout must not resurrect older session cookies');
    await third.close();
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('explicitly allowlisted localStorage is restored before page scripts run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-browser-local-storage-'));
  const profileId = '00000000-0000-4000-8000-000000000555';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<script>document.title = [localStorage.getItem("fixture-token"), sessionStorage.getItem("fixture-session")].join("|");</script>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port.toString()}`;
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  try {
    const first = await runtime.openProfile({ profileId, headless: true, sessionStateOrigins: [origin], persistSessionStorage: true });
    await first.page.goto(`${origin}/`);
    await first.page.evaluate(() => window.localStorage.setItem('fixture-token', 'persisted-local-storage'));
    await first.page.evaluate(() => window.sessionStorage.setItem('fixture-session', 'persisted-session-storage'));
    await first.page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('fixture-db', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('items');
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction('items', 'readwrite');
          transaction.objectStore('items').put('persisted-indexed-db', 'fixture-key');
          transaction.oncomplete = () => { database.close(); resolve(); };
          transaction.onerror = () => reject(transaction.error);
        };
        request.onerror = () => reject(request.error);
      });
    });
    await first.close();

    // The persistent browser directory is deliberately removed so this test
    // verifies the encrypted sidecar rather than Chromium's own profile.
    const profilePath = join(root, profileId);
    const sealed = await readFile(join(profilePath, 'session-cookies.enc'), 'utf8');
    await rm(profilePath, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(profilePath, { recursive: true });
    await writeFile(join(profilePath, 'session-cookies.enc'), sealed, { mode: 0o600 });

    const second = await runtime.openProfile({ profileId, headless: true, sessionStateOrigins: [origin], persistSessionStorage: true });
    await second.page.goto(`${origin}/`);
    assert.equal(await second.page.title(), 'persisted-local-storage|persisted-session-storage');
    assert.equal(await second.page.evaluate(async () => await new Promise<string | null>((resolve, reject) => {
      const request = indexedDB.open('fixture-db');
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('items', 'readonly');
        const read = transaction.objectStore('items').get('fixture-key');
        read.onsuccess = () => { database.close(); resolve(typeof read.result === 'string' ? read.result : null); };
        read.onerror = () => reject(read.error);
      };
      request.onerror = () => reject(request.error);
    })), 'persisted-indexed-db');
    await second.close();
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('tab-scoped sessionStorage is reset by default while durable storage remains', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-browser-session-reset-'));
  const profileId = '00000000-0000-4000-8000-000000000556';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<script>document.title = [localStorage.getItem("fixture-token"), sessionStorage.getItem("fixture-session")].join("|");</script>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port.toString()}`;
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 7));
  try {
    const first = await runtime.openProfile({ profileId, headless: true, sessionStateOrigins: [origin] });
    await first.page.goto(`${origin}/`);
    await first.page.evaluate(() => {
      window.localStorage.setItem('fixture-token', 'durable');
      window.sessionStorage.setItem('fixture-session', 'stale-tab-state');
    });
    await first.close();

    const second = await runtime.openProfile({ profileId, headless: true, sessionStateOrigins: [origin] });
    await second.page.goto(`${origin}/`);
    assert.equal(await second.page.title(), 'durable|');
    assert.equal(await second.page.evaluate(() => window.sessionStorage.getItem('fixture-session')), null);
    await second.close();
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('session cookies survive an encrypted snapshot restore into a different profile root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-cookie-snapshot-'));
  const key = Buffer.alloc(32, 9);
  const profileId = '00000000-0000-4000-8000-000000000333';
  const source = new BrowserRuntime(join(root, 'source'), 1, key);
  const restored = new BrowserRuntime(join(root, 'restored'), 1, key);
  const objects = new LocalObjectStorage(join(root, 'objects'));
  try {
    const first = await source.openProfile({ profileId, headless: true });
    await first.context.addCookies([{ name: 'c_user', value: 'synthetic-user', domain: '.facebook.com', path: '/' }]);
    await first.close();
    const snapshot = await new ProfileSnapshotStore(objects, join(root, 'source'), join(root, 'tmp'), key).snapshot(profileId, 1);
    await new ProfileSnapshotStore(objects, join(root, 'restored'), join(root, 'tmp'), key).restore(profileId, snapshot.storageUri);
    const second = await restored.openProfile({ profileId, headless: true });
    assert.equal((await second.context.cookies('https://www.facebook.com/')).find(c => c.name === 'c_user')?.value, 'synthetic-user');
    await second.close();
  } finally {
    await source.closeAll();
    await restored.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupted encrypted cookie state fails closed and releases the browser slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-cookie-corruption-'));
  const profileId = '00000000-0000-4000-8000-000000000444';
  const runtime = new BrowserRuntime(root, 1, Buffer.alloc(32, 11));
  try {
    const first = await runtime.openProfile({ profileId, headless: true });
    await first.context.addCookies([{ name: 'fixture', value: 'secret', url: 'https://example.com' }]);
    await first.close();
    const file = join(root, profileId, 'session-cookies.enc');
    const original = await readFile(file, 'utf8');
    await writeFile(file, 'not-valid-encrypted-state');
    await assert.rejects(() => runtime.openProfile({ profileId, headless: true }), /sealed secret/);
    assert.equal(runtime.activeSessionCount, 0);
    await writeFile(file, original);
    const recovered = await runtime.openProfile({ profileId, headless: true, slotTimeoutMs: 1000 });
    assert.equal((await recovered.context.cookies('https://example.com')).find(c => c.name === 'fixture')?.value, 'secret');
    await Promise.all([recovered.close(), recovered.close()]);
  } finally {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
