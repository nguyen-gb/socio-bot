import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const web = process.env.WEB_URL ?? 'http://localhost:3000';
const env = await readFile(new URL('../.env', import.meta.url), 'utf8');
const password = process.env.UI_TEST_PASSWORD ?? env.match(/^BOOTSTRAP_ADMIN_PASSWORD=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
assert.ok(password, 'Missing BOOTSTRAP_ADMIN_PASSWORD/UI_TEST_PASSWORD');
const login = await fetch(`${web}/api/auth/login`, { method: 'POST', headers: { origin: web, 'content-type': 'application/json' }, body: JSON.stringify({ email: process.env.UI_TEST_EMAIL ?? 'owner@socio.local', password }), signal: AbortSignal.timeout(30_000) });
assert.equal(login.status, 200, `Login failed (${login.status})`);
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

async function json(path, init = {}) {
  const response = await fetch(`${web}${path}`, { ...init, headers: { cookie, ...((init.method ?? 'GET') !== 'GET' ? { origin: web } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers }, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

try {
  const [accounts, groups, tasks] = await Promise.all([
    json('/api/control/accounts'),
    json('/api/facebook/groups').catch(() => []),
    json('/api/control/tasks?take=100'),
  ]);
  const facebookAccounts = accounts.filter(account => account.platform === 'FACEBOOK');
  const taskArgument = process.argv.find(argument => argument.startsWith('--task='))?.slice('--task='.length);
  if (taskArgument && !process.argv.includes('--run')) {
    const task = tasks.find(item => item.id === taskArgument);
    console.log(JSON.stringify(task ? {
      id: task.id,
      action: task.action,
      status: task.status,
      payload: task.payload,
      lastError: task.lastError,
      result: task.runs?.[0]?.result,
    } : null, null, 2));
    process.exitCode = task ? 0 : 2;
  }
  const postUrls = new Set();
  for (const task of tasks.filter(task => task.platform === 'FACEBOOK')) {
    if (typeof task.payload?.postUrl === 'string') postUrls.add(task.payload.postUrl);
    for (const run of task.runs ?? []) {
      if (typeof run.result?.postUrl === 'string') postUrls.add(run.result.postUrl);
      for (const row of run.result?.posts ?? []) if (typeof row?.postUrl === 'string') postUrls.add(row.postUrl);
      for (const row of run.result?.report?.entries ?? []) if (typeof row?.postUrl === 'string') postUrls.add(row.postUrl);
    }
  }
  if (process.argv.includes('--run')) {
    const account = facebookAccounts.find(item => ['READY', 'RUNNING'].includes(item.status));
    assert.ok(account, 'No READY/RUNNING Facebook account');
    const groupArgument = process.argv.find(argument => argument.startsWith('--group='))?.slice('--group='.length);
    const group = groups.find(item => item.accountId === account.id && item.groupUrl === groupArgument)
      ?? groups.find(item => item.accountId === account.id && /^Test(?:\s|$)/i.test(item.groupName ?? ''))
      ?? groups.find(item => item.accountId === account.id && item.status === 'JOINED');
    assert.ok(group, 'No synchronized Facebook group');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const textArgument = process.argv.find(argument => argument.startsWith('--text='))?.slice('--text='.length);
    const text = textArgument ?? `Kiểm thử campaign ${timestamp}`;
    const terminal = new Set(['SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'CANCELLED']);
    const results = [];

    async function runTask(action, payload) {
      console.log(`START ${action}`);
      const created = await json('/api/tasks', { method: 'POST', body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), action: { platform: 'FACEBOOK', accountId: account.id, action, payload } }) });
      const taskId = created.id;
      assert.ok(taskId, `${action} returned no task id`);
      if (action !== 'SYNC_FACEBOOK_GROUPS') await json(`/api/tasks/${taskId}/approve`, { method: 'POST' });
      const deadline = Date.now() + 15 * 60_000;
      let task;
      while (Date.now() < deadline) {
        const current = await json('/api/control/tasks?take=100');
        task = current.find(item => item.id === taskId);
        if (task && terminal.has(task.status)) break;
        await new Promise(resolve => setTimeout(resolve, 5_000));
      }
      assert.ok(task, `${action} disappeared from task list`);
      const result = task.runs?.[0]?.result ?? {};
      const summary = { id: task.id, action, status: task.status, lastError: task.lastError, result, report: result.report?.entries?.slice(-8) ?? [] };
      results.push(summary);
      console.log(`END ${action} ${task.status}`);
      console.log(JSON.stringify(summary));
      return summary;
    }

    const only = process.argv.find(argument => argument.startsWith('--only='))?.slice('--only='.length);
    const postArgument = process.argv.find(argument => argument.startsWith('--post='))?.slice('--post='.length);
    const profileArgument = process.argv.find(argument => argument.startsWith('--profile='))?.slice('--profile='.length);
    let selectedPostUrl = postArgument;
    if (only === 'sync') {
      await runTask('SYNC_FACEBOOK_GROUPS', {});
    } else if (only === 'join') {
      await runTask('JOIN_FACEBOOK_GROUP', { groupUrl: group.groupUrl });
    } else if (only === 'post') {
      await runTask('POST_FACEBOOK_GROUP', { groupUrl: group.groupUrl, text, mediaAssetIds: [] });
    } else if (only === 'reply') {
      assert.ok(selectedPostUrl, '--post is required for --only=reply');
      await runTask('REPLY_FACEBOOK_POST_COMMENTS', { postUrl: selectedPostUrl, text: `${text} reply`, mediaAssetIds: [], maxReplies: 1 });
    } else if (only === 'scan') {
      assert.ok(selectedPostUrl, '--post is required for --only=scan');
      await runTask('SCAN_FACEBOOK_POST_COMMENTS', { postUrl: selectedPostUrl });
    } else if (only === 'direct-inbox') {
      assert.ok(profileArgument, '--profile is required for --only=direct-inbox');
      await runTask('MESSAGE_FACEBOOK_RECIPIENT', { groupUrl: group.groupUrl, profileUrl: profileArgument, text: `${text} inbox direct`, mediaAssetIds: [], excludeProfileUrls: [] });
    } else if (only === 'inbox') {
      await runTask('MESSAGE_FACEBOOK_RECIPIENT', { groupUrl: group.groupUrl, text: `${text} inbox member`, mediaAssetIds: [], excludeProfileUrls: [] });
    } else if (only === 'comment') {
      const comment = await runTask('COMMENT_FACEBOOK_GROUP_POSTS', { groupUrl: group.groupUrl, text: `${text} comment`, mediaAssetIds: [], daysRecent: 30, minReactions: 0, minComments: 0, maxPosts: 1 });
      selectedPostUrl = comment.result?.posts?.find(row => typeof row?.postUrl === 'string')?.postUrl;
    } else if (only === 'post-flows') {
      assert.ok(selectedPostUrl, '--post is required for --only=post-flows');
      await runTask('SCAN_FACEBOOK_POST_COMMENTS', { postUrl: selectedPostUrl });
      await runTask('REPLY_FACEBOOK_POST_COMMENTS', { postUrl: selectedPostUrl, text: `${text} reply`, mediaAssetIds: [], maxReplies: 1 });
      await runTask('MESSAGE_FACEBOOK_REACTOR', { postUrl: selectedPostUrl, recipientSource: 'REACTORS_AND_COMMENTERS', text: `${text} inbox reactor`, mediaAssetIds: [], excludeProfileUrls: [] });
    } else {
      if (!process.argv.includes('--skip-sync')) await runTask('SYNC_FACEBOOK_GROUPS', {});
      await runTask('JOIN_FACEBOOK_GROUP', { groupUrl: group.groupUrl });
      const post = await runTask('POST_FACEBOOK_GROUP', { groupUrl: group.groupUrl, text, mediaAssetIds: [] });
      const comment = await runTask('COMMENT_FACEBOOK_GROUP_POSTS', { groupUrl: group.groupUrl, text: `${text} comment`, mediaAssetIds: [], daysRecent: 30, minReactions: 0, minComments: 0, maxPosts: 1 });
      selectedPostUrl = post.result?.postUrl ?? comment.result?.posts?.find(row => typeof row?.postUrl === 'string')?.postUrl;
      if (selectedPostUrl) {
        await runTask('SCAN_FACEBOOK_POST_COMMENTS', { postUrl: selectedPostUrl });
        await runTask('REPLY_FACEBOOK_POST_COMMENTS', { postUrl: selectedPostUrl, text: `${text} reply`, mediaAssetIds: [], maxReplies: 1 });
        await runTask('MESSAGE_FACEBOOK_REACTOR', { postUrl: selectedPostUrl, recipientSource: 'REACTORS_AND_COMMENTERS', text: `${text} inbox reactor`, mediaAssetIds: [], excludeProfileUrls: [] });
      }
      await runTask('MESSAGE_FACEBOOK_RECIPIENT', { groupUrl: group.groupUrl, text: `${text} inbox member`, mediaAssetIds: [], excludeProfileUrls: [] });
    }
    console.log(`FINAL ${JSON.stringify({ account: account.id, group: group.groupUrl, selectedPostUrl, results })}`);
    process.exitCode = results.every(result => result.status === 'SUCCEEDED') ? 0 : 2;
  }
  if (!process.argv.includes('--run') && !taskArgument) console.log(JSON.stringify({
    accounts: facebookAccounts.map(account => ({ id: account.id, username: account.username, status: account.status, profileId: account.profileId })),
    groups: groups.slice(0, 20).map(group => ({ accountId: group.accountId, groupName: group.groupName, groupUrl: group.groupUrl, status: group.status })),
    postUrls: [...postUrls].slice(0, 20),
    recentTasks: tasks.filter(task => task.platform === 'FACEBOOK').slice(0, 20).map(task => ({ id: task.id, action: task.action, status: task.status, payload: task.payload, lastError: task.lastError, result: task.runs?.[0]?.result })),
  }, null, 2));
} finally {
  await fetch(`${web}/api/auth/logout`, { method: 'POST', headers: { origin: web, cookie } }).catch(() => undefined);
}
