import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEnvironment } from './environment';

const requiredKeys = [
  'NODE_ENV',
  'REMOTE_SESSION_SECRET',
  'PROFILE_ENCRYPTION_KEY',
  'BROWSER_HEADLESS',
  'BROWSER_CHANNEL',
  'BROWSER_COLOR_SCHEME',
  'BROWSER_FINGERPRINT_EMULATION',
  'BROWSER_TASK_TIMEOUT_MS',
  'TIKTOK_SEARCH_MODE',
  'TIKTOK_SEARCH_FIXTURE_SCENARIO',
] as const;

test('browser mode follows the environment default and accepts an explicit override', () => {
  const previous = Object.fromEntries(
    requiredKeys.map((key) => [key, process.env[key]]),
  );
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.BROWSER_HEADLESS;
    delete process.env.REMOTE_SESSION_SECRET;
    delete process.env.PROFILE_ENCRYPTION_KEY;
    assert.equal(loadEnvironment().browserHeadless, false);

    process.env.NODE_ENV = 'production';
    process.env.REMOTE_SESSION_SECRET = 'r'.repeat(32);
    process.env.PROFILE_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    delete process.env.BROWSER_HEADLESS;
    assert.equal(loadEnvironment().browserHeadless, true);

    process.env.BROWSER_HEADLESS = 'false';
    assert.equal(loadEnvironment().browserHeadless, false);
    process.env.BROWSER_HEADLESS = 'true';
    assert.equal(loadEnvironment().browserHeadless, true);

    delete process.env.BROWSER_CHANNEL;
    assert.equal(loadEnvironment().browserChannel, 'chrome');
    process.env.BROWSER_CHANNEL = 'msedge';
    assert.equal(loadEnvironment().browserChannel, 'msedge');

    process.env.BROWSER_COLOR_SCHEME = 'dark';
    assert.equal(loadEnvironment().browserColorScheme, 'dark');
    process.env.BROWSER_COLOR_SCHEME = 'unsupported';
    assert.throws(() => loadEnvironment(), /Expected one of light, dark, no-preference/);
    delete process.env.BROWSER_COLOR_SCHEME;

    delete process.env.BROWSER_FINGERPRINT_EMULATION;
    assert.equal(loadEnvironment().browserFingerprintEmulation, true);
    process.env.BROWSER_FINGERPRINT_EMULATION = 'false';
    assert.equal(loadEnvironment().browserFingerprintEmulation, false);

    delete process.env.BROWSER_TASK_TIMEOUT_MS;
    assert.equal(loadEnvironment().browserTaskTimeoutMs, 900_000);
    process.env.BROWSER_TASK_TIMEOUT_MS = '900000';
    assert.equal(loadEnvironment().browserTaskTimeoutMs, 900_000);
    process.env.BROWSER_TASK_TIMEOUT_MS = '900001';
    assert.throws(() => loadEnvironment(), /BROWSER_TASK_TIMEOUT_MS/);
    delete process.env.BROWSER_TASK_TIMEOUT_MS;

    process.env.NODE_ENV = 'development';
    process.env.TIKTOK_SEARCH_MODE = 'fixture';
    process.env.TIKTOK_SEARCH_FIXTURE_SCENARIO = 'challenge';
    assert.equal(loadEnvironment().tiktokSearchMode, 'fixture');
    assert.equal(loadEnvironment().tiktokSearchFixtureScenario, 'challenge');

    process.env.NODE_ENV = 'production';
    assert.throws(() => loadEnvironment(), /only allowed outside production/i);
  } finally {
    for (const key of requiredKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('browser environment rejects malformed values before launching the worker', () => {
  const keys = ['BROWSER_LOCALE', 'BROWSER_TIMEZONE_ID', 'BROWSER_VIEWPORT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.BROWSER_LOCALE = 'en_US';
    assert.throws(() => loadEnvironment(), /Invalid BROWSER_LOCALE/);
    process.env.BROWSER_LOCALE = 'en-US';
    process.env.BROWSER_TIMEZONE_ID = 'Mars/Olympus_Mons';
    assert.throws(() => loadEnvironment(), /Invalid BROWSER_TIMEZONE_ID/);
    process.env.BROWSER_TIMEZONE_ID = 'Asia/Ho_Chi_Minh';
    process.env.BROWSER_VIEWPORT = '639x480';
    assert.throws(() => loadEnvironment(), /Invalid BROWSER_VIEWPORT/);
    process.env.BROWSER_VIEWPORT = '1280x720';
    assert.equal(loadEnvironment().browserLocale, 'en-US');
    assert.equal(loadEnvironment().browserTimezoneId, 'Asia/Ho_Chi_Minh');
    assert.deepEqual(loadEnvironment().browserViewport, { width: 1280, height: 720 });
    process.env.BROWSER_VIEWPORT = 'auto';
    assert.equal(loadEnvironment().browserViewport, null);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('AntiCaptcha.top is opt-in and validates its API configuration', () => {
  const keys = ['ANTICAPTCHA_API_KEY', 'ANTICAPTCHA_API_URL', 'ANTICAPTCHA_RECOGNITION_URL', 'ANTICAPTCHA_RESULT_URL', 'ANTICAPTCHA_API_TRANSPORT', 'ANTICAPTCHA_AUTO_SOLVE', 'ANTICAPTCHA_TIMEOUT_MS', 'ANTICAPTCHA_TIKTOK_ROTATE_INVERT', 'ANTICAPTCHA_TIKTOK_ROTATE_MODE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.NODE_ENV = 'development';
    delete process.env.ANTICAPTCHA_API_KEY;
    delete process.env.ANTICAPTCHA_API_URL;
    delete process.env.ANTICAPTCHA_RECOGNITION_URL;
    delete process.env.ANTICAPTCHA_RESULT_URL;
    delete process.env.ANTICAPTCHA_AUTO_SOLVE;
    assert.equal(loadEnvironment().anticaptchaApiKey, undefined);
    assert.equal(loadEnvironment().anticaptchaApiUrl, 'https://anticaptcha.top/api/captcha');
    assert.equal(loadEnvironment().anticaptchaRecognitionUrl, 'https://anticaptcha.top/in.php');
    assert.equal(loadEnvironment().anticaptchaResultUrl, 'https://anticaptcha.top/res.php');
    assert.equal(loadEnvironment().anticaptchaApiTransport, 'json');
    assert.equal(loadEnvironment().anticaptchaAutoSolve, false);

    process.env.ANTICAPTCHA_AUTO_SOLVE = 'true';
    assert.throws(() => loadEnvironment(), /ANTICAPTCHA_API_KEY is required/);
    process.env.ANTICAPTCHA_API_KEY = 'test-key';
    process.env.ANTICAPTCHA_API_URL = 'https://captcha.example.test/api/captcha/';
    process.env.ANTICAPTCHA_RECOGNITION_URL = 'https://captcha.example.test/in.php/';
    process.env.ANTICAPTCHA_RESULT_URL = 'https://captcha.example.test/res.php/';
    process.env.ANTICAPTCHA_TIMEOUT_MS = '60000';
    const loaded = loadEnvironment();
    assert.equal(loaded.anticaptchaAutoSolve, true);
    assert.equal(loaded.anticaptchaApiUrl, 'https://captcha.example.test/api/captcha');
    assert.equal(loaded.anticaptchaRecognitionUrl, 'https://captcha.example.test/in.php');
    assert.equal(loaded.anticaptchaResultUrl, 'https://captcha.example.test/res.php');
    assert.equal(loaded.anticaptchaTimeoutMs, 60000);
    assert.equal(loaded.anticaptchaTikTokRotateInvert, false);
    assert.equal(loaded.anticaptchaTikTokRotateMode, 'degrees');

    process.env.ANTICAPTCHA_API_URL = 'ftp://captcha.example.test/api/captcha';
    assert.throws(() => loadEnvironment(), /must use http or https/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
