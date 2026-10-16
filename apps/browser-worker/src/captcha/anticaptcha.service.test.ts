import assert from 'node:assert/strict';
import test from 'node:test';
import { AntiCaptchaService } from './anticaptcha.service';

function service(values: Record<string, unknown>): AntiCaptchaService {
  return new AntiCaptchaService({
    get: (key: string) => values[key],
  } as never);
}

test('AntiCaptcha.top solves TikTok rotate with the documented type and image fields', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    const payload = method === 'POST'
      ? { status: 1, request: 'task-1' }
      : { status: 1, request: 'coordinates:x=0,y=170', message: 'Đã xử lý xong' };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await service({
      anticaptchaApiKey: 'key-1',
      anticaptchaApiUrl: 'https://anticaptcha.top/api/captcha',
      anticaptchaRecognitionUrl: 'https://anticaptcha.top/in.php',
      anticaptchaResultUrl: 'https://anticaptcha.top/res.php',
      anticaptchaApiTransport: 'json',
      anticaptchaAutoSolve: true,
      anticaptchaTimeoutMs: 1000,
      anticaptchaTikTokRotateMode: 'degrees',
    }).solveTikTokRotate(['inside-base64', 'outside-base64']);
    assert.equal(result, 170 / 271);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, 'https://anticaptcha.top/in.php');
    assert.equal(calls[0]?.method, 'POST');
    assert.deepEqual(calls[0]?.body, {
      key: 'key-1',
      method: 'base64',
      textinstructions: 'koleso',
      click: 'geetest',
      body0: 'inside-base64',
      body1: 'outside-base64',
      json: 1,
    });
    assert.equal(calls[1]?.url, 'https://anticaptcha.top/res.php?key=key-1&id=task-1&json=1');
    assert.equal(calls[1]?.method, 'GET');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AntiCaptcha.top stays disabled unless explicitly enabled with a key', async () => {
  const captcha = service({
    anticaptchaApiKey: undefined,
    anticaptchaApiUrl: 'https://anticaptcha.top/api/captcha',
    anticaptchaAutoSolve: false,
    anticaptchaTimeoutMs: 1000,
  });
  assert.equal(captcha.enabled, false);
  assert.deepEqual(await captcha.trySolveVisibleRecaptcha({} as never), {
    attempted: false,
    solved: false,
    reason: 'disabled',
  });
});

test('AntiCaptcha.top sends a standard reCAPTCHA request and injects the returned token', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url: String(input), method, body });
    const payload = method === 'POST'
      ? { status: 1, request: 'task-1' }
      : { status: 1, request: 'token-1' };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  const fields: Array<{ value: string }> = [];
  const page = {
    evaluate: async (callback: unknown, arg?: unknown) => {
      if (arg === undefined) {
        return {
          siteKey: 'site-key',
          version: 'v2' as const,
          websiteURL: 'https://example.com',
        };
      }
      void callback;
      void arg;
      fields.push({ value: 'token-1' });
      return 1;
    },
  };
  try {
    const result = await service({
      anticaptchaApiKey: 'key-1',
      anticaptchaRecognitionUrl: 'https://anticaptcha.top/in.php',
      anticaptchaResultUrl: 'https://anticaptcha.top/res.php',
      anticaptchaAutoSolve: true,
      anticaptchaTimeoutMs: 1000,
    }).trySolveVisibleRecaptcha(page as never);
    assert.deepEqual(result, { attempted: true, solved: true });
    assert.deepEqual(calls[0], {
      url: 'https://anticaptcha.top/in.php',
      method: 'POST',
      body: {
        key: 'key-1',
        method: 'userrecaptcha',
        googlekey: 'site-key',
        pageurl: 'https://example.com',
        json: 1,
      },
    });
    assert.deepEqual(calls[1], {
      url: 'https://anticaptcha.top/res.php?key=key-1&id=task-1&json=1',
      method: 'GET',
      body: undefined,
    });
    assert.equal(fields.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
