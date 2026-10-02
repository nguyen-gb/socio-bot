import { normalizeFacebookGroupUrl, normalizeFacebookPostUrl, type ActionResult } from '@socio/contracts';
import type { PlatformSession } from '@socio/platform-core';
import type { Locator, Page } from 'playwright';
import { attachFacebookImages } from './facebook-images';

const ALL_COMMENTS = /^(?:All comments|Tất cả bình luận|Tất cả các bình luận)(?:\s*(?:\(.+\)|\d+))?$/i;
const COMMENT_SORT = /^(?:Most relevant|Relevant|Phù hợp nhất|Bình luận phù hợp nhất|Mới nhất)(?:\s*(?:\(.+\)|\d+))?$/i;
const LOAD_MORE = /^(?:View more comments?|View previous comments?|See more comments?|Xem thêm(?:\s+\d+)? bình luận|Xem các bình luận trước|Xem thêm)(?:\s*(?:\(.+\)|\d+))?$/i;
const REPLY = /^(Reply|Trả lời)$/i;
const REPLY_SEND = /^(Comment|Bình luận|Post comment|Đăng bình luận|Send|Gửi)$/i;
const PHONE = /(?:\+?84|0084|0)(?:[\s().-]*\d){8,11}/g;

export interface FacebookGroupPostCommentFilters {
  daysRecent: number;
  minReactions: number;
  maxReactions?: number;
  minComments: number;
  maxComments?: number;
  maxPosts: number;
}

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
    // A Facebook permalink commonly renders the post in a visible dialog,
    // while the page-level <main> remains a background shell. Read comments
    // from the same post surface that is used by reply campaigns so scanning
    // never returns an empty result from the hidden shell.
    const commentSurface = await resolveReplyScope(page, postUrl);
    if (!commentSurface) return manual('Không xác định được khung bình luận của bài viết; chưa quét.', {
      postUrl,
      actualUrl: page.url(),
      commentsScanned: 0,
      phoneNumbers: [],
      phoneCount: 0,
    });
    const comments = await loadComments(page, commentSurface, this.timing.controlTimeoutMs ?? 30_000);
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

  /** Find recent group-feed posts by the frozen filters and leave one top-level
   * comment on every matching post.  Each post is opened separately so the
   * composer and confirmation stay scoped to the requested post. */
  async commentGroupPosts(session: PlatformSession, inputGroupUrl: string, text: string, mediaAssetIds: string[] = [], filters: FacebookGroupPostCommentFilters): Promise<ActionResult> {
    const page = session.page as Page;
    const groupUrl = normalizeFacebookGroupUrl(inputGroupUrl);
    try { await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: this.timing.mainTimeoutMs ?? 45_000 }); }
    catch { return manual('Không tải được nhóm Facebook; chưa bình luận bài viết.', { groupUrl, postsFound: 0, postsCommented: 0 }); }
    const blocked = await guard(page);
    if (blocked) return blocked;
    const main = page.locator('[role="main"], main').filter({ visible: true }).first();
    await main.waitFor({ state: 'visible', timeout: this.timing.mainTimeoutMs ?? 45_000 }).catch(() => undefined);
    if (!(await main.isVisible().catch(() => false))) return manual('Không xác định được nội dung nhóm Facebook; chưa bình luận bài viết.', { groupUrl, postsFound: 0, postsCommented: 0 });
    const posts = await discoverGroupPosts(page, groupUrl, filters, this.timing.controlTimeoutMs ?? 30_000);
    if (!posts.length) return manual('Không tìm thấy bài viết phù hợp bộ lọc trong nhóm; chưa bình luận.', { groupUrl, postsFound: 0, postsCommented: 0, filters });
    let postsCommented = 0;
    let sideEffectStarted = false;
    const results: Array<Record<string, unknown>> = [];
    for (const post of posts) {
      const result = await this.commentSinglePost(session, post.postUrl, text, mediaAssetIds);
      const row = { postUrl: post.postUrl, reactions: post.reactions, comments: post.comments, ...(post.createdAt ? { createdAt: post.createdAt.toISOString() } : {}), ...(result.data ?? {}) };
      results.push(row);
      if (result.data?.sideEffectStarted === true) sideEffectStarted = true;
      if (result.ok) postsCommented += 1;
      else if (sideEffectStarted) break;
      await page.waitForTimeout(750);
    }
    const data = { groupUrl, postsFound: posts.length, postsCommented, filters, posts: results, ...(sideEffectStarted ? { sideEffectStarted: true } : {}) };
    if (postsCommented === posts.length) return { ok: true, data };
    return manual(postsCommented ? 'Đã bình luận một phần; dừng để kiểm tra các bài còn lại, không tự gửi lại.' : 'Không xác nhận được bình luận vào bài viết; chưa gửi thêm.', data);
  }

  private async commentSinglePost(session: PlatformSession, inputPostUrl: string, text: string, mediaAssetIds: string[]): Promise<ActionResult> {
    const page = session.page as Page;
    const postUrl = normalizeFacebookPostUrl(inputPostUrl);
    try { await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: this.timing.mainTimeoutMs ?? 45_000 }); }
    catch { return manual('Không tải được bài viết Facebook; chưa bình luận.', { postUrl }); }
    const blocked = await guard(page);
    if (blocked) return blocked;
    await selectAllComments(page, this.timing.controlTimeoutMs ?? 30_000);
    let scope = await resolveReplyScope(page, postUrl);
    if (!scope) {
      // A post with no existing comments has no comment node for
      // resolveReplyScope to anchor on. Fall back to the visible post
      // dialog/main surface so the top-level composer can still be used.
      const dialogs = page.locator('[role="dialog"]');
      const lastDialog = dialogs.last();
      if (await lastDialog.isVisible().catch(() => false)) {
        scope = lastDialog;
      } else {
        const main = page.locator('[role="main"], main').filter({ visible: true }).first();
        if (await main.isVisible().catch(() => false) && replySurfaceHasTargetPost(postUrl, page.url())) scope = main;
      }
    }
    if (!scope) return manual('Không mở đúng bài viết Facebook; chưa bình luận.', { postUrl });
    const textbox = await topLevelCommentTextbox(scope, page);
    if (!textbox) return manual('Không tìm thấy ô bình luận bài viết; chưa gửi.', { postUrl });
    const beforeMatches = await visiblePostedReplyCount(scope, text);
    const beforeImageSources = mediaAssetIds.length ? await visibleImageSources(scope) : [];
    await textbox.fill(text);
    if ((await editorText(textbox)).trim() !== text.trim()) return manual('Nội dung bình luận chưa khớp; chưa gửi.', { postUrl });
    const formComposer = textbox.locator('xpath=ancestor::form[1]');
    const editorSurface = textbox.locator('xpath=ancestor::*[.//*[@role="textbox"] and .//*[@role="button"]][1]');
    const composer = await formComposer.count() ? formComposer : editorSurface;
    const send = composer.getByRole('button', { name: REPLY_SEND }).filter({ visible: true }).last();
    if (mediaAssetIds.length) {
      if (!session.resolveMediaAssets) throw new Error('Worker chưa hỗ trợ tải ảnh; chưa gửi bình luận.');
      const images = await session.resolveMediaAssets(mediaAssetIds);
      if (images.length !== mediaAssetIds.length) throw new Error('Không tải đủ ảnh của bình luận; chưa gửi.');
      await attachFacebookImages(page, composer, images, this.timing.controlTimeoutMs ?? 60_000, send, scope, scope);
    }
    await send.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 15_000 }).catch(() => undefined);
    if (!(await send.isVisible().catch(() => false)) || !(await send.isEnabled().catch(() => false))) return manual('Nút gửi bình luận chưa sẵn sàng; chưa gửi.', { postUrl });
    await session.beforeExternalAction?.();
    await textbox.press('Enter').catch(() => undefined);
    let confirmed = await waitForPostedReply(scope, textbox, text, beforeMatches, this.timing.controlTimeoutMs ?? 15_000, beforeImageSources, mediaAssetIds.length > 0);
    if (!confirmed && (await editorText(textbox)).includes(text.trim())) {
      await send.click({ timeout: 5_000 }).catch(async () => { await send.click({ force: true, timeout: 3_000 }).catch(() => undefined); });
      confirmed = await waitForPostedReply(scope, textbox, text, beforeMatches, this.timing.controlTimeoutMs ?? 15_000, beforeImageSources, mediaAssetIds.length > 0);
    }
    if (!confirmed) return manual('Đã gửi thao tác nhưng chưa xác nhận được bình luận; không tự gửi lại.', { postUrl, replyStatus: 'UNKNOWN', sideEffectStarted: true });
    return { ok: true, data: { postUrl, commentStatus: 'SENT', sideEffectStarted: true } };
  }

  async replyPostComments(session: PlatformSession, inputPostUrl: string, text: string, maxReplies: number, mediaAssetIds: string[] = []): Promise<ActionResult> {
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
    // A permalink opens the post in a modal on desktop. Never use the whole
    // body here: a restored Messenger dock also contains Reply-like text and
    // a contenteditable editor, which would make us type/send in Messenger.
    // Resolve the visible post surface first and fail safely when Facebook has
    // redirected away from the requested post.
    const replyScope = await resolveReplyScope(page, postUrl);
    if (!replyScope) return manual('Không mở đúng bài viết Facebook; chưa trả lời bình luận.', {
      postUrl,
      actualUrl: page.url(),
      repliesRequested: maxReplies,
      repliesSent: 0,
    });
    const actorHints = [session.accountExternalId, session.accountUsername].filter((value): value is string => Boolean(value?.trim()));
    const commentsAvailable = await loadReplyControls(page, replyScope, maxReplies, this.timing.controlTimeoutMs ?? 30_000, actorHints);
    if (!commentsAvailable) return manual('Không tìm thấy bình luận có thể trả lời trong bài viết.', { postUrl, repliesRequested: maxReplies, repliesSent: 0, commentsAvailable });

    let repliesSent = 0;
    while (repliesSent < maxReplies) {
      const control = await nextReplyControl(replyScope, actorHints);
      if (!control) break;
      // Facebook frequently renders the visible "Reply/Trả lời" label inside
      // a button whose hit target is partially covered by a sticky modal or a
      // docked Messenger panel.  A regular Playwright click then times out
      // even though the action is still valid.  Resolve the nearest semantic
      // action and fall back to a forced/DOM click before reporting a manual
      // action; this keeps the click scoped to the selected comment.
      const replyTarget = control.locator('xpath=ancestor-or-self::*[@role="button" or self::button or self::a][1]').first();
      const target = await replyTarget.count().catch(() => 0) > 0 ? replyTarget : control;
      let opened = false;
      try {
        await target.click({ timeout: 5_000 });
        opened = true;
      } catch {
        try {
          await target.click({ force: true, timeout: 3_000 });
          opened = true;
        } catch {
          opened = await target.evaluate(element => {
            (element as HTMLElement).click();
            return true;
          }).catch(() => false);
        }
      }
      if (!opened) return manual('Không mở được ô trả lời bình luận; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
      await page.waitForTimeout(300);
      // Facebook can keep a post-level composer (or another comment editor)
      // mounted elsewhere in the page. Scope the textbox and send button to
      // the exact comment whose Reply control was clicked, otherwise a global
      // `.last()` lookup may fill the wrong composer and never post the reply.
      const comment = replyCommentScope(control);
      const scopedTextbox = replyTextboxes(comment).last();
      await scopedTextbox.waitFor({ state: 'visible', timeout: Math.min(this.timing.controlTimeoutMs ?? 15_000, 5_000) }).catch(() => undefined);
      // If Facebook portals the editor outside the comment wrapper, take the
      // nearest eligible textbox in document order after the clicked Reply
      // control. This is safer than a page-wide `.last()` lookup when a
      // docked Messenger composer is also open.
      const nearbyTextbox = replyTextboxesAfter(control).first();
      await nearbyTextbox.waitFor({ state: 'visible', timeout: Math.min(this.timing.controlTimeoutMs ?? 15_000, 5_000) }).catch(() => undefined);
      const textbox = await scopedTextbox.isVisible().catch(() => false)
        ? scopedTextbox
        : await nearbyTextbox.isVisible().catch(() => false)
          ? nearbyTextbox
          : replyTextboxes(replyScope).last();
      await textbox.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 15_000 }).catch(() => undefined);
      if (!(await textbox.isVisible().catch(() => false))) return manual('Không tìm thấy ô nhập trả lời bình luận; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
      const beforeMatches = await visiblePostedReplyCount(replyScope, text);
      const beforeImageSources = mediaAssetIds.length ? await visibleImageSources(replyScope) : [];
      const existingEditorText = await editorText(textbox);
      if (text.trim()) await appendReplyText(textbox, text);
      const typed = await editorText(textbox);
      // Reply editors may already contain Facebook's mention entity for the
      // author. Never clear that entity: validate that our text was appended
      // while allowing the existing mention (and its display text) to remain.
      if (!typed.includes(text.trim()) || (existingEditorText.trim() && !typed.includes(existingEditorText.trim()))) {
        return manual('Nội dung trả lời chưa khớp hoặc đã mất tag người được trả lời; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
      }
      // Keep a scoped submit button as a fallback.  Facebook's inline reply
      // composer accepts Enter, which is less susceptible to an obstructed
      // hit target than clicking the blue arrow.  We still resolve the button
      // up front so that it can be used if this particular composer disables
      // Enter (or treats it as a newline).
      const formComposer = textbox.locator('xpath=ancestor::form[1]');
      // Facebook's inline reply editor is not consistently wrapped in a
      // <form>. In that variant the photo control and file input live in
      // the nearest editor surface that contains both the textbox and the
      // action buttons. Keep the form for submit-button resolution, but use
      // the editor surface for media so we never fall back to a page-level
      // or Messenger input.
      const editorSurface = textbox.locator('xpath=ancestor::*[.//*[@role="textbox"] and .//*[@role="button"]][1]');
      const composer = await formComposer.count() ? formComposer : editorSurface;
      const explicitSubmit = composer.locator('#focused-state-composer-submit').getByRole('button').filter({ visible: true }).last();
      const scopedSend = composer.getByRole('button', { name: REPLY_SEND }).filter({ visible: true }).last();
      const formSend = composer.getByRole('button').filter({ visible: true }).last();
      const namedSend = page.getByRole('button', { name: REPLY_SEND }).filter({ visible: true }).last();
      const send = await explicitSubmit.isVisible().catch(() => false)
        ? explicitSubmit
        : await scopedSend.isVisible().catch(() => false)
          ? scopedSend
          : await formSend.isVisible().catch(() => false)
            ? formSend
            : namedSend;
      if (mediaAssetIds.length) {
        if (!session.resolveMediaAssets) throw new Error('Worker chưa hỗ trợ tải ảnh; chưa gửi rep bình luận.');
        const images = await session.resolveMediaAssets(mediaAssetIds);
        if (images.length !== mediaAssetIds.length) throw new Error('Không tải đủ ảnh của rep bình luận; chưa gửi.');
        // Facebook mounts the inline reply action row (including the photo
        // control/file input) in the editor's form, which can be a sibling of
        // the comment article. Scope the upload to this exact form rather than
        // the article so the camera button is found without ever touching the
        // docked Messenger composer.
        // Depending on the Facebook locale/version the action row is either a
        // child of the editor form or a sibling mounted in the comment article.
        // Use the union of both narrowly-scoped surfaces; this still excludes
        // the page-level Messenger dock and lets us observe either preview.
        // Keep the upload locator anchored to this exact reply form so a
        // page-level comment/Messenger file input cannot steal the image.
        // Facebook may render the thumbnail in the surrounding post dialog,
        // therefore observe that surface separately while retaining the
        // comment article as a narrowly-scoped fallback for locale variants.
        await attachFacebookImages(page, composer, images, this.timing.controlTimeoutMs ?? 60_000, send, replyScope, comment);
      }
      await send.waitFor({ state: 'visible', timeout: this.timing.controlTimeoutMs ?? 15_000 }).catch(() => undefined);
      if (!(await send.isVisible().catch(() => false)) || !(await send.isEnabled().catch(() => false))) return manual('Nút gửi trả lời chưa sẵn sàng; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
      try { await session.beforeExternalAction?.(); } catch (error) { throw error; }
      // Submit with Enter first.  If Facebook did not consume it, only fall
      // back to the scoped button while the text is still present in the
      // editor and no posted reply is visible.  This makes a retry safe: an
      // already-published reply is never sent twice.
      const confirmationTimeout = this.timing.controlTimeoutMs ?? 15_000;
      try { await textbox.press('Enter'); } catch { /* use the button fallback below */ }
      let confirmed = await waitForPostedReply(replyScope, textbox, text, beforeMatches, confirmationTimeout, beforeImageSources, mediaAssetIds.length > 0);
      if (!confirmed) {
        const stillTyped = (await editorText(textbox)).includes(text.trim());
        const postedNow = await visiblePostedReplyCount(replyScope, text);
        if (stillTyped && postedNow <= beforeMatches) {
          let clicked = false;
          try { await send.click({ timeout: 5_000 }); clicked = true; }
          catch {
            try { await send.click({ force: true, timeout: 3_000 }); clicked = true; }
            catch { clicked = await send.evaluate(element => { (element as HTMLElement).click(); return true; }).catch(() => false); }
          }
          if (!clicked) return manual('Không gửi được trả lời bằng Enter hoặc nút gửi; chưa gửi thêm.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
          confirmed = await waitForPostedReply(replyScope, textbox, text, beforeMatches, confirmationTimeout, beforeImageSources, mediaAssetIds.length > 0);
        }
      }
      if (!confirmed) return manual('Đã gửi thao tác trả lời nhưng chưa xác nhận được kết quả; không tự gửi lại.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable, replyStatus: 'UNKNOWN' });
      repliesSent += 1;
      await control.evaluate(element => element.setAttribute('data-socio-replied', 'true')).catch(() => undefined);
      await page.waitForTimeout(250);
    }
    if (repliesSent < maxReplies) return manual('Không còn đủ bình luận có thể trả lời để đạt số lượt yêu cầu.', { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable });
    return { ok: true, data: { postUrl, repliesRequested: maxReplies, repliesSent, commentsAvailable, replyStatus: 'SENT' } };
  }
}

async function editorText(textbox: Locator): Promise<string> {
  if (!(await textbox.isVisible({ timeout: 500 }).catch(() => false))) return '';
  return textbox.inputValue({ timeout: 500 }).catch(async () => textbox.innerText({ timeout: 500 }).catch(() => ''));
}

async function appendReplyText(textbox: Locator, text: string): Promise<void> {
  const contentEditable = await textbox.getAttribute('contenteditable').catch(() => null);
  if (contentEditable === 'true') {
    // Clicking Reply leaves the author mention selected in a contenteditable
    // editor. End collapses that selection after the mention, then we append
    // the reply without replacing the mention node.
    await textbox.click({ force: true }).catch(() => undefined);
    await textbox.press('End').catch(() => undefined);
    const existing = await editorText(textbox);
    if (existing.trim()) await textbox.press('Space').catch(() => undefined);
    await textbox.pressSequentially(text);
    return;
  }
  await textbox.fill(text);
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
    // Comet does not use one stable marker for every comment revision. Some
    // comments expose data-ad-preview/data-ad-comet-preview, while others are
    // only represented by a role=article or comment test id. Collect all
    // visible comment surfaces and deduplicate their normalized text; this
    // keeps phone extraction intact even when Facebook changes the inner
    // message wrapper or lazy-renders a reply.
    const messageTexts = await main.locator('[data-ad-preview="message"], [data-ad-comet-preview="message"]').filter({ visible: true }).allTextContents().catch(() => []);
    const articleTexts = await main.locator('[role="article"], [data-commentid], [data-testid="comment"], [data-testid*="comment"]').filter({ visible: true }).allTextContents().catch(() => []);
    for (const text of [...messageTexts, ...articleTexts]) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized) seen.add(normalized);
    }
    const more = main.getByRole('button', { name: LOAD_MORE }).or(main.getByRole('link', { name: LOAD_MORE })).filter({ visible: true }).last();
    if (await more.isVisible().catch(() => false)) await more.click({ timeout: 3_000 }).catch(() => undefined);
    await scrollCommentSurfaces(page);
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

function replyCommentScope(control: Locator): Locator {
  // The nearest ancestor containing the comment text is stable across the
  // role/button and plain-text Reply variants used by Facebook. Facebook has
  // used both data-ad-preview and data-ad-comet-preview for the message node;
  // accepting both prevents the fallback from ever touching a Messenger box.
  return control.locator('xpath=ancestor::*[@role="article" or @data-testid="comment" or contains(@data-testid, "comment") or contains(@aria-label, "comment") or .//*[@data-ad-preview="message" or @data-ad-comet-preview="message" or @data-testid="comment" or contains(@data-testid, "comment")]][1]');
}

function replyTextboxes(scope: Locator): Locator {
  // Do not let a restored Messenger conversation steal the text. Its editor
  // is often mounted at body level and can be the last visible textbox. Keep
  // candidates whose ancestors are not chat/log/message surfaces.
  return scope.locator(`xpath=.//*[(self::textarea or @role="textbox" or @contenteditable="true") and ${replyTextboxNotChatXPath}]`).filter({ visible: true });
}

function replyTextboxesAfter(control: Locator): Locator {
  return control.locator(`xpath=following::*[(self::textarea or @role="textbox" or @contenteditable="true") and ${replyTextboxNotChatXPath}]`).filter({ visible: true });
}

const replyTextboxNotChatXPath = 'not(contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "viết cho") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "write to") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "công cụ soạn cuộc trò chuyện") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "conversation composer")) and not(ancestor::*[@role="log" or (@role="dialog" and .//*[@role="log" or @data-scope="messages_table"]) or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "message") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "tin nhắn") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "messenger") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "chat") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "conversation") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "công cụ soạn cuộc trò chuyện") or contains(translate(@aria-label, "ABCDEFGHIJKLMNOPQRSTUVWXYZĐ", "abcdefghijklmnopqrstuvwxyzđ"), "conversation composer") or contains(translate(@data-testid, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "messenger") or contains(translate(@data-testid, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "chat") or contains(translate(@data-testid, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "message") or contains(translate(@data-pagelet, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "messenger") or contains(translate(@data-pagelet, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "chat")])';

function replySurfaceHasTargetPost(postUrl: string, actualUrl: string): boolean {
  const targetIds = postUrl.match(/\d+/g) ?? [];
  if (!targetIds.length) return false;
  return targetIds.some(id => actualUrl.includes(id));
}

async function resolveReplyScope(page: Page, postUrl: string): Promise<Locator | undefined> {
  const dialogs = page.locator('[role="dialog"]').filter({ visible: true });
  const dialogCount = await dialogs.count().catch(() => 0);
  for (let index = dialogCount - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    const label = ((await dialog.getAttribute('aria-label').catch(() => null)) ?? '').toLowerCase();
    if (/messenger|message|tin nhắn|chat|conversation|cuộc trò chuyện/.test(label)) continue;
    const comments = dialog.locator('[role="article"], [data-commentid], [data-testid="comment"], [data-ad-preview="message"], [data-ad-comet-preview="message"]');
    // The post modal may initially be scrolled to the bottom or render the
    // Reply labels lazily only after the comment list is nudged.  The presence
    // of comment nodes in a non-Messenger dialog is the stable identity of the
    // target surface; loadReplyControls() below is responsible for scrolling
    // until an eligible Reply control becomes visible.
    if (await comments.count().catch(() => 0) > 0) return dialog;
  }
  // A normal post page keeps its comments under main. Only accept it when the
  // URL still contains an id from the requested post; a home/feed redirect
  // must never be searched for reply controls.
  if (!replySurfaceHasTargetPost(postUrl, page.url())) return undefined;
  const main = page.locator('[role="main"], main').filter({ visible: true }).first();
  if (await main.isVisible().catch(() => false) && await main.locator('[role="article"], [data-commentid], [data-testid="comment"], [data-ad-preview="message"], [data-ad-comet-preview="message"]').count().catch(() => 0) > 0) return main;
  return undefined;
}

interface DiscoveredGroupPost {
  postUrl: string;
  createdAt?: Date;
  reactions: number;
  comments: number;
}

async function discoverGroupPosts(page: Page, groupUrl: string, filters: FacebookGroupPostCommentFilters, timeoutMs: number): Promise<DiscoveredGroupPost[]> {
  const deadline = Date.now() + Math.max(timeoutMs, 30_000);
  const posts = new Map<string, DiscoveredGroupPost>();
  let stagnant = 0;
  let previousCount = 0;
  while (Date.now() < deadline && stagnant < 6 && posts.size < Math.max(filters.maxPosts * 3, 20)) {
    const articles = page.locator('[role="article"]').filter({ visible: true });
    const rows = await articles.evaluateAll((elements) => elements.map(element => {
      const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]')).map(anchor => anchor.href);
      const postHref = links.find(href => /\/groups\/[^/]+\/(?:posts|permalink)\/\d+/i.test(href))
        ?? links.find(href => /\/[^/]+\/(?:posts|permalink)\/\d+/i.test(href));
      if (!postHref) return undefined;
      const timeNode = element.querySelector<HTMLElement>('time[datetime], abbr[title], [data-utime]');
      const labels = Array.from(element.querySelectorAll<HTMLElement>('[aria-label], [title]')).map(node => `${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`);
      return {
        href: postHref,
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        time: timeNode?.getAttribute('datetime') ?? timeNode?.getAttribute('title') ?? timeNode?.getAttribute('data-utime') ?? timeNode?.textContent ?? '',
        labels: labels.join(' '),
      };
    }).filter((value): value is { href: string; text: string; time: string; labels: string } => Boolean(value))).catch(() => []);
    for (const row of rows) {
      let postUrl: string;
      try { postUrl = normalizeFacebookPostUrl(row.href); } catch { continue; }
      if (!postUrl.includes(new URL(groupUrl).pathname.split('/').filter(Boolean)[1] ?? '')) continue;
      const createdAt = parseFacebookPostDate(row.time, row.text);
      const reactions = parseFacebookMetric(row.labels, row.text, /(?:like|likes|reaction|reactions|lượt thích|lượt bày tỏ|cảm xúc|tim)/i);
      const comments = parseFacebookMetric(row.labels, row.text, /(?:comment|comments|bình luận)/i);
      posts.set(postUrl, { postUrl, ...(createdAt ? { createdAt } : {}), reactions, comments });
    }
    if (posts.size === previousCount) stagnant += 1; else stagnant = 0;
    previousCount = posts.size;
    if (posts.size >= Math.max(filters.maxPosts * 2, 20)) break;
    await page.evaluate(() => {
      const candidates = [document.scrollingElement, document.body, ...Array.from(document.querySelectorAll<HTMLElement>('*'))];
      for (const element of candidates) {
        if (!element) continue;
        const style = window.getComputedStyle(element);
        if (element.scrollHeight > element.clientHeight + 8 && /(auto|scroll|overlay)/i.test(style.overflowY)) element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(600, Math.floor(element.clientHeight * 0.85)));
      }
    }).catch(() => undefined);
    await page.waitForTimeout(400);
  }
  const cutoff = Date.now() - filters.daysRecent * 24 * 60 * 60 * 1000;
  return [...posts.values()]
    // Never treat an unparsed timestamp as recent: the requested time window
    // is a safety boundary, so an ambiguous post must not receive a comment.
    .filter(post => Boolean(post.createdAt && post.createdAt.getTime() >= cutoff))
    .filter(post => post.reactions >= filters.minReactions && (filters.maxReactions == null || post.reactions <= filters.maxReactions))
    .filter(post => post.comments >= filters.minComments && (filters.maxComments == null || post.comments <= filters.maxComments))
    .slice(0, filters.maxPosts);
}

