import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import {
  createLoginSessionSchema,
  type CreateLoginSessionInput,
} from '@socio/contracts';
import { OrganizationId } from '../common/organization-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MinimumRole } from '../auth/roles.decorator';
import { LoginSessionsService } from './login-sessions.service';

@Controller()
export class LoginSessionsController {
  constructor(private readonly sessions: LoginSessionsService) {}

  @Post('accounts/:accountId/login-sessions')
  @MinimumRole('OPERATOR')
  create(
    @OrganizationId() organizationId: string,
    @Param('accountId') accountId: string,
    @Body(new ZodValidationPipe(createLoginSessionSchema))
    input: CreateLoginSessionInput,
  ) {
    return this.sessions.create(organizationId, accountId, input);
  }

  @Get('login-sessions')
  listActive(@OrganizationId() organizationId: string) {
    return this.sessions.listActive(organizationId);
  }

  @Get('accounts/:accountId/login-sessions')
  listForAccount(
    @OrganizationId() organizationId: string,
    @Param('accountId') accountId: string,
  ) {
    return this.sessions.listForAccount(organizationId, accountId);
  }

  @Get('login-sessions/:sessionId')
  get(
    @OrganizationId() organizationId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.sessions.get(organizationId, sessionId);
  }

  @Delete('login-sessions/:sessionId')
  @MinimumRole('OPERATOR')
  close(
    @OrganizationId() organizationId: string,
    @Param('sessionId') sessionId: string,
    @Query('force') force?: string,
  ) {
    return this.sessions.close(organizationId, sessionId, force === 'true');
  }
}
