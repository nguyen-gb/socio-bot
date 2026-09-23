import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createAccountSchema,
  type CreateAccountInput,
  updateAccountSchema,
  type UpdateAccountInput,
} from '@socio/contracts';
import { OrganizationId } from '../common/organization-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MinimumRole } from '../auth/roles.decorator';
import { AccountsService } from './accounts.service';

@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(@OrganizationId() organizationId: string) {
    return this.accounts.list(organizationId);
  }

  @Get(':id')
  get(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.accounts.get(organizationId, id);
  }

  @Get(':id/credentials')
  @MinimumRole('ADMIN')
  credentials(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.accounts.credentials(organizationId, id);
  }

  @Post()
  @MinimumRole('ADMIN')
  create(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(createAccountSchema)) input: CreateAccountInput,
  ) {
    return this.accounts.create(organizationId, input);
  }

  @Patch(':id')
  @MinimumRole('ADMIN')
  update(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAccountSchema)) input: UpdateAccountInput,
  ) {
    return this.accounts.update(organizationId, id, input);
  }

  @Delete(':id')
  @MinimumRole('ADMIN')
  remove(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.accounts.remove(organizationId, id);
  }
}
