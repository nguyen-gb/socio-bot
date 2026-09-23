import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const web = process.env.WEB_URL ?? 'http://localhost:3000';
const campaignId = randomUUID();
for (const resource of ['groups', 'campaigns']) {
  const response = await fetch(`${web}/api/facebook/${resource}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 401, `${resource}: expected API authentication, not an HTML 404`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(typeof (await response.json()).message, 'string');
}
// Exercise the real Next proxy, not a browser-intercepted API mock.
// Without authentication every permitted action must stop at the API auth guard.
for (const action of ['approve', 'cancel', 'pause', 'resume', 'retry']) {
  const response = await fetch(`${web}/api/facebook/campaigns/${campaignId}/${action}`, {
    method: 'POST',
    headers: { origin: web, 'content-type': 'application/json' },
    body: JSON.stringify(action === 'retry' ? { taskIds: [randomUUID()] } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 401, `${action}: ${await response.text()}`);
}
for (const path of [`campaigns/${campaignId}/unknown`, 'campaigns/not-a-uuid/retry', `campaigns/${campaignId}/retry/extra`]) {
  const response = await fetch(`${web}/api/facebook/${path}`, {
    method: 'POST', headers: { origin: web, 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 404, path);
  assert.equal((await response.json()).message, 'Action not found');
}
console.log('PASS: actual Next proxy returns JSON for GET groups/campaigns and forwards approve/cancel/pause/resume/retry to API authentication; unknown actions remain blocked. No authenticated mutations or Facebook actions.');
