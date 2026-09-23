import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { OrganizationRole } from '@socio/contracts';
import type { AuthenticatedRequest } from './auth.types';
import { MINIMUM_ROLE } from './roles.decorator';

const RANK: Record<OrganizationRole, number> = {
  VIEWER: 0,
  OPERATOR: 1,
  ADMIN: 2,
  OWNER: 3,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const minimum = this.reflector.getAllAndOverride<OrganizationRole>(MINIMUM_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!minimum) return true;
    const principal = context.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (!principal || RANK[principal.role] < RANK[minimum]) {
      throw new ForbiddenException(`This action requires ${minimum} access`);
    }
    return true;
  }
}