async function topLevelCommentTextbox(scope: Locator, page: Page): Promise<Locator | undefined> {
  const candidates = replyTextboxes(scope);
  const count = await candidates.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    const label = `${await candidate.getAttribute('aria-label').catch(() => '')} ${await candidate.getAttribute('placeholder').catch(() => '')} ${await candidate.getAttribute('data-placeholder').catch(() => '')}`;
    if (/(comment|bình luận|viết bình luận|write a comment|nhận xét)/i.test(label)) return candidate;
  }
  const fallback = replyTextboxes(page.locator('body')).last();
  return await fallback.isVisible().catch(() => false) ? fallback : undefined;
}

function parseFacebookMetric(labels: string, text: string, kind: RegExp): number {
  const source = `${labels} ${text}`;
  const patterns = [
    new RegExp(`(\\d[\\d.,\\s]*\\s*[kmb]?)\\s*${kind.source}`, 'i'),
    new RegExp(`${kind.source}\\s*[:·-]?\\s*(\\d[\\d.,\\s]*\\s*[kmb]?)`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (match?.[1]) return parseFacebookCount(match[1]);
  }
  return 0;
}

function parseFacebookCount(value: string): number {
  const normalized = value.trim().replace(/\s/g, '').toLowerCase();
  const suffix = normalized.slice(-1);
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
  const numberPart = multiplier === 1 ? normalized : normalized.slice(0, -1);
  const digits = numberPart.replace(/[^\d]/g, '');
  if (!digits) return 0;
  if (multiplier === 1) return Number(digits);
  const decimal = Number(numberPart.replace(',', '.').replace(/[^\d.]/g, ''));
  return Number.isFinite(decimal) ? Math.round(decimal * multiplier) : Number(digits) * multiplier;
}

function parseFacebookPostDate(value: string, text: string): Date | undefined {
  const raw = value.trim();
  // Facebook's Vietnamese locale renders absolute timestamps like
  // "18 Tháng 9 lúc 23:20".  They are not parseable by Date.parse, and
  // treating them as unknown would incorrectly drop otherwise eligible
  // posts from a bounded recent-days campaign.  Parse the localized form
  // explicitly and assume the current year when Facebook omits it.
  const localizedSource = `${raw} ${text}`;
  const vietnamese = localizedSource.match(/(?:^|\s)(\d{1,2})\s*th(?:á|a)ng\s*(\d{1,2})(?:\s*(?:n(?:ă|a)m)\s*(\d{4}))?(?:\s*(?:l(?:ú|u)c|at)\s*(\d{1,2})(?::(\d{2}))?)?/i);
  if (vietnamese) {
    const day = Number(vietnamese[1]);
    const month = Number(vietnamese[2]);
    const explicitYear = vietnamese[3] ? Number(vietnamese[3]) : new Date().getFullYear();
    const hour = vietnamese[4] ? Number(vietnamese[4]) : 0;
    const minute = vietnamese[5] ? Number(vietnamese[5]) : 0;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      const date = new Date(explicitYear, month - 1, day, hour, minute);
      // When a year is omitted, a future date is almost certainly from the
      // previous year (e.g. a December post viewed in January).
      if (!vietnamese[3] && date.getTime() > Date.now() + 86_400_000) date.setFullYear(date.getFullYear() - 1);
      return date;
    }
  }
  const englishMonth = localizedSource.match(/(?:^|\s)(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?(?:\s*(?:at|l(?:ú|u)c)\s*(\d{1,2})(?::(\d{2}))?)?/i)
    ?? localizedSource.match(/(?:^|\s)(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:,?\s*(\d{4}))?(?:\s*(?:at|l(?:ú|u)c)\s*(\d{1,2})(?::(\d{2}))?)?/i);
  if (englishMonth) {
    const first = englishMonth[1]!;
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthToken = /^\d+$/.test(first) ? englishMonth[2]! : first;
    const dayToken = /^\d+$/.test(first) ? first : englishMonth[2]!;
    const yearToken = /^\d+$/.test(first) ? englishMonth[3] : englishMonth[3];
    const hourToken = /^\d+$/.test(first) ? englishMonth[4] : englishMonth[4];
    const minuteToken = /^\d+$/.test(first) ? englishMonth[5] : englishMonth[5];
    const month = monthNames.findIndex(name => monthToken.toLowerCase().startsWith(name)) + 1;
    const year = yearToken ? Number(yearToken) : new Date().getFullYear();
    const date = new Date(year, month - 1, Number(dayToken), hourToken ? Number(hourToken) : 0, minuteToken ? Number(minuteToken) : 0);
    if (month > 0 && date.getTime() > 0) {
      if (!yearToken && date.getTime() > Date.now() + 86_400_000) date.setFullYear(date.getFullYear() - 1);
      return date;
    }
  }
  if (/^\d{9,13}$/.test(raw)) {
    const number = Number(raw);
    return new Date(raw.length === 10 ? number * 1000 : number);
  }
  const absolute = raw ? new Date(raw) : undefined;
  if (absolute && !Number.isNaN(absolute.getTime()) && /\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|tháng|2026/i.test(raw)) return absolute;
  const relative = `${raw} ${text}`.match(/(?:^|\s)(\d+)\s*(seconds?|secs?|phút|minutes?|mins?|giờ|hours?|hrs?|ngày|days?|d|h|m)(?:\s|$)/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const milliseconds = /day|ngày|^d$/.test(unit) ? 86_400_000 : /hour|giờ|^h$/.test(unit) ? 3_600_000 : /minute|phút|min|^m$/.test(unit) ? 60_000 : 1_000;
    return new Date(Date.now() - amount * milliseconds);
  }
  if (/yesterday|hôm qua/i.test(raw)) return new Date(Date.now() - 86_400_000);
  return undefined;
}

async function nextReplyControl(main: Locator, actorHints: string[]): Promise<Locator | undefined> {
  const controls = replyControls(main);
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (await isOwnComment(control, actorHints)) continue;
    if (await control.getAttribute('data-socio-replied').catch(() => null) !== 'true') return control;
  }
  return undefined;
}

