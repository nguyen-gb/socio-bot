import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaService } from './media.service';

const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
test('image uploads verify file signature and size before storing data', async () => {
  let writes = 0;
  const service = new MediaService({ mediaAsset: { create: async ({ data }: any) => data } } as never,
    { putBytes: async () => { writes++; return { uri: 's3://fixture/image', sizeBytes: bytes.length }; } } as never);
  const file = { originalname: 'image.png', mimetype: 'image/png', size: bytes.length, buffer: bytes };
  for (const invalid of [{ ...file, buffer: Buffer.from('<html>bad</html>') }, { ...file, mimetype: 'image/jpeg' }, { ...file, buffer: Buffer.concat([bytes, Buffer.alloc(10 * 1024 * 1024)]) }]) {
    await assert.rejects(service.create('org', invalid), /Ảnh phải/);
  }
  assert.equal(writes, 0);
  const result = await service.create('org', file);
  assert.equal(result.organizationId, 'org'); assert.equal(result.status, 'READY'); assert.equal(writes, 1);
});
test('image content is workspace scoped and missing images never read storage', async () => {
  let reads = 0;
  const prisma = { mediaAsset: { findFirst: async (query: any): Promise<any> => { assert.equal(query.where.organizationId, 'org'); return null; } } };
  const service = new MediaService(prisma as never, { getBytes: async () => { reads++; return bytes; } } as never);
  await assert.rejects(service.image('org', 'id'), /Image not found/);
  assert.equal(reads, 0);
  prisma.mediaAsset.findFirst = async () => ({ storageUri: 's3://fixture/image', contentType: 'image/png' });
  assert.deepEqual((await service.image('org', 'id')).bytes, bytes);
});
