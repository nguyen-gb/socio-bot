import assert from 'node:assert/strict';
import test from 'node:test';
import { sealSecret, unsealSecret } from './sealed-secret';

test('sealed credentials round-trip without exposing plaintext', () => {
  const key = Buffer.alloc(32, 9);
  const sealed = sealSecret({ username: 'operator', password: 'private-value' }, key);
  assert.equal(sealed.includes('private-value'), false);
  assert.deepEqual(
    unsealSecret<{ username: string; password: string }>(sealed, key),
    { username: 'operator', password: 'private-value' },
  );
});

test('sealed credentials reject a different encryption key', () => {
  const sealed = sealSecret({ value: 'secret' }, Buffer.alloc(32, 2));
  assert.throws(() => unsealSecret(sealed, Buffer.alloc(32, 3)));
});