async function loadReplyControls(page: Page, main: Locator, target: number, timeoutMs: number, actorHints: string[]): Promise<number> {
  const deadline = Date.now() + Math.max(timeoutMs, 30_000);
  let stagnant = 0;
  let previous = 0;
  while (Date.now() < deadline && stagnant < 8) {
    const count = await eligibleReplyControlCount(main, actorHints);
    if (count >= target) return count;
    const more = main.getByRole('button', { name: LOAD_MORE }).or(main.getByRole('link', { name: LOAD_MORE })).filter({ visible: true }).last();
    if (await more.isVisible().catch(() => false)) await more.click({ timeout: 3_000 }).catch(() => undefined);
    await scrollCommentSurfaces(page);
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(350);
    stagnant = count === previous ? stagnant + 1 : 0;
    previous = count;
  }
  return await eligibleReplyControlCount(main, actorHints);
}

async function eligibleReplyControlCount(main: Locator, actorHints: string[]): Promise<number> {
  const controls = replyControls(main);
  const count = await controls.count();
  let eligible = 0;
  for (let index = 0; index < count; index += 1) {
    if (!(await isOwnComment(controls.nth(index), actorHints))) eligible += 1;
  }
  return eligible;
}

async function isOwnComment(control: Locator, actorHints: string[]): Promise<boolean> {
  if (!actorHints.length) return false;
  const comment = replyCommentScope(control);
  for (const hint of actorHints) {
    const normalized = hint.trim().toLowerCase();
    if (!normalized) continue;
    // The message body can contain a tagged link back to the parent author.
    // Only the first profile link in the comment article is the author link;
    // scanning every href incorrectly classified replies to our own comment
    // as own comments as well (and left no eligible target for another
    // profile).
    const links = comment.locator('a[href]');
    const linkCount = await links.count().catch(() => 0);
    if (linkCount > 0) {
      const authorLink = links.first();
      const href = (await authorLink.getAttribute('href').catch(() => null))?.toLowerCase() ?? '';
      const name = (await authorLink.innerText().catch(() => '')).trim().toLowerCase();
      if (name === normalized || href.includes(`/${normalized}`) || href.includes(`profile.php?id=${normalized}`)) return true;
      continue;
    }
    const exactName = comment.getByText(hint.trim(), { exact: true }).filter({ visible: true }).first();
    if (await exactName.count().catch(() => 0)) return true;
  }
  return false;
}

