import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const web = process.env.WEB_URL ?? 'http://localhost:3000';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const password = process.env.UI_TEST_PASSWORD ?? env.match(/^BOOTSTRAP_ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
assert.ok(password, 'Missing test login password');
const login = await fetch(`${web}/api/auth/login`, {
  method: 'POST', headers: { origin: web, 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.UI_TEST_EMAIL ?? 'owner@socio.local', password }),
  signal: AbortSignal.timeout(30_000),
});
assert.equal(login.status, 200, 'Test login failed');
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
try {
  for (const resource of ['campaigns', 'groups']) {
    const response = await fetch(`${web}/api/facebook/${resource}`, {
      headers: { cookie }, signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `${resource} must reach the authenticated backend`);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.ok(Array.isArray(await response.json()), `${resource} must return a JSON array`);
    console.log(`PASS: authenticated GET /api/facebook/${resource} → 200 JSON array`);
  }
} finally {
  await fetch(`${web}/api/auth/logout`, { method: 'POST', headers: { origin: web, cookie } });
}
console.log('Existing campaigns/groups read only; no campaigns or Facebook actions started.');
