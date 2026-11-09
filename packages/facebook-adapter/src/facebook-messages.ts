import { normalizeFacebookGroupUrl, normalizeFacebookPostUrl, normalizeFacebookProfileUrl, type ActionResult, type FacebookPostRecipientSource } from '@socio/contracts';
import { gotoPlatformPage, type PlatformSession } from '@socio/platform-core';
import type { Locator, Page } from 'playwright';
import { attachFacebookImages } from './facebook-images';

const MESSAGE = /^(Message|Send message|Nhắn tin|Gửi tin nhắn)$/i;
const SEND = /^(Send|Gửi)$/i;
const SEND_LIKE = /^(Send a Like|Send a like|Gửi lượt thích)$/i;
const MESSAGE_PHOTO = /^(Photo\/?video|Photos\/?videos|Add photos\/?videos|Add photos|Photo|Photos|Attach a photo|Attach photo|Ảnh\/?video|Thêm ảnh\/?video|Thêm ảnh|Đính kèm ảnh(?: hoặc video)?)$/i;
const MINIMIZED_CHAT = /^(Open chat with|Open conversation with|Mở chat với|Mở cuộc trò chuyện với|Mở cửa sổ chat với)/i;
const CLOSE_CHAT = /^(Close chat|Close conversation|Close this chat|Đóng chat|Đóng đoạn chat|Đóng cuộc trò chuyện|Đóng cửa sổ chat|Đóng cửa sổ trò chuyện)$/i;
const ALL_POST_COMMENTS = /^(?:All comments|Tất cả bình luận|Tất cả các bình luận)(?:\s*(?:\(.+\)|\d+))?$/i;
const REACTION_TOOLBAR = /^(?:See who reacted to this|Xem ai đã bày tỏ cảm xúc về nội dung này)$/i;
const REACTION_SUMMARY = /^(?:(?:\d+[\d.,KMB]*\s+)?(?:reactions?|lượt bày tỏ cảm xúc)|(?:Like|Love|Care|Haha|Wow|Sad|Angry|Thích|Yêu thích|Thương thương|Buồn|Phẫn nộ):\s*\d+[\d.,KMB]*\s*(?:people|person|người))$/i;
const BLOCKED = /You can(?:not|'t|’t) send messages|This person is unavailable|Couldn(?:not|'t|’t) send|Bạn không thể gửi tin nhắn|Người này hiện không khả dụng|Không thể gửi/i;
const MAX_RECIPIENT_CANDIDATES = 3;
const normalizeText = (value: string) => value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim();

export class FacebookMessagesAutomation {
  private memberDiscoveryDiagnostics: Record<string, unknown> | undefined;

  constructor(private readonly timing: { mainTimeoutMs?: number; controlTimeoutMs?: number; confirmationTimeoutMs?: number } = {}) {}

  async messageRandomGroupMember(session: PlatformSession, inputGroupUrl: string, text: string, mediaAssetIds: string[] = [], excludedProfileUrls: string[] = []): Promise<ActionResult> {
    const page = automationPage(session);
    const groupUrl = normalizeFacebookGroupUrl(inputGroupUrl);
    try { await gotoPlatformPage(page, `${groupUrl.replace(/\/$/, '')}/members`, undefined, { timeoutMs: this.timing.mainTimeoutMs ?? 30_000 }); }
    catch { return manual('Không tải được danh sách thành viên nhóm; chưa gửi tin nhắn.', { groupUrl }); }
    const interrupted = await guard(page);
    if (interrupted) return interrupted;
    const excluded = new Set(excludedProfileUrls.map(value => {
      try { return normalizeFacebookProfileUrl(value); } catch { return value; }
    }));
    const ownProfileIds = await facebookOwnProfileIds(session, page);
    const members = (await this.randomVisibleGroupMembers(page, excluded))
      .filter(member => !ownProfileIds.has(facebookProfileIdentifier(member.profileUrl)));
    if (!members.length) return manual('Không tìm thấy thành viên có profile công khai trong nhóm; chưa gửi tin nhắn.', { groupUrl, memberDiscovery: this.memberDiscoveryDiagnostics });
    let last: ActionResult | undefined;
    let attemptedCandidates = 0;
    let skippedDuplicates = 0;
    for (const member of members) {
      const globallyReserved = await session.reserveFacebookTarget?.({ action: 'MESSAGE', targetKey: member.profileUrl });
      if (globallyReserved === false) {
        skippedDuplicates += 1;
        continue;
      }
      const reserved = await session.reserveMessageRecipient?.({ groupUrl, profileUrl: member.profileUrl, displayName: member.displayName });
      if (reserved === false) {
        skippedDuplicates += 1;
        await session.releaseFacebookTarget?.({ action: 'MESSAGE', targetKey: member.profileUrl });
        continue;
      }
      attemptedCandidates += 1;
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
      if (result.ok) {
        await session.completeFacebookTarget?.({ action: 'MESSAGE', targetKey: member.profileUrl });
        return last;
      }
      if (result.data?.messageStatus === 'UNKNOWN' || result.data?.sideEffectStarted === true) return last;
      await session.releaseMessageRecipient?.({ groupUrl, profileUrl: member.profileUrl });
      await session.releaseFacebookTarget?.({ action: 'MESSAGE', targetKey: member.profileUrl });
      if (attemptedCandidates >= MAX_RECIPIENT_CANDIDATES) break;
    }
    return last ?? (skippedDuplicates > 0
      ? { ok: true, data: { groupUrl, messageStatus: 'SKIPPED_DUPLICATE', deduplicated: true, actionStatus: 'SKIPPED' } }
      : manual('Không tìm thấy thành viên có profile công khai trong nhóm; chưa gửi tin nhắn.', { groupUrl, memberDiscovery: this.memberDiscoveryDiagnostics }));
  }

