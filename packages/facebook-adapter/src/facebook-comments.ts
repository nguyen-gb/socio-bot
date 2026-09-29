import { normalizeFacebookPostUrl, type ActionResult } from '@socio/contracts';
import type { PlatformSession } from '@socio/platform-core';
import type { Locator, Page } from 'playwright';

const ALL_COMMENTS = /^(?:All comments|Tất cả bình luận|Tất cả các bình luận)(?:\s*(?:\(.+\)|\d+))?$/i;
const COMMENT_SORT = /^(?:Most relevant|Relevant|Phù hợp nhất|Bình luận phù hợp nhất|Mới nhất)(?:\s*(?:\(.+\)|\d+))?$/i;
const LOAD_MORE = /^(?:View more comments?|View previous comments?|See more comments?|Xem thêm(?:\s+\d+)? bình luận|Xem các bình luận trước|Xem thêm)(?:\s*(?:\(.+\)|\d+))?$/i;
const REPLY = /^(Reply|Trả lời)$/i;
const REPLY_SEND = /^(Reply|Trả lời|Comment|Bình luận|Send|Gửi)$/i;
const PHONE = /(?:\+?84|0084|0)(?:[\s().-]*\d){8,11}/g;

export class FacebookCommentsAutomation {
  constructor(private readonly timing: { mainTimeoutMs?: number; controlTimeoutMs?: number } = {}) {}

