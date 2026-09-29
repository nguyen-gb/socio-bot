import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { FacebookMessagesAutomation } from './facebook-messages';

const profileUrl = 'https://www.facebook.com/consented.user/';
const automation = new FacebookMessagesAutomation({ mainTimeoutMs: 500, controlTimeoutMs: 700, confirmationTimeoutMs: 1000 });
async function fixture(html: string, run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main role="main">${html}</main>` }));
    await run(await context.newPage());
  } finally { await browser.close(); }
}

const messenger = `<button onclick="document.querySelector('[role=dialog]').hidden=false">Message</button>
  <div role="dialog" hidden><div role="textbox" contenteditable="true"></div><button onclick="const box=this.previousElementSibling;const row=document.createElement('div');row.setAttribute('role','row');row.textContent=box.textContent;this.parentElement.append(row);box.textContent=''">Send</button></div>`;

test('sends once only after durable marker and confirms the resulting bubble', async () => fixture(messenger, async page => {
  let marked = false;
  const result = await automation.message({ page, profileId: 'fixture', beforeExternalAction: async () => {
    assert.equal(await page.getByRole('row').count(), 0); marked = true;
  } }, profileUrl, 'Tin nhắn đã được đồng ý');
  assert.equal(marked, true); assert.equal(result.ok, true); assert.equal(result.data?.messageStatus, 'SENT');
  assert.equal(await page.getByRole('row').count(), 1);
}));

test('marker failure prevents sending and an unavailable profile stops safely', async () => {
  await fixture(messenger, async page => {
    await assert.rejects(automation.message({ page, profileId: 'fixture', beforeExternalAction: async () => { throw new Error('marker failed'); } }, profileUrl, 'Không được gửi'), /marker failed/);
    assert.equal(await page.getByRole('row').count(), 0);
  });
  await fixture('<p>Profile unavailable</p>', async page => {
    const result = await automation.message({ page, profileId: 'fixture' }, profileUrl, 'Không được gửi');
    assert.equal(result.ok, false); assert.equal(result.data?.requiresAction, true);
  });
});

test('an old identical bubble never confirms a new unacknowledged send', async () => fixture(`<button onclick="document.querySelector('[role=dialog]').hidden=false">Message</button>
  <div role="dialog" hidden><div role="row">Tin nhắn trùng</div><div role="textbox" contenteditable="true"></div><button onclick="this.previousElementSibling.textContent=''">Send</button></div>`, async page => {
  const result = await automation.message({ page, profileId: 'fixture', beforeExternalAction: async () => {} }, profileUrl, 'Tin nhắn trùng');
  assert.equal(result.ok, false); assert.equal(result.data?.messageStatus, 'UNKNOWN');
  assert.equal(await page.getByRole('row').count(), 1);
}));

test('accepts Facebook canonical username redirect for a selected numeric member ID', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'c_user', value: '61594169541646', domain: '.facebook.com', path: '/' }]);
    await context.route('**/*', route => {
      if (route.request().url().startsWith('https://www.facebook.com/100028475506542')) {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<script>history.replaceState({}, '', '/tran.van.nguyen/')</script><main role="main">${messenger}</main>` });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main role="main">${messenger}</main>` });
    });
    const result = await automation.message({ page: await context.newPage(), profileId: 'fixture', beforeExternalAction: async () => {} }, 'https://www.facebook.com/100028475506542', 'Tin nhắn nhóm');
    assert.equal(result.ok, true);
    assert.equal(result.data?.messageStatus, 'SENT');
  } finally { await browser.close(); }
});

test('sends from Facebook docked Messenger composer without a dialog role', async () => fixture(`<button onclick="document.querySelector('#composer').hidden=false">Message</button>
  <div id="composer" hidden><div role="textbox" contenteditable="true"></div><button aria-label="Press Enter to send" onclick="const box=document.querySelector('[contenteditable=true]');const row=document.createElement('div');row.setAttribute('role','row');row.textContent=box.textContent;document.querySelector('#composer').append(row);box.textContent=''">Send</button></div>`, async page => {
  const result = await automation.message({ page, profileId: 'fixture', beforeExternalAction: async () => {} }, profileUrl, 'Tin nhắn docked');
  assert.equal(result.ok, true);
  assert.equal(result.data?.messageStatus, 'SENT');
}));

test('opens the profile Message action instead of a stale body-level chat action', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<div id="stale-chat"><button>Message</button><textarea></textarea></div>
      <main role="main"><h1>Recipient</h1><button onclick="document.querySelector('#profile-chat').hidden=false">Message</button>
        <div id="profile-chat" role="dialog" hidden><div role="textbox" contenteditable="true"></div><button aria-label="Send" onclick="const box=this.parentElement.querySelector('[contenteditable=true]');const row=document.createElement('div');row.setAttribute('role','row');row.textContent=box.textContent;this.parentElement.append(row);box.textContent=''">Send</button></div>
      </main>` }));
    const result = await automation.message({ page: await context.newPage(), profileId: 'fixture', beforeExternalAction: async () => {} }, profileUrl, 'Tin nhắn đúng profile');
    assert.equal(result.ok, true);
    assert.equal(result.data?.messageStatus, 'SENT');
  } finally { await browser.close(); }
});

