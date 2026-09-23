import {
  BadRequestException,
  ForbiddenException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const OrganizationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const headerOrganizationId = request.header('x-organization-id');
    const organizationId = request.principal?.organizationId || headerOrganizationId;
    if (!organizationId || !UUID_PATTERN.test(organizationId)) {
      throw new BadRequestException(
        'x-organization-id must be a valid UUID',
      );
    }
    if (
      request.principal?.kind === 'user' &&
      headerOrganizationId &&
      headerOrganizationId !== organizationId
    ) {
      throw new ForbiddenException('Cannot override the token organization');
    }
    return organizationId;
  },
);
