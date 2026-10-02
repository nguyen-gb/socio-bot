import type { PlatformMediaFile } from '@socio/platform-core';
import type { Locator, Page } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PHOTO_CONTROL = /^(?:Photo\/?video|Photos\/?videos|Photo or video|Add photos\/?videos|Add photos|Photo|Photos|Attach a photo(?: or video)?|Attach photo(?: or video)?|Attach a file up to 100 ?MB|Đính kèm file có kích thước tối đa là 100 ?MB|Add photo(?: or video)?|Add media|Media|Image|Images|Picture|Pictures|Ảnh|Ảnh\/?video|Ảnh hoặc video|Thêm ảnh\/?video|Thêm ảnh|Chọn ảnh|Hình ảnh|Đính kèm ảnh(?: hoặc video)?)$/i;
const MORE_ACTIONS = /^(?:More actions|Open more actions|More options|Open more options|Mở hành động khác|Mở thêm hành động|Xem thêm hành động|Hành động khác)$/i;
const REMOVE_PHOTO = /^(Remove (?:photo|image)(?: \d+)?|Delete (?:photo|image)(?: \d+)?|Xóa ảnh(?: \d+)?|Gỡ ảnh(?: \d+)?)$/i;
const UPLOAD_ERROR = /couldn.t upload|failed to upload|upload failed|unable to upload|couldn.t add.*photo|không thể tải.*(?:ảnh|lên)|tải.*(?:ảnh|lên).*thất bại/i;

// Inspect the composer's own new, decoded thumbnails. Avatar images that were
// already present before selection cannot satisfy this check.
async function sources(dialog: Locator) {
  return dialog.locator('img').evaluateAll(elements => elements.filter(element => {
    const image = element as HTMLImageElement;
    const rect = image.getBoundingClientRect();
    const source = image.currentSrc || image.src;
    // Existing avatars and post media are regular https URLs and can be
    // lazy-loaded while the comment list scrolls.  A freshly selected local
    // attachment is represented by a blob/data URL until Facebook finishes
    // the upload, so only those thumbnails are valid upload evidence.
    const localPreview = source.startsWith('blob:') || source.startsWith('data:');
    return localPreview && image.complete && image.naturalWidth > 0 && rect.width >= 16 && rect.height >= 16;
  }).map(element => (element as HTMLImageElement).src));
}

