import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginSessionSchema, remoteBrowserCommandSchema } from './sessions';

test('login sessions apply a bounded default TTL', () => {
  assert.deepEqual(createLoginSessionSchema.parse({}), { ttlSeconds: 600 });
  assert.equal(createLoginSessionSchema.safeParse({ ttlSeconds: 30 }).success, false);
  assert.equal(createLoginSessionSchema.safeParse({ ttlSeconds: 1801 }).success, false);
});

test('remote scroll and drag inputs are bounded and navigation keys are allowed', () => {
  for (const type of ['wheel', 'mouse']) {
    const command = type === 'wheel' ? { type, x: 0.5, y: 0.5, deltaX: -25.5, deltaY: 120 } : { type, action: 'move', x: 1, y: 0 };
    assert.equal(remoteBrowserCommandSchema.safeParse(command).success, true);
    assert.equal(remoteBrowserCommandSchema.safeParse({ ...command, x: -0.1 }).success, false);
    assert.equal(remoteBrowserCommandSchema.safeParse({ ...command, y: Infinity }).success, false);
  }
  assert.equal(remoteBrowserCommandSchema.safeParse({ type: 'wheel', x: 0, y: 0, deltaX: 0, deltaY: 4001 }).success, false);
  assert.equal(remoteBrowserCommandSchema.safeParse({ type: 'mouse', action: 'doubleClick', x: 0, y: 0 }).success, false);
  assert.equal(remoteBrowserCommandSchema.safeParse({ type: 'release' }).success, true);
  for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) {
    assert.equal(remoteBrowserCommandSchema.safeParse({ type: 'key', key }).success, true);
  }
});

test('remote browser commands only accept normalized input', () => {
  assert.equal(
    remoteBrowserCommandSchema.safeParse({ type: 'click', x: 0.25, y: 0.75 }).success,
    true,
  );
  assert.equal(
    remoteBrowserCommandSchema.safeParse({ type: 'click', x: 2, y: 0.5 }).success,
    false,
  );
  assert.equal(
    remoteBrowserCommandSchema.safeParse({ type: 'key', key: 'F12' }).success,
    false,
  );
  assert.deepEqual(
    remoteBrowserCommandSchema.parse({ type: 'key', key: 'Tab', shift: true }),
    { type: 'key', key: 'Tab', shift: true },
  );
});

test('browser navigation only accepts HTTP(S) and scoped tab identifiers', () => {
  for (const url of ['https://example.com/path', 'http://localhost:3000/']) assert.equal(remoteBrowserCommandSchema.safeParse({ type: 'navigate', url }).success, true);
  for (const url of ['javascript:alert(1)', 'file:///C:/Windows/system.ini', 'data:text/html,test', 'chrome://settings', 'https://user:secret@example.com/', '/relative']) assert.equal(remoteBrowserCommandSchema.safeParse({ type: 'navigate', url }).success, false);
  assert.equal(remoteBrowserCommandSchema.safeParse({ type: 'closeTab', tabId: 'not-a-tab' }).success, false);
  assert.equal(remoteBrowserCommandSchema.safeParse({ type: 'navigation', action: 'back' }).success, true);
});
