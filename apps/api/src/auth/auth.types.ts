import type { OrganizationRole } from '@socio/contracts';
import type { Request } from 'express';

export interface AuthPrincipal {
  kind: 'user' | 'service';
  userId?: string;
  organizationId: string;
  role: OrganizationRole;
  email?: string;
}

export interface AuthenticatedRequest extends Request {
  principal?: AuthPrincipal;
}