  async messageRandomPostReactor(session: PlatformSession, inputPostUrl: string, text: string, mediaAssetIds: string[] = [], excludedProfileUrls: string[] = [], recipientSource: FacebookPostRecipientSource = 'REACTORS'): Promise<ActionResult> {
    const page = automationPage(session);
    const postUrl = normalizeFacebookPostUrl(inputPostUrl);
    try { await gotoPlatformPage(page, postUrl, undefined, { timeoutMs: this.timing.mainTimeoutMs ?? 30_000 }); }
    catch { return manual('Không tải được bài viết; chưa gửi tin nhắn.', { postUrl }); }
    const interrupted = await guard(page);
    if (interrupted) return interrupted;
    const excluded = new Set(excludedProfileUrls.map(value => {
      try { return normalizeFacebookProfileUrl(value); } catch { return value; }
    }));
    const ownProfileIds = await facebookOwnProfileIds(session, page);
    const reactors = recipientSource === 'COMMENTERS' ? [] : await this.randomVisiblePostReactors(page, excluded);
    const commenters = recipientSource === 'REACTORS' ? [] : await this.randomVisiblePostCommenters(page, excluded);
    const recipients = [...new Map([...reactors, ...commenters].map(recipient => [recipient.profileUrl, recipient])).values()]
      .filter(recipient => !ownProfileIds.has(facebookProfileIdentifier(recipient.profileUrl)));
    for (let index = recipients.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [recipients[index], recipients[swap]] = [recipients[swap]!, recipients[index]!];
    }
    if (!recipients.length) return manual(recipientSource === 'COMMENTERS' ? 'Không tìm thấy tài khoản đã bình luận công khai trong bài viết; chưa gửi tin nhắn.' : 'Không tìm thấy tài khoản đã react hoặc bình luận công khai trong bài viết; chưa gửi tin nhắn.', { postUrl });
    let last: ActionResult | undefined;
    let attemptedCandidates = 0;
    let skippedDuplicates = 0;
    for (const reactor of recipients) {
      const globallyReserved = await session.reserveFacebookTarget?.({ action: 'MESSAGE', targetKey: reactor.profileUrl });
      if (globallyReserved === false) {
        skippedDuplicates += 1;
        continue;
      }
      const reserved = await session.reserveMessageRecipient?.({ groupUrl: postUrl, profileUrl: reactor.profileUrl, displayName: reactor.displayName });
      if (reserved === false) {
        skippedDuplicates += 1;
        await session.releaseFacebookTarget?.({ action: 'MESSAGE', targetKey: reactor.profileUrl });
        continue;
      }
      attemptedCandidates += 1;
      const result = await this.message(session, reactor.profileUrl, text, mediaAssetIds);
      const data = { ...result.data, postUrl, groupUrl: postUrl, profileUrl: reactor.profileUrl, displayName: reactor.displayName };
      last = { ...result, data };
      if (result.ok) {
        await session.completeFacebookTarget?.({ action: 'MESSAGE', targetKey: reactor.profileUrl });
        return last;
      }
      if (result.data?.messageStatus === 'UNKNOWN' || result.data?.sideEffectStarted === true) return last;
      await session.releaseMessageRecipient?.({ groupUrl: postUrl, profileUrl: reactor.profileUrl });
      await session.releaseFacebookTarget?.({ action: 'MESSAGE', targetKey: reactor.profileUrl });
      if (attemptedCandidates >= MAX_RECIPIENT_CANDIDATES) break;
    }
    return last ?? (skippedDuplicates > 0
      ? { ok: true, data: { postUrl, groupUrl: postUrl, messageStatus: 'SKIPPED_DUPLICATE', deduplicated: true, actionStatus: 'SKIPPED' } }
      : manual('Không tìm thấy tài khoản đủ điều kiện trong bài viết; chưa gửi tin nhắn.', { postUrl }));
  }

