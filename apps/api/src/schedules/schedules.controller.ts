import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  createScheduleSchema,
  type CreateScheduleInput,
} from '@socio/contracts';
import { MinimumRole } from '../auth/roles.decorator';
import { OrganizationId } from '../common/organization-id.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { SchedulesService } from './schedules.service';

@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(@OrganizationId() organizationId: string) {
    return this.schedules.list(organizationId);
  }

  @Get(':id')
  get(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.schedules.get(organizationId, id);
  }

  @Post()
  @MinimumRole('OPERATOR')
  create(
    @OrganizationId() organizationId: string,
    @Body(new ZodValidationPipe(createScheduleSchema)) input: CreateScheduleInput,
  ) {
    return this.schedules.create(organizationId, input);
  }

  @Post(':id/enable')
  @MinimumRole('OPERATOR')
  enable(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.schedules.setEnabled(organizationId, id, true);
  }

  @Post(':id/disable')
  @MinimumRole('OPERATOR')
  disable(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.schedules.setEnabled(organizationId, id, false);
  }

  @Post(':id/trigger')
  @MinimumRole('OPERATOR')
  trigger(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.schedules.trigger(organizationId, id);
  }

  @Delete(':id')
  @MinimumRole('ADMIN')
  remove(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.schedules.remove(organizationId, id);
  }
}
