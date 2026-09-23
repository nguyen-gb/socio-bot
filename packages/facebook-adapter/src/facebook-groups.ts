import { normalizeFacebookGroupUrl, type ActionResult } from '@socio/contracts';
import { LoginRequiredError, type PlatformSession } from '@socio/platform-core';
import type { Locator, Page, Request, Response } from 'playwright';
import { isTaskPostRequest, readPostConfirmation, type FacebookPostConfirmation } from './facebook-post-confirmation';

const JOIN = /^(Join group|Join|Request to join(?: group)?|Join again|Tham gia nhóm|Yêu cầu tham gia(?: nhóm)?|Tham gia lại|Accept invitation|Chấp nhận lời mời)$/i;
const JOINED = /^(Joined|Member|You(?:'|’)re a member|Đã tham gia|Bạn là thành viên|Leave group|Rời nhóm)$/i;
const PENDING = /^(Cancel request|Hủy yêu cầu|Request sent|Requested|Membership pending|Pending approval|Đã gửi yêu cầu|Yêu cầu đã gửi|Chờ duyệt|Đang chờ phê duyệt)$/i;
const PENDING_NOTICE = /Your (?:membership |join )?request(?: to join(?: this group)?)? (?:is pending|has been sent)|You(?:'|’)ve requested to join|Your membership is pending|Yêu cầu tham gia của bạn.*(?:chờ|đã.*gửi)|Bạn đã gửi yêu cầu tham gia/i;
const QUESTIONS = /(?:answer|membership|participation) questions|group rules|agree to.*rules|trả lời.*câu hỏi|câu hỏi.*(?:thành viên|tham gia)|quy tắc nhóm|đồng ý.*quy tắc/i;
const QUESTION_PROMPT = /answer (?:membership |participation )?questions|trả lời (?:các )?câu hỏi|agree to (?:the )?group rules|đồng ý (?:với )?quy tắc nhóm/i;
const UNAVAILABLE = /This content (?:isn't|is not|isn’t) available|This group is (?:no longer available|paused|archived)|You can(?:not|'t|’t) (?:join|access) this group|Nội dung này hiện không (?:khả dụng|hiển thị)|Nhóm này (?:không còn|đã bị|đã tạm dừng)|Nhóm đã được lưu trữ|Bạn không thể (?:tham gia|truy cập) nhóm/i;
const GROUP_CONTENT = ':not(article *, [role="article"] *, nav *, [role="navigation"] *)';
const ADMIN_TOOLS = /^(Admin tools|Công cụ quản trị(?: viên)?|Công cụ quản lý)$/i;
const ADMIN_ROUTES = new Set(['admin_assistant', 'pending_posts', 'admin_activities', 'member_reported_content', 'group_quality', 'edit', 'community_roles', 'manage_rules']);
const PENDING_POST = /Your post is pending|Your post has been submitted|Bài viết.*(chờ|đợi).*duyệt|Bài viết của bạn đã được gửi/i;
const COMPOSER = /Write something|Write a post|Bạn viết gì|Viết bài|Bạn đang nghĩ gì/i;
const MENTIONS = /^(Mentions suggestions|Gợi ý nhắc đến|Gợi ý đề cập|Gợi ý gắn thẻ)$/i;
const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim();

export class FacebookGroupsAutomation {
  constructor(private readonly timing: { mainTimeoutMs?: number; controlTimeoutMs?: number; joinConfirmationTimeoutMs?: number; postConfirmationTimeoutMs?: number } = {}) {}
  async sync(session: PlatformSession): Promise<ActionResult> {
    const page = automationPage(session);
    const blocked = await openGroupsPage(page, 'https://www.facebook.com/groups/joins/');
    if (blocked) return blocked;
    // Only collect the account's joined-groups page, not recommendations/feed links.
    if (!new URL(page.url()).pathname.startsWith('/groups/joins')) return manual('Facebook không mở được danh sách nhóm đã tham gia');
    const groups = new Map<string, string>();
    let stalled = 0;
    let complete = false;
    for (let iteration = 0; iteration < 40; iteration++) {
      const entries = await page.locator('[role="main"] a[href*="/groups/"]').evaluateAll((anchors) => anchors.filter((anchor) => !anchor.closest('nav,[role="navigation"]')).map((anchor) => ({
        url: (anchor as HTMLAnchorElement).href,
        name: (anchor.textContent ?? '').trim(),
      })));
      const previousSize = groups.size;
      for (const entry of entries) {
        try {
          const groupUrl = normalizeFacebookGroupUrl(entry.url);
          if (entry.name) groups.set(groupUrl, entry.name.slice(0, 255));
        } catch { /* Ignore navigation, posts and non-group links. */ }
      }
      if (groups.size >= 1000) break;
      stalled = groups.size === previousSize ? stalled + 1 : 0;
      if (stalled >= 3) { complete = true; break; }
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(700);
      const interrupted = await guard(page);
      if (interrupted) return interrupted;
    }
    if (!groups.size) return manual('Không đọc được nhóm nào. Kiểm tra account và danh sách nhóm trong browser.');
    return { ok: true, data: { groups: [...groups].slice(0, 1000).map(([groupUrl, groupName]) => ({ groupUrl, groupName })), complete } };
  }

  async join(session: PlatformSession, inputUrl: string): Promise<ActionResult> {
    const page = automationPage(session);
    const groupUrl = normalizeFacebookGroupUrl(inputUrl);
    const blocked = await openGroupsPage(page, groupUrl, this.timing.mainTimeoutMs);
    if (blocked) return blocked;
    const groupName = await page.title();
    if (!isGroupPage(page, groupUrl)) return manual('Facebook không mở đúng trang nhóm đích; không gửi yêu cầu', { groupUrl, membershipStatus: 'UNKNOWN' });
    const main = page.getByRole('main').first();
    if (!(await main.isVisible())) return manual('Không xác định được nội dung nhóm đích; đã dừng', { groupUrl });
    const data = { groupUrl, groupName };
    const controlsUntil = Date.now() + (this.timing.controlTimeoutMs ?? 15_000);
    let state = await joinState(page, groupUrl, data, true);
    while (!state.result && !state.button && Date.now() < controlsUntil) {
      await page.waitForTimeout(250);
      state = await joinState(page, groupUrl, data, true);
    }
    if (state.result) return state.result;
    if (!state.button) return manual('Không có nút tham gia khả dụng; nhóm có thể bị hạn chế hoặc giao diện chưa tải đầy đủ.', { ...data, membershipStatus: 'UNKNOWN' });
    await session.beforeExternalAction?.();
    // Recheck after the durable marker: membership/login can change while it is saved.
    state = await joinState(page, groupUrl, data, true);
    if (state.result) return state.result;
    if (!state.button) return manual('Nút tham gia đã thay đổi; không gửi yêu cầu.', { ...data, membershipStatus: 'UNKNOWN' });
    try { await state.button.click({ timeout: 15_000 }); }
    catch {
      const interrupted = await guard(page);
      if (interrupted) return interrupted;
      return manual('Thao tác tham gia bị gián đoạn, chưa rõ đã gửi hay chưa. Kiểm tra thủ công, không tự gửi lại.', { ...data, membershipStatus: 'UNKNOWN' });
    }
    const confirmationUntil = Date.now() + (this.timing.joinConfirmationTimeoutMs ?? 15_000);
    do {
      state = await joinState(page, groupUrl, data, false);
      if (state.result) return state.result;
      await page.waitForTimeout(250);
    } while (Date.now() < confirmationUntil);
    return manual('Đã bấm tham gia nhưng chưa xác nhận được kết quả. Không tự gửi lại yêu cầu.', { ...data, membershipStatus: 'UNKNOWN' });
  }

  async post(session: PlatformSession, inputUrl: string, text: string): Promise<ActionResult> {
    const page = automationPage(session);
    const groupUrl = normalizeFacebookGroupUrl(inputUrl);
    const blocked = await openGroupsPage(page, groupUrl, this.timing.mainTimeoutMs);
    if (blocked) return blocked;
    if (!isGroupPage(page, groupUrl)) return manual('Facebook không mở đúng trang nhóm đích; không gửi bài', { groupUrl });
    const main = page.getByRole('main').first();
    if (!(await main.isVisible())) return manual('Không xác định được nội dung nhóm đích; đã dừng', { groupUrl });
    // Facebook collapses long posts in the feed, so full-text matching cannot
    // confirm the result of a successful long submission.
    const excerpt = normalizeText(text).slice(0, 160);
    const previousPosts = await page.getByRole('article').filter({ hasText: excerpt, visible: true }).count();
    const pendingBefore = await page.getByText(PENDING_POST).first().isVisible();
    const openComposer = groupButtons(page, COMPOSER).first();
    await openComposer.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 20_000 }).catch(() => undefined);
    const beforeComposer = await guard(page);
    if (beforeComposer) return beforeComposer;
    if (!(await openComposer.isVisible())) return manual('Nhóm không có nút soạn bài hoặc account chưa được phép đăng', { groupUrl });
    if (!(await openComposer.isEnabled())) return manual('Nút soạn bài đang bị vô hiệu hóa; chưa gửi bài.', { groupUrl });
    await openComposer.click({ timeout: 15_000 });
    // Facebook nests a header-only dialog inside the actual composer modal.
    // Select the outer dialog; the last dialog can contain no editor at all.
    const dialog = page.getByRole('dialog').filter({ visible: true }).first();
    await dialog.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 20_000 }).catch(() => undefined);
    if (!(await dialog.isVisible())) return manual('Không mở được khung soạn bài', { groupUrl });
    const textbox = dialog.locator('[role="textbox"][contenteditable="true"], [contenteditable="true"][data-lexical-editor="true"]').filter({ visible: true }).first();
    // The dialog shell is visible before its editor and publishing controls hydrate.
    await textbox.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 30_000 }).catch(() => undefined);
    if (!(await textbox.isVisible())) return manual('Không tìm thấy trường nội dung bài đăng', { groupUrl });
    await textbox.fill(text);
    if (normalizeText(await textbox.innerText()) !== normalizeText(text)) return manual('Nội dung trong khung soạn chưa khớp; chưa gửi bài', { groupUrl });
    const submit = dialog.getByRole('button', { name: /^(Post|Đăng|Submit|Gửi)$/i }).first();
    await submit.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 15_000 }).catch(() => undefined);
    const enabledUntil = Date.now() + (this.timing.controlTimeoutMs ?? 15_000);
    while (await submit.isVisible() && !(await submit.isEnabled()) && Date.now() < enabledUntil) await page.waitForTimeout(250);
    if (!(await submit.isVisible()) || !(await submit.isEnabled())) return manual('Nút đăng chưa sẵn sàng; kiểm tra yêu cầu của nhóm', { groupUrl });
    // Entering even a plain word can open Facebook's mention typeahead over
    // Post. Escape only that known suggestion UI, never click an option or
    // force-click through it. Trial clicks have no publishing side effect.
    const actionableUntil = Date.now() + (this.timing.controlTimeoutMs ?? 15_000);
    let actionable = false;
    do {
      const suggestions = page.getByRole('listbox', { name: MENTIONS }).filter({ visible: true }).first();
      if (await suggestions.isVisible()) {
        await textbox.press('Escape', { timeout: 2000 }).catch(() => undefined);
        await suggestions.waitFor({ state: 'hidden', timeout: 500 }).catch(() => undefined);
      }
      const interrupted = await guard(page);
      if (interrupted) return interrupted;
      if (!isGroupPage(page, groupUrl) || !(await dialog.isVisible()) || !(await textbox.isVisible())
        || normalizeText(await textbox.innerText()) !== normalizeText(text)) return manual('Khung soạn bài hoặc nội dung đã thay đổi khi xử lý gợi ý; chưa gửi bài.', { groupUrl });
      try {
        await submit.click({ trial: true, timeout: Math.max(1, Math.min(750, actionableUntil - Date.now())) });
        actionable = true;
      } catch { /* Wait for a transient overlay without attempting to publish. */ }
      if (actionable) break;
      await page.waitForTimeout(100);
    } while (Date.now() < actionableUntil);
    if (!actionable) return manual('Nút Đăng đang bị lớp giao diện che hoặc chưa thể bấm; chưa gửi bài. Mở browser để kiểm tra.', { groupUrl });
    const beforeSubmit = await guard(page);
    if (beforeSubmit) return beforeSubmit;
    if (!isGroupPage(page, groupUrl)) return manual('Facebook đã chuyển sang nhóm khác; không gửi bài.', { groupUrl });
    await session.beforeExternalAction?.();
    const afterMarker = await guard(page);
    if (afterMarker) return afterMarker;
    if (!isGroupPage(page, groupUrl) || !(await dialog.isVisible()) || !(await submit.isVisible()) || !(await submit.isEnabled())
      || normalizeText(await textbox.innerText()) !== normalizeText(text)) return manual('Trang nhóm hoặc khung soạn bài đã thay đổi; chưa gửi bài.', { groupUrl });
    // Typeahead responses can arrive AFTER a successful pointer trial while
    // the durable marker is saved. Activate the actual Post control using its
    // keyboard interaction, not coordinates that a late suggestion can cover.
    // Focus Post itself (never Enter in the editor/listbox, which selects a tag).
    const lateSuggestions = page.getByRole('listbox', { name: MENTIONS }).filter({ visible: true }).first();
    if (await lateSuggestions.isVisible()) {
      await textbox.press('Escape', { timeout: 2000 }).catch(() => undefined);
      await lateSuggestions.waitFor({ state: 'hidden', timeout: 500 }).catch(() => undefined);
      if (await lateSuggestions.isVisible() || !(await dialog.isVisible()) || !(await textbox.isVisible())) return manual('Gợi ý vừa xuất hiện chưa đóng được hoặc khung soạn đã thay đổi; chưa kích hoạt gửi.', { groupUrl });
    }
    await submit.focus();
    if (!(await submit.evaluate(element => document.activeElement === element)) || !(await submit.isEnabled())
      || !isGroupPage(page, groupUrl) || !(await dialog.isVisible()) || normalizeText(await textbox.innerText()) !== normalizeText(text)) return manual('Không focus được nút Đăng hoặc nội dung đã thay đổi; chưa kích hoạt gửi.', { groupUrl });
    const actorId = (await page.context().cookies('https://www.facebook.com/')).find(cookie => cookie.name === 'c_user')?.value ?? '';
    let creation: FacebookPostConfirmation | undefined;
    let listening = true;
    let creationObserved = false;
    const matchesCreation = (request: Request) => {
      const endpoint = new URL(request.url());
      return endpoint.protocol === 'https:' && ['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(endpoint.hostname)
        && (!endpoint.port || endpoint.port === '443') && /^\/api\/graphql\/?$/.test(endpoint.pathname) && request.method() === 'POST'
        && isTaskPostRequest(request.postData() ?? '', groupUrl, text, actorId);
    };
    const observeRequest = (request: Request) => { if (matchesCreation(request)) creationObserved = true; };
    const observeCreation = (response: Response) => {
      const request = response.request();
      if (!matchesCreation(request)) return;
      creationObserved = true;
      if (response.status() >= 400) { creation = { status: 'REJECTED', reason: `Facebook trả lỗi HTTP ${response.status()} khi tạo bài; kiểm tra trước khi thử lại.` }; return; }
      void response.text().then(body => {
        if (listening) creation = readPostConfirmation(body, groupUrl, text);
      }).catch(() => undefined);
    };
    page.on('request', observeRequest);
    page.on('response', observeCreation);
    try {
      await submit.press('Enter', { timeout: 15_000 });
      const confirmationUntil = Date.now() + (this.timing.postConfirmationTimeoutMs ?? 20_000);
      do {
        const interrupted = await guard(page);
        if (interrupted) return interrupted;
        if (!isGroupPage(page, groupUrl)) return manual('Đã gửi thao tác nhưng Facebook chuyển sang trang khác. Kiểm tra nhóm đích trước khi thử lại.', { groupUrl, publicationStatus: 'UNKNOWN' });
        if (creation?.status === 'REJECTED') return manual(creation.reason ?? 'Facebook không xác nhận tạo bài.', { groupUrl, publicationStatus: 'UNKNOWN', postUrl: creation.postUrl });
        if (creation?.status === 'PUBLISHED' || creation?.status === 'PENDING_APPROVAL') return {
          ok: true, externalReference: creation.postUrl,
          data: { groupUrl, publicationStatus: creation.status, postUrl: creation.postUrl, confirmationSource: 'CREATION_RESPONSE' },
        };
        const pendingNotice = page.getByText(PENDING_POST).first();
        if (!pendingBefore && await pendingNotice.isVisible()) return { ok: true, data: { groupUrl, publicationStatus: 'PENDING_APPROVAL' } };
        const posted = page.getByRole('article').filter({ hasText: excerpt, visible: true });
        if (!creationObserved && !(await dialog.isVisible()) && await posted.count() > previousPosts) {
          const permalink = posted.last().locator('a[href*="/posts/"],a[href*="permalink"]').first();
          const href = await permalink.count() ? await permalink.getAttribute('href') : null;
          const link = href ? new URL(href, groupUrl).href : null;
          return { ok: true, externalReference: link ?? undefined, data: { groupUrl, publicationStatus: 'PUBLISHED', postUrl: link } };
        }
        await page.waitForTimeout(500);
      } while (Date.now() < confirmationUntil);
      return manual('Đã gửi thao tác đăng nhưng chưa xác nhận được kết quả. Kiểm tra nhóm trước khi tạo tác vụ mới để tránh đăng trùng.', { groupUrl, publicationStatus: 'UNKNOWN' });
    } finally {
      listening = false;
      page.off('request', observeRequest);
      page.off('response', observeCreation);
    }
  }
}

