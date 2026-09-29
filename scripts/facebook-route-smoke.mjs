import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const web = process.env.WEB_URL ?? 'http://localhost:3000';
const campaignId = randomUUID();
for (const resource of ['groups', 'campaigns', 'group-collections', 'opt-in-recipients']) {
  const response = await fetch(`${web}/api/facebook/${resource}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 401, `${resource}: expected API authentication, not an HTML 404`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(typeof (await response.json()).message, 'string');
}
for (const request of [
  { path: 'group-collections', method: 'POST', body: { name: 'Fixture', groupUrls: ['https://www.facebook.com/groups/fixture/'] } },
  { path: `group-collections/${campaignId}`, method: 'PATCH', body: { name: 'Fixture', groupUrls: ['https://www.facebook.com/groups/fixture/'] } },
  { path: `group-collections/${campaignId}`, method: 'DELETE' },
]) {
  const response = await fetch(`${web}/api/facebook/${request.path}`, {
    method: request.method, headers: { origin: web, 'content-type': 'application/json' },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 401, `${request.method} ${request.path}: ${await response.text()}`);
}
const recipientId = randomUUID();
for (const request of [
  { path: 'opt-in-recipients', method: 'POST', body: {} },
  { path: `opt-in-recipients/${recipientId}`, method: 'PATCH', body: {} },
  { path: `opt-in-recipients/${recipientId}`, method: 'DELETE' },
  { path: `opt-in-recipients/${recipientId}/reactivate`, method: 'POST', body: {} },
  { path: 'groups/message', method: 'POST', body: {} },
  { path: 'posts/reply-comments', method: 'POST', body: {} },
]) {
  const response = await fetch(`${web}/api/facebook/${request.path}`, {
    method: request.method, headers: { origin: web, 'content-type': 'application/json' }, body: JSON.stringify(request.body ?? {}), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 401, `${request.method} ${request.path}: ${await response.text()}`);
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
console.log('PASS: actual Next proxy forwards group collections, opt-in recipients, message drafts and campaign controls to API authentication; unknown actions remain blocked. No authenticated mutations or Facebook actions.');
