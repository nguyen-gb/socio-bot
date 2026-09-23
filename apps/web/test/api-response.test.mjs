import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const output = await mkdtemp(join(tmpdir(), 'socio-api-response-test-'));
after(() => rm(output, { recursive: true, force: true }));
execFileSync(process.execPath, [join(dirname(require.resolve('typescript')), 'tsc.js'),
  fileURLToPath(new URL('../lib/api-response.ts', import.meta.url)), '--outDir', output,
  '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck'], { stdio: 'pipe', cwd: output });
const { readApiJson } = require(join(output, 'api-response.js'));

test('returns JSON data and preserves API error payloads', async () => {
  assert.deepEqual(await readApiJson(Response.json([]), '/api/facebook/groups'), []);
  assert.deepEqual(await readApiJson(Response.json({ message: 'Forbidden' }, { status: 403 }), '/api/facebook/campaigns'), { message: 'Forbidden' });
});
test('HTML 404 reports endpoint and status without leaking the page', async () => {
  await assert.rejects(readApiJson(new Response('<!DOCTYPE html><html>private page</html>', {
    status: 404, headers: { 'content-type': 'text/html' },
  }), '/api/facebook/groups'), error => {
    assert.match(error.message, /API \/api\/facebook\/groups.*HTML thay vì JSON.*HTTP 404/);
    assert.doesNotMatch(error.message, /Unexpected token|private page/);
    return true;
  });
});
test('malformed or empty responses report a clear non-JSON error', async () => {
  for (const body of ['not json', '']) {
    await assert.rejects(readApiJson(new Response(body, { status: 502 }), '/api/facebook/campaigns'), /dữ liệu không phải JSON.*HTTP 502/);
  }
});