test('uploads a selected image before sending a Messenger message', async () => {
  const image = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const html = `<button onclick="document.querySelector('[role=dialog]').hidden=false">Message</button>
    <div role="dialog" hidden>
      <div role="textbox" contenteditable="true"></div>
      <button aria-label="Attach a file up to 100 MB" onclick="document.querySelector('[type=file]').hidden=false">+</button>
      <input type="file" accept="image/jpeg,image/png,image/webp" hidden onchange="const image=document.createElement('img'); image.width=80; image.height=80; image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='; this.parentElement.append(image); this.parentElement.querySelector('button[aria-label=Send]').disabled=false">
      <button aria-label="Send" disabled onclick="const box=this.parentElement.querySelector('[contenteditable=true]');const row=document.createElement('div');row.setAttribute('role','row');row.textContent=box.textContent;this.parentElement.append(row);box.textContent=''">Send</button>
    </div>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main role="main">${html}</main>` }));
    const page = await context.newPage();
    const result = await new FacebookMessagesAutomation({ mainTimeoutMs: 500, controlTimeoutMs: 2_000, confirmationTimeoutMs: 1_000 }).message({
      page, profileId: 'fixture',
      resolveMediaAssets: async ids => ids.map(id => ({ name: `${id}.png`, mimeType: 'image/png', buffer: image })),
      beforeExternalAction: async () => {},
    }, profileUrl, 'Tin nhắn kèm ảnh', ['00000000-0000-4000-8000-000000000001']);
    assert.equal(result.ok, true);
    assert.equal(result.data?.messageStatus, 'SENT');
    assert.equal(await page.locator('[role="dialog"] img').count(), 1);
  } finally { await browser.close(); }
});

test('scopes Messenger image upload away from an unrelated Facebook composer', async () => {
  const image = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const html = `<div id="post-composer"><input id="post-file" type="file"></div>
    <button onclick="document.querySelector('#chat').hidden=false">Message</button>
    <div id="chat" hidden>
      <div role="textbox" contenteditable="true"></div>
      <input id="chat-file" type="file" hidden onchange="const image=document.createElement('img'); image.width=80; image.height=80; image.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='; this.parentElement.append(image); this.parentElement.querySelector('[aria-label=Send]').disabled=false">
      <button aria-label="Send" disabled onclick="const box=this.parentElement.querySelector('[contenteditable=true]'); const row=document.createElement('div'); row.setAttribute('role','row'); row.textContent=box.textContent; this.parentElement.append(row); box.textContent=''">Send</button>
    </div>`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main role="main">${html}</main>` }));
    const page = await context.newPage();
    const result = await new FacebookMessagesAutomation({ mainTimeoutMs: 500, controlTimeoutMs: 2_000, confirmationTimeoutMs: 1_000 }).message({
      page, profileId: 'fixture',
      resolveMediaAssets: async ids => ids.map(id => ({ name: `${id}.png`, mimeType: 'image/png', buffer: image })),
      beforeExternalAction: async () => {},
    }, profileUrl, 'Tin nhắn đúng composer', ['00000000-0000-4000-8000-000000000002']);
    assert.equal(result.ok, true);
    assert.equal(await page.locator('#chat img').count(), 1);
    assert.equal(await page.locator('#post-file').evaluate(input => (input as HTMLInputElement).files?.length ?? 0), 0);
  } finally { await browser.close(); }
});

test('closes minimized Vietnamese Messenger chats before opening the profile composer', async () => fixture(`<button aria-label="Mở cuộc trò chuyện với Cuộc trò chuyện cũ" onclick="document.querySelector('#old-chat').hidden=false">Cuộc trò chuyện cũ</button>
  <div id="old-chat" hidden><button aria-label="Đóng cửa sổ chat" onclick="this.parentElement.remove()">Đóng</button></div>
  <button onclick="document.querySelector('#composer').hidden=false">Message</button>
  <div id="composer" hidden><div role="textbox" contenteditable="true"></div><button aria-label="Nhấn Enter để gửi" onclick="const box=document.querySelector('[contenteditable=true]');const row=document.createElement('div');row.setAttribute('role','row');row.textContent=box.textContent;document.querySelector('#composer').append(row);box.textContent=''">Gửi</button></div>`, async page => {
  const result = await automation.message({ page, profileId: 'fixture', beforeExternalAction: async () => {} }, profileUrl, 'Tin nhắn sau khi dọn chat');
  assert.equal(result.ok, true);
  assert.equal(await page.locator('#old-chat').count(), 0);
  assert.equal(result.data?.messageStatus, 'SENT');
}));

test('selects a visible group member at random and only then opens the message flow', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'c_user', value: '61594169541646', domain: '.facebook.com', path: '/' }]);
    await context.route('**/*', route => {
      const memberPage = route.request().url().endsWith('/groups/fixture/members');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main role="main">${memberPage
        ? '<a href="https://www.facebook.com/groups/1710577763336777/user/61594169541646/">Current account</a><a href="https://www.facebook.com/groups/1710577763336777/user/100028475506542/">Member One</a><a href="https://www.facebook.com/people/Member-Two/100012345678901/">Member Two</a>'
        : messenger}</main>` });
    });
    const page = await context.newPage();
    const result = await automation.messageRandomGroupMember({ page, profileId: 'fixture', beforeExternalAction: async () => {} }, 'https://www.facebook.com/groups/fixture/', 'Tin nhắn nhóm');
    assert.equal(result.ok, true);
    assert.equal(result.data?.groupUrl, 'https://www.facebook.com/groups/fixture/');
    assert.ok(['https://www.facebook.com/100028475506542', 'https://www.facebook.com/profile.php?id=100012345678901'].includes(String(result.data?.profileUrl)));
  } finally { await browser.close(); }
});
