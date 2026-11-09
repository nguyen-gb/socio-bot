import { Controller, Get, Query } from '@nestjs/common';
import { MinimumRole } from '../auth/roles.decorator';
import { OrganizationId } from '../common/organization-id.decorator';
import { PrismaService } from '../database/prisma.service';

@Controller('audit')
@MinimumRole('ADMIN')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@OrganizationId() organizationId: string, @Query('take') rawTake?: string) {
    const parsed = Number(rawTake ?? 200);
    const take = Number.isFinite(parsed) ? Math.min(500, Math.max(1, Math.trunc(parsed))) : 200;
    return this.prisma.auditLog.findMany({
      where: { organizationId },
      include: { actor: { select: { id: true, email: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