/** Scroll Facebook's modal comment pane, not just the document body. */
async function scrollCommentSurfaces(page: Page): Promise<void> {
  await page.evaluate(() => {
    const elements = [document.documentElement, document.body, ...Array.from(document.querySelectorAll<HTMLElement>('*'))];
    for (const element of elements) {
      const style = window.getComputedStyle(element);
      const scrollable = element.scrollHeight > element.clientHeight + 8 && /(auto|scroll|overlay)/i.test(style.overflowY);
      const rect = element.getBoundingClientRect();
      if (!scrollable || rect.width <= 0 || rect.height <= 0) continue;
      element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(500, Math.floor(element.clientHeight * 0.8)));
    }
  }).catch(() => undefined);
}

async function visibleExactTextCount(scope: Locator, text: string): Promise<number> {
  return scope.getByText(text, { exact: true }).filter({ visible: true }).count().catch(() => 0);
}

async function visiblePostedExactTextCount(scope: Locator, text: string): Promise<number> {
  const candidates = scope.getByText(text, { exact: true }).filter({ visible: true });
  const count = await candidates.count().catch(() => 0);
  let posted = 0;
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const editorAncestor = candidate.locator('xpath=ancestor-or-self::*[@role="textbox" or @contenteditable="true" or self::textarea][1]');
    if (!(await editorAncestor.count().catch(() => 0))) posted += 1;
  }
  return posted;
}

