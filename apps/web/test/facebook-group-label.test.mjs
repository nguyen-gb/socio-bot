import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const output = await mkdtemp(join(tmpdir(), 'socio-group-label-test-'));
after(() => rm(output, { recursive: true, force: true }));
execFileSync(process.execPath, [join(dirname(require.resolve('typescript')), 'tsc.js'),
  fileURLToPath(new URL('../lib/facebook-group-label.ts', import.meta.url)), '--outDir', output,
  '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck'], { stdio: 'pipe', cwd: output });
const { facebookGroupId, facebookGroupLabel } = require(join(output, 'facebook-group-label.js'));
const groupUrl = 'https://www.facebook.com/groups/123456789/?ref=fixture';

test('missing/empty names and generic View group labels display the group ID', () => {
  for (const groupName of [undefined, null, '', '  ', 'View group', ' VIEW GROUP ', 'View\n group', 'View group | Facebook', 'Xem nhóm']) {
    assert.equal(facebookGroupLabel({ groupName, groupUrl }), '123456789');
  }
});
test('real names are preserved rather than stripped because they contain View group', () => {
  for (const groupName of ['Cộng đồng Việt Nam', 'View group Photography', 'Nhóm học tập']) {
    assert.equal(facebookGroupLabel({ groupName: ` ${groupName} `, groupUrl }), groupName);
  }
});
test('fallback supports vanity IDs, trailing slash/query and malformed legacy links', () => {
  assert.equal(facebookGroupLabel({ groupUrl: 'https://m.facebook.com/groups/ten-nhom?ref=fixture' }), 'ten-nhom');
  assert.equal(facebookGroupId('bad-url'), 'bad-url');
});
