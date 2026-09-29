import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';
import { FacebookGroupsAutomation } from './facebook-groups';

const scan = new FacebookGroupsAutomation({ mainTimeoutMs: 300, syncQuietMs: 250, syncPollMs: 30, syncTimeoutMs: 7000 });
const slow = new FacebookGroupsAutomation({ mainTimeoutMs: 300, syncQuietMs: 250, syncPollMs: 30, syncTimeoutMs: 1000 });
async function fixture(html: string, run: (page: Page) => Promise<void>) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'c_user', value: 'fixture', domain: '.facebook.com', path: '/' }]);
    await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main role="main">${html}</main>` }));
    await run(await context.newPage());
  } finally { await browser.close(); }
}
const sync = (page: Page) => scan.sync({ page, profileId: 'fixture' });

test('full sync includes manually joined and unnamed groups, excludes recommendations, feed and navigation', async () => fixture(`
  <a href="/groups/manual/">Manually joined</a><a href="/groups/123/"><img alt="View group" width="50" height="50"></a>
  <a href="/groups/123/?ref=x">View group</a><a href="/groups/manual/posts/42/">Post link</a>
  <section><h2>Suggested groups</h2><a href="/groups/suggested/">Recommendation</a></section>
  <section><a href="/groups/notjoined/">Not joined</a><button>Join group</button></section>
  <nav><a href="/groups/nav/">Sidebar</a></nav><article><a href="/groups/feed/">Feed</a></article>
  <div hidden><a href="/groups/hidden/">Hidden recommendation</a></div>
  <a href="https://evil.test/groups/foreign/">Foreign</a>
`, async page => {
  const result = await sync(page);
  assert.equal(result.ok, true); assert.equal(result.data?.complete, true);
  assert.deepEqual(result.data?.groups, [{ groupUrl: 'https://www.facebook.com/groups/manual/', groupName: 'Manually joined' }, { groupUrl: 'https://www.facebook.com/groups/123/', groupName: null }]);
}));

test('sync waits through a slow loading indicator rather than calling the first batch complete', async () => fixture(`
  <a href="/groups/first/">First</a><div id="loading" role="progressbar">Loading</div>
  <script>setTimeout(()=>{document.querySelector('main').insertAdjacentHTML('beforeend','<a href="/groups/later/">Later</a>');document.querySelector('#loading').remove()},1000)</script>
`, async page => {
  const result = await sync(page); assert.equal(result.ok, true); assert.equal(result.data?.groupCount, 2);
}));

test('sync traverses more than 40 batches using the list load-more control', async () => fixture(`
  <a href="/groups/0/">Group 0</a><button id="more">See more</button>
  <script>let count=0;document.querySelector('#more').onclick=function(){count++;this.insertAdjacentHTML('beforebegin','<a href="/groups/'+count+'/">Group '+count+'</a>');if(count===45)this.remove()}</script>
`, async page => {
  const result = await sync(page); assert.equal(result.ok, true); assert.equal(result.data?.groupCount, 46);
}));

test('a recommendation See more button does not hide the joined-list pagination', async () => fixture(`
  <section><h2>Suggested groups</h2><a href="/groups/suggested/">Suggested</a><button onclick="window.wrong=true">See more</button></section>
  <section><h2>Your groups</h2><a href="/groups/first/">First</a><button onclick="this.insertAdjacentHTML('beforebegin','&lt;a href=/groups/second/&gt;Second&lt;/a&gt;');this.remove()">See more</button></section>
`, async page => {
  const result = await sync(page); assert.equal(result.ok, true); assert.equal(result.data?.groupCount, 2);
  assert.equal(await page.evaluate('window.wrong'), undefined);
}));

test('Vietnamese group-card overflow menus are not treated as pagination', async () => fixture(`
  <a href="/groups/real/">Real</a><div role="button" aria-label="Xem thêm" aria-haspopup="dialog">Xem thêm</div>
`, async page => {
  const result = await sync(page);
  assert.equal(result.ok, true); assert.equal(result.data?.complete, true); assert.equal(result.data?.groupCount, 1);
}));

test('sync reads a nested virtualized scrolling list and retains earlier groups', async () => fixture(`
  <div id="list" style="height:200px;overflow-y:auto"></div><script>
  const list=document.querySelector('#list');
  function render(){const batch=Math.min(9,Math.floor(list.scrollTop/200));list.innerHTML='<div style="height:'+batch*200+'px"></div>'+Array.from({length:10},(_,i)=>'<a style="display:block;height:20px" href="/groups/'+(batch*10+i)+'/">Group '+(batch*10+i)+'</a>').join('')+'<div style="height:'+((9-batch)*200)+'px"></div>'}
  render();list.addEventListener('scroll',render);
  </script>
`, async page => {
  const result = await sync(page); assert.equal(result.ok, true); assert.equal(result.data?.groupCount, 100);
}));

test('sync does not truncate an inventory at 1000 groups', async () => fixture(
  Array.from({ length: 1005 }, (_, i) => `<a href="/groups/${i}/">Group ${i}</a>`).join(' '), async page => {
    const result = await sync(page); assert.equal(result.ok, true); assert.equal(result.data?.groupCount, 1005);
  },
));

test('explicit empty membership is a successful zero, but an unloaded shell is incomplete', async () => {
  await fixture('<p>Bạn chưa tham gia nhóm nào</p>', async page => { const result = await sync(page); assert.equal(result.ok, true); assert.equal(result.data?.groupCount, 0); });
  await fixture('<div></div>', async page => { const result = await slow.sync({ page, profileId: 'fixture' }); assert.equal(result.ok, false); assert.equal(result.data?.complete, false); });
});

test('stalled loading returns partial groups with an explicit incomplete status', async () => fixture(
  '<a href="/groups/known/">Known</a><div role="progressbar">Loading</div>', async page => {
    const result = await slow.sync({ page, profileId: 'fixture' });
    assert.equal(result.ok, false); assert.equal(result.data?.requiresAction, true); assert.equal(result.data?.groupCount, 1); assert.equal(result.data?.complete, false);
  },
));

test('navigation to discovery while syncing cannot import recommendations', async () => fixture(`
  <a href="/groups/real/">Real</a><div role="progressbar">Loading</div>
  <script>setTimeout(()=>{history.replaceState({},'', '/groups/discover/');document.querySelector('main').innerHTML='<a href="/groups/recommended/">Suggested</a>'},200)</script>
`, async page => {
  const result = await sync(page); assert.equal(result.ok, false); assert.equal(result.data?.groupCount, 1);
  assert.equal((result.data?.groups as any[])[0].groupName, 'Real');
}));
