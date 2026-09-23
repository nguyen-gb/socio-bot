import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateAddress } from './proxies.service';

test('proxy host guard blocks non-public addresses', () => {
  for (const address of [
    '127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.2.1',
    '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});
