import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ObjectStorage } from '@socio/object-storage';
import { PrismaService } from '../database/prisma.service';
import { OBJECT_STORAGE } from '../storage/object-storage.module';

export interface UploadedMedia {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(OBJECT_STORAGE) private readonly objects: ObjectStorage,
  ) {}

  async create(organizationId: string, file: UploadedMedia) {
    const id = randomUUID();
    const extension = safeExtension(file.originalname);
    const stored = await this.objects.putBytes(
      `media/${organizationId}/${id}${extension}`,
      file.buffer,
      file.mimetype,
    );
    const asset = await this.prisma.mediaAsset.create({
      data: {
        id,
        organizationId,
        fileName: file.originalname.slice(0, 255),
        contentType: file.mimetype,
        sizeBytes: BigInt(stored.sizeBytes),
        storageUri: stored.uri,
        checksum: createHash('sha256').update(file.buffer).digest('hex'),
        status: 'READY',
      },
    });
    return present(asset);
  }

  async list(organizationId: string) {
    const assets = await this.prisma.mediaAsset.findMany({
      where: { organizationId, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return assets.map(present);
  }

  async get(organizationId: string, id: string) {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: { id, organizationId, status: { not: 'DELETED' } },
    });
    if (!asset) throw new NotFoundException('Media asset not found');
    return present(asset);
  }
}

function safeExtension(name: string): string {
  const match = /\.[a-z0-9]{1,8}$/i.exec(name);
  return match?.[0]?.toLowerCase() ?? '';
}

function present<T extends { sizeBytes: bigint }>(asset: T) {
  return { ...asset, sizeBytes: asset.sizeBytes.toString() };
}
