import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlatformAdapter } from './index';
import { PlatformAdapterRegistry } from './index';

const adapter: PlatformAdapter = {
  platform: 'X',
  execute: async () => ({ ok: true }),
};

test('adapter registry supports extension without changing execution core', () => {
  const registry = new PlatformAdapterRegistry([adapter]);
  assert.equal(registry.get('X'), adapter);
  assert.deepEqual(registry.list(), ['X']);
  assert.throws(() => registry.register(adapter), /already registered/);
});