function automationPage(session: PlatformSession): Page {
  if (!('getByRole' in session.page)) throw new Error('Facebook group actions require a Playwright page');
  return session.page as Page;
}

function isGroupPage(page: Page, expected?: string): boolean {
  try { const url = normalizeFacebookGroupUrl(page.url()); return !expected || url === expected; } catch { return false; }
}

function groupButtons(page: Page, name: RegExp): Locator {
  return page.getByRole('main').first().getByRole('button', { name }).and(page.locator(GROUP_CONTENT)).filter({ visible: true });
}

async function hasGroupManagementTools(page: Page, expected: string): Promise<boolean> {
  // Admins/moderators can have a management sidebar instead of a Joined button.
  // Require two distinct tools in that sidebar for this exact group, not an
  // Admin badge in a post, a notification, or links for another group.
  const tools = page.getByRole('navigation', { name: ADMIN_TOOLS }).filter({ visible: true });
  const links = await tools.locator('a[href]').and(page.locator(':not(article *, [role="article"] *)')).filter({ visible: true })
    .evaluateAll(anchors => anchors.map(anchor => (anchor as HTMLAnchorElement).href));
  const groupPath = new URL(expected).pathname;
  const routes = new Set<string>();
  for (const href of links) {
    try {
      const target = new URL(href);
      if (target.protocol !== 'https:' || !['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(target.hostname)
        || target.username || target.password || !target.pathname.startsWith(groupPath)) continue;
      const route = target.pathname.slice(groupPath.length).replace(/\/$/, '');
      if (ADMIN_ROUTES.has(route)) routes.add(route);
    } catch { /* Ignore malformed or unrelated links. */ }
  }
  return routes.size >= 2;
}

async function joinState(page: Page, expected: string, data: Record<string, unknown>, beforeClick: boolean): Promise<{ result?: ActionResult; button?: Locator }> {
  const blocked = await guard(page);
  if (blocked) return { result: blocked };
  if (!isGroupPage(page, expected)) return { result: manual('Facebook chuyển sang trang khác; không gửi yêu cầu.', { ...data, membershipStatus: 'UNKNOWN' }) };
  await dismissWelcome(page);
  const main = page.getByRole('main').first();
  const dialog = page.getByRole('dialog').filter({ visible: true }).first();
  const questions = main.getByText(QUESTION_PROMPT).and(page.locator(GROUP_CONTENT)).filter({ visible: true }).first();
  if (await dialog.isVisible() || await questions.isVisible()) return { result: manual(
    await questions.isVisible() || await dialog.filter({ hasText: QUESTIONS }).isVisible()
      ? 'Nhóm yêu cầu trả lời câu hỏi hoặc xác nhận quy tắc. Hãy thao tác thủ công.' : 'Có hộp thoại cần thao tác thủ công; chưa xác nhận tham gia.',
    { ...data, membershipStatus: 'REQUIRES_ACTION' }) };
  const joined = await groupButtons(page, JOINED).count() > 0;
  const limited = await main.getByText(/You have limited membership|Bạn (?:có|đang có) tư cách thành viên hạn chế/i).and(page.locator(GROUP_CONTENT)).filter({ visible: true }).first().isVisible();
  const pending = await groupButtons(page, PENDING).count() > 0
    || await main.getByText(PENDING_NOTICE).and(page.locator(GROUP_CONTENT)).filter({ visible: true }).first().isVisible();
  const management = await hasGroupManagementTools(page, expected);
  if ((joined || limited || management) && pending) return { result: manual('Trạng thái tham gia và chờ duyệt đang mâu thuẫn. Kiểm tra thủ công, không gửi thêm yêu cầu.', { ...data, membershipStatus: 'UNKNOWN' }) };
  if (joined) return { result: { ok: true, data: { ...data, membershipStatus: 'JOINED', ...(beforeClick ? { alreadyJoined: true } : {}) } } };
  if (management) return { result: { ok: true, data: { ...data, membershipStatus: 'JOINED', groupRole: 'ADMIN_OR_MODERATOR', ...(beforeClick ? { alreadyJoined: true } : {}) } } };
  if (limited) return { result: { ok: true, data: { ...data, membershipStatus: 'JOINED', limitedMembership: true, ...(beforeClick ? { alreadyJoined: true } : {}) } } };
  if (pending) return { result: { ok: true, data: { ...data, membershipStatus: 'PENDING', ...(beforeClick ? { requestAlreadyPending: true } : {}) } } };
  if (await main.getByText(UNAVAILABLE).and(page.locator(GROUP_CONTENT)).filter({ visible: true }).first().isVisible()) {
    return { result: manual('Nhóm không khả dụng, đã tạm dừng/lưu trữ hoặc không cho phép tham gia.', { ...data, membershipStatus: 'UNKNOWN', groupUnavailable: true }) };
  }
  const buttons = groupButtons(page, JOIN);
  if (beforeClick && await buttons.count() > 1) return { result: manual('Có nhiều nút tham gia khác nhau; không xác định được thao tác đúng.', { ...data, membershipStatus: 'UNKNOWN' }) };
  if (beforeClick && await buttons.count() === 1 && await buttons.first().isEnabled()) return { button: buttons.first() };
  return {};
}

async function openGroupsPage(page: Page, url: string, mainTimeoutMs = 30_000): Promise<ActionResult | undefined> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  const blocked = await guard(page);
  if (blocked) return blocked;
  // A welcome overlay hides the group's main from the accessibility tree.
  // Only dismiss the welcome UI; never accept rules, questions or challenges.
  await dismissWelcome(page);
  // DOMContentLoaded is not proof that Facebook's dynamically-rendered controls
  // are ready. In particular a slow proxy may leave an empty shell for a while.
  const main = page.getByRole('main').first();
  await main.waitFor({ state: 'visible', timeout: mainTimeoutMs }).catch(() => undefined);
  // Authentication/challenge state can change while the group is loading.
  return guard(page);
}

