import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const web = process.env.WEB_URL ?? 'http://localhost:3000';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const password = process.env.UI_TEST_PASSWORD ?? env.match(/^BOOTSTRAP_ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
assert.ok(password, 'Missing BOOTSTRAP_ADMIN_PASSWORD/UI_TEST_PASSWORD');

const login = await fetch(`${web}/api/auth/login`, {
  method: 'POST', headers: { origin: web, 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.UI_TEST_EMAIL ?? 'owner@socio.local', password }),
  signal: AbortSignal.timeout(30_000),
});
assert.equal(login.status, 200, `Login failed (${login.status})`);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert.ok(cookie, 'Login returned no session cookie');

async function json(path, init = {}) {
  const response = await fetch(`${web}${path}`, {
    ...init,
    headers: { cookie, ...(init.body ? { 'content-type': 'application/json', origin: web } : {}), ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

try {
  const accounts = await json('/api/control/accounts');
  const tasks = await json('/api/control/tasks?take=100');
  if (process.argv.includes('--search-urls')) {
    const search = tasks.find(task => task.action === 'SEARCH_TIKTOK_VIDEOS' && task.status === 'SUCCEEDED' && task.payload?.name?.startsWith('SMOKE '));
    console.log(JSON.stringify((search?.runs?.[0]?.result?.videos ?? []).map(video => video.videoUrl)));
  } else if (process.argv.includes('--run') || process.argv.includes('--interactions') || process.argv.includes('--image-inbox')) {
    const account = accounts.find(item => item.platform === 'TIKTOK' && ['READY', 'RUNNING'].includes(item.status));
    assert.ok(account, 'No READY/RUNNING TikTok account');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const videoArgument = process.argv.find(argument => argument.startsWith('--video='))?.slice('--video='.length);
    const targetVideo = videoArgument ?? process.env.TIKTOK_SMOKE_VIDEO ?? 'https://www.tiktok.com/@tam9771230/video/7701007410097409288';
    const followerArgument = process.argv.find(argument => argument.startsWith('--followers='))?.slice('--followers='.length);
    const followerChannel = followerArgument ?? process.env.TIKTOK_SMOKE_FOLLOWERS ?? '@trang_an_chi951519';
    const text = process.env.TIKTOK_SMOKE_TEXT ?? `test flow ${new Date().toLocaleDateString('vi-VN')}`;
    const media = await json('/api/media').catch(() => []);
    let image = Array.isArray(media) ? media.find(item => String(item.mimeType ?? '').startsWith('image/')) : undefined;
    if (process.argv.includes('--image-inbox') && !image) {
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'image/png' }), 'tiktok-smoke.png');
      const uploaded = await fetch(`${web}/api/media`, { method: 'POST', headers: { cookie, origin: web }, body: form, signal: AbortSignal.timeout(30_000) });
      assert.equal(uploaded.status, 201, `Smoke image upload failed (${uploaded.status})`);
      image = await uploaded.json();
    }
    let plans = [
      { action: 'SEARCH_TIKTOK_VIDEOS', payload: { name: `SMOKE ${timestamp} Search`, query: 'mèo', maxVideos: 3 } },
      { action: 'AUTO_COMMENT_TIKTOK_HOME', payload: { name: `SMOKE ${timestamp} Auto comment`, text, maxVideos: 1, minLikes: 0, intervalSeconds: 10 } },
      { action: 'COMMENT_TIKTOK_VIDEOS', payload: { name: `SMOKE ${timestamp} Comment`, videoUrls: [targetVideo], text, maxVideos: 1, intervalSeconds: 10 } },
      { action: 'REPLY_TIKTOK_COMMENTS', payload: { name: `SMOKE ${timestamp} Reply`, videoUrls: [targetVideo], text: `${text} reply`, maxReplies: 1, intervalSeconds: 10 } },
      { action: 'LIKE_TIKTOK_COMMENTS', payload: { name: `SMOKE ${timestamp} Like`, videoUrls: [targetVideo], maxLikes: 1, intervalSeconds: 10 } },
      { action: 'MESSAGE_TIKTOK_FOLLOWERS', payload: { name: `SMOKE ${timestamp} Inbox`, username: followerChannel, text, mediaAssetIds: image ? [image.id] : [], maxFollowers: 1, intervalSeconds: 10 } },
    ];
    if (process.argv.includes('--interactions')) plans = plans.filter(plan => ['REPLY_TIKTOK_COMMENTS', 'LIKE_TIKTOK_COMMENTS'].includes(plan.action));
    if (process.argv.includes('--image-inbox')) plans = [{ action: 'MESSAGE_TIKTOK_FOLLOWERS', payload: { name: `SMOKE ${timestamp} Inbox image fallback`, username: followerChannel, text, mediaAssetIds: [image.id], maxFollowers: 1, intervalSeconds: 10 } }];
    const terminal = new Set(['SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'CANCELLED']);
    const results = [];
    for (const plan of plans) {
      console.log(`START ${plan.action}`);
      const batch = await json('/api/tasks/batch', {
        method: 'POST',
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          tasks: [{ action: { platform: 'TIKTOK', accountId: account.id, action: plan.action, payload: plan.payload } }],
        }),
      });
      const taskId = batch.tasks?.[0]?.id;
      assert.ok(taskId, `${plan.action} returned no task id`);
      if (plan.action !== 'SEARCH_TIKTOK_VIDEOS') {
        await json('/api/tasks/batch/approve', { method: 'POST', body: JSON.stringify({ taskIds: [taskId] }) });
      }
      const deadline = Date.now() + 12 * 60_000;
      let task;
      while (Date.now() < deadline) {
        const current = await json('/api/control/tasks?take=100');
        task = current.find(item => item.id === taskId);
        if (task && terminal.has(task.status)) break;
        await new Promise(resolve => setTimeout(resolve, 5_000));
      }
      assert.ok(task, `${plan.action} disappeared from task list`);
      const result = task.runs?.[0]?.result;
      const entries = result?.report?.entries ?? [];
      const summary = {
        id: task.id,
        action: task.action,
        name: task.payload?.name,
        status: task.status,
        approvalStatus: task.approvalStatus,
        lastError: task.lastError,
        sent: result?.sent ?? result?.totalSent,
        liked: result?.liked,
        count: result?.count,
        imageAttached: plan.action === 'MESSAGE_TIKTOK_FOLLOWERS' ? Boolean(image) : undefined,
        report: entries.slice(-5),
      };
      results.push(summary);
      console.log(`END ${plan.action} ${task.status}`);
      console.log(JSON.stringify(summary));
      if (!terminal.has(task.status)) break;
    }
    console.log(`FINAL ${JSON.stringify(results)}`);
    process.exitCode = results.every(result => result.status === 'SUCCEEDED') ? 0 : 2;
  } else {
    console.log(JSON.stringify({
      accounts: accounts.filter(account => account.platform === 'TIKTOK').map(account => ({ id: account.id, username: account.username, status: account.status, profileId: account.profileId })),
      recentTikTokTasks: tasks.filter(task => task.platform === 'TIKTOK').slice(0, 10).map(task => ({ id: task.id, action: task.action, status: task.status, approvalStatus: task.approvalStatus, name: task.payload?.name, lastError: task.lastError, result: task.runs?.[0]?.result })),
    }, null, 2));
  }
} finally {
  await fetch(`${web}/api/auth/logout`, { method: 'POST', headers: { origin: web, cookie } }).catch(() => undefined);
}
