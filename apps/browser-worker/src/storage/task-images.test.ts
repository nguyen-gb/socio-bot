import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadTaskImages } from './task-images';

const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ids = [1, 2].map(i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
const assets = ids.map(id => ({ id, storageUri: `s3://fixture/${id}`, fileName: '../../bad.png', contentType: 'image/png', sizeBytes: BigInt(bytes.length), checksum: createHash('sha256').update(bytes).digest('hex') }));
test('worker reads only READY workspace images and restores approved order', async () => {
  const prisma = { mediaAsset: { findMany: async (query: any) => {
    assert.equal(query.where.organizationId, 'workspace'); assert.equal(query.where.status, 'READY');
    assert.deepEqual(query.where.id.in, ids); return [...assets].reverse();
  } } };
  const calls: string[] = [];
  const objects = { getBytes: async (uri: string) => { calls.push(uri); return bytes; } };
  const files = await loadTaskImages(prisma as never, objects as never, 'workspace', ids);
  assert.deepEqual(files.map(file => file.name), ids.map(id => `${id}.png`));
  assert.deepEqual(calls, assets.map(asset => asset.storageUri));
  assert.ok(files.every(file => file.buffer.equals(bytes)));
});
test('missing, foreign or deleted images fail before reading storage', async () => {
  const objects = { getBytes: async () => { throw new Error('Must not read'); } };
  await assert.rejects(loadTaskImages({ mediaAsset: { findMany: async () => [assets[0]] } } as never, objects as never, 'workspace', ids), /không còn khả dụng/);
});
test('changed checksum, MIME or byte size prevents uploading media', async () => {
  for (const override of [{ checksum: 'changed' }, { contentType: 'image/jpeg' }, { sizeBytes: 999n }]) {
    await assert.rejects(loadTaskImages({ mediaAsset: { findMany: async () => [{ ...assets[0], ...override }] } } as never,
      { getBytes: async () => bytes } as never, 'workspace', [ids[0]!]), /Dữ liệu ảnh/);
  }
});
