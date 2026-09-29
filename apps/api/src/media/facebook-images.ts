import { BadRequestException } from '@nestjs/common';
import { FACEBOOK_IMAGE_MAX_BYTES, FACEBOOK_IMAGE_TYPES } from '@socio/contracts';
import type { PrismaService } from '../database/prisma.service';

export async function validateFacebookImages(prisma: PrismaService, organizationId: string, ids: string[] = []) {
  if (!ids.length) return;
  const count = await prisma.mediaAsset.count({ where: {
    id: { in: ids }, organizationId, status: 'READY',
    contentType: { in: [...FACEBOOK_IMAGE_TYPES] }, sizeBytes: { gt: 0, lte: FACEBOOK_IMAGE_MAX_BYTES },
  } });
  if (count !== ids.length) throw new BadRequestException('Ảnh phải thuộc workspace, sẵn sàng sử dụng, định dạng JPG/PNG/WebP và tối đa 10 MB/ảnh.');
}
