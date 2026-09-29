import { createHash } from 'node:crypto';
import { FACEBOOK_IMAGE_MAX_BYTES, FACEBOOK_IMAGE_TYPES, facebookMediaIdsSchema, imageContentType } from '@socio/contracts';
import type { ObjectStorage } from '@socio/object-storage';
import type { PlatformMediaFile } from '@socio/platform-core';
import type { PrismaService } from '../database/prisma.service';

export async function loadTaskImages(prisma: PrismaService, objects: ObjectStorage, organizationId: string, ids: string[]): Promise<PlatformMediaFile[]> {
  const selected = facebookMediaIdsSchema.parse(ids);
  if (!selected.length) return [];
  const assets = await prisma.mediaAsset.findMany({ where: {
    id: { in: selected }, organizationId, status: 'READY',
    contentType: { in: [...FACEBOOK_IMAGE_TYPES] }, sizeBytes: { gt: 0, lte: FACEBOOK_IMAGE_MAX_BYTES },
  } });
  if (assets.length !== selected.length) throw new Error('Ảnh không còn khả dụng hoặc không thuộc workspace; chưa gửi bài.');
  const files: PlatformMediaFile[] = [];
  for (const id of selected) {
    const asset = assets.find(asset => asset.id === id)!;
    const buffer = Buffer.from(await objects.getBytes(asset.storageUri));
    if (buffer.length !== Number(asset.sizeBytes) || buffer.length > FACEBOOK_IMAGE_MAX_BYTES
      || imageContentType(buffer) !== asset.contentType
      || createHash('sha256').update(buffer).digest('hex') !== asset.checksum) {
      throw new Error('Dữ liệu ảnh đã thay đổi hoặc không hợp lệ; chưa gửi bài.');
    }
    // Derive a safe filename from the verified type, not a client-supplied path.
    const extension = asset.contentType === 'image/jpeg' ? 'jpg' : asset.contentType.split('/')[1];
    files.push({ name: `${id}.${extension}`, mimeType: asset.contentType, buffer });
  }
  return files;
}
