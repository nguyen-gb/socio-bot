import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeProxyError } from './proxy-check.activities';

test('normalizes Playwright proxy connection errors', () => {
  assert.equal(
    normalizeProxyError(new Error('page.goto: net::ERR_PROXY_CONNECTION_FAILED')),
    'Proxy từ chối hoặc không nhận kết nối',
  );
  assert.equal(
    normalizeProxyError(new Error('page.goto: Timeout 25000ms exceeded')),
    'Không thể kết nối proxy: hết thời gian chờ',
  );
  assert.equal(
    normalizeProxyError(new Error('page.goto: net::ERR_INVALID_AUTH_CREDENTIALS')),
    'Username hoặc password của proxy không đúng',
  );
});
