// Isolated HTTP test using the real media controller/storage and Next proxy.
// No production database, credentials, browser profile or Facebook connection.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { LocalObjectStorage } = require('@socio/object-storage');
const { MediaController } = require('./dist/media/media.controller.js');
const { MediaService } = require('./dist/media/media.service.js');
const root = await mkdtemp(join(tmpdir(), 'socio-photo-http-'));
const assets = [];
const prisma = { mediaAsset: {
  create: async ({ data }) => { assets.push(data); return data; },
  findFirst: async ({ where }) => assets.find(asset => asset.id === where.id && asset.organizationId === where.organizationId) ?? null,
} };
class TestModule {}
Module({ controllers: [MediaController], providers: [{ provide: MediaService, useValue: new MediaService(prisma, new LocalObjectStorage(root)) }] })(TestModule);
let app, web;
try {
  app = await NestFactory.create(TestModule, { logger: false });
  app.setGlobalPrefix('api');
  app.use((request, response, next) => {
    const token = request.headers.authorization;
    if (!['Bearer fixture', 'Bearer other-workspace'].includes(token)) return response.status(401).json({ message: 'Unauthorized' });
    request.principal = { kind: 'user', organizationId: token === 'Bearer fixture' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002' };
    next();
  });
  await app.listen(0, '127.0.0.1');
  const backend = await app.getUrl();
  const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const port = Number(process.env.MEDIA_HTTP_TEST_PORT ?? 3106), base = `http://localhost:${port}`;
  web = spawn(process.execPath, [webRequire.resolve('next/dist/bin/next'), 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: fileURLToPath(new URL('../apps/web/', import.meta.url)), windowsHide: true,
    env: { ...process.env, API_INTERNAL_URL: backend }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  web.stdout.on('data', chunk => { output += chunk; }); web.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 100; i++) {
    if (web.exitCode !== null) throw new Error(`Test web exited: ${output}`);
    if (output.includes('Ready')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const headers = { cookie: 'socio_access=fixture', origin: base };
  for (const size of [png.length, 10 * 1024 * 1024]) {
    const bytes = Buffer.alloc(size); png.copy(bytes);
    const body = new FormData(); body.append('file', new Blob([bytes], { type: 'image/png' }), 'fixture.png');
    const uploaded = await fetch(`${base}/api/media`, { method: 'POST', headers, body });
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const asset = await uploaded.json();
    assert.equal(asset.sizeBytes, String(size));
    const content = await fetch(`${base}/api/media/${asset.id}/content`, { headers });
    assert.equal(content.status, 200); assert.equal(content.headers.get('content-type'), 'image/png');
    assert.match(content.headers.get('cache-control'), /private.*no-store/);
    assert.ok(Buffer.from(await content.arrayBuffer()).equals(bytes), 'Proxy must preserve binary bytes');
    assert.equal((await fetch(`${base}/api/media/${asset.id}/content`)).status, 401);
    assert.equal((await fetch(`${base}/api/media/${asset.id}/content`, { headers: { cookie: 'socio_access=other-workspace' } })).status, 404);
  }
  const fake = new FormData(); fake.append('file', new Blob(['<html>fake image</html>'], { type: 'image/png' }), 'fake.png');
  assert.equal((await fetch(`${base}/api/media`, { method: 'POST', headers, body: fake })).status, 400);
  console.log(JSON.stringify({ multipartUpload: true, maximum10MBImage: true, binaryPreview: true, tenantIsolation: true, anonymousRejected: true, fakeImageRejected: true }));
} finally {
  if (web && web.exitCode === null) { const exited = new Promise(resolve => web.once('exit', resolve)); web.kill(); await exited; }
  if (app) await app.close();
  await rm(root, { recursive: true, force: true }); // mkdtemp-created fixture storage only.
}
