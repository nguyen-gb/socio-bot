import { normalizeFacebookGroupUrl, normalizeFacebookPostUrl, normalizeFacebookProfileUrl, type ActionResult, type FacebookPostRecipientSource } from '@socio/contracts';
import { type PlatformSession } from '@socio/platform-core';
import type { Locator, Page } from 'playwright';
import { attachFacebookImages } from './facebook-images';

const MESSAGE = /^(Message|Send message|Nhắn tin|Gửi tin nhắn)$/i;
const SEND = /^(Send|Gửi)$/i;
const MESSAGE_PHOTO = /^(Photo\/?video|Photos\/?videos|Add photos\/?videos|Add photos|Photo|Photos|Attach a photo|Attach photo|Ảnh\/?video|Thêm ảnh\/?video|Thêm ảnh|Đính kèm ảnh(?: hoặc video)?)$/i;
const MINIMIZED_CHAT = /^(Open chat with|Open conversation with|Mở chat với|Mở cuộc trò chuyện với|Mở cửa sổ chat với)/i;
const CLOSE_CHAT = /^(Close chat|Close conversation|Close this chat|Đóng chat|Đóng đoạn chat|Đóng cuộc trò chuyện|Đóng cửa sổ chat|Đóng cửa sổ trò chuyện)$/i;
const ALL_POST_COMMENTS = /^(?:All comments|Tất cả bình luận|Tất cả các bình luận)(?:\s*(?:\(.+\)|\d+))?$/i;
const BLOCKED = /You can(?:not|'t|’t) send messages|This person is unavailable|Couldn(?:not|'t|’t) send|Bạn không thể gửi tin nhắn|Người này hiện không khả dụng|Không thể gửi/i;
const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

export class FacebookMessagesAutomation {
  constructor(private readonly timing: { mainTimeoutMs?: number; controlTimeoutMs?: number; confirmationTimeoutMs?: number } = {}) {}

  async messageRandomGroupMember(session: PlatformSession, inputGroupUrl: string, text: string, mediaAssetIds: string[] = [], excludedProfileUrls: string[] = []): Promise<ActionResult> {
    const page = automationPage(session);
    const groupUrl = normalizeFacebookGroupUrl(inputGroupUrl);
    try { await page.goto(`${groupUrl.replace(/\/$/, '')}/members`, { waitUntil: 'domcontentloaded', timeout: this.timing.mainTimeoutMs ?? 45_000 }); }
    catch { return manual('Không tải được danh sách thành viên nhóm; chưa gửi tin nhắn.', { groupUrl }); }
    const interrupted = await guard(page);
    if (interrupted) return interrupted;
    const excluded = new Set(excludedProfileUrls.map(value => {
      try { return normalizeFacebookProfileUrl(value); } catch { return value; }
    }));
    const members = await this.randomVisibleGroupMembers(page, excluded);
    if (!members.length) return manual('Không tìm thấy thành viên có profile công khai trong nhóm; chưa gửi tin nhắn.', { groupUrl });
    let last: ActionResult | undefined;
    for (const member of members) {
      const reserved = await session.reserveMessageRecipient?.({ groupUrl, profileUrl: member.profileUrl, displayName: member.displayName });
      if (reserved === false) continue;
      let result: ActionResult;
      try { result = await this.message(session, member.profileUrl, text, mediaAssetIds); }
      catch (error) {
        // A thrown error may happen after the durable before-send marker. Keep
        // the reservation so a retry cannot accidentally send twice.
        throw error;
      }
      const data = { ...result.data, groupUrl, profileUrl: member.profileUrl, displayName: member.displayName };
      last = { ...result, data };
      // A profile may be public but have no usable Messenger composer (for
      // example an E2EE thread that never hydrates). Skip that candidate and
      // continue through the randomized list. Once a send may have started,
      // stop immediately so a retry cannot duplicate the message.
      if (result.ok || result.data?.messageStatus === 'UNKNOWN' || result.data?.sideEffectStarted === true) return last;
      await session.releaseMessageRecipient?.({ groupUrl, profileUrl: member.profileUrl });
    }
    return last ?? manual('Không tìm thấy thành viên có profile công khai trong nhóm; chưa gửi tin nhắn.', { groupUrl });
  }

