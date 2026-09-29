import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { FacebookCommentsAutomation, extractFacebookPhoneNumbers } from './facebook-comments';

async function fixture(html: string, run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'c_user', value: 'fixture-user', domain: '.facebook.com', path: '/' }]);
    await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<main role="main">${html}</main>` }));
    await run(await context.newPage());
  } finally {
    await browser.close();
  }
}

test('normalizes Vietnamese phone formats and removes duplicate numbers', () => {
  assert.deepEqual(extractFacebookPhoneNumbers('0901 234 567, +84 912-345-678, 0094 12345678, 0901234567'), ['0901234567', '0912345678']);
});

test('selects all comments, loads more comments, and extracts phone numbers', async () => fixture(`
  <button aria-label="Most relevant" onclick="document.querySelector('[role=menu]').hidden=false">Most relevant</button>
  <div role="menu" hidden><button role="menuitem" onclick="this.closest('[role=menu]').hidden=true">All comments</button></div>
  <div data-ad-preview="message">Liên hệ 0901 234 567</div>
  <button aria-label="View more comments" onclick="this.previousElementSibling.insertAdjacentHTML('afterend','<div data-ad-preview=message>Gọi +84 912 345 678</div>');this.remove()">View more comments</button>
`, async page => {
  const result = await new FacebookCommentsAutomation({ mainTimeoutMs: 700, controlTimeoutMs: 900 }).scanPostComments({ page, profileId: 'fixture' }, 'https://facebook.com/groups/123/posts/456');
  assert.equal(result.ok, true);
  assert.equal(result.data?.commentsScanned, 2);
  assert.deepEqual(result.data?.phoneNumbers, ['0901234567', '0912345678']);
  assert.equal(result.data?.phoneCount, 2);
}));

test('stops safely when Facebook requires a security check', async () => fixture('<p>Security check</p>', async page => {
  const result = await new FacebookCommentsAutomation({ mainTimeoutMs: 300, controlTimeoutMs: 300 }).scanPostComments({ page, profileId: 'fixture' }, 'https://facebook.com/groups/123/posts/456');
  assert.equal(result.ok, false);
  assert.equal(result.data?.requiresAction, true);
}));

test('replies to the configured number of visible comments and confirms each reply', async () => fixture(`
  <button aria-label="Most relevant" onclick="document.querySelector('[role=menu]').hidden=false">Most relevant</button>
  <div role="menu" hidden><button role="menuitem" onclick="this.closest('[role=menu]').hidden=true">All comments</button></div>
  <div class="comment"><div data-ad-preview="message">Bình luận một</div><button onclick="const p=this.parentElement;const box=document.createElement('div');box.setAttribute('role','textbox');box.contentEditable='true';const send=document.createElement('button');send.textContent='Reply';send.onclick=()=>{const out=document.createElement('div');out.textContent=box.textContent;p.append(out);box.remove();send.remove()};p.append(box,send)">Reply</button></div>
  <div class="comment"><div data-ad-preview="message">Bình luận hai</div><button onclick="const p=this.parentElement;const box=document.createElement('div');box.setAttribute('role','textbox');box.contentEditable='true';const send=document.createElement('button');send.textContent='Reply';send.onclick=()=>{const out=document.createElement('div');out.textContent=box.textContent;p.append(out);box.remove();send.remove()};p.append(box,send)">Reply</button></div>
`, async page => {
  let markers = 0;
  const result = await new FacebookCommentsAutomation({ mainTimeoutMs: 700, controlTimeoutMs: 900 }).replyPostComments({ page, profileId: 'fixture', beforeExternalAction: async () => { markers += 1; } }, 'https://facebook.com/groups/123/posts/456', 'Cảm ơn bạn', 2);
  assert.equal(result.ok, true);
  assert.equal(result.data?.repliesSent, 2);
  assert.equal(markers, 2);
}));

test('does not send beyond available comments', async () => fixture(`
  <div class="comment"><div data-ad-preview="message">Bình luận duy nhất</div><button onclick="const p=this.parentElement;const box=document.createElement('div');box.setAttribute('role','textbox');box.contentEditable='true';const send=document.createElement('button');send.textContent='Reply';send.onclick=()=>{const out=document.createElement('div');out.textContent=box.textContent;p.append(out);box.remove();send.remove()};p.append(box,send)">Reply</button></div>
`, async page => {
  const result = await new FacebookCommentsAutomation({ mainTimeoutMs: 700, controlTimeoutMs: 900 }).replyPostComments({ page, profileId: 'fixture', beforeExternalAction: async () => {} }, 'https://facebook.com/groups/123/posts/456', 'Cảm ơn bạn', 2);
  assert.equal(result.ok, false);
  assert.equal(result.data?.requiresAction, true);
  assert.equal(result.data?.repliesSent, 1);
}));
