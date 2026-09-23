import { Controller, Get } from '@nestjs/common';
import { MinimumRole } from '../auth/roles.decorator';
import { OrganizationId } from '../common/organization-id.decorator';
import { PrismaService } from '../database/prisma.service';
import { ServiceOnly } from '../common/service-only.decorator';

@Controller()
export class OperationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('workers')
  @MinimumRole('ADMIN')
  @ServiceOnly()
  workers() {
    return this.prisma.workerNode.findMany({
      include: { slots: { orderBy: { slotIndex: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  @Get('audit')
  @MinimumRole('ADMIN')
  audit(@OrganizationId() organizationId: string) {
    return this.prisma.auditLog.findMany({
      where: { organizationId },
      include: { actor: { select: { email: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }
}
