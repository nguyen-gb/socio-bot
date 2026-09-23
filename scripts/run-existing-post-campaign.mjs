// Explicit invocation only: retries selected, approved, safely-unsent tasks via the normal UI API.
import { readFile } from 'node:fs/promises';
const [campaignId, ...taskIds] = process.argv.slice(2);
if (!campaignId || !taskIds.length) throw new Error('Usage: node scripts/run-existing-post-campaign.mjs <campaign-id> <task-id>...');
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const password = env.match(/^BOOTSTRAP_ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
const base = 'http://localhost:3000';
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'owner@socio.local', password }) });
if (!login.ok) throw new Error(`Login failed: ${login.status}`);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
if (!cookie) throw new Error('No session cookie');
const response = await fetch(`${base}/api/facebook/campaigns/${encodeURIComponent(campaignId)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify({ taskIds, verifiedUnsentTaskIds: [] }) });
console.log(JSON.stringify({ status: response.status, result: await response.json() }));
if (!response.ok) process.exitCode = 1;
