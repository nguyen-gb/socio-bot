import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { createUserSchema, updateUserSchema, type CreateUserInput, type UpdateUserInput } from '@socio/contracts';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { AuthPrincipal } from '../auth/auth.types';
import { MinimumRole } from '../auth/roles.decorator';
import { OrganizationId } from '../common/organization-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { UsersService } from './users.service';

@Controller('users')
@MinimumRole('ADMIN')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get() list(@OrganizationId() organizationId: string) { return this.users.list(organizationId); }
  @Post() create(@OrganizationId() organizationId: string, @Body(new ZodValidationPipe(createUserSchema)) input: CreateUserInput) { return this.users.create(organizationId, input); }
  @Patch(':id') update(@OrganizationId() organizationId: string, @Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal, @Body(new ZodValidationPipe(updateUserSchema)) input: UpdateUserInput) { return this.users.update(organizationId, id, principal.userId, input); }
  @Delete(':id') remove(@OrganizationId() organizationId: string, @Param('id') id: string, @CurrentPrincipal() principal: AuthPrincipal) { return this.users.remove(organizationId, id, principal.userId); }
}