export async function attachFacebookImages(page: Page, dialog: Locator, files: PlatformMediaFile[], timeoutMs = 60_000, readyControl?: Locator, observationDialog?: Locator, fallbackDialog?: Locator): Promise<() => Promise<boolean>> {
  // Always stage media to worker-local files.  The browser-worker can run
  // through a remote Playwright transport; passing Buffer payloads directly
  // to setInputFiles() can silently produce an empty multipart upload even
  // though the call itself succeeds.  A real path keeps the bytes intact for
  // both local and remote Chromium sessions.  Files are retained until the
  // upload is confirmed by attachPreparedImages().
  const directory = await mkdtemp(join(tmpdir(), 'socio-facebook-images-'));
  try {
    const paths: string[] = [];
    const usedNames = new Set<string>();
    const useIndexedNames = files.reduce((total, file) => total + file.buffer.length, 0) >= 50 * 1024 * 1024;
    for (const [index, file] of files.entries()) {
      const extension = file.mimeType === 'image/jpeg' ? 'jpg' : file.mimeType === 'image/png' ? 'png' : 'webp';
      const requestedName = file.name?.replace(/[\\/]+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '') || `${index}.${extension}`;
      const baseName = requestedName.includes('.') ? requestedName : `${requestedName}.${extension}`;
      // Keep the compact indexed names for large staged batches. Besides
      // avoiding long multipart metadata, this preserves the original
      // large-upload behavior while normal-sized uploads retain useful names.
      let safeName = useIndexedNames ? `${index}.${extension}` : baseName;
      if (usedNames.has(safeName)) safeName = `${index}-${baseName}`;
      usedNames.add(safeName);
      const path = join(directory, safeName);
      await writeFile(path, file.buffer, { mode: 0o600 }); paths.push(path);
    }
    return await attachPreparedImages(page, dialog, paths, timeoutMs, readyControl, observationDialog, fallbackDialog);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function attachPreparedImages(page: Page, dialog: Locator, files: PlatformMediaFile[] | string[], timeoutMs: number, readyControl?: Locator, observationDialog?: Locator, fallbackDialog?: Locator): Promise<() => Promise<boolean>> {
  const observation = observationDialog ?? dialog;
  const originalSources = new Set(await sources(observation));
  const originalRemoveCount = await observation.getByRole('button', { name: REMOVE_PHOTO }).filter({ visible: true }).count();
  // Messenger's composer exposes a reusable file input with accept="*/*"
  // (unlike the post composer, which advertises image MIME types). The API
  // already validates every media asset as an image, so scope to the
  // composer's file input instead of filtering on its accept attribute.
  const scopedInputs = dialog.locator('input[type="file"]');
  const scopedMultipleInputs = dialog.locator('input[type="file"][multiple]');
  const fallbackInputs = fallbackDialog?.locator('input[type="file"]');
  const fallbackMultipleInputs = fallbackDialog?.locator('input[type="file"][multiple]');
  // Facebook mounts more than one hidden picker in a post dialog. The picker
  // paired with the photo/video action advertises multiple=true; prefer it so
  // we do not upload through an unrelated single-file input (which results in
  // a zero-byte /ajax/ufi/upload request).
  const scopedInput = (await scopedMultipleInputs.count()) ? scopedMultipleInputs.first() : scopedInputs.first();
  const fallbackInput = fallbackDialog
    ? (await fallbackMultipleInputs!.count()) ? fallbackMultipleInputs!.first() : fallbackInputs!.first()
    : undefined;
  const input = (await scopedInput.count()) ? scopedInput : fallbackInput ?? scopedInput;
  // Prefer the visible semantic photo control.  Facebook keeps a hidden,
  // page-level input mounted in the post dialog even when the inline reply
  // action row has its own picker; selecting the first input blindly sends an
  // empty multipart request to /ajax/ufi/upload.
  let photoButton = await resolvePhotoButton(dialog) ?? (fallbackDialog ? await resolvePhotoButton(fallbackDialog) : undefined);
  // In the docked Messenger layout Facebook collapses the attachment tools
  // behind a localized “More actions” (+) button.  The photo control is only
  // mounted after that menu is opened, so resolve and click the menu trigger
  // before looking for the actual picker.  Keep the trigger scoped to the
  // selected chat composer; never open a page-level menu from another surface.
  if (!photoButton) {
    const trigger = await resolveMoreActions(dialog) ?? (fallbackDialog ? await resolveMoreActions(fallbackDialog) : undefined);
    if (trigger) {
      await trigger.click({ timeout: 5_000 }).catch(async () => {
        await trigger.click({ force: true, timeout: 2_000 }).catch(() => undefined);
      });
      await page.waitForTimeout(250);
      const menu = page.getByRole('menu').filter({ visible: true }).last();
      photoButton = await resolvePhotoButton(menu) ?? await resolvePhotoButton(dialog) ?? (fallbackDialog ? await resolvePhotoButton(fallbackDialog) : undefined);
    }
  }
  if (!photoButton && await input.count()) {
    if (files.length > 1 && !(await input.evaluate(element => (element as HTMLInputElement).multiple))) {
      throw new Error('Khung soạn hiện tại không hỗ trợ chọn nhiều ảnh; chưa gửi bài.');
    }
    await input.setInputFiles(files, { timeout: 15_000 });
  } else {
    // Keep the semantic locator free of Playwright's visible filter. Facebook
    // replaces this action-row node while Messenger hydrates; the extra
    // visibility predicate can keep resolving the detached node forever.
    let button = photoButton;
    const buttonScope = fallbackDialog ?? dialog;
    if (!button || !(await button.isVisible().catch(() => false))) throw new Error('Không tìm thấy nút thêm ảnh trong khung soạn bài; chưa gửi bài.');
    // Some variants reveal a drop zone first; others open the picker directly.
    let chooser: import('playwright').FileChooser | undefined;
    const receive = (event: import('playwright').FileChooser) => { chooser = event; };
    page.on('filechooser', receive);
    try {
      // Messenger can replace the composer action row while the E2EE thread
      // hydrates. Retry the same semantic control instead of force-clicking a
      // stale DOM node through that transition.
      const clickUntil = Date.now() + 10_000;
      let clicked = false;
      while (Date.now() < clickUntil && !chooser) {
        const currentButton = await resolvePhotoButton(buttonScope) ?? button;
        try {
          if (await currentButton.isVisible()) {
            try {
              // Messenger may replace this node between the actionability
              // check and pointer dispatch. Keep each attempt short so a
              // detached node cannot consume the whole retry window.
              await currentButton.click({ timeout: 450 });
              clicked = true;
              break;
            } catch {
              // A force click keeps the semantic locator but skips the
              // stability wait that Facebook's animated E2EE action row can
              // never satisfy while it is being replaced.
              try {
                await currentButton.click({ force: true, timeout: 350 });
                clicked = true;
                break;
              } catch { /* Try the direct node and coordinate fallbacks below. */ }
              // Invoke the currently resolved semantic element directly before
              // querying coordinates. This bypasses actionability/stability
              // checks while preserving Facebook's own click handler.
              const clickedCurrentNode = await currentButton.evaluate(element => {
                (element as HTMLElement).click();
                return true;
              }, undefined, { timeout: 250 }).catch(() => false);
              if (clickedCurrentNode) {
                clicked = true;
                break;
              }
              // Use the fresh semantic control's current box as a fallback.
              // The bounded timeout is important: locator.boundingBox() can
              // otherwise wait for the default 15s after a React detach.
              const box = await currentButton.boundingBox({ timeout: 250 }).catch(() => null);
              if (box) {
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => undefined);
                clicked = true;
                break;
              }
              // If the node is replaced before Playwright can resolve it,
              // query the current document synchronously and dispatch the
              // semantic control's click without retaining a stale locator.
              const clickedCurrentDom = await page.evaluate(({ source, flags }) => {
                const matcher = new RegExp(source, flags);
                const controls = Array.from(document.querySelectorAll<HTMLElement>('[role="button"][aria-label], button[aria-label]'));
                const target = controls.find(control => {
                  const rect = control.getBoundingClientRect();
                  return matcher.test(control.getAttribute('aria-label') ?? '')
                    && rect.width > 0 && rect.height > 0
                    && getComputedStyle(control).visibility !== 'hidden';
                });
                if (!target) return false;
                target.click();
                return true;
              }, { source: PHOTO_CONTROL.source, flags: PHOTO_CONTROL.flags }).catch(() => false);
              if (clickedCurrentDom) {
                clicked = true;
                break;
              }
            }
          }
        } catch { /* Wait for Messenger's action row to settle after re-render. */ }
        await page.waitForTimeout(100);
      }
      if (!clicked && !chooser) throw new Error('Không thể mở nút thêm ảnh trong khung soạn bài; chưa gửi bài.');
      const until = Date.now() + 10_000;
      while (!chooser && !(await buttonScope.locator('input[type="file"]').count()) && Date.now() < until) {
        const add = buttonScope.getByRole('button', { name: /^(Add photos\/videos|Add photos|Thêm ảnh\/video|Thêm ảnh)$/i }).first();
        if (await add.isVisible()) { await add.click({ timeout: 2000 }); break; }
        await page.waitForTimeout(100);
      }
      if (chooser) {
        if (files.length > 1 && !chooser.isMultiple()) throw new Error('Khung soạn chỉ cho phép một ảnh; chưa gửi bài.');
        await chooser.setFiles(files, { timeout: 15_000 });
      } else {
        // The picker may be represented by a fresh hidden input after the
        // action row is clicked. Prefer the newest scoped input; the original
        // page-level input is only a last-resort fallback.
        const postClickInputs = buttonScope.locator('input[type="file"]');
        const postClickInput = await postClickInputs.count() ? postClickInputs.last() : input;
        await postClickInput.waitFor({ state: 'attached', timeout: 5000 });
        if (files.length > 1 && !(await postClickInput.evaluate(element => (element as HTMLInputElement).multiple))) throw new Error('Khung soạn chỉ cho phép một ảnh; chưa gửi bài.');
        await postClickInput.setInputFiles(files, { timeout: 15_000 });
      }
    } finally { page.off('filechooser', receive); }
  }
  const ready = async () => {
    if (!(await observation.isVisible()) || await observation.getByText(UPLOAD_ERROR).filter({ visible: true }).count()) return false;
    if (await observation.locator('[role="progressbar"], [aria-busy="true"]').filter({ visible: true }).count()) return false;
    const previews = (await sources(observation)).filter(source => !originalSources.has(source));
    const removeCount = await observation.getByRole('button', { name: REMOVE_PHOTO }).filter({ visible: true }).count() - originalRemoveCount;
    return previews.length >= files.length || removeCount === files.length;
  };
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (await observation.getByText(UPLOAD_ERROR).filter({ visible: true }).count()) throw new Error('Facebook báo lỗi tải ảnh; chưa gửi bài.');
    const control = readyControl ?? observation.getByRole('button', { name: /^(Post|Đăng|Submit|Gửi)$/i }).first();
    if (await ready() && await control.isVisible() && await control.isEnabled()) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 750) return ready;
    } else stableSince = 0;
    await page.waitForTimeout(150);
  }
  throw new Error('Chưa xác nhận tất cả ảnh tải xong trên Facebook; chưa gửi bài.');
}

