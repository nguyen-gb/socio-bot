import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { normalizeFacebookGroupUrl, joinFacebookGroupsSchema, postFacebookGroupsSchema } from '@socio/contracts';
import { FacebookGroupsAutomation } from './facebook-groups';

const url = 'https://www.facebook.com/groups/123456/';
const automation = new FacebookGroupsAutomation();
const quick = new FacebookGroupsAutomation({ mainTimeoutMs: 600, controlTimeoutMs: 600, joinConfirmationTimeoutMs: 800, postConfirmationTimeoutMs: 800 });
async function fixture(html: string, run: (page: Page) => Promise<void>, loggedIn = true) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (loggedIn) await context.addCookies([{ name: 'c_user', value: 'fixture-user', domain: '.facebook.com', path: '/' }]);
    await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<title>Fixture group</title><main role="main">${html}</main>` }));
    await run(await context.newPage());
  } finally { await browser.close(); }
}

test('group URLs are canonical, deduplicated and reject non-Facebook or post links', () => {
  assert.equal(normalizeFacebookGroupUrl('https://m.facebook.com/groups/abc/?ref=share'), 'https://www.facebook.com/groups/abc/');
  for (const bad of ['http://facebook.com/groups/a', 'https://facebook.com.evil.test/groups/a', 'https://facebook.com/groups/a/posts/1', 'https://user:pass@facebook.com/groups/a', 'https://facebook.com/groups/joins/']) assert.throws(() => normalizeFacebookGroupUrl(bad));
  assert.equal(joinFacebookGroupsSchema.parse({ name: 'Test', idempotencyKey: 'test-key-123', groupUrls: [url, url + '?ref=x'] }).groupUrls.length, 1);
  assert.equal(postFacebookGroupsSchema.safeParse({ name: 'Test', idempotencyKey: 'test-key-123', text: 'Post', selection: 'LIMIT', maxGroupsPerAccount: 2 }).success, false);
});

test('Chromium confirms joined membership after one click', async () => fixture('<button onclick="this.textContent=\'Joined\'">Join group</button>', async (page) => {
  const result = await automation.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.ok, true); assert.equal(result.data?.membershipStatus, 'JOINED');
}));

test('durable send marker is written before Join, and marker failure prevents clicking', async () => fixture('<button onclick="window.clicked=true">Join group</button>', async (page) => {
  await assert.rejects(() => automation.join({ page, profileId: 'fixture', beforeExternalAction: async () => { assert.equal(await page.evaluate('window.clicked'), undefined); throw new Error('Marker storage unavailable'); } }, url), /Marker storage unavailable/);
  assert.equal(await page.evaluate('window.clicked'), undefined);
}));

test('joining waits for the group main and membership controls to render', async () => fixture('<button hidden id="join" onclick="this.textContent=\'Joined\'">Join group</button><script>document.querySelector("main").hidden=true;setTimeout(()=>document.querySelector("main").hidden=false,200);setTimeout(()=>document.querySelector("#join").hidden=false,400);</script>', async (page) => {
  const result = await automation.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.ok, true);
  assert.equal(result.data?.membershipStatus, 'JOINED');
}));

test('login lost during group hydration prevents clicking Join group', async () => fixture('<button hidden id="join" onclick="window.clicked=true">Join group</button><script>document.querySelector("main").hidden=true;setTimeout(()=>{document.querySelector("main").hidden=false;document.querySelector("#join").hidden=false;document.cookie="c_user=; Max-Age=0; path=/; domain=.facebook.com"},200);</script>', async (page) => {
  await assert.rejects(() => automation.join({ page, profileId: 'fixture' }, url), /interactive login/);
  assert.equal(await page.evaluate('window.clicked'), undefined);
}));
test('Chromium distinguishes pending request from joined', async () => fixture('<button onclick="this.textContent=\'Cancel request\'">Tham gia nhóm</button>', async (page) => {
  const result = await automation.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.data?.membershipStatus, 'PENDING');
}));

test('slow membership acknowledgement waits without clicking Join twice', async () => fixture('<button onclick="window.clicks=(window.clicks||0)+1;setTimeout(()=>this.textContent=\'Cancel request\',2500)">Join group</button>', async page => {
  const result = await automation.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.data?.membershipStatus, 'PENDING');
  assert.equal(await page.evaluate('window.clicks'), 1);
}));
test('membership questions stop for manual input', async () => fixture('<button onclick="document.querySelector(\'[role=dialog]\').hidden=false">Join group</button><div role="dialog" hidden>Answer membership questions</div>', async (page) => {
  const result = await automation.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.ok, false); assert.equal(result.data?.membershipStatus, 'REQUIRES_ACTION');
}));
test('ambiguous join does not claim success or click twice', async () => fixture('<button onclick="window.clicks=(window.clicks||0)+1">Join group</button>', async (page) => {
  const result = await automation.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.ok, false); assert.equal(await page.evaluate('window.clicks'), 1);
}));
test('CAPTCHA prevents any group mutation', async () => fixture('<input name="captcha_response"><button onclick="window.clicked=true">Join group</button>', async (page) => {
  const result = await automation.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.data?.accountChallenged, true); assert.equal(await page.evaluate('window.clicked'), undefined);
}));
test('missing login cookie prevents joining', async () => fixture('<button>Join group</button>', async (page) => {
  await assert.rejects(() => automation.join({ page, profileId: 'fixture' }, url), /interactive login/);
}, false));
const composer = (after: string) => `<button>Joined</button><button onclick="document.querySelector('[role=dialog]').hidden=false">Write something</button><div role="dialog" hidden><div role="textbox" contenteditable="true"></div><button onclick="${after}">Post</button></div>`;
test('post never presses Enter in the editor when focus is redirected away from Post', async () => fixture(composer('window.submitted=true').replace('<button onclick="window.submitted', '<button onfocus="document.querySelector(\'[role=textbox]\').focus()" onclick="window.submitted'), async page => {
  let markers = 0;
  await page.addInitScript(() => document.addEventListener('keydown', event => { if (event.key === 'Enter') (window as unknown as { enters: number }).enters = 1; }));
  const result = await quick.post({ page, profileId: 'fixture', beforeExternalAction: async () => { markers++; } }, url, 'Test');
  assert.equal(result.ok, false); assert.equal(markers, 1);
  assert.equal(await page.evaluate('window.submitted'), undefined);
  assert.equal(await page.evaluate('window.enters'), undefined);
}));

const creationBody = new URLSearchParams({ fb_api_req_friendly_name: 'ComposerStoryCreateMutation', variables: JSON.stringify({ input: { audience: { to_id: '123456' }, actor_id: 'fixture-user', message: { text: 'Fixture post' } } }) }).toString();
const creationReply = { data: { story_create: { post_id: null, publishing_flow: 'FALLBACK', story: { url: `${url}permalink/789/`, to: { id: '123456' }, if_viewer_can_learn_more_about_pending_post: null }, group_feed_story_edge: { node: { post_id: '789', comet_sections: { content: { story: { message: { text: 'Fixture post' } } } } } } } } };
for (const scenario of ['mention-overlay', 'delayed-mention-overlay', 'late-overlay-native-button', 'late-overlay-facebook-role-button', 'unknown-overlay', 'persistent-suggestions', 'escape-changes-text', 'escape-closes-composer']) test(`post pointer interception: ${scenario}`, async () => {
  const publish = "window.clicks=(window.clicks||0)+1;document.querySelector('[role=dialog]').hidden=true;document.querySelector('#overlay').hidden=true;const p=document.createElement('p');p.textContent='Your post is pending';document.body.append(p)";
  const input = scenario.startsWith('late-overlay') ? '' : scenario === 'delayed-mention-overlay' ? "document.querySelector('#post').disabled=true;setTimeout(()=>{document.querySelector('#overlay').hidden=false;document.querySelector('#post').disabled=false},150)" : "document.querySelector('#overlay').hidden=false";
  const escape = scenario === 'unknown-overlay' || scenario === 'persistent-suggestions' ? 'window.escapes=(window.escapes||0)+1' : "document.querySelector('#overlay').hidden=true;" + (scenario === 'escape-changes-text' ? "document.querySelector('[role=textbox]').textContent='Changed'" : scenario === 'escape-closes-composer' ? "document.querySelector('[role=dialog]').hidden=true" : '');
  let html = composer(publish).replace('<div role="textbox"', `<div oninput="${input}" role="textbox"`).replace('<button onclick="window.clicks', '<button id="post" onclick="window.clicks')
    + `<div id="overlay" hidden role="listbox" aria-label="${scenario === 'unknown-overlay' ? 'Unrelated confirmation' : 'Mentions suggestions'}" style="position:fixed;inset:0;z-index:100;background:white"><div role="option" onclick="window.selected=true">Tested</div></div><script>document.addEventListener('keydown',event=>{if(event.key==='Escape'){${escape}}})</script>`;
  if (scenario === 'late-overlay-facebook-role-button') html = html.replace('<button id="post"', '<div role="button" aria-label="Post" tabindex="0" onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.click()}" id="post"').replace('>Post</button>', '>Post</div>');
  await fixture(html, async page => {
    let markers = 0;
    const result = await quick.post({ page, profileId: 'fixture', beforeExternalAction: async () => {
      assert.equal(await page.locator('#overlay').isVisible(), false);
      assert.equal(await page.getByRole('textbox').innerText(), 'Test');
      markers++;
      if (scenario.startsWith('late-overlay')) {
        // Reproduce the saved trace: trial passed, then a late typeahead response
        // covered Post during the marker write. A pointer click now times out.
        await page.locator('#overlay').evaluate(element => { (element as HTMLElement).hidden = false; });
      }
    } }, url, 'Test');
    const success = scenario.startsWith('late-overlay') || scenario === 'mention-overlay' || scenario === 'delayed-mention-overlay';
    assert.equal(result.ok, success);
    if (success) assert.equal(result.data?.publicationStatus, 'PENDING_APPROVAL');
    assert.equal(markers, success ? 1 : 0);
    assert.equal(await page.evaluate('window.clicks||0'), success ? 1 : 0);
    assert.equal(await page.evaluate('window.selected'), undefined);
    if (scenario === 'unknown-overlay') assert.equal(await page.evaluate('window.escapes'), undefined);
  });
});
for (const scenario of ['roleless-feed', 'not-in-feed', 'graphql-error', 'http-error', 'malformed', 'wrong-group', 'pending', 'pending-participation']) test(`post creation response: ${scenario}`, async () => {
  const after = `window.clicks=(window.clicks||0)+1;document.querySelector('[role=dialog]').hidden=true;fetch('/api/graphql/',{method:'POST',body:${JSON.stringify(creationBody)}});` + (scenario === 'roleless-feed' ? `const p=document.createElement('div');p.setAttribute('aria-posinset','1');p.innerHTML='<div data-ad-rendering-role="story_message">Fixture post</div>';document.querySelector('main').append(p);` : scenario === 'graphql-error' ? `const p=document.createElement('article');p.textContent='Fixture post';document.querySelector('main').append(p);` : '');
  await fixture(composer(after.replaceAll('"', '&quot;')), async page => {
    let requests = 0, markers = 0;
    await page.route('**/api/graphql/**', async route => {
      requests++;
      const reply = JSON.parse(JSON.stringify(creationReply));
      if (scenario === 'wrong-group') reply.data.story_create.story.to.id = '654321';
      if (scenario === 'pending') reply.data.story_create.story.if_viewer_can_learn_more_about_pending_post = { __typename: 'PendingPost' };
      if (scenario === 'pending-participation') reply.data.story_create.story.to.if_viewer_can_see_pending_content_card = {
        group_pending_action_card_renderer: { group: { if_viewer_can_see_pending_content_card: { pending_post_info: { pending_content_section_title: 'Pending admin approval' } } } },
        if_viewer_cannot_add_pending_participation_content_in_forum: { id: '123456' },
      };
      await route.fulfill({ status: scenario === 'http-error' ? 500 : 200, contentType: 'application/json', body: scenario === 'graphql-error' ? JSON.stringify({ errors: [{ message: 'Rejected' }] }) : scenario === 'malformed' ? '<!DOCTYPE html>' : JSON.stringify(reply) });
    });
    const listeners = page as unknown as { listenerCount(event: string): number };
    const beforeRequests = listeners.listenerCount('request'), beforeResponses = listeners.listenerCount('response');
    const result = await quick.post({ page, profileId: 'fixture', beforeExternalAction: async () => { markers++; } }, url, 'Fixture post');
    assert.equal(result.ok, ['roleless-feed', 'not-in-feed', 'pending', 'pending-participation'].includes(scenario));
    if (result.ok) {
      assert.equal(result.data?.publicationStatus, scenario.startsWith('pending') ? 'PENDING_APPROVAL' : 'PUBLISHED');
      assert.equal(result.externalReference, `${url}permalink/789/`);
      assert.equal(result.data?.confirmationSource, 'CREATION_RESPONSE');
    }
    assert.equal(markers, 1); assert.equal(requests, 1); assert.equal(await page.evaluate('window.clicks'), 1);
    assert.equal(listeners.listenerCount('request'), beforeRequests); assert.equal(listeners.listenerCount('response'), beforeResponses);
  });
});

test('durable send marker is written before Post, and marker failure prevents submission', async () => fixture(composer('window.submitted=true'), async (page) => {
  await assert.rejects(() => automation.post({ page, profileId: 'fixture', beforeExternalAction: async () => { assert.equal(await page.evaluate('window.submitted'), undefined); throw new Error('Marker storage unavailable'); } }, url, 'Fixture post'), /Marker storage unavailable/);
  assert.equal(await page.evaluate('window.submitted'), undefined);
}));
test('post confirmation requires a new visible article', async () => fixture(composer("const t=document.querySelector('[role=textbox]').textContent; document.querySelector('[role=dialog]').hidden=true; const a=document.createElement('article'); a.setAttribute('role','article'); a.textContent=t; document.body.append(a)"), async (page) => {
  const result = await automation.post({ page, profileId: 'fixture' }, url, 'Fixture post');
  assert.equal(result.ok, true); assert.equal(result.data?.publicationStatus, 'PUBLISHED');
}));
test('Facebook nested header dialog does not hide the real composer editor', async () => fixture(composer("document.querySelector('[role=dialog]').hidden=true;const p=document.createElement('p');p.textContent='Your post is pending';document.body.append(p)").replace('<div role="textbox"', '<div role="dialog" aria-label="Create post"><h2>Create post</h2></div><div role="textbox"'), async page => {
  const result = await automation.post({ page, profileId: 'fixture' }, url, 'Nested dialog fixture');
  assert.equal(result.data?.publicationStatus, 'PENDING_APPROVAL');
}));
test('posts awaiting moderation are not reported as published', async () => fixture(composer("document.querySelector('[role=dialog]').hidden=true; const p=document.createElement('p'); p.textContent='Your post is pending'; document.body.append(p)"), async (page) => {
  const result = await automation.post({ page, profileId: 'fixture' }, url, 'Fixture pending post');
  assert.equal(result.ok, true); assert.equal(result.data?.publicationStatus, 'PENDING_APPROVAL');
}));
test('post waits for editor hydration, enabled submit and delayed truncated feed confirmation', async () => fixture(`
  <button>Joined</button><button onclick="document.querySelector('[role=dialog]').hidden=false;setTimeout(()=>document.querySelector('#editor').hidden=false,1000)">Write something</button>
  <div role="dialog" hidden><div id="editor" hidden><div role="textbox" contenteditable="true" oninput="setTimeout(()=>document.querySelector('#post').disabled=false,500)"></div></div>
  <button id="post" disabled onclick="window.clicks=(window.clicks||0)+1;const text=document.querySelector('[role=textbox]').innerText;document.querySelector('[role=dialog]').hidden=true;setTimeout(()=>{const a=document.createElement('article');a.setAttribute('role','article');a.textContent=text.replace(/\\s+/g,' ').slice(0,200);const link=document.createElement('a');link.href='/groups/123456/posts/789/';link.textContent='View post';a.append(link);document.body.append(a)},2000)">Post</button></div>`, async page => {
  const text = 'Bài viết dài cần giữ nguyên nội dung.\n\n' + 'Nội dung kiểm thử tiếng Việt. '.repeat(80);
  let markers = 0;
  const result = await automation.post({ page, profileId: 'fixture', beforeExternalAction: async () => { markers++; } }, url, text);
  assert.equal(result.data?.publicationStatus, 'PUBLISHED');
  assert.equal(result.externalReference, 'https://www.facebook.com/groups/123456/posts/789/');
  assert.equal(await page.evaluate('window.clicks'), 1);
  assert.equal(markers, 1);
}));
test('an existing matching article does not confirm an unacknowledged submission', async () => fixture('<article role="article">Existing post</article>' + composer("window.clicks=(window.clicks||0)+1;document.querySelector('[role=dialog]').hidden=true"), async page => {
  const result = await automation.post({ page, profileId: 'fixture' }, url, 'Existing post');
  assert.equal(result.data?.publicationStatus, 'UNKNOWN');
  assert.equal(await page.evaluate('window.clicks'), 1);
}));
test('unconfirmed post is not resent', async () => fixture(composer("window.clicks=(window.clicks||0)+1; document.querySelector('[role=dialog]').hidden=true"), async (page) => {
  const result = await automation.post({ page, profileId: 'fixture' }, url, 'Fixture uncertain post');
  assert.equal(result.ok, false); assert.equal(result.data?.publicationStatus, 'UNKNOWN'); assert.equal(await page.evaluate('window.clicks'), 1);
}));
test('sync only reads valid group links in joined-groups main content', async () => fixture('<nav><a href="/groups/recommendation/">Recommendation</a></nav><main role="main"><a href="/groups/123456/?ref=x">Group A</a><a href="/groups/123456/">Group A</a><a href="/groups/123456/posts/9">Post</a><a href="https://evil.test/groups/987/">Invalid</a></main>', async (page) => {
  const result = await automation.sync({ page, profileId: 'fixture' });
  assert.equal(result.ok, true); assert.deepEqual(result.data?.groups, [{ groupUrl: url, groupName: 'Group A' }]);
}));

const joinCases: Array<{ name: string; html: string; status?: string; clicks?: number; ok?: boolean; challenged?: boolean }> = [
  { name: 'already joined', html: '<button onclick="window.clicks=1">Joined</button>', status: 'JOINED' },
  { name: 'member dropdown', html: '<button onclick="window.clicks=1">Member</button>', status: 'JOINED' },
  { name: 'leave action proves membership but is never clicked', html: '<button onclick="window.clicks=1">Rời nhóm</button>', status: 'JOINED' },
  { name: 'existing pending request is never cancelled', html: '<button onclick="window.clicks=1">Cancel request</button>', status: 'PENDING' },
  { name: 'disabled request-sent control', html: '<button disabled>Đã gửi yêu cầu</button>', status: 'PENDING' },
  { name: 'pending notice overrides a still-visible Join button', html: '<p>Your request to join this group is pending</p><button onclick="window.clicks=1">Join group</button>', status: 'PENDING' },
  { name: 'limited membership is not confused with posting permission', html: '<p>You have limited membership</p>', status: 'JOINED' },
  { name: 'request to join', html: '<button onclick="window.clicks=(window.clicks||0)+1;this.textContent=\'Requested\'">Request to join</button>', status: 'PENDING', clicks: 1 },
  { name: 'accept invitation', html: '<button onclick="window.clicks=(window.clicks||0)+1;this.textContent=\'Joined\'">Accept invitation</button>', status: 'JOINED', clicks: 1 },
  { name: 'request declined before this run can be re-requested explicitly', html: '<button onclick="window.clicks=(window.clicks||0)+1;this.textContent=\'Hủy yêu cầu\'">Tham gia lại</button>', status: 'PENDING', clicks: 1 },
  { name: 'disabled Join stops without sending', html: '<button disabled onclick="window.clicks=1">Join group</button>', status: 'UNKNOWN', ok: false },
  { name: 'Join enables after hydration', html: '<button id="join" disabled onclick="window.clicks=(window.clicks||0)+1;this.textContent=\'Joined\'">Join group</button><script>setTimeout(()=>document.querySelector("#join").disabled=false,150)</script>', status: 'JOINED', clicks: 1 },
  { name: 'missing membership controls', html: '<h1>Unknown group layout</h1>', status: 'UNKNOWN', ok: false },
  { name: 'ambiguous duplicate Join buttons', html: '<button onclick="window.clicks=1">Join group</button><button onclick="window.clicks=1">Request to join</button>', status: 'UNKNOWN', ok: false },
  { name: 'unrelated feed membership buttons are ignored', html: '<article role="article"><button>Joined</button><button>Cancel request</button></article><button onclick="window.clicks=(window.clicks||0)+1;this.textContent=\'Joined\'">Join group</button>', status: 'JOINED', clicks: 1 },
  { name: 'ordinary group rules text is not a membership question gate', html: '<h2>Group rules</h2><button>Joined</button>', status: 'JOINED' },
  { name: 'conflicting header signals require manual verification', html: '<button>Joined</button><button>Request sent</button><button onclick="window.clicks=1">Join group</button>', status: 'UNKNOWN', ok: false },
  { name: 'unavailable group', html: '<p>This content isn\'t available</p><button onclick="window.clicks=1">Join group</button>', status: 'UNKNOWN', ok: false },
  { name: 'paused group', html: '<p>This group is paused</p><button onclick="window.clicks=1">Join group</button>', status: 'UNKNOWN', ok: false },
  { name: 'archived group', html: '<p>This group is archived</p><button onclick="window.clicks=1">Join group</button>', status: 'UNKNOWN', ok: false },
  { name: 'preexisting questions dialog', html: '<button onclick="window.clicks=1">Join group</button><div role="dialog">Answer membership questions</div>', status: 'REQUIRES_ACTION', ok: false },
  { name: 'pending request still has unfinished questions', html: '<button onclick="window.clicks=1">Cancel request</button><div role="dialog">Answer membership questions</div>', status: 'REQUIRES_ACTION', ok: false },
  { name: 'inline unfinished question prompt', html: '<p>Trả lời câu hỏi</p><button onclick="window.clicks=1">Tham gia nhóm</button>', status: 'REQUIRES_ACTION', ok: false },
  { name: 'rules after Join are never accepted automatically', html: '<button onclick="window.clicks=(window.clicks||0)+1;document.querySelector(\'[role=dialog]\').hidden=false">Join group</button><div role="dialog" hidden>Agree to group rules <button onclick="window.accepted=true">Submit</button></div>', status: 'REQUIRES_ACTION', clicks: 1, ok: false },
  { name: 'unrelated blocking dialog', html: '<button onclick="window.clicks=1">Join group</button><div role="dialog">Choose an identity</div>', status: 'REQUIRES_ACTION', ok: false },
  { name: 'rate-limited account', html: '<p>We limit how often you can do certain things</p><button onclick="window.clicks=1">Join group</button>', ok: false, challenged: true },
  { name: 'challenge appearing after Join', html: '<button onclick="window.clicks=(window.clicks||0)+1;const input=document.createElement(\'input\');input.name=\'captcha_response\';document.body.append(input)">Join group</button>', clicks: 1, ok: false, challenged: true },
];
const managementLinks = (id = '123456') => `<a role="link" href="/groups/${id}/admin_assistant/?source=admin_home">Admin Assist</a><a role="link" href="/groups/${id}/pending_posts/">Pending posts</a><a role="link" href="/groups/${id}/admin_activities/">Activity log</a>`;
const managementSidebar = (links: string, label = 'Admin tools', hidden = false) => `<h1>Test</h1></main><div role="navigation" aria-label="Group navigation"><div role="navigation" aria-label="${label}" ${hidden ? 'hidden' : ''}>${links}</div></div><main role="main"><button>Write something...</button>`;
const managementCases = [
  { name: 'actual admin layout has management sidebar outside main and no Joined button', html: managementSidebar(managementLinks()), joined: true },
  { name: 'moderator tools also prove membership', html: managementSidebar('<a href="/groups/123456/pending_posts/">Pending posts</a><a href="/groups/123456/member_reported_content/">Member-reported content</a>'), joined: true },
  { name: 'Vietnamese management sidebar', html: managementSidebar(managementLinks(), 'Công cụ quản trị'), joined: true },
  { name: 'management sidebar for another group is not proof', html: managementSidebar(managementLinks('654321')), joined: false },
  { name: 'external management links are not proof', html: managementSidebar(managementLinks().replaceAll('href="/groups/', 'href="https://facebook.com.evil.test/groups/')), joined: false },
  { name: 'hidden management sidebar is not proof', html: managementSidebar(managementLinks(), 'Admin tools', true), joined: false },
  { name: 'single admin link is not proof', html: managementSidebar('<a href="/groups/123456/edit/">Group settings</a>'), joined: false },
  { name: 'duplicate admin links are not independent proof', html: managementSidebar('<a href="/groups/123456/edit/">Group settings</a>'.repeat(2)), joined: false },
  { name: 'generic navigation links are not a management sidebar', html: managementSidebar(managementLinks(), 'Notifications'), joined: false },
  { name: 'feed Admin badge and management links are not proof', html: `<h1>Test</h1><article role="article"><span>Admin</span><nav aria-label="Admin tools">${managementLinks()}</nav></article>`, joined: false },
];
for (const scenario of managementCases) test(`membership management: ${scenario.name}`, async () => fixture(scenario.html, async page => {
  let markers = 0;
  const result = await quick.join({ page, profileId: 'fixture', beforeExternalAction: async () => { markers++; } }, url);
  assert.equal(result.ok, scenario.joined);
  assert.equal(result.data?.membershipStatus, scenario.joined ? 'JOINED' : 'UNKNOWN');
  if (scenario.joined) { assert.equal(result.data?.alreadyJoined, true); assert.equal(result.data?.groupRole, 'ADMIN_OR_MODERATOR'); }
  assert.equal(markers, 0);
}));
test('membership management conflicting with pending request requires verification', async () => fixture(managementSidebar(managementLinks()).replace('<h1>Test</h1>', '<h1>Test</h1><button>Cancel request</button>'), async page => {
  const result = await quick.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.ok, false);
  assert.equal(result.data?.membershipStatus, 'UNKNOWN');
}));
for (const scenario of joinCases) test(`join matrix: ${scenario.name}`, async () => fixture(scenario.html, async page => {
  let markers = 0;
  const result = await quick.join({ page, profileId: 'fixture', beforeExternalAction: async () => { markers++; } }, url);
  assert.equal(result.ok, scenario.ok ?? true);
  if (scenario.status) assert.equal(result.data?.membershipStatus, scenario.status);
  if (scenario.challenged) assert.equal(result.data?.accountChallenged, true);
  assert.equal(await page.evaluate('window.clicks||0'), scenario.clicks ?? 0);
  assert.equal(markers, scenario.clicks ?? 0);
  assert.equal(await page.evaluate('window.accepted'), undefined);
}));

test('membership changes while saving the marker prevent a second request', async () => fixture('<button>Join group</button>', async page => {
  const result = await quick.join({ page, profileId: 'fixture', beforeExternalAction: async () => {
    await page.getByRole('button', { name: 'Join group' }).evaluate(button => { button.textContent = 'Cancel request'; });
  } }, url);
  assert.equal(result.data?.membershipStatus, 'PENDING');
  assert.equal(result.data?.requestAlreadyPending, true);
}));
test('visible inline login form with a stale cookie still prevents Join', async () => fixture('<input name="email"><input name="pass"><button onclick="window.clicks=1">Join group</button>', async page => {
  await assert.rejects(quick.join({ page, profileId: 'fixture' }, url), /interactive login/);
  assert.equal(await page.evaluate('window.clicks'), undefined);
}));
for (const destination of ['https://www.facebook.com/groups/other/', 'https://www.facebook.com/groups/123456/posts/9/', 'https://evil.test/groups/123456/']) {
  test(`redirect does not authorize Join/Post at ${destination}`, async () => fixture('<button onclick="window.clicked=true">Join group</button>', async page => {
    // Model the final navigation URL through the fixture's intercepted requests.
    // HTTP redirect chains bypass Playwright routing after their first request.
    const navigate = page.goto.bind(page);
    page.goto = (_input, options) => navigate(destination, options);
    let markers = 0;
    for (const action of ['join', 'post'] as const) {
      const session = { page, profileId: 'fixture', beforeExternalAction: async () => { markers++; } };
      const result = action === 'join' ? await quick.join(session, url) : await quick.post(session, url, 'Never submitted');
      assert.equal(result.ok, false);
    }
    assert.equal(markers, 0);
    assert.equal(await page.evaluate('window.clicked'), undefined);
  }));
}

for (const membership of ['', '<button>Join group</button>', '<button>Cancel request</button>']) {
  test(`post uses composer, not membership (${membership || 'no membership control'})`, async () => fixture(composer("window.clicks=(window.clicks||0)+1;document.querySelector('[role=dialog]').hidden=true;const p=document.createElement('p');p.textContent='Your post is pending';document.body.append(p)").replace('<button>Joined</button>', membership), async page => {
    let markers = 0;
    const result = await quick.post({ page, profileId: 'fixture', beforeExternalAction: async () => { markers++; } }, url, 'Composer is available');
    assert.equal(result.data?.publicationStatus, 'PENDING_APPROVAL');
    assert.equal(result.data?.membershipStatus, undefined);
    assert.equal(await page.evaluate('window.clicks'), 1);
    assert.equal(markers, 1);
  }));
}
const postBlocked = [
  { name: 'joined but no composer', html: '<button>Joined</button>' },
  { name: 'composer exists only in an unrelated feed article', html: '<article role="article"><button onclick="window.submitted=true">Write something</button></article>' },
  { name: 'composer is disabled', html: '<button disabled>Write something</button>' },
  { name: 'composer opens a question dialog without editor', html: '<button onclick="document.querySelector(\'[role=dialog]\').hidden=false">Write something</button><div role="dialog" hidden>Answer participation questions</div>' },
  { name: 'submit never enables', html: composer('window.submitted=true').replace('<button onclick="window.submitted=true">Post', '<button disabled onclick="window.submitted=true">Post') },
  { name: 'CAPTCHA blocks composer', html: '<input name="captcha_response">' + composer('window.submitted=true') },
];
for (const scenario of postBlocked) test(`post matrix: ${scenario.name}`, async () => fixture(scenario.html, async page => {
  let markers = 0;
  const result = await quick.post({ page, profileId: 'fixture', beforeExternalAction: async () => { markers++; } }, url, 'Never submitted');
  assert.equal(result.ok, false);
  assert.equal(result.data?.requiresAction, true);
  assert.equal(await page.evaluate('window.submitted'), undefined);
  assert.equal(markers, 0);
}));
test('welcome overlay can be closed without accepting group rules', async () => fixture('<button>Joined</button><div role="dialog">Welcome to the group <button onclick="this.parentElement.hidden=true">Close</button></div>', async page => {
  const result = await quick.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.data?.membershipStatus, 'JOINED');
}));
test('welcome appearing after a successful Join is dismissed before reading membership', async () => fixture('<button onclick="window.clicks=(window.clicks||0)+1;this.textContent=\'Joined\';document.querySelector(\'[role=dialog]\').hidden=false">Join group</button><div role="dialog" hidden>Welcome to the group <button onclick="this.parentElement.hidden=true">Close</button></div>', async page => {
  const result = await quick.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.data?.membershipStatus, 'JOINED');
  assert.equal(await page.evaluate('window.clicks'), 1);
}));
test('welcome containing group rules is never silently dismissed', async () => fixture('<button>Joined</button><div role="dialog">Welcome to the group. Agree to group rules <button onclick="window.dismissed=true;this.parentElement.hidden=true">Close</button></div>', async page => {
  const result = await quick.join({ page, profileId: 'fixture' }, url);
  assert.equal(result.data?.membershipStatus, 'REQUIRES_ACTION');
  assert.equal(await page.evaluate('window.dismissed'), undefined);
}));

for (const change of ['target', 'editor', 'disabled', 'captcha']) test(`post rechecks ${change} after saving the send marker`, async () => fixture(composer('window.submitted=true'), async page => {
  const result = await quick.post({ page, profileId: 'fixture', beforeExternalAction: async () => {
    await page.evaluate(kind => {
      if (kind === 'target') history.replaceState({}, '', '/groups/other/');
      if (kind === 'editor') document.querySelector('[role=textbox]')!.textContent = 'Changed content';
      if (kind === 'disabled') (document.querySelector('[role=dialog] button') as HTMLButtonElement).disabled = true;
      if (kind === 'captcha') { const input = document.createElement('input'); input.name = 'captcha_response'; document.body.append(input); }
    }, change);
  } }, url, 'Fixture post');
  assert.equal(result.ok, false);
  assert.equal(await page.evaluate('window.submitted'), undefined);
}));