  async scanPostComments(session: PlatformSession, inputPostUrl: string): Promise<ActionResult> {
    const page = session.page as Page;
    const postUrl = normalizeFacebookPostUrl(inputPostUrl);
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: this.timing.mainTimeoutMs ?? 45_000 });
    } catch {
      return manual('Không tải được bài viết Facebook; chưa quét bình luận.', { postUrl });
    }
    const guardResult = await guard(page);
    if (guardResult) return guardResult;
    const main = page.locator('[role="main"], main').first();
    await main.waitFor({ state: 'visible', timeout: this.timing.mainTimeoutMs ?? 45_000 }).catch(() => undefined);
    if (!(await main.isVisible().catch(() => false))) {
      return manual('Không xác định được nội dung bài viết; chưa quét bình luận.', {
        postUrl,
        actualUrl: page.url(),
        title: await page.title().catch(() => ''),
        mainCount: await page.locator('[role="main"], main').count().catch(() => 0),
      });
    }
    await selectAllComments(page, this.timing.controlTimeoutMs ?? 30_000);
    const comments = await loadComments(page, main, this.timing.controlTimeoutMs ?? 30_000);
    const phoneNumbers = extractFacebookPhoneNumbers(comments.join('\n'));
    return {
      ok: true,
      data: {
        postUrl,
        commentsScanned: comments.length,
        phoneNumbers,
        phoneCount: phoneNumbers.length,
      },
    };
  }

  async replyPostComments(session: PlatformSession, inputPostUrl: string, text: string, maxReplies: number): Promise<ActionResult> {
    const page = session.page as Page;
    const postUrl = normalizeFacebookPostUrl(inputPostUrl);
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: this.timing.mainTimeoutMs ?? 45_000 });
    } catch {
      return manual('Không tải được bài viết Facebook; chưa trả lời bình luận.', { postUrl, repliesRequested: maxReplies, repliesSent: 0 });
    }
    const guardResult = await guard(page);
    if (guardResult) return guardResult;
    const main = page.locator('[role="main"], main').first();
    await main.waitFor({ state: 'visible', timeout: this.timing.mainTimeoutMs ?? 45_000 }).catch(() => undefined);
    if (!(await main.isVisible().catch(() => false))) {
      return manual('Không xác định được nội dung bài viết; chưa trả lời bình luận.', {
        postUrl,
        repliesRequested: maxReplies,
        repliesSent: 0,
        actualUrl: page.url(),
        title: await page.title().catch(() => ''),
        mainCount: await page.locator('[role="main"], main').count().catch(() => 0),
      });
    }
    await selectAllComments(page, this.timing.controlTimeoutMs ?? 30_000);
    // A permalink opens the post in a modal on desktop. Its comments are
    // rendered outside the page's semantic <main>, so use the visible body as
    // the fallback scope for reply actions (the modal is the only visible
    // surface with Reply/Trả lời controls at this point).
    const replyScope = page.locator('body');
    const commentsAvailable = await loadReplyControls(page, replyScope, maxReplies, this.timing.controlTimeoutMs ?? 30_000);
    if (!commentsAvailable) return manual('Không tìm thấy bình luận có thể trả lời trong bài viết.', { postUrl, repliesRequested: maxReplies, repliesSent: 0, commentsAvailable });

    let repliesSent = 0;
    while (repliesSent < maxReplies) {
      const control = await nextReplyControl(replyScope);
      if (!control) break;
      try { await control.click({ timeout: 5_000 }); }
      catch { return manual('Không mở được ô trả lời bình luận; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable }); }
      const textbox = page.locator('[role="textbox"][contenteditable="true"], [contenteditable="true"][data-lexical-editor="true"], textarea').filter({ visible: true }).last();
      await textbox.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 15_000 }).catch(() => undefined);
      if (!(await textbox.isVisible().catch(() => false))) return manual('Không tìm thấy ô nhập trả lời bình luận; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
      const beforeMatches = await visibleExactTextCount(replyScope, text);
      await textbox.fill(text);
      const typed = await textbox.inputValue().catch(async () => textbox.innerText().catch(() => ''));
      if (typed.trim() !== text.trim()) return manual('Nội dung trả lời chưa khớp; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
      // Facebook renders the submit control as either a semantic button or a
      // plain text action depending on the locale/Comet surface. Keep both
      // forms so a localized comment dialog is handled consistently.
      const send = page.getByRole('button', { name: REPLY_SEND }).or(page.getByText(REPLY_SEND)).filter({ visible: true }).last();
      await send.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 15_000 }).catch(() => undefined);
      if (!(await send.isVisible().catch(() => false)) || !(await send.isEnabled().catch(() => false))) return manual('Nút gửi trả lời chưa sẵn sàng; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
      try { await session.beforeExternalAction?.(); } catch (error) { throw error; }
      await send.click({ timeout: 5_000 }).catch(() => undefined);
      const confirmed = await waitForNewExactText(replyScope, text, beforeMatches, this.timing.controlTimeoutMs ?? 15_000);
      if (!confirmed) return manual('Đã gửi thao tác trả lời nhưng chưa xác nhận được kết quả; không tự gửi lại.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable, replyStatus: 'UNKNOWN' });
      repliesSent += 1;
      await control.evaluate(element => element.setAttribute('data-socio-replied', 'true')).catch(() => undefined);
      await page.waitForTimeout(250);
    }
    if (repliesSent < maxReplies) return manual('Không còn đủ bình luận có thể trả lời để đạt số lượt yêu cầu.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
    return { ok: true, data: { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable, replyStatus: 'SENT' } };
  }
}

export function extractFacebookPhoneNumbers(text: string): string[] {
  const numbers = new Set<string>();
  for (const match of text.matchAll(PHONE)) {
    const raw = match[0]!.replace(/[^\d+]/g, '');
    const digits = raw.replace(/^\+/, '');
    let local: string | undefined;
    if (digits.startsWith('0084')) local = `0${digits.slice(4)}`;
    else if (digits.startsWith('84')) local = `0${digits.slice(2)}`;
    else if (digits.startsWith('0')) local = digits;
    if (local && /^0(?:2|3|5|7|8|9)\d{8,9}$/.test(local)) numbers.add(local);
  }
  return [...numbers];
}

async function selectAllComments(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sort = page.getByRole('button', { name: COMMENT_SORT }).or(page.getByRole('link', { name: COMMENT_SORT })).filter({ visible: true }).last();
    if (await sort.isVisible().catch(() => false)) {
      await sort.click({ timeout: 3_000 }).catch(() => undefined);
      const all = page.getByRole('menuitem', { name: ALL_COMMENTS }).or(page.getByText(ALL_COMMENTS)).filter({ visible: true }).last();
      if (await all.isVisible().catch(() => false)) await all.click({ timeout: 3_000 }).catch(() => undefined);
      return;
    }
    const all = page.getByRole('button', { name: ALL_COMMENTS }).or(page.getByText(ALL_COMMENTS)).filter({ visible: true }).last();
    if (await all.isVisible().catch(() => false)) return;
    await page.waitForTimeout(250);
  }
}

