import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RemoteSessionToken {
  token: string;
  expiresAt: Date;
}

export function signRemoteSessionToken(
  sessionId: string,
  secret: string,
  ttlSeconds = 60,
  now = new Date(),
): RemoteSessionToken {
  assertSecret(secret);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
  const payload = `${sessionId}.${expiresAtSeconds.toString()}`;
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  return {
    token: `${expiresAtSeconds.toString()}.${signature}`,
    expiresAt,
  };
}

export function verifyRemoteSessionToken(
  sessionId: string,
  token: string,
  secret: string,
  now = new Date(),
): boolean {
  try {
    assertSecret(secret);
    const [expiresAtValue, candidateSignature, ...rest] = token.split('.');
    if (!expiresAtValue || !candidateSignature || rest.length > 0) return false;

    const expiresAtSeconds = Number(expiresAtValue);
    if (!Number.isSafeInteger(expiresAtSeconds)) return false;
    if (expiresAtSeconds <= Math.floor(now.getTime() / 1_000)) return false;

    const expectedSignature = createHmac('sha256', secret)
      .update(`${sessionId}.${expiresAtValue}`)
      .digest('base64url');
    const candidate = Buffer.from(candidateSignature);
    const expected = Buffer.from(expectedSignature);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

function assertSecret(secret: string): void {
  if (secret.length < 32) {
    throw new Error('REMOTE_SESSION_SECRET must contain at least 32 characters');
  }
}
