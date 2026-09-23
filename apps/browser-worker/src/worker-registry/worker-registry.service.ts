import { hostname } from 'node:os';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerNode } from '@socio/database';
import type { WorkerEnvironment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class WorkerRegistryService implements OnModuleDestroy {
  private node?: WorkerNode;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<WorkerEnvironment, true>,
  ) {}

  get workerId(): string {
    if (!this.node) throw new Error('Worker registry has not been initialized');
    return this.node.id;
  }

  async start(): Promise<void> {
    const name = this.config.get('workerName', { infer: true });
    const capacity = this.config.get('browserSlots', { infer: true });

    this.node = await this.prisma.workerNode.upsert({
      where: { name },
      create: {
        name,
        hostname: hostname(),
        capacity,
        version: this.config.get('workerVersion', { infer: true }),
        status: 'READY',
        lastHeartbeat: new Date(),
      },
      update: {
        hostname: hostname(),
        capacity,
        version: this.config.get('workerVersion', { infer: true }),
        status: 'READY',
        lastHeartbeat: new Date(),
      },
    });

    await this.prisma.$transaction(
      Array.from({ length: capacity }, (_, slotIndex) =>
        this.prisma.workerSlot.upsert({
          where: {
            workerId_slotIndex: { workerId: this.workerId, slotIndex },
          },
          create: { workerId: this.workerId, slotIndex },
          update: { status: 'AVAILABLE' },
        }),
      ),
    );

    this.heartbeat = setInterval(() => {
      void this.prisma.workerNode.update({
        where: { id: this.workerId },
        data: { lastHeartbeat: new Date(), status: 'READY' },
      });
    }, 15_000);
    this.heartbeat.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.node) {
      await this.prisma.workerNode.update({
        where: { id: this.node.id },
        data: { status: 'OFFLINE', lastHeartbeat: new Date() },
      });
    }
  }
}
