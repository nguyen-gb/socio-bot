import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Prisma } from '@socio/database';
import type { Observable } from 'rxjs';
import { from, mergeMap } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !request.principal?.organizationId) {
      return next.handle();
    }
    // Persist an audit attempt before entering a mutation. This prevents a
    // successful write from having no durable audit record when the process
    // exits or the later response path is interrupted.
    return from(this.prisma.auditLog.create({
      data: {
        organizationId: request.principal.organizationId,
        actorUserId: request.principal.userId,
        action: `${request.method} ${request.route?.path ?? request.path}`,
        resourceType: resourceType(request.originalUrl),
        resourceId: extractResourceId(request.params),
        ipAddress: request.ip,
        metadata: {
          kind: request.principal.kind,
          userAgent: request.header('user-agent') ?? null,
          stage: 'ATTEMPTED',
        } as Prisma.InputJsonValue,
      },
    })).pipe(mergeMap(() => next.handle()));
  }
}

function resourceType(originalUrl: string): string {
  const segments = originalUrl.split('?')[0]!.split('/').filter(Boolean);
  return (segments[0] === 'api' ? segments[1] : segments[0]) ?? 'unknown';
}

function extractResourceId(
  params: Record<string, string | string[]>,
): string | undefined {
  const candidate = params.id ?? params.sessionId ?? params.accountId;
  const paramId = Array.isArray(candidate) ? candidate[0] : candidate;
  if (paramId && /^[0-9a-f-]{36}$/i.test(paramId)) return paramId;
  return undefined;
}
