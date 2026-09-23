import assert from 'node:assert/strict';
import test from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { AccessTokenService } from './access-token.service';
import { hashPassword, verifyPassword } from './password';

test('password hashes verify without storing plaintext', async () => {
  const encoded = await hashPassword('A-Very-Strong-Password!');
  assert.equal(encoded.includes('A-Very-Strong-Password!'), false);
  assert.equal(await verifyPassword('A-Very-Strong-Password!', encoded), true);
  assert.equal(await verifyPassword('wrong-password', encoded), false);
});

test('access token is scoped to the signed user and organization', () => {
  const config = {
    get(key: string) {
      if (key === 'accessTokenSecret') return 'test-access-token-secret-at-least-32-characters';
      if (key === 'accessTokenTtlSeconds') return 3600;
      throw new Error(`Unexpected config key ${key}`);
    },
  };
  const service = new AccessTokenService(config as never);
  const issued = service.issue({
    userId: '00000000-0000-4000-8000-000000000010',
    organizationId: '00000000-0000-4000-8000-000000000001',
    role: 'OPERATOR',
    email: 'operator@socio.local',
  });
  assert.deepEqual(service.verify(issued.token), {
    kind: 'user',
    userId: '00000000-0000-4000-8000-000000000010',
    organizationId: '00000000-0000-4000-8000-000000000001',
    role: 'OPERATOR',
    email: 'operator@socio.local',
  });
  assert.throws(
    () => service.verify(`${issued.token.slice(0, -1)}x`),
    UnauthorizedException,
  );
});
