import { SetMetadata } from '@nestjs/common';
import type { OrganizationRole } from '@socio/contracts';

export const MINIMUM_ROLE = Symbol('MINIMUM_ROLE');
export const MinimumRole = (role: OrganizationRole) => SetMetadata(MINIMUM_ROLE, role);