async function loadComments(page: Page, main: Locator, timeoutMs: number): Promise<string[]> {
  const seen = new Set<string>();
  const deadline = Date.now() + Math.max(timeoutMs, 30_000);
  let stagnant = 0;
  while (Date.now() < deadline && stagnant < 8) {
    const before = seen.size;
    for (const text of await main.locator('[data-ad-preview="message"]').allTextContents()) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized) seen.add(normalized);
    }
    const more = main.getByRole('button', { name: LOAD_MORE }).or(main.getByRole('link', { name: LOAD_MORE })).filter({ visible: true }).last();
    if (await more.isVisible().catch(() => false)) await more.click({ timeout: 3_000 }).catch(() => undefined);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(350);
    stagnant = seen.size === before ? stagnant + 1 : 0;
  }
  return [...seen];
}

function replyControls(main: Locator): Locator {
  // On the current Facebook comments surface “Reply/Trả lời” is commonly a
  // visible text action without a button/link role. getByText also matches the
  // semantic variants and clicking the text bubbles to Facebook's handler.
  return main.getByText(REPLY, { exact: true }).filter({ visible: true });
}

async function nextReplyControl(main: Locator): Promise<Locator | undefined> {
  const controls = replyControls(main);
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (await control.getAttribute('data-socio-replied').catch(() => null) !== 'true') return control;
  }
  return undefined;
}

async function loadReplyControls(page: Page, main: Locator, target: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + Math.max(timeoutMs, 30_000);
  let stagnant = 0;
  let previous = 0;
  while (Date.now() < deadline && stagnant < 8) {
    const count = await replyControls(main).count();
    if (count >= target) return count;
    const more = main.getByRole('button', { name: LOAD_MORE }).or(main.getByRole('link', { name: LOAD_MORE })).filter({ visible: true }).last();
    if (await more.isVisible().catch(() => false)) await more.click({ timeout: 3_000 }).catch(() => undefined);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(350);
    stagnant = count === previous ? stagnant + 1 : 0;
    previous = count;
  }
  return await replyControls(main).count();
}

async function visibleExactTextCount(scope: Locator, text: string): Promise<number> {
  return scope.getByText(text, { exact: true }).filter({ visible: true }).count().catch(() => 0);
}

async function waitForNewExactText(scope: Locator, text: string, before: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await visibleExactTextCount(scope, text) > before) return true;
    await scope.page().waitForTimeout(250);
  }
  return false;
}

async function guard(page: Page): Promise<ActionResult | undefined> {
  const url = page.url();
  if (/\/(?:login|checkpoint|challenge)\b/i.test(url)) return manual('Facebook yêu cầu đăng nhập hoặc xác minh; chưa quét bình luận.', { accountChallenged: !/\/login\b/i.test(url) });
  const cookies = await page.context().cookies('https://www.facebook.com/').catch(() => []);
  if (!cookies.some(cookie => cookie.name === 'c_user' && cookie.value)) return manual('Facebook yêu cầu đăng nhập; chưa quét bình luận.', { accountChallenged: false });
  const loginForm = page.locator('input[name="email"], input[name="pass"]').filter({ visible: true });
  if (await loginForm.count().catch(() => 0)) return manual('Facebook yêu cầu đăng nhập; chưa quét bình luận.', { accountChallenged: false });
  const blocked = page.getByText(/captcha|security check|xác minh|kiểm tra bảo mật/i).filter({ visible: true }).first();
  if (await blocked.isVisible().catch(() => false)) return manual('Facebook yêu cầu CAPTCHA/xác minh; chưa quét bình luận.', { accountChallenged: true });
  return undefined;
}

function manual(reason: string, data: Record<string, unknown> = {}): ActionResult {
  return { ok: false, data: { ...data, requiresAction: true, reason } };
}