/**
 * Facebook occasionally renders a just-submitted reply in a transient
 * comment/article node whose text is not exposed through Playwright's exact
 * text locator (for example while it shows “Posting…”).  Count both the
 * semantic text matches and those visible comment surfaces so confirmation
 * does not race the Comet re-render.
 */
async function visiblePostedReplyCount(scope: Locator, text: string): Promise<number> {
  const exact = await visiblePostedExactTextCount(scope, text);
  if (exact > 0) return exact;
  const visible = await scope.page().evaluate(({ needle }) => {
    const wanted = needle.replace(/\s+/g, ' ').trim();
    if (!wanted) return 0;
    const isVisible = (element: Element) => {
      const node = element as HTMLElement;
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const surfaces = document.querySelectorAll(
      '[role="article"], [data-testid="comment"], [data-testid*="comment"], [data-ad-preview="message"], [data-ad-comet-preview="message"]',
    );
    let matches = 0;
    for (const surface of surfaces) {
      if (!isVisible(surface)) continue;
      // A draft editor can be nested in a comment/article surface.  It is not
      // a posted reply until the editor itself is gone or no longer contains
      // the requested text (checked by waitForPostedReply below).
      const textContent = (surface.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (textContent.includes(wanted)) matches += 1;
    }
    return matches;
  }, { needle: text }).catch(() => 0);
  return visible;
}

async function visibleImageSources(scope: Locator): Promise<string[]> {
  return scope.page().evaluate(() => Array.from(document.querySelectorAll('img')).filter(element => {
    const image = element as HTMLImageElement;
    const rect = image.getBoundingClientRect();
    const style = window.getComputedStyle(image);
    return rect.width >= 40 && rect.height >= 40 && image.complete && image.naturalWidth > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }).map(element => (element as HTMLImageElement).src).filter(Boolean)).catch(() => []);
}

async function waitForPostedReply(scope: Locator, textbox: Locator, text: string, before: number, timeoutMs: number, beforeImageSources: string[] = [], requireImage = false): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const posted = await visiblePostedReplyCount(scope, text);
    const editorVisible = await textbox.isVisible().catch(() => false);
    const editorValue = await editorText(textbox);
    const editorSettled = !editorVisible || (text.trim() ? !editorValue.includes(text.trim()) : false);
    const currentImageSources = requireImage ? await visibleImageSources(scope) : [];
    const imagePosted = beforeImageSources.length === 0 || currentImageSources.some(source => !beforeImageSources.includes(source));
    // A successful send must produce a non-editor reply and must either close
    // the inline editor or clear its text. This prevents the typed-but-unsent
    // composer from being mistaken for a published comment.
    const textPosted = text.trim() ? posted > before : true;
    if (textPosted && editorSettled && (!requireImage || imagePosted)) return true;
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
