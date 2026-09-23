import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sealSecret } from '@socio/object-storage';
import { SecretsService } from './secrets.service';

test('proxy credentials resolve from a bounded secret file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'socio-secrets-'));
  const key = Buffer.alloc(32, 5);
  const config = {
    get: (name: string) =>
      name === 'profileEncryptionKey' ? key.toString('base64') : root,
  };
  const service = new SecretsService(config as never);
  try {
    await mkdir(join(root, 'proxies'));
    await writeFile(
      join(root, 'proxies', 'primary.json'),
      JSON.stringify({ username: 'proxy-user', password: 'proxy-password' }),
    );
    assert.deepEqual(await service.proxyCredentials('file://proxies/primary.json'), {
      username: 'proxy-user',
      password: 'proxy-password',
    });
    const sealed = sealSecret(
      { username: 'sealed-user', password: 'sealed-password' },
      key,
    );
    assert.deepEqual(await service.proxyCredentials(sealed), {
      username: 'sealed-user',
      password: 'sealed-password',
    });
    const profileSecret = sealSecret(
      {
        login: 'profile-user',
        password: 'profile-password',
        cookies: 'c_user=123; xs=abc',
      },
      key,
    );
    assert.deepEqual(await service.profileCredentials(profileSecret), {
      login: 'profile-user',
      password: 'profile-password',
      cookies: 'c_user=123; xs=abc',
    });
    await assert.rejects(() => service.proxyCredentials('file://../outside.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
