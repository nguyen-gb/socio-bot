import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const PREFIX = 'sealed:v1';

export function sealSecret(value: unknown, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function unsealSecret<T>(reference: string, key: Buffer): T {
  assertKey(key);
  const [scheme, version, ivValue, tagValue, encryptedValue, extra] =
    reference.split(':');
  if (
    scheme !== 'sealed' ||
    version !== 'v1' ||
    !ivValue ||
    !tagValue ||
    !encryptedValue ||
    extra
  ) {
    throw new Error('Invalid sealed secret reference');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

export function isSealedSecret(reference: string): boolean {
  return reference.startsWith(`${PREFIX}:`);
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error('Secret encryption key must be exactly 32 bytes');
  }
}
