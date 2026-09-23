import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccessTokenService } from '../auth/access-token.service';
import type { AuthenticatedRequest } from '../auth/auth.types';
import type { ApiEnvironment } from '../config/environment';
import { PUBLIC_ENDPOINT } from './public.decorator';
import { SERVICE_ONLY } from './service-only.decorator';

@Injectable()
export class ControlApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<ApiEnvironment, true>,
    private readonly tokens: AccessTokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ENDPOINT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const serviceOnly = this.reflector.getAllAndOverride<boolean>(SERVICE_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.header('authorization') ?? '';
    const candidate = request.header('x-api-key') ??
      (authorization.startsWith('Service ') ? authorization.slice(8) : '');
    const expected = this.config.get('controlApiKey', { infer: true });

    if (safeEqual(candidate, expected)) {
      request.principal = {
        kind: 'service',
        organizationId: request.header('x-organization-id') ?? '',
        role: 'OWNER',
      };
      return true;
    }

    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token) throw new UnauthorizedException('Authentication required');
    request.principal = this.tokens.verify(token);
    if (serviceOnly) {
      throw new ForbiddenException('This endpoint is restricted to internal services');
    }
    return true;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