  async messageRandomPostReactor(session: PlatformSession, inputPostUrl: string, text: string, mediaAssetIds: string[] = [], excludedProfileUrls: string[] = [], recipientSource: FacebookPostRecipientSource = 'REACTORS'): Promise<ActionResult> {
    const page = automationPage(session);
    const postUrl = normalizeFacebookPostUrl(inputPostUrl);
    try { await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: this.timing.mainTimeoutMs ?? 45_000 }); }
    catch { return manual('Không tải được bài viết; chưa gửi tin nhắn.', { postUrl }); }
    const interrupted = await guard(page);
    if (interrupted) return interrupted;
    const excluded = new Set(excludedProfileUrls.map(value => {
      try { return normalizeFacebookProfileUrl(value); } catch { return value; }
    }));
    const reactors = recipientSource === 'COMMENTERS' ? [] : await this.randomVisiblePostReactors(page, excluded);
    const commenters = recipientSource === 'REACTORS' ? [] : await this.randomVisiblePostCommenters(page, excluded);
    const recipients = [...new Map([...reactors, ...commenters].map(recipient => [recipient.profileUrl, recipient])).values()];
    for (let index = recipients.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [recipients[index], recipients[swap]] = [recipients[swap]!, recipients[index]!];
    }
    if (!recipients.length) return manual(recipientSource === 'COMMENTERS' ? 'Không tìm thấy tài khoản đã bình luận công khai trong bài viết; chưa gửi tin nhắn.' : 'Không tìm thấy tài khoản đã react hoặc bình luận công khai trong bài viết; chưa gửi tin nhắn.', { postUrl });
    let last: ActionResult | undefined;
    for (const reactor of recipients) {
      const reserved = await session.reserveMessageRecipient?.({ groupUrl: postUrl, profileUrl: reactor.profileUrl, displayName: reactor.displayName });
      if (reserved === false) continue;
      const result = await this.message(session, reactor.profileUrl, text, mediaAssetIds);
      const data = { ...result.data, postUrl, groupUrl: postUrl, profileUrl: reactor.profileUrl, displayName: reactor.displayName };
      last = { ...result, data };
      if (result.ok || result.data?.messageStatus === 'UNKNOWN' || result.data?.sideEffectStarted === true) return last;
      await session.releaseMessageRecipient?.({ groupUrl: postUrl, profileUrl: reactor.profileUrl });
    }
    return last ?? manual('Không tìm thấy tài khoản đủ điều kiện trong bài viết; chưa gửi tin nhắn.', { postUrl });
  }

  async message(session: PlatformSession, inputProfileUrl: string, text: string, mediaAssetIds: string[] = []): Promise<ActionResult> {
    const page = automationPage(session);
    const profileUrl = normalizeFacebookProfileUrl(inputProfileUrl);
    try { await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: this.timing.mainTimeoutMs ?? 45_000 }); }
    catch { return manual('Không tải được profile người nhận; chưa gửi tin nhắn.', { profileUrl }); }
    const interrupted = await guard(page);
    if (interrupted) return interrupted;
    if (!isExpectedProfile(page, profileUrl)) return manual('Facebook không mở đúng profile người nhận; chưa gửi tin nhắn.', { profileUrl });
    const main = page.getByRole('main').first();
    // A profile redirect can render the shell before Facebook hydrates the
    // action row. Give the row a full control window instead of treating a
    // temporarily empty shell as “no Message button”.
    const controlTimeoutMs = this.timing.controlTimeoutMs ?? 30_000;
    await main.waitFor({ state: 'visible', timeout: controlTimeoutMs }).catch(() => undefined);
    if (!(await main.isVisible())) return manual('Không xác định được profile người nhận; chưa gửi tin nhắn.', { profileUrl });
    // Profile action rows can hydrate after the main landmark, especially on
    // a username redirect. Give the row a short settling window before
    // resolving the Message control.
    await page.waitForTimeout(3_000);
    // Saved Facebook sessions restore docked chats asynchronously after the
    // profile shell appears. Close them after that hydration (rather than
    // immediately after navigation) so a restored window cannot steal the
    // textbox or upload target below.
    await closeMinimizedMessageWindows(page);
    // Read the visible profile heading before opening Messenger. The page can
    // contain several stale chat windows, so this name is later used to bind
    // the textbox to the conversation opened from this profile.
    const profileHeading = normalizeText(await main.locator('h1').first().innerText().catch(() => ''));
    // Prefer the profile action row. Searching document.body first can pick a
    // Message button from an already-open chat or an unrelated surface.
    // Facebook may portal the action row outside <main>, so retain a body
    // fallback only when the profile scope is empty.
    const profileOpen = messageControls(main).first();
    const open = (await profileOpen.count().catch(() => 0)) ? profileOpen : messageControls(page.locator('body')).first();
    await open.waitFor({ state: 'visible', timeout: controlTimeoutMs }).catch(() => undefined);
    if (!(await open.isVisible()) || !(await open.isEnabled())) return manual('Profile không có nút Nhắn tin khả dụng; chưa gửi.', { profileUrl });
    if (!(await clickMessageControl(page, open))) {
      return manual('Không mở được nút Nhắn tin; chưa gửi.', { profileUrl });
    }
    const composerTimeoutMs = this.timing.controlTimeoutMs ?? 45_000;
    const dialog = page.getByRole('dialog').filter({ visible: true }).last();
    await dialog.waitFor({ state: 'visible', timeout: composerTimeoutMs }).catch(() => undefined);
    // Comet sometimes renders the profile composer as a docked Messenger
    // surface without role="dialog". In that layout the visible composer
    // textbox is the stable anchor; use the page as its scope instead of
    // reporting a false "could not open message frame" result.
    const surface = (await dialog.isVisible().catch(() => false)) ? dialog : page.locator('body');
    const textbox = await findMessageTextbox(surface, profileHeading);
    await textbox.waitFor({ state: 'visible', timeout: composerTimeoutMs }).catch(() => undefined);
    if (!(await textbox.isVisible())) return manual('Không mở được khung nhắn tin; chưa gửi.', { profileUrl });
    // When Facebook renders Messenger as a docked surface there is no dialog
    // role, and the page can also contain a post/comment composer with its own
    // file input. Scope all message controls to the nearest ancestor of the
    // selected Messenger textbox so an image is never uploaded into the wrong
    // Facebook composer.
    const composer = await nearestMessageComposer(textbox, surface);
    // The file input lives in a small composer region, while Messenger puts
    // the attachment preview and conversation log in its themed chat root.
    // Use that broader root for previews/confirmation, but keep the narrow
    // composer for selecting the upload input itself.
    const messageSurface = await nearestMessageSurface(textbox, composer, surface);
    const messageRows = messageSurface.locator('[role="row"], [data-scope="messages_table"]');
    // Docked Messenger keeps the conversation log outside the composer
    // subtree. Keep a separate log anchor for confirmation so a successful
    // image/text send is not reported as UNKNOWN merely because the composer
    // itself has no message rows.
    const messageLog = messageSurface.locator('[role="log"][aria-label^="Messages in conversation with"], [role="log"]').filter({ visible: true }).last();
    const previousRowCount = await messageRows.count();
    const previousMessages = await messageRows.filter({ hasText: text, visible: true }).count();
    const previousLogText = await readMessageLogText(messageLog);
    const previousLogTextCount = text ? occurrences(normalizeText(previousLogText), normalizeText(text)) : 0;
    const send = messageSendControls(composer).last();
    if (text) {
      await textbox.fill(text);
      if (normalizeText(await textboxText(textbox)) !== normalizeText(text)) return manual('Nội dung trong khung nhắn chưa khớp; chưa gửi.', { profileUrl });
    }
    if (mediaAssetIds.length) {
      if (!session.resolveMediaAssets) throw new Error('Worker chưa hỗ trợ tải ảnh; chưa gửi tin nhắn.');
      const images = await session.resolveMediaAssets(mediaAssetIds);
      if (images.length !== mediaAssetIds.length) throw new Error('Không tải đủ ảnh của tin nhắn; chưa gửi.');
      // Keep the upload picker scoped to the nearest Messenger composer.  The
      // broader message surface also contains the profile/post shell (and,
      // on saved sessions, unrelated Facebook file inputs), so passing it as
      // the picker scope can resolve no photo control or select the wrong
      // composer.  Use the surface only for upload/preview observation.
      await attachFacebookImages(
        page,
        composer,
        images,
        this.timing.controlTimeoutMs ?? 60_000,
        send,
        messageSurface,
        messageSurface,
      );
    }
    await send.waitFor({ state: 'visible', timeout: composerTimeoutMs }).catch(() => undefined);
    if (!(await send.isVisible()) || !(await send.isEnabled())) return manual('Nút Gửi chưa sẵn sàng; chưa gửi tin nhắn.', { profileUrl });
    await send.click({ trial: true, timeout: 3_000 }).catch(() => undefined);
    const beforeSend = await guard(page);
    if (beforeSend) return beforeSend;
    await session.beforeExternalAction?.();
    if (!isExpectedProfile(page, profileUrl) || !(await textbox.isVisible()) || !(await send.isVisible()) || !(await send.isEnabled())
      || normalizeText(await textboxText(textbox)) !== normalizeText(text)) return manual('Khung nhắn hoặc nội dung đã thay đổi; chưa gửi.', { profileUrl });
    const waitForSent = async (): Promise<boolean> => {
      const deadline = Date.now() + (this.timing.confirmationTimeoutMs ?? 15_000);
      do {
        const afterSend = await guard(page);
        if (afterSend) return false;
        if (await surface.getByText(BLOCKED).filter({ visible: true }).first().isVisible()) return false;
        const bubble = text ? messageRows.filter({ hasText: text, visible: true }) : messageRows;
        const currentLogText = await readMessageLogText(messageLog);
        const currentLogTextCount = text ? occurrences(normalizeText(currentLogText), normalizeText(text)) : 0;
        const logChanged = text
          ? currentLogTextCount > previousLogTextCount
          : normalizeText(currentLogText) !== normalizeText(previousLogText);
        if ((await bubble.count() > previousMessages || await messageRows.count() > previousRowCount || logChanged) && normalizeText(await textboxText(textbox)) === '') return true;
        await page.waitForTimeout(250);
      } while (Date.now() < deadline);
      return false;
    };
    // Facebook's Messenger composer is designed around Enter-to-send. Use it
    // first; only click the scoped send control when Enter left the text in
    // the editor and no new message was confirmed.
    try { await textbox.press('Enter'); } catch { /* use the button fallback */ }
    let sent = await waitForSent();
    if (!sent && normalizeText(await textboxText(textbox)) !== '') {
      const interruptedAfterEnter = await guard(page);
      if (interruptedAfterEnter) return interruptedAfterEnter;
      if (await surface.getByText(BLOCKED).filter({ visible: true }).first().isVisible()) return manual('Facebook từ chối gửi tin nhắn. Không tự thử lại.', { profileUrl, messageStatus: 'UNKNOWN' });
      try {
        await send.click({ timeout: 15_000 });
        sent = true;
      } catch {
        try {
          await send.click({ force: true, timeout: 3_000 });
          sent = true;
        } catch {
          sent = await send.evaluate(element => {
            (element as HTMLElement).click();
            return true;
          }).catch(() => false);
        }
      }
      if (sent) sent = await waitForSent();
    }
    if (!sent) return manual('Đã gửi thao tác nhưng chưa xác nhận được tin nhắn. Kiểm tra hội thoại trước khi chạy lại.', { profileUrl, messageStatus: 'UNKNOWN' });
    return { ok: true, data: { profileUrl, messageStatus: 'SENT' } };
  }

  private async randomVisibleGroupMembers(page: Page, excluded?: Set<string>): Promise<Array<{ profileUrl: string; displayName?: string }>> {
    const timeout = this.timing.controlTimeoutMs ?? 20_000;
    const main = page.getByRole('main').first();
    await main.waitFor({ state: 'visible', timeout }).catch(() => undefined);
    if (!(await main.isVisible())) return [];
    // Facebook virtualizes the member list. A few small scrolls let the task
    // choose from more than the first rendered batch without harvesting a list.
    for (let index = 0; index < 3; index += 1) {
      await page.mouse.wheel(0, 700);
      await page.waitForTimeout(350);
    }
    const currentUserId = await facebookUserId(page);
    const candidates = await main.locator('a[href]').evaluateAll((anchors) => anchors.map(anchor => ({
      href: (anchor as HTMLAnchorElement).href,
      name: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })));
    const unique = new Map<string, { profileUrl: string; displayName?: string }>();
    for (const candidate of candidates) {
      try {
        const profileUrl = normalizeFacebookProfileUrl(candidate.href);
        if (currentUserId && profileId(profileUrl) === currentUserId) continue;
        unique.set(profileUrl, { profileUrl, ...(candidate.name ? { displayName: candidate.name.slice(0, 120) } : {}) });
      } catch { /* Navigation and group links are not member profiles. */ }
    }
    const members = [...unique.values()].filter(member => !excluded?.has(member.profileUrl));
    // Fisher-Yates keeps selection random while allowing the flow to skip a
    // member whose Messenger surface is unavailable and try another member.
    for (let index = members.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [members[index], members[swap]] = [members[swap]!, members[index]!];
    }
    return members;
  }

  private async randomVisiblePostReactors(page: Page, excluded?: Set<string>): Promise<Array<{ profileUrl: string; displayName?: string }>> {
    const timeout = this.timing.controlTimeoutMs ?? 20_000;
    const main = page.getByRole('main').first();
    await main.waitFor({ state: 'visible', timeout }).catch(() => undefined);
    if (!(await main.isVisible())) return [];
    const reactionPattern = /(?:reaction|reactions|cảm xúc|người đã bày tỏ|lượt bày tỏ|like|likes|thích)/i;
    // Comet has shipped the reaction counter as a semantic button, a text
    // link, and (in older layouts) a direct /ufi/reaction/profile/browser/
    // link. Try each shape separately so a duplicated locator cannot trigger
    // Playwright strict-mode failures.
    let trigger = main.locator('a[href*="/ufi/reaction/profile/browser/"]').filter({ visible: true }).first();
    if (!(await trigger.isVisible().catch(() => false))) trigger = main.getByRole('button', { name: reactionPattern }).filter({ visible: true }).first();
    if (!(await trigger.isVisible().catch(() => false))) trigger = main.locator('[role="button"], a[role="link"], button').filter({ hasText: reactionPattern }).filter({ visible: true }).first();
    if (!(await trigger.count().catch(() => 0)) || !(await trigger.isVisible().catch(() => false))) return [];
    await trigger.click({ timeout }).catch(async () => { await trigger.click({ force: true, timeout: 3_000 }).catch(() => undefined); });
    await page.waitForTimeout(700);
    const dialog = page.getByRole('dialog').filter({ visible: true }).last();
    const scope = (await dialog.isVisible().catch(() => false)) ? dialog : page.locator('body');
    const currentUserId = await facebookUserId(page);
    const candidates = await scope.locator('a[href*="/user/"], a[href*="profile.php"], a[href^="https://www.facebook.com/"]').evaluateAll((anchors) => anchors.map(anchor => ({
      href: (anchor as HTMLAnchorElement).href,
      name: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }))).catch(() => [] as Array<{ href: string; name: string }>);
    const unique = new Map<string, { profileUrl: string; displayName?: string }>();
    for (const candidate of candidates) {
      try {
        const profileUrl = normalizeFacebookProfileUrl(candidate.href);
        if (currentUserId && profileId(profileUrl) === currentUserId) continue;
        unique.set(profileUrl, { profileUrl, ...(candidate.name ? { displayName: candidate.name.slice(0, 120) } : {}) });
      } catch { /* Reaction dialog also contains navigation links. */ }
    }
    const reactors = [...unique.values()].filter(reactor => !excluded?.has(reactor.profileUrl));
    for (let index = reactors.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [reactors[index], reactors[swap]] = [reactors[swap]!, reactors[index]!];
    }
    return reactors;
  }

  private async randomVisiblePostCommenters(page: Page, excluded?: Set<string>): Promise<Array<{ profileUrl: string; displayName?: string }>> {
    let scope = await resolvePostCommentScope(page);
    if (!scope) return [];
    await selectAllComments(page, scope);
    // “All comments” can open a dedicated comments dialog. Resolve again so
    // the harvest is performed inside that dialog rather than the background
    // post shell.
    scope = await resolvePostCommentScope(page) ?? scope;
    for (let index = 0; index < 8; index += 1) {
      const morePattern = /(?:view more comments?|view previous comments?|see more comments?|xem thêm|xem các bình luận trước)/i;
      let more = scope.getByRole('button', { name: morePattern }).filter({ visible: true }).last();
      if (!(await more.isVisible().catch(() => false))) more = scope.getByRole('link', { name: morePattern }).filter({ visible: true }).last();
      if (await more.isVisible().catch(() => false)) await more.click({ timeout: 3_000 }).catch(() => undefined);
      await page.evaluate(() => {
        for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
          if (element.scrollHeight > element.clientHeight + 8 && /(auto|scroll|overlay)/i.test(getComputedStyle(element).overflowY)) element.scrollTop = Math.min(element.scrollHeight, element.scrollTop + Math.max(500, Math.floor(element.clientHeight * 0.8)));
        }
      }).catch(() => undefined);
      await page.waitForTimeout(300);
    }
    const currentUserId = await facebookUserId(page);
    const comments = scope.locator('[role="article"], [data-commentid], [data-testid="comment"], [data-testid*="comment"], [data-testid*="Comment"], [data-ad-preview="message"], [data-ad-comet-preview="message"]').filter({ visible: true });
    const candidates = await comments.evaluateAll((elements) => elements.filter(element => !(element.getAttribute('role') === 'article' && element.querySelector('[role="article"]'))).map(element => {
      // Prefer Facebook's explicit comment-author routes. A comment surface
      // can also contain links to the post, group, or reaction controls, so a
      // broad first-anchor lookup may accidentally message the post author.
      const link = element.querySelector<HTMLAnchorElement>('a[href*="/user/"], a[href*="/people/"], a[href*="/profile.php"]')
        ?? element.querySelector<HTMLAnchorElement>('a[href^="https://www.facebook.com/"]');
      return link ? { href: link.href, name: (link.textContent ?? '').replace(/\s+/g, ' ').trim() } : undefined;
    }).filter((value): value is { href: string; name: string } => Boolean(value))).catch(() => [] as Array<{ href: string; name: string }>);
    // Some older UFI layouts expose only the group-member author anchor and
    // do not mark the surrounding comment node. Keep that explicit route as a
    // safe fallback instead of broadening to every profile link in the post.
    if (!candidates.length) {
      const authorLinks = await scope.locator('a[href*="/groups/"][href*="/user/"]').filter({ visible: true }).evaluateAll((anchors) => anchors.map(anchor => ({
        href: (anchor as HTMLAnchorElement).href,
        name: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }))).catch(() => [] as Array<{ href: string; name: string }>);
      candidates.push(...authorLinks);
    }
    const unique = new Map<string, { profileUrl: string; displayName?: string }>();
    for (const candidate of candidates) {
      try {
        const profileUrl = normalizeFacebookProfileUrl(candidate.href);
        if (currentUserId && profileId(profileUrl) === currentUserId) continue;
        if (!excluded?.has(profileUrl)) unique.set(profileUrl, { profileUrl, ...(candidate.name ? { displayName: candidate.name.slice(0, 120) } : {}) });
      } catch { /* Comment surfaces also contain post/group links. */ }
    }
    const commenters = [...unique.values()];
    for (let index = commenters.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [commenters[index], commenters[swap]] = [commenters[swap]!, commenters[index]!];
    }
    return commenters;
  }
}

