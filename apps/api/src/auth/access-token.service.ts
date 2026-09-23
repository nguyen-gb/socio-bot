import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { organizationRoleSchema } from '@socio/contracts';
import { z } from 'zod';
import type { ApiEnvironment } from '../config/environment';
import type { AuthPrincipal } from './auth.types';

const payloadSchema = z.object({
  sub: z.uuid(),
  org: z.uuid(),
  role: organizationRoleSchema,
  email: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
});

@Injectable()
export class AccessTokenService {
  constructor(private readonly config: ConfigService<ApiEnvironment, true>) {}

  issue(principal: Omit<AuthPrincipal, 'kind'>) {
    if (!principal.userId || !principal.email) {
      throw new Error('User id and email are required for an access token');
    }
    const now = Math.floor(Date.now() / 1_000);
    const expiresAt = now + this.config.get('accessTokenTtlSeconds', { infer: true });
    const header = encodeJson({ alg: 'HS256', typ: 'JWT' });
    const payload = encodeJson({
      sub: principal.userId,
      org: principal.organizationId,
      role: principal.role,
      email: principal.email,
      iat: now,
      exp: expiresAt,
    });
    const unsigned = `${header}.${payload}`;
    return {
      token: `${unsigned}.${this.signature(unsigned)}`,
      expiresAt: new Date(expiresAt * 1_000),
    };
  }

  verify(token: string): AuthPrincipal {
    const [header, payload, signature] = token.split('.');
    if (!header || !payload || !signature) throw new UnauthorizedException('Invalid access token');
    const expected = Buffer.from(this.signature(`${header}.${payload}`));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException('Invalid access token');
    }
    try {
      const parsed = payloadSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      if (parsed.exp <= Math.floor(Date.now() / 1_000)) {
        throw new UnauthorizedException('Access token expired');
      }
      return {
        kind: 'user',
        userId: parsed.sub,
        organizationId: parsed.org,
        role: parsed.role,
        email: parsed.email,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid access token');
    }
  }

  private signature(value: string): string {
    return createHmac('sha256', this.config.get('accessTokenSecret', { infer: true }))
      .update(value)
      .digest('base64url');
  }
}

function encodeJson(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
