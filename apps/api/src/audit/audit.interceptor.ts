import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Prisma } from '@socio/database';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs';
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
    return next.handle().pipe(
      tap((result) => {
        const resourceId = extractResourceId(request.params, result);
        void this.prisma.auditLog.create({
          data: {
            organizationId: request.principal!.organizationId,
            actorUserId: request.principal!.userId,
            action: `${request.method} ${request.route?.path ?? request.path}`,
            resourceType: resourceType(request.originalUrl),
            resourceId,
            ipAddress: request.ip,
            metadata: {
              kind: request.principal!.kind,
              userAgent: request.header('user-agent') ?? null,
            } as Prisma.InputJsonValue,
          },
        }).catch(() => undefined);
      }),
    );
  }
}

function resourceType(originalUrl: string): string {
  const segments = originalUrl.split('?')[0]!.split('/').filter(Boolean);
  return (segments[0] === 'api' ? segments[1] : segments[0]) ?? 'unknown';
}

function extractResourceId(
  params: Record<string, string | string[]>,
  result: unknown,
): string | undefined {
  const candidate = params.id ?? params.sessionId ?? params.accountId;
  const paramId = Array.isArray(candidate) ? candidate[0] : candidate;
  if (paramId && /^[0-9a-f-]{36}$/i.test(paramId)) return paramId;
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id?: unknown }).id;
    if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) return id;
  }
  return undefined;
}