async function resolvePostCommentScope(page: Page): Promise<Locator | undefined> {
  const dialogs = page.getByRole('dialog').filter({ visible: true });
  for (let index = await dialogs.count() - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    const label = (await dialog.getAttribute('aria-label').catch(() => null) ?? '').toLocaleLowerCase();
    if (/messenger|message|tin nhắn|chat|conversation|cuộc trò chuyện/.test(label)) continue;
    const comments = dialog.locator('[role="article"], [data-commentid], [data-testid="comment"], [data-ad-preview="message"], [data-ad-comet-preview="message"]').filter({ visible: true });
    if (await comments.count().catch(() => 0)) return dialog;
  }
  const main = page.getByRole('main').first();
  return await main.isVisible().catch(() => false) ? main : undefined;
}

async function selectAllComments(page: Page, scope: Locator): Promise<void> {
  let control = scope.getByRole('button', { name: ALL_POST_COMMENTS }).filter({ visible: true }).first();
  if (!(await control.isVisible().catch(() => false))) control = scope.getByRole('link', { name: ALL_POST_COMMENTS }).filter({ visible: true }).first();
  if (!(await control.isVisible().catch(() => false))) control = page.getByText(ALL_POST_COMMENTS).filter({ visible: true }).first();
  if (await control.isVisible().catch(() => false)) {
    await control.click({ timeout: 5_000 }).catch(async () => { await control.click({ force: true, timeout: 2_000 }).catch(() => undefined); });
    await page.waitForTimeout(500);
  }
}