async function resolvePhotoButton(scope: Locator): Promise<Locator | undefined> {
  const semantic = scope.getByRole('button', { name: PHOTO_CONTROL })
    .or(scope.getByRole('menuitem', { name: PHOTO_CONTROL }))
    .first();
  if (await semantic.isVisible().catch(() => false)) return semantic;
  // A few Facebook builds expose the action as a role=button div with a
  // title/aria-label rather than a button element. Keep the search scoped to
  // the reply surface so Messenger controls can never be selected.
  const candidates = scope.locator('[role="button"][aria-label], button[aria-label], [role="button"][title], button[title]').filter({ visible: true });
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const label = (await candidate.getAttribute('aria-label').catch(() => null)) ?? (await candidate.getAttribute('title').catch(() => null)) ?? '';
    if (PHOTO_CONTROL.test(label.trim())) return candidate;
  }
  return undefined;
}

async function resolveMoreActions(scope: Locator): Promise<Locator | undefined> {
  const semantic = scope.getByRole('button', { name: MORE_ACTIONS }).first();
  if (await semantic.isVisible().catch(() => false)) return semantic;
  const candidates = scope.locator('[role="button"][aria-label], button[aria-label], [role="button"][title], button[title]').filter({ visible: true });
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const label = (await candidate.getAttribute('aria-label').catch(() => null)) ?? (await candidate.getAttribute('title').catch(() => null)) ?? '';
    if (MORE_ACTIONS.test(label.trim())) return candidate;
  }
  return undefined;
}
