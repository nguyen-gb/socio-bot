import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { OrganizationId } from '../common/organization-id.decorator';
import { MinimumRole } from '../auth/roles.decorator';
import { CreateProxyDto } from './dto/create-proxy.dto';
import { ProxiesService } from './proxies.service';
import { AssignProxyDto } from './dto/assign-proxy.dto';
import { UpdateProxyDto } from './dto/update-proxy.dto';

@Controller('proxies')
export class ProxiesController {
  constructor(private readonly proxies: ProxiesService) {}

  @Get()
  list(@OrganizationId() organizationId: string) {
    return this.proxies.list(organizationId);
  }

  @Post()
  @MinimumRole('ADMIN')
  create(
    @OrganizationId() organizationId: string,
    @Body() input: CreateProxyDto,
  ) {
    return this.proxies.create(organizationId, input);
  }

  @Patch(':id')
  @MinimumRole('ADMIN')
  update(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Body() input: UpdateProxyDto,
  ) {
    return this.proxies.update(organizationId, id, input);
  }

  @Delete(':id')
  @MinimumRole('ADMIN')
  remove(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.proxies.remove(organizationId, id);
  }

  @Post(':id/test')
  @MinimumRole('OPERATOR')
  test(@OrganizationId() organizationId: string, @Param('id') id: string) {
    return this.proxies.test(organizationId, id);
  }

  @Get(':id/credentials')
  @MinimumRole('ADMIN')
  credentials(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
  ) {
    return this.proxies.credentials(organizationId, id);
  }

  @Post(':id/assign')
  @MinimumRole('ADMIN')
  assign(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Body() input: AssignProxyDto,
  ) {
    return this.proxies.assign(organizationId, id, input.accountId);
  }

  @Post(':id/release')
  @MinimumRole('ADMIN')
  release(
    @OrganizationId() organizationId: string,
    @Param('id') id: string,
    @Body() input: AssignProxyDto,
  ) {
    return this.proxies.release(organizationId, id, input.accountId);
  }
}