async function closeMinimizedMessageWindows(page: Page): Promise<void> {
  const minimized = page.getByRole('button', { name: MINIMIZED_CHAT })
    .or(page.getByRole('link', { name: MINIMIZED_CHAT }))
    .filter({ visible: true });
  const close = page.getByRole('button', { name: CLOSE_CHAT })
    .or(page.getByRole('link', { name: CLOSE_CHAT }))
    .filter({ visible: true });

  // Facebook keeps minimized Messenger heads across profile navigations. Open
  // each head just long enough to expose its header close control, then close
  // it before the profile Message button is evaluated. This prevents a stale
  // E2EE dock from stealing the click or composer focus.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let changed = false;
    for (const control of await close.all()) {
      if (!(await control.isVisible().catch(() => false))) continue;
      await control.click({ timeout: 2_000 }).catch(() => undefined);
      changed = true;
      await page.waitForTimeout(100);
    }
    // A few Comet layouts render the close affordance as a generic div with
    // aria-label rather than a semantic button/link. Use the DOM only for
    // the exact localized close labels, never the broad “Close/Đóng” label
    // used by image previews and other dialogs.
    const closedViaDom = await page.evaluate((source) => {
      const matcher = new RegExp(source, 'i');
      let count = 0;
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('[aria-label]'))) {
        const label = element.getAttribute('aria-label') ?? '';
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (!matcher.test(label) || !rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
        element.click();
        count += 1;
      }
      return count;
    }, CLOSE_CHAT.source).catch(() => 0);
    if (closedViaDom > 0) {
      changed = true;
      await page.waitForTimeout(100);
    }
    const head = minimized.first();
    if (await head.isVisible().catch(() => false)) {
      await head.click({ timeout: 2_000 }).catch(() => undefined);
      changed = true;
      await page.waitForTimeout(150);
      continue;
    }
    if (!changed) break;
  }
}