async function dismissWelcome(page: Page): Promise<void> {
  const welcome = page.getByRole('dialog').filter({ hasText: /welcome to|chào mừng.*(?:nhóm|đến)|group by/i }).filter({ visible: true }).first();
  if (await welcome.isVisible()) {
    if (await welcome.filter({ hasText: QUESTIONS }).isVisible()) return;
    const close = welcome.getByRole('button', { name: /^(Close|Đóng)$/i }).first();
    if (await close.isVisible() && await close.isEnabled()) await close.click({ timeout: 5000 });
  }
}

async function guard(page: Page): Promise<ActionResult | undefined> {
  const url = new URL(page.url());
  if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname)) return manual('Facebook điều hướng ra ngoài nền tảng; đã dừng');
  if (/checkpoint|challenge|captcha/.test(url.pathname) || await page.locator('iframe[src*="captcha"],input[name="captcha_response"]').count() > 0) {
    return manual('Facebook yêu cầu xác minh/CAPTCHA. Hãy thao tác thủ công.', { accountChallenged: true });
  }
  const cookies = await page.context().cookies('https://www.facebook.com/');
  if (url.pathname.includes('/login') || !cookies.some((cookie) => cookie.name === 'c_user' && cookie.value)
    || await page.locator('input[name="email"]').filter({ visible: true }).count() > 0 && await page.locator('input[name="pass"]').filter({ visible: true }).count() > 0) throw new LoginRequiredError();
  if (await page.getByText(/You.re temporarily blocked|Bạn tạm thời bị chặn|We limit how often|Chúng tôi hạn chế tần suất/i).first().isVisible()) {
    return manual('Facebook giới hạn account. Đã dừng, không thử vượt giới hạn.', { accountChallenged: true });
  }
  return undefined;
}

function manual(reason: string, data: Record<string, unknown> = {}): ActionResult {
  return { ok: false, data: { ...data, requiresAction: true, reason } };
}