  async message(session: PlatformSession, inputProfileUrl: string, text: string, mediaAssetIds: string[] = []): Promise<ActionResult> {
    const page = automationPage(session);
    const profileUrl = normalizeFacebookProfileUrl(inputProfileUrl);
    try { await gotoPlatformPage(page, profileUrl, undefined, { timeoutMs: this.timing.mainTimeoutMs ?? 30_000 }); }
    catch { return manual('Không tải được profile người nhận; chưa gửi tin nhắn.', { profileUrl }); }
    const interrupted = await guard(page);
    if (interrupted) return interrupted;
    if (!isExpectedProfile(page, profileUrl)) return manual('Facebook không mở đúng profile người nhận; chưa gửi tin nhắn.', { profileUrl });
    const main = page.getByRole('main').first();
    // A profile redirect can render the shell before Facebook hydrates the
    // action row. Give the row a full control window instead of treating a
    // temporarily empty shell as “no Message button”.
    // Page navigation keeps its longer network budget, but individual UI
    // controls follow the 10-second campaign default. A missing Message
    // button must not hold a random-recipient campaign for 30-45 seconds per
    // candidate.
    const controlTimeoutMs = this.timing.controlTimeoutMs ?? 10_000;
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
    const composerTimeoutMs = this.timing.controlTimeoutMs ?? 10_000;
    // Search the whole document and bind the result to the expected profile
    // below. Facebook can keep an unrelated visible dialog (notifications,
    // reactions, a stale modal) while profile Messenger opens as a docked
    // sibling. Choosing the last dialog as the search root therefore hides a
    // real composer and falsely reports that the profile cannot be messaged.
    const surface = page.locator('body');
    let textbox = await findMessageTextbox(surface, profileHeading, profileUrl);
    await textbox.waitFor({ state: 'visible', timeout: composerTimeoutMs }).catch(() => undefined);
    if (!(await textbox.isVisible())) return manual('Không mở được khung nhắn tin; chưa gửi.', { profileUrl });
    const targetEditorLabel = await textbox.getAttribute('aria-label').catch(() => null);
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
    const messageSurface = await nearestMessageSurface(textbox, composer, surface, profileUrl);
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
    const previousSurfaceText = await messageSurface.innerText({ timeout: 500 }).catch(() => '');
    const previousSurfaceTextCount = text ? occurrences(normalizeText(previousSurfaceText), normalizeText(text)) : 0;
    const send = messageSendControls(composer).last();
    if (text) {
      await enterMessageText(textbox, text, composerTimeoutMs);
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
    let sendReady = await send.isVisible().catch(() => false) && await send.isEnabled().catch(() => false);
    if (!sendReady && text && await composer.getByRole('button', { name: SEND_LIKE }).filter({ visible: true }).isVisible().catch(() => false)) {
      // textContent can look correct while Facebook's Lexical state still
      // thinks the composer is empty (the action remains “Send a Like”). In
      // that state Enter can submit a partial/garbage draft. Reinsert the
      // whole value through one native input transaction and require the real
      // send affordance before writing the durable marker.
      await replaceMessageTextAtomically(textbox, text, composerTimeoutMs).catch(() => undefined);
      await send.waitFor({ state: 'visible', timeout: Math.min(composerTimeoutMs, 3_000) }).catch(() => undefined);
      sendReady = await send.isVisible().catch(() => false) && await send.isEnabled().catch(() => false);
      if (normalizeText(await textboxText(textbox).catch(() => '')) !== normalizeText(text) || !sendReady) {
        return manual('Facebook chưa nhận đầy đủ nội dung trong khung nhắn; chưa gửi.', { profileUrl });
      }
    }
    // Current docked Messenger variants may expose only the textbox and use
    // Enter as the send action, without an accessible button named Send. Text
    // messages can still be submitted safely through the editor. Image-only
    // messages retain the stricter button requirement.
    if (!sendReady && !text) return manual('Nút Gửi chưa sẵn sàng; chưa gửi tin nhắn.', { profileUrl });
    if (sendReady) await send.click({ trial: true, timeout: 3_000 }).catch(() => undefined);
    const beforeSend = await guard(page);
    if (beforeSend) return beforeSend;
    await session.beforeExternalAction?.();
    // Persisting the durable marker yields to the worker/Temporal activity.
    // During that gap Facebook's Lexical editor may replace its contenteditable
    // node even though the same composer and draft remain visible. Re-resolve
    // the profile-scoped editor before the final safety check so a harmless
    // React re-render is not mistaken for the user/browser changing context.
    const labelBoundTextbox = targetEditorLabel
      ? surface.getByRole('textbox', { name: targetEditorLabel, exact: true }).filter({ visible: true }).last()
      : undefined;
    const refreshedTextbox = labelBoundTextbox && await labelBoundTextbox.isVisible().catch(() => false)
      ? labelBoundTextbox
      : await findMessageTextbox(surface, profileHeading, profileUrl);
    await refreshedTextbox.waitFor({ state: 'visible', timeout: Math.min(composerTimeoutMs, 3_000) }).catch(() => undefined);
    const profileStillExpected = isExpectedProfile(page, profileUrl);
    const editorStillVisible = await refreshedTextbox.isVisible().catch(() => false);
    let draftStillMatches = editorStillVisible
      && normalizeText(await textboxText(refreshedTextbox).catch(() => '')) === normalizeText(text);
    if (profileStillExpected && editorStillVisible && text && !draftStillMatches) {
      // Lexical may replace the editor node and drop its uncontrolled draft
      // while the durable marker is persisted. Re-entering text is safe here:
      // the external send action has not run, and both the page route and the
      // profile-scoped composer have already been revalidated.
      await enterMessageText(refreshedTextbox, text, composerTimeoutMs).catch(() => undefined);
      draftStillMatches = normalizeText(await textboxText(refreshedTextbox).catch(() => '')) === normalizeText(text);
    }
    if (!profileStillExpected || !editorStillVisible || !draftStillMatches) {
      // The durable marker has already been persisted. Even though the final
      // click/Enter has not run yet, treat this candidate as uncertain so the
      // outer random-recipient loop keeps its reservation and never advances
      // to another person after an interrupted marked attempt.
      return manual('Khung nhắn hoặc nội dung đã thay đổi sau khi đánh dấu gửi. Kiểm tra hội thoại trước khi chạy lại.', {
        profileUrl,
        messageStatus: 'UNKNOWN',
        validation: { profileStillExpected, editorStillVisible, draftStillMatches },
      });
    }
    textbox = refreshedTextbox;
    // The durable marker can yield long enough for Facebook to replace not
    // only the Lexical textbox, but also its composer/chat ancestors. A
    // locator created before that yield may consequently resolve to no send
    // control (or to a detached control) even though the refreshed editor is
    // valid. Bind every final-action and confirmation locator to the refreshed
    // editor so the click and the observed transcript belong to the same chat.
    const activeComposer = await nearestMessageComposer(textbox, surface);
    const activeMessageSurface = await nearestMessageSurface(textbox, activeComposer, surface, profileUrl);
    const activeMessageRows = activeMessageSurface.locator('[role="row"], [data-scope="messages_table"]');
    const activeMessageLog = activeMessageSurface.locator('[role="log"][aria-label^="Messages in conversation with"], [role="log"]').filter({ visible: true }).last();
    const activeSend = messageSendControls(activeComposer).last();
    await activeSend.waitFor({ state: 'visible', timeout: Math.min(composerTimeoutMs, 3_000) }).catch(() => undefined);
    let activeSendReady = await activeSend.isVisible().catch(() => false)
      && await activeSend.isEnabled().catch(() => false);
    if (!activeSendReady && text && await activeComposer.getByRole('button', { name: SEND_LIKE }).filter({ visible: true }).isVisible().catch(() => false)) {
      await replaceMessageTextAtomically(textbox, text, composerTimeoutMs).catch(() => undefined);
      await activeSend.waitFor({ state: 'visible', timeout: Math.min(composerTimeoutMs, 3_000) }).catch(() => undefined);
      activeSendReady = await activeSend.isVisible().catch(() => false)
        && await activeSend.isEnabled().catch(() => false);
      if (normalizeText(await textboxText(textbox).catch(() => '')) !== normalizeText(text) || !activeSendReady) {
        return manual('Facebook làm mất trạng thái nội dung sau khi đánh dấu gửi; chưa bấm gửi. Kiểm tra hội thoại trước khi chạy lại.', {
          profileUrl,
          messageStatus: 'UNKNOWN',
          validation: { profileStillExpected, editorStillVisible, draftStillMatches: false, lexicalDraftRegistered: false },
        });
      }
    }
    if (!activeSendReady && !text) {
      return manual('Nút Gửi đã thay đổi sau khi đánh dấu gửi; chưa gửi tin nhắn.', { profileUrl, messageStatus: 'UNKNOWN' });
    }
    const waitForSent = async (): Promise<boolean> => {
      const deadline = Date.now() + (this.timing.confirmationTimeoutMs ?? 15_000);
      do {
        const afterSend = await guard(page);
        if (afterSend) return false;
        if (await surface.getByText(BLOCKED).filter({ visible: true }).first().isVisible()) return false;
        const bubble = text ? activeMessageRows.filter({ hasText: text, visible: true }) : activeMessageRows;
        const currentLogText = await readMessageLogText(activeMessageLog);
        const currentLogTextCount = text ? occurrences(normalizeText(currentLogText), normalizeText(text)) : 0;
        const logChanged = text
          ? currentLogTextCount > previousLogTextCount
          : normalizeText(currentLogText) !== normalizeText(previousLogText);
        const currentSurfaceText = await activeMessageSurface.innerText({ timeout: 500 }).catch(() => '');
        const surfaceChanged = text
          ? occurrences(normalizeText(currentSurfaceText), normalizeText(text)) > previousSurfaceTextCount
          : normalizeText(currentSurfaceText) !== normalizeText(previousSurfaceText);
        if ((await bubble.count() > previousMessages || await activeMessageRows.count() > previousRowCount || logChanged || surfaceChanged) && normalizeText(await textboxText(textbox)) === '') return true;
        await page.waitForTimeout(250);
      } while (Date.now() < deadline);
      return false;
    };
    // Current Facebook exposes an explicit “Press Enter to send” button once
    // the Lexical editor receives text. Clicking that scoped control is more
    // reliable than synthesising Enter (which can clear a contenteditable
    // draft without submitting on some E2EE/new-conversation composers).
    // Keep Enter as the fallback for variants that truly have no named button.
    if (activeSendReady) {
      try { await activeSend.click({ timeout: 15_000 }); }
      catch {
        try { await activeSend.click({ force: true, timeout: 3_000 }); }
        catch { try { await textbox.press('Enter'); } catch { /* confirmed below */ } }
      }
    } else {
      try { await textbox.press('Enter'); } catch { /* confirmed below */ }
    }
    let sent = await waitForSent();
    if (!sent && normalizeText(await textboxText(textbox)) !== '') {
      const interruptedAfterEnter = await guard(page);
      if (interruptedAfterEnter) return interruptedAfterEnter;
      if (await surface.getByText(BLOCKED).filter({ visible: true }).first().isVisible()) return manual('Facebook từ chối gửi tin nhắn. Không tự thử lại.', { profileUrl, messageStatus: 'UNKNOWN' });
      const fallbackSend = messageSendControls(activeComposer).last();
      const fallbackSendReady = await fallbackSend.isVisible().catch(() => false) && await fallbackSend.isEnabled().catch(() => false);
      if (!fallbackSendReady) return manual('Đã gửi bằng Enter nhưng chưa xác nhận được tin nhắn và không có nút Gửi để thử lại. Kiểm tra hội thoại trước khi chạy lại.', { profileUrl, messageStatus: 'UNKNOWN' });
      try {
        await fallbackSend.click({ timeout: 15_000 });
        sent = true;
      } catch {
        try {
          await fallbackSend.click({ force: true, timeout: 3_000 });
          sent = true;
        } catch {
          sent = await fallbackSend.evaluate(element => {
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
    const timeout = this.timing.controlTimeoutMs ?? 10_000;
    const main = page.getByRole('main').first();
    await main.waitFor({ state: 'visible', timeout }).catch(() => undefined);
    if (!(await main.isVisible())) return [];
    const toCandidates = (anchors: Element[]) => anchors.map(anchor => ({
      href: (anchor as HTMLAnchorElement).href,
      name: (anchor.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }));
    // Current Facebook renders the People/member strip above the main
    // landmark. Query the explicit group-member route across the page first;
    // scanning only <main> sees footer/navigation links but misses the actual
    // members. Retain the broader main fallback for older layouts.
    const explicitMemberLinks = page.locator('a[href*="/groups/"][href*="/user/"]');
    await explicitMemberLinks.first().waitFor({ state: 'attached', timeout }).catch(() => undefined);
    let candidates = await explicitMemberLinks.evaluateAll(toCandidates)
      .catch(() => [] as Array<{ href: string; name: string }>);
    const initialExplicitCount = candidates.length;
    let reloadedForMembers = false;
    if (!candidates.length) {
      reloadedForMembers = true;
      await page.keyboard.press('Control+R').catch(() => undefined);
      await page.waitForLoadState('domcontentloaded', { timeout: this.timing.mainTimeoutMs ?? 30_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000 + Math.floor(Math.random() * 2_001));
      await explicitMemberLinks.first().waitFor({ state: 'attached', timeout }).catch(() => undefined);
      candidates = await explicitMemberLinks.evaluateAll(toCandidates)
        .catch(() => [] as Array<{ href: string; name: string }>);
    }
    // Only scroll when the initial People strip has not hydrated. Scrolling
    // first causes Facebook to virtualize that header and remove all member
    // anchors before they can be collected.
    if (!candidates.length) {
      for (let index = 0; index < 3; index += 1) {
        await page.mouse.wheel(0, 700);
        await page.waitForTimeout(350);
      }
      candidates = await explicitMemberLinks.evaluateAll(toCandidates)
        .catch(() => [] as Array<{ href: string; name: string }>);
    }
    if (!candidates.length) {
      candidates = await main.locator('a[href]').evaluateAll(toCandidates)
        .catch(() => [] as Array<{ href: string; name: string }>);
    }
    const currentUserId = await facebookUserId(page);
    const unique = new Map<string, { profileUrl: string; displayName?: string }>();
    for (const candidate of candidates) {
      try {
        if (!isFacebookProfileCandidate(candidate.href)) continue;
        const profileUrl = normalizeFacebookProfileUrl(candidate.href);
        if (currentUserId && profileId(profileUrl) === currentUserId) continue;
        unique.set(profileUrl, { profileUrl, ...(candidate.name ? { displayName: candidate.name.slice(0, 120) } : {}) });
      } catch { /* Navigation and group links are not member profiles. */ }
    }
    const members = [...unique.values()].filter(member => !excluded?.has(member.profileUrl));
    this.memberDiscoveryDiagnostics = {
      pageUrl: page.url(),
      initialExplicitCount,
      reloadedForMembers,
      rawCandidateCount: candidates.length,
      normalizedCandidateCount: unique.size,
      availableCandidateCount: members.length,
    };
    // Fisher-Yates keeps selection random while allowing the flow to skip a
    // member whose Messenger surface is unavailable and try another member.
    for (let index = members.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.random() * (index + 1));
      [members[index], members[swap]] = [members[swap]!, members[index]!];
    }
    return members;
  }

  private async randomVisiblePostReactors(page: Page, excluded?: Set<string>): Promise<Array<{ profileUrl: string; displayName?: string }>> {
    const timeout = this.timing.controlTimeoutMs ?? 10_000;
    const postScope = await resolvePostReactionScope(page);
    if (!postScope) return [];
    // Comet has shipped the reaction counter as a semantic button, a text
    // link, and (in older layouts) a direct /ufi/reaction/profile/browser/
    // link. Never use a broad /like|reaction/ matcher: current Facebook puts
    // "React with Like to … post" before "Like: 1 person", and clicking the
    // former would mutate the post instead of opening the recipient list.
    let trigger = postScope.locator('a[href*="/ufi/reaction/profile/browser/"]').filter({ visible: true }).first();
    if (!(await trigger.isVisible().catch(() => false))) {
      const toolbar = postScope.getByRole('toolbar', { name: REACTION_TOOLBAR }).filter({ visible: true }).first();
      trigger = toolbar.getByRole('button').filter({ visible: true }).first();
    }
    if (!(await trigger.isVisible().catch(() => false))) trigger = postScope.getByRole('button', { name: REACTION_SUMMARY }).filter({ visible: true }).first();
    if (!(await trigger.isVisible().catch(() => false))) trigger = postScope.getByRole('link', { name: REACTION_SUMMARY }).filter({ visible: true }).first();
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
        if (!isFacebookProfileCandidate(candidate.href)) continue;
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
        if (!isFacebookProfileCandidate(candidate.href)) continue;
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

async function facebookOwnProfileIds(session: PlatformSession, page: Page): Promise<Set<string>> {
  const values = new Set<string>();
  for (const candidate of [session.accountExternalId, session.accountUsername]) {
    if (!candidate) continue;
    const identifier = facebookProfileIdentifier(candidate);
    if (identifier) values.add(identifier);
  }
  const cookies = await page.context().cookies('https://www.facebook.com/').catch(() => []);
  const cUser = cookies.find(cookie => cookie.name === 'c_user')?.value;
  if (cUser) values.add(cUser);
  return values;
}

function facebookProfileIdentifier(value: string): string {
  try {
    const normalized = normalizeFacebookProfileUrl(value);
    const url = new URL(normalized);
    return url.searchParams.get('id') ?? url.pathname.replace(/^\//, '').replace(/\/$/, '').toLocaleLowerCase();
  } catch {
    return value.trim().replace(/^@/, '').toLocaleLowerCase();
  }
}

async function resolvePostReactionScope(page: Page): Promise<Locator | undefined> {
  const dialogs = page.getByRole('dialog').filter({ visible: true });
  for (let index = await dialogs.count() - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    const label = ((await dialog.getAttribute('aria-label').catch(() => null)) ?? '').toLowerCase();
    if (/messenger|message|tin nhắn|chat|conversation|cuộc trò chuyện/.test(label)) continue;
    const toolbar = dialog.getByRole('toolbar', { name: REACTION_TOOLBAR }).filter({ visible: true });
    const summary = dialog.getByRole('button', { name: REACTION_SUMMARY }).or(dialog.getByRole('link', { name: REACTION_SUMMARY })).filter({ visible: true });
    if (await toolbar.count().catch(() => 0) || await summary.count().catch(() => 0)) return dialog;
  }
  const main = page.getByRole('main').first();
  await main.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  return await main.isVisible().catch(() => false) ? main : undefined;
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

async function findMessageTextbox(surface: Locator, expectedName: string, expectedProfileUrl: string): Promise<Locator> {
  const candidates = surface.locator('[role="textbox"][contenteditable="true"], textarea').filter({ visible: true });
  const directMessageEditors = surface.locator(
    '[role="textbox"][contenteditable="true"][aria-label^="Write to "], [role="textbox"][contenteditable="true"][aria-label^="Viết cho "]',
  ).filter({ visible: true });
  const directCount = await directMessageEditors.count().catch(() => 0);
  if (directCount) {
    const expected = normalizeText(expectedName).toLocaleLowerCase();
    if (expected) {
      for (let index = directCount - 1; index >= 0; index -= 1) {
        const candidate = directMessageEditors.nth(index);
        const label = normalizeText(await candidate.getAttribute('aria-label').catch(() => '') ?? '').toLocaleLowerCase();
        if (label === `write to ${expected}` || label === `viết cho ${expected}`) return candidate;
      }
    }
    // All restored chats are closed before opening the profile action. If the
    // redirected profile heading is unavailable, the sole visible direct
    // message editor is the composer created by that click.
    if (directCount === 1) return directMessageEditors.first();
  }
  const count = await candidates.count().catch(() => 0);
  if (!count) return candidates.last();
  const expected = normalizeText(expectedName).toLocaleLowerCase();
  const expectedProfileId = facebookProfileIdentifier(expectedProfileUrl);
  if (expectedName || expectedProfileId) {
    let nameMatch: Locator | undefined;
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = candidates.nth(index);
      if (expectedProfileId && await textboxBelongsToProfile(candidate, expectedProfileId)) return candidate;
      if (expected && await textboxBelongsToProfileName(candidate, expected)) return candidate;
      const themed = candidate.locator('xpath=ancestor::*[contains(@style, "--chat-composer")]').last();
      const region = candidate.locator('xpath=ancestor::*[@role="region" or @role="dialog"]').last();
      const root = (await themed.count().catch(() => 0) && await themed.isVisible().catch(() => false)) ? themed : region;
      if (!(await root.count().catch(() => 0))) continue;
      const visibleText = await root.innerText({ timeout: 500 }).catch(() => '');
      const labels = await root.locator('[aria-label]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? '')).catch(() => [] as string[]);
      // Prefer Facebook's exact conversation anchors. A broad text search is
      // unsafe here because an older chat can contain the profile name in a
      // previously sent message while its composer belongs to another person.
      const exact = expected && labels.some(label => {
        const normalized = normalizeText(label).toLocaleLowerCase();
        return normalized === `viết cho ${expected}`
          || normalized === `write to ${expected}`
          || normalized === `tin nhắn trong cuộc trò chuyện với ${expected}`
          || normalized === `messages in conversation with ${expected}`;
      });
      if (exact) return candidate;
      if (expected && !nameMatch && normalizeText(`${visibleText} ${labels.join(' ')}`).toLocaleLowerCase().includes(expected)) nameMatch = candidate;
    }
    if (nameMatch) return nameMatch;
  }
  return candidates.last();
}

async function clickMessageControl(page: Page, control: Locator): Promise<boolean> {
  try {
    await control.click({ timeout: 15_000 });
    // A successful semantic click is enough to proceed to the dedicated
    // composer lookup below. Re-validating here used to reject real Facebook
    // chats whose docked composer reuses an existing textbox slot or whose
    // numeric profile URL redirects to a username. The downstream lookup is
    // profile/name scoped and remains the safety boundary before any text is
    // entered or external-action marker is persisted.
    return true;
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
    const clickedFallback = await page.evaluate(({ source, flags }) => {
      const matcher = new RegExp(source, flags);
      const controls = Array.from(document.querySelectorAll<HTMLElement>('[role="button"][aria-label], a[role="link"][aria-label]'));
      const target = controls.find(element => matcher.test(element.getAttribute('aria-label') ?? ''));
      if (!target) return false;
      target.click();
      return true;
    }, { source: MESSAGE.source, flags: MESSAGE.flags }).catch(() => false);
    return clickedFallback;
  }
}

async function textboxBelongsToProfile(textbox: Locator, expectedProfileId: string): Promise<boolean> {
  let current = textbox;
  for (let depth = 0; depth < 18; depth += 1) {
    const parent = current.locator('xpath=..');
    if (!(await parent.count().catch(() => 0))) return false;
    const visibleTextboxes = await parent.locator('[role="textbox"][contenteditable="true"], textarea').filter({ visible: true }).count().catch(() => 0);
    // Crossing into a container with another composer means the profile link
    // could belong to a sibling chat or the underlying Facebook page.
    if (visibleTextboxes > 1) return false;
    const links = await parent.locator('a[href]').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href)).catch(() => [] as string[]);
    if (links.some(link => facebookProfileIdentifier(link) === expectedProfileId)) return true;
    current = parent;
  }
  return false;
}

async function textboxBelongsToProfileName(textbox: Locator, normalizedExpectedName: string): Promise<boolean> {
  let current = textbox;
  for (let depth = 0; depth < 18; depth += 1) {
    const parent = current.locator('xpath=..');
    if (!(await parent.count().catch(() => 0))) return false;
    const visibleTextboxes = await parent.locator('[role="textbox"][contenteditable="true"], textarea').filter({ visible: true }).count().catch(() => 0);
    if (visibleTextboxes > 1) return false;
    const labels = await parent.locator('[aria-label]').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label') ?? '')).catch(() => [] as string[]);
    if (labels.some(label => {
      const normalized = normalizeText(label).toLocaleLowerCase();
      return normalized === `write to ${normalizedExpectedName}`
        || normalized === `viết cho ${normalizedExpectedName}`
        || normalized === `messages in conversation with ${normalizedExpectedName}`
        || normalized === `tin nhắn trong cuộc trò chuyện với ${normalizedExpectedName}`;
    })) return true;
    const linkNames = await parent.locator('a[href]').allTextContents().catch(() => [] as string[]);
    if (linkNames.some(name => normalizeText(name).toLocaleLowerCase() === normalizedExpectedName)) return true;
    current = parent;
  }
  return false;
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

async function nearestMessageSurface(textbox: Locator, composer: Locator, fallback: Locator, expectedProfileUrl: string): Promise<Locator> {
  // Prefer the profile-bound chat root. Some Comet builds put the historic
  // --chat-composer marker or role=region on a *small composer wrapper* rather
  // than on the whole chat. Returning that wrapper makes a real send invisible
  // to confirmation because the transcript is its sibling.
  const expectedProfileId = facebookProfileIdentifier(expectedProfileUrl);
  let current = textbox;
  for (let depth = 0; depth < 18; depth += 1) {
    const parent = current.locator('xpath=..');
    if (!(await parent.count().catch(() => 0))) break;
    const visibleTextboxes = await parent.locator('[role="textbox"][contenteditable="true"], textarea').filter({ visible: true }).count().catch(() => 0);
    if (visibleTextboxes > 1) break;
    const links = await parent.locator('a[href]').evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href)).catch(() => [] as string[]);
    if (links.some(link => facebookProfileIdentifier(link) === expectedProfileId)) return parent;
    current = parent;
  }
  // Older Messenger layouts do use these markers for the complete chat root.
  // Keep them only as fallbacks when a stable profile link is unavailable.
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
  return isFacebookProfileCandidate(value);
}

const FACEBOOK_SYSTEM_ROUTES = new Set([
  '', 'about', 'ads', 'business', 'checkpoint', 'events', 'friends', 'gaming',
  'groups', 'help', 'home.php', 'login', 'marketplace', 'messages', 'notifications',
  'pages', 'photo', 'plugins', 'policies', 'privacy', 'reel', 'reels', 'recover',
  'search', 'settings', 'stories', 'story', 'terms', 'watch',
]);

function isFacebookProfileCandidate(value: string): boolean {
  const url = new URL(value);
  if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname)) return false;
  if (url.pathname === '/profile.php') return /^\d+$/.test(url.searchParams.get('id') ?? '');
  if (/^\/groups\/[^/]+\/user\/\d+\/?$/.test(url.pathname)) return true;
  if (/^\/people\/[^/]+\/\d+\/?$/.test(url.pathname)) return true;
  const match = /^\/([a-zA-Z0-9._-]+)\/?$/.exec(url.pathname);
  if (!match) return false;
  return !FACEBOOK_SYSTEM_ROUTES.has(match[1]!.toLowerCase());
}

async function textboxText(textbox: Locator): Promise<string> {
  return textbox.evaluate(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : element.textContent ?? '');
}

async function enterMessageText(textbox: Locator, text: string, timeoutMs: number): Promise<void> {
  const nativeInput = await textbox.evaluate(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement).catch(() => false);
  if (nativeInput) {
    await textbox.fill(text);
    return;
  }
  // Facebook Messenger uses a Lexical contenteditable. locator.fill() can
  // mutate its DOM without updating React/Lexical state, leaving the control
  // as “Send a Like”; Enter then clears the apparent draft without sending.
  // Real key events update the editor state and expose “Press Enter to send”.
  await textbox.click({ timeout: timeoutMs });
  await textbox.press('Control+A');
  await textbox.press('Backspace');
  await textbox.pressSequentially(text, { timeout: Math.max(timeoutMs, 15_000) });
}

async function replaceMessageTextAtomically(textbox: Locator, text: string, timeoutMs: number): Promise<void> {
  const nativeInput = await textbox.evaluate(element => element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement).catch(() => false);
  if (nativeInput) {
    await textbox.fill(text, { timeout: timeoutMs });
    return;
  }
  await textbox.click({ timeout: timeoutMs });
  // execCommand is deprecated for author code, but remains the most reliable
  // way to emit one browser-native beforeinput/input transaction into
  // Facebook's controlled contenteditable. Unlike assigning textContent, it
  // updates Lexical state and makes the send action replace “Send a Like”.
  await textbox.evaluate((element, value) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!document.execCommand('insertText', false, value)) throw new Error('Facebook editor rejected atomic text insertion');
  }, text, { timeout: timeoutMs });
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