async function findMessageTextbox(surface: Locator, expectedName: string): Promise<Locator> {
  const candidates = surface.locator('[role="textbox"][contenteditable="true"], textarea').filter({ visible: true });
  const count = await candidates.count().catch(() => 0);
  if (!count) return candidates.last();
  if (expectedName) {
    const expected = normalizeText(expectedName).toLocaleLowerCase();
    let nameMatch: Locator | undefined;
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      const themed = candidate.locator('xpath=ancestor::*[contains(@style, "--chat-composer")]').last();
      const region = candidate.locator('xpath=ancestor::*[@role="region" or @role="dialog"]').last();
      const root = (await themed.count().catch(() => 0) && await themed.isVisible().catch(() => false)) ? themed : region;
      if (!(await root.count().catch(() => 0))) continue;
      const visibleText = await root.innerText({ timeout: 500 }).catch(() => '');
      const labels = await root.locator('[aria-label]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? '')).catch(() => [] as string[]);
      // Prefer Facebook's exact conversation anchors. A broad text search is
      // unsafe here because an older chat can contain the profile name in a
      // previously sent message while its composer belongs to another person.
      const exact = labels.some(label => {
        const normalized = normalizeText(label).toLocaleLowerCase();
        return normalized === `viết cho ${expected}`
          || normalized === `write to ${expected}`
          || normalized === `tin nhắn trong cuộc trò chuyện với ${expected}`
          || normalized === `messages in conversation with ${expected}`;
      });
      if (exact) return candidate;
      if (!nameMatch && normalizeText(`${visibleText} ${labels.join(' ')}`).toLocaleLowerCase().includes(expected)) nameMatch = candidate;
    }
    if (nameMatch) return nameMatch;
  }
  return candidates.last();
}

