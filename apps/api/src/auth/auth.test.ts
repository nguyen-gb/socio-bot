import assert from 'node:assert/strict';
import test from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { AccessTokenService } from './access-token.service';
import { AuthService } from './auth.service';
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

test('refresh token rotation is claimed atomically before minting a replacement', async () => {
  const membership = {
    organizationId: '00000000-0000-4000-8000-000000000001',
    role: 'OWNER' as const,
    organization: { name: 'Test' },
  };
  const current = {
    id: '00000000-0000-4000-8000-000000000020',
    organizationId: membership.organizationId,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    user: {
      id: '00000000-0000-4000-8000-000000000010',
      email: 'owner@socio.local',
      displayName: 'Owner',
      status: 'ACTIVE',
      memberships: [membership],
    },
  };
  let replacementCreated = false;
  const transaction = {
    refreshToken: {
      findUnique: async () => current,
      updateMany: async () => ({ count: 0 }),
      create: async () => { replacementCreated = true; },
    },
  };
  const prisma = {
    $transaction: async (callback: (tx: typeof transaction) => unknown) => callback(transaction),
  };
  const service = new AuthService(
    prisma as never,
    { issue: () => ({ token: 'access', expiresAt: new Date(Date.now() + 60_000) }) } as never,
    { get: () => 30 } as never,
  );

  await assert.rejects(() => service.refresh('already-used'), UnauthorizedException);
  assert.equal(replacementCreated, false);
});
