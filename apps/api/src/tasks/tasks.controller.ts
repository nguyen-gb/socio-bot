import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  createTaskSchema,
  type CreateTaskInput,
} from '@socio/contracts';
import { OrganizationId } from '../common/organization-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MinimumRole } from '../auth/roles.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { AuthPrincipal } from '../auth/auth.types';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@OrganizationId() organizationId: string) {
    return this.tasks.list(organizationId);
  }

  @Get(':id')
  get(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.tasks.get(organizationId, id);
  }

  @Post()
  @MinimumRole('OPERATOR')
  create(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(createTaskSchema)) input: CreateTaskInput,
  ) {
    return this.tasks.create(organizationId, input);
  }

  @Post(':id/approve')
  @MinimumRole('ADMIN')
  approve(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    return this.tasks.approve(organizationId, id, principal.userId);
  }

  @Post(':id/reject')
  @MinimumRole('ADMIN')
  reject(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    return this.tasks.reject(organizationId, id, principal.userId);
  }

  @Post(':id/retry')
  @MinimumRole('OPERATOR')
  retry(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.tasks.retry(organizationId, id);
  }

  @Post(':id/retry-action')
  @MinimumRole('ADMIN')
  retryAction(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @CurrentPrincipal() principal: AuthPrincipal,
  ) {
    return this.tasks.retryAction(organizationId, id, principal.userId);
  }

  @Post(':id/cancel')
  @MinimumRole('ADMIN')
  cancel(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.tasks.cancel(organizationId, id);
  }

  @Post(':id/pause')
  @MinimumRole('ADMIN')
  pause(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.tasks.pause(organizationId, id);
  }

  @Post(':id/resume')
  @MinimumRole('ADMIN')
  resume(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.tasks.resume(organizationId, id);
  }
}