async function clickMessageControl(page: Page, control: Locator): Promise<boolean> {
  try {
    await control.click({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    if (await page.locator('[role="textbox"][contenteditable="true"], textarea').filter({ visible: true }).count()) return true;
  } catch {
    // Facebook can leave a sticky header layer over the profile action row
    // while it hydrates. Keep the semantic locator, but skip pointer
    // interception only after the normal click has failed.
  }
  try {
    await control.click({ force: true, timeout: 3_000 });
    return true;
  } catch {
    const clicked = await control.evaluate(element => {
      (element as HTMLElement).click();
      return true;
    }).catch(() => false);
    if (clicked) return true;
    return page.evaluate(({ source, flags }) => {
      const matcher = new RegExp(source, flags);
      const controls = Array.from(document.querySelectorAll<HTMLElement>('[role="button"][aria-label], a[role="link"][aria-label]'));
      const target = controls.find(element => matcher.test(element.getAttribute('aria-label') ?? ''));
      if (!target) return false;
      target.click();
      return true;
    }, { source: MESSAGE.source, flags: MESSAGE.flags }).catch(() => false);
  }
}

async function facebookUserId(page: Page): Promise<string | undefined> {
  try {
    const cookie = (await page.context().cookies('https://www.facebook.com')).find(item => item.name === 'c_user');
    return cookie?.value && /^\d+$/.test(cookie.value) ? cookie.value : undefined;
  } catch { return undefined; }
}

function automationPage(session: PlatformSession): Page {
  if (!('getByRole' in session.page)) throw new Error('Facebook message actions require a Playwright page');
  return session.page as Page;
}

function messageControls(main: Locator) {
  const semantic = main.getByRole('button', { name: MESSAGE }).or(main.getByRole('link', { name: MESSAGE }));
  // Some profile layouts expose the action as a generic role=button whose
  // accessible name is hydrated a moment after its visible text. Match the
  // visible label as a fallback so the action is not lost during that gap.
  const labeled = main.locator('[role="button"], a[role="link"], button').filter({ hasText: MESSAGE });
  return semantic.or(labeled).filter({ visible: true });
}

function messageSendControls(scope: Locator) {
  return scope.getByRole('button', { name: SEND })
    .or(scope.getByRole('button', { name: /^(Press Enter to send|Nhấn Enter để gửi)$/i }))
    .filter({ visible: true });
}

function occurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

async function readMessageLogText(log: Locator): Promise<string> {
  if (!(await log.count().catch(() => 0))) return '';
  return log.innerText({ timeout: 500 }).catch(() => '');
}

async function nearestMessageComposer(textbox: Locator, fallback: Locator): Promise<Locator> {
  let current = textbox;
  for (let depth = 0; depth < 16; depth += 1) {
    const parent = current.locator('xpath=..');
    if (!(await parent.count().catch(() => 0))) break;
    // The first ancestor that owns the Messenger upload affordance is the
    // conversation composer. Some Comet variants render the send control as a
    // generic icon (without an accessible “Send” name), so looking only for
    // the semantic send button can fall all the way back to document.body and
    // select an unrelated post/comment file input. Prefer the nearest ancestor
    // that owns either Messenger's file input/photo control or a named send
    // control; all of those controls are scoped to this textbox's chat.
    if (await parent.locator('input[type="file"]').count().catch(() => 0)) return parent;
    if (await parent.getByRole('button', { name: MESSAGE_PHOTO }).count().catch(() => 0)) return parent;
    if (await parent.locator('[role="button"], button').filter({ hasText: MESSAGE_PHOTO }).count().catch(() => 0)) return parent;
    if (await messageSendControls(parent).count().catch(() => 0)) return parent;
    current = parent;
  }
  return fallback;
}

async function nearestMessageSurface(textbox: Locator, composer: Locator, fallback: Locator): Promise<Locator> {
  // Comet's docked Messenger root carries a stable custom-property marker;
  // unlike Facebook's generated class names it survives locale/layout changes
  // and contains both the composer region and the message log/preview.
  const themed = textbox.locator('xpath=ancestor::*[contains(@style, "--chat-composer")]').last();
  if (await themed.count().catch(() => 0) && await themed.isVisible().catch(() => false)) return themed;
  const region = textbox.locator('xpath=ancestor::*[@role="region"]').last();
  if (await region.count().catch(() => 0) && await region.isVisible().catch(() => false)) return region;
  return (await composer.count().catch(() => 0)) ? composer : fallback;
}

function isExpectedProfile(page: Page, expected: string): boolean {
  try {
    const current = normalizeFacebookProfileUrl(page.url());
    if (current === expected) return true;

    // A numeric profile URL often redirects to the member's username URL.  The
    // two URLs cannot be string-compared, but this is a Facebook-owned public
    // profile route reached from the requested numeric profile ID.  Still reject
    // every non-profile route (home, group, login, checkpoint, etc.).
    return profileId(expected) !== undefined && isFacebookProfileRoute(page.url());
  }
  catch { return false; }
}

function profileId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.pathname === '/profile.php') return url.searchParams.get('id') ?? undefined;
    const groupMember = /^\/groups\/[^/]+\/user\/(\d+)\/?$/.exec(url.pathname);
    if (groupMember) return groupMember[1];
    const people = /^\/people\/[^/]+\/(\d+)\/?$/.exec(url.pathname);
    if (people) return people[1];
    const numeric = /^\/(\d+)\/?$/.exec(url.pathname);
    return numeric?.[1];
  } catch { return undefined; }
}

