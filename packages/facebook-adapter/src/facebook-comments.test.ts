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
  <div class="comment"><div data-ad-preview="message">Bình luận một</div><button onclick="const p=this.parentElement;const box=document.createElement('div');box.setAttribute('role','textbox');box.contentEditable='true';const mention=document.createElement('span');mention.setAttribute('data-mention','true');mention.textContent='Trần Văn Nguyên';box.append(mention);const send=document.createElement('button');send.setAttribute('aria-label','Comment');send.textContent='Comment';send.onclick=()=>{window.__mentionPreserved=box.textContent.includes('Trần Văn Nguyên')&&box.textContent.includes('Cảm ơn bạn');const out=document.createElement('div');out.textContent='Cảm ơn bạn';p.append(out);box.remove();send.remove()};p.append(box,send)">Reply</button></div>
  <div class="comment"><div data-ad-comet-preview="message">Bình luận hai</div><button onclick="const p=this.parentElement;const box=document.createElement('div');box.setAttribute('role','textbox');box.contentEditable='true';const send=document.createElement('button');send.setAttribute('aria-label','Comment');send.textContent='Comment';send.onclick=()=>{const out=document.createElement('div');out.textContent=box.textContent;p.append(out);box.remove();send.remove()};p.append(box,send)">Reply</button></div>
  <div id="post-level-composer" role="textbox" contenteditable="true"></div>
  <div id="chat-composer" role="textbox" contenteditable="true" aria-label="Write a message"></div>
`, async page => {
  let markers = 0;
  const result = await new FacebookCommentsAutomation({ mainTimeoutMs: 700, controlTimeoutMs: 900 }).replyPostComments({ page, profileId: 'fixture', beforeExternalAction: async () => { markers += 1; } }, 'https://facebook.com/groups/123/posts/456', 'Cảm ơn bạn', 2);
  assert.equal(result.ok, true);
  assert.equal(result.data?.repliesSent, 2);
  assert.equal(markers, 2);
  // A post-level composer is intentionally present in this fixture. The
  // reply text must stay scoped to each clicked comment instead of being
  // written into that unrelated composer.
  assert.equal(await page.locator('#post-level-composer').innerText(), '');
  assert.equal(await page.locator('#chat-composer').innerText(), '');
  assert.equal(await page.evaluate(() => (window as unknown as { __mentionPreserved?: boolean }).__mentionPreserved), true);
  assert.equal(await page.locator('.comment').nth(0).getByText('Cảm ơn bạn', { exact: true }).count(), 1);
  assert.equal(await page.locator('.comment').nth(1).getByText('Cảm ơn bạn', { exact: true }).count(), 1);
}));

test('does not send beyond available comments', async () => fixture(`
  <div class="comment"><div data-ad-preview="message">Bình luận duy nhất</div><button onclick="const p=this.parentElement;const box=document.createElement('div');box.setAttribute('role','textbox');box.contentEditable='true';const send=document.createElement('button');send.setAttribute('aria-label','Comment');send.textContent='Comment';send.onclick=()=>{const out=document.createElement('div');out.textContent=box.textContent;p.append(out);box.remove();send.remove()};p.append(box,send)">Reply</button></div>
`, async page => {
  const result = await new FacebookCommentsAutomation({ mainTimeoutMs: 700, controlTimeoutMs: 900 }).replyPostComments({ page, profileId: 'fixture', beforeExternalAction: async () => {} }, 'https://facebook.com/groups/123/posts/456', 'Cảm ơn bạn', 2);
  assert.equal(result.ok, false);
  assert.equal(result.data?.requiresAction, true);
  assert.equal(result.data?.repliesSent, 1);
}));

test('skips comments authored by the logged-in profile', async () => fixture(`
  <div class="comment"><a href="/tran.van.nguyen.768806">Trần Văn Nguyên</a><div data-ad-preview="message">Bình luận của tôi</div><button onclick="const p=this.parentElement;const box=document.createElement('div');box.setAttribute('role','textbox');box.contentEditable='true';const send=document.createElement('button');send.setAttribute('aria-label','Comment');send.textContent='Comment';send.onclick=()=>{const out=document.createElement('div');out.textContent=box.textContent;p.append(out);box.remove();send.remove()};p.append(box,send)">Reply</button></div>
  <div class="comment"><a href="/other.person">Người khác</a><div data-ad-preview="message">Bình luận của người khác</div><button onclick="const p=this.parentElement;const box=document.createElement('div');box.setAttribute('role','textbox');box.contentEditable='true';const send=document.createElement('button');send.setAttribute('aria-label','Comment');send.textContent='Comment';send.onclick=()=>{const out=document.createElement('div');out.textContent=box.textContent;p.append(out);box.remove();send.remove()};p.append(box,send)">Reply</button></div>
`, async page => {
  const result = await new FacebookCommentsAutomation({ mainTimeoutMs: 700, controlTimeoutMs: 900 }).replyPostComments({ page, profileId: 'fixture', accountUsername: 'Trần Văn Nguyên', accountExternalId: 'tran.van.nguyen.768806', beforeExternalAction: async () => {} }, 'https://facebook.com/groups/123/posts/456', 'Cảm ơn bạn', 1);
  assert.equal(result.ok, true);
  assert.equal(result.data?.repliesSent, 1);
  assert.equal(await page.locator('.comment').nth(0).getByText('Cảm ơn bạn', { exact: true }).count(), 0);
  assert.equal(await page.locator('.comment').nth(1).getByText('Cảm ơn bạn', { exact: true }).count(), 1);
}));

test('attaches an image to each comment reply before submitting', async () => fixture(`
  <div class="comment"><div data-ad-preview="message">Bình luận có ảnh</div>
    <button onclick="this.nextElementSibling.hidden=false;this.nextElementSibling.querySelector('div[contenteditable]').focus()">Reply</button>
    <form hidden onsubmit="event.preventDefault();const p=this.closest('.comment');const form=this;const box=form.querySelector('div[contenteditable]');const out=document.createElement('div');out.setAttribute('data-ad-preview','message');out.textContent=box.textContent;const image=form.querySelector('img[data-uploaded]');if(image){const copy=image.cloneNode(true);copy.removeAttribute('data-uploaded');out.append(copy)}p.append(out);form.remove()">
      <div role="textbox" contenteditable="true" onkeydown="if(event.key==='Enter'){event.preventDefault();this.closest('form').requestSubmit()}"></div>
      <input type="file" accept="image/*" onchange="const form=this.closest('form');const image=document.createElement('img');image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';image.width=64;image.height=64;image.setAttribute('data-uploaded','true');const remove=document.createElement('button');remove.setAttribute('aria-label','Remove photo');remove.textContent='Remove photo';form.append(image,remove)">
      <button type="submit" aria-label="Comment">Comment</button>
    </form>
  </div>
`, async page => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const result = await new FacebookCommentsAutomation({ mainTimeoutMs: 700, controlTimeoutMs: 2_000 }).replyPostComments({
    page,
    profileId: 'fixture',
    resolveMediaAssets: async ids => ids.map(id => ({ name: `${id}.png`, mimeType: 'image/png', buffer: image })),
    beforeExternalAction: async () => {},
  }, 'https://facebook.com/groups/123/posts/456', 'Rep kèm ảnh', 1, ['asset-1']);
  assert.equal(result.ok, true);
  assert.equal(result.data?.repliesSent, 1);
  const posted = page.locator('.comment [data-ad-preview="message"]').filter({ hasText: 'Rep kèm ảnh' }).last();
  assert.equal(await posted.count(), 1);
  assert.equal(await posted.locator('img').count(), 1);
}));
