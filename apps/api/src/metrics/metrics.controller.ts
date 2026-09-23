import { Controller, Get, Header } from '@nestjs/common';
import { MinimumRole } from '../auth/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { ServiceOnly } from '../common/service-only.decorator';

@Controller('metrics')
@ServiceOnly()
export class MetricsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics() {
    const [tasks, accounts, workers, sessions] = await Promise.all([
      this.prisma.task.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.platformAccount.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.workerNode.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.browserSession.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    const lines = [
      '# HELP socio_info Socio control plane build information',
      '# TYPE socio_info gauge',
      'socio_info{service="api"} 1',
      ...series('socio_tasks_total', tasks),
      ...series('socio_accounts_total', accounts),
      ...series('socio_workers_total', workers),
      ...series('socio_browser_sessions_total', sessions),
    ];
    return `${lines.join('\n')}\n`;
  }
}

function series(
  metric: string,
  rows: Array<{ status: string; _count: { _all: number } }>,
) {
  return [
    `# TYPE ${metric} gauge`,
    ...rows.map((row) => `${metric}{status="${row.status}"} ${row._count._all.toString()}`),
  ];
}