function isFacebookProfileRoute(value: string): boolean {
  const url = new URL(value);
  if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname)) return false;
  const match = /^\/([a-zA-Z0-9._-]+)\/?$/.exec(url.pathname);
  if (!match) return false;
  return !new Set(['groups', 'pages', 'events', 'marketplace', 'watch', 'messages', 'login', 'checkpoint']).has(match[1]!.toLowerCase());
}

async function textboxText(textbox: Locator): Promise<string> {
  return textbox.evaluate(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : element.textContent ?? '');
}

async function guard(page: Page): Promise<ActionResult | undefined> {
  const url = page.url();
  if (/\/(?:login|checkpoint)\b/i.test(url)) return manual('Facebook yêu cầu đăng nhập hoặc xác minh; chưa gửi tin nhắn.', { accountChallenged: url.includes('/checkpoint') });
  const blocked = page.getByText(/captcha|security check|xác minh|kiểm tra bảo mật/i).filter({ visible: true }).first();
  if (await blocked.isVisible()) return manual('Facebook yêu cầu CAPTCHA/xác minh; chưa gửi tin nhắn.', { accountChallenged: true });
  return undefined;
}

function manual(reason: string, data: Record<string, unknown> = {}): ActionResult {
  return { ok: false, data: { ...data, requiresAction: true, reason } };
}
