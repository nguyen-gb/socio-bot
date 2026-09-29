import type { PlatformMediaFile } from '@socio/platform-core';
import type { Locator, Page } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PHOTO_CONTROL = /^(Photo\/?video|Photos\/?videos|Add photos\/?videos|Add photos|Photo|Photos|Attach a photo|Attach photo|Attach a file up to 100 MB|Add photo|Ảnh\/?video|Thêm ảnh\/?video|Thêm ảnh|Đính kèm ảnh(?: hoặc video)?)$/i;
const REMOVE_PHOTO = /^(Remove (?:photo|image)(?: \d+)?|Delete (?:photo|image)(?: \d+)?|Xóa ảnh(?: \d+)?|Gỡ ảnh(?: \d+)?)$/i;
const UPLOAD_ERROR = /couldn.t upload|failed to upload|upload failed|unable to upload|couldn.t add.*photo|không thể tải.*(?:ảnh|lên)|tải.*(?:ảnh|lên).*thất bại/i;

// Inspect the composer's own new, decoded thumbnails. Avatar images that were
// already present before selection cannot satisfy this check.
async function sources(dialog: Locator) {
  return dialog.locator('img').evaluateAll(elements => elements.filter(element => {
    const image = element as HTMLImageElement;
    const rect = image.getBoundingClientRect();
    return image.complete && image.naturalWidth > 0 && rect.width >= 40 && rect.height >= 40;
  }).map(element => (element as HTMLImageElement).src));
}

export async function attachFacebookImages(page: Page, dialog: Locator, files: PlatformMediaFile[], timeoutMs = 60_000, readyControl?: Locator): Promise<() => Promise<boolean>> {
  // Playwright rejects buffer payloads totalling >= 50 MB. For larger batches,
  // use worker-local files and keep them until Facebook finishes the upload.
  if (files.reduce((total, file) => total + file.buffer.length, 0) < 50 * 1024 * 1024) {
    return attachPreparedImages(page, dialog, files, timeoutMs, readyControl);
  }
  const directory = await mkdtemp(join(tmpdir(), 'socio-facebook-images-'));
  try {
    const paths: string[] = [];
    for (const [index, file] of files.entries()) {
      const extension = file.mimeType === 'image/jpeg' ? 'jpg' : file.mimeType === 'image/png' ? 'png' : 'webp';
      const path = join(directory, `${index}.${extension}`);
      await writeFile(path, file.buffer, { mode: 0o600 }); paths.push(path);
    }
    return await attachPreparedImages(page, dialog, paths, timeoutMs, readyControl);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function attachPreparedImages(page: Page, dialog: Locator, files: PlatformMediaFile[] | string[], timeoutMs: number, readyControl?: Locator): Promise<() => Promise<boolean>> {
  const originalSources = new Set(await sources(dialog));
  const originalRemoveCount = await dialog.getByRole('button', { name: REMOVE_PHOTO }).filter({ visible: true }).count();
  // Messenger's composer exposes a reusable file input with accept="*/*"
  // (unlike the post composer, which advertises image MIME types). The API
  // already validates every media asset as an image, so scope to the
  // composer's file input instead of filtering on its accept attribute.
  const input = dialog.locator('input[type="file"]').first();
  if (await input.count()) {
    if (files.length > 1 && !(await input.evaluate(element => (element as HTMLInputElement).multiple))) {
      throw new Error('Khung soạn hiện tại không hỗ trợ chọn nhiều ảnh; chưa gửi bài.');
    }
    await input.setInputFiles(files, { timeout: 15_000 });
  } else {
    // Keep the semantic locator free of Playwright's visible filter. Facebook
    // replaces this action-row node while Messenger hydrates; the extra
    // visibility predicate can keep resolving the detached node forever.
    const button = dialog.getByRole('button', { name: PHOTO_CONTROL }).first();
    if (!(await button.isVisible())) throw new Error('Không tìm thấy nút thêm ảnh trong khung soạn bài; chưa gửi bài.');
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
        const currentButton = dialog.getByRole('button', { name: PHOTO_CONTROL }).first();
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
      while (!chooser && !(await input.count()) && Date.now() < until) {
        const add = dialog.getByRole('button', { name: /^(Add photos\/videos|Add photos|Thêm ảnh\/video|Thêm ảnh)$/i }).first();
        if (await add.isVisible()) { await add.click({ timeout: 2000 }); break; }
        await page.waitForTimeout(100);
      }
      if (chooser) {
        if (files.length > 1 && !chooser.isMultiple()) throw new Error('Khung soạn chỉ cho phép một ảnh; chưa gửi bài.');
        await chooser.setFiles(files, { timeout: 15_000 });
      } else {
        await input.waitFor({ state: 'attached', timeout: 5000 });
        if (files.length > 1 && !(await input.evaluate(element => (element as HTMLInputElement).multiple))) throw new Error('Khung soạn chỉ cho phép một ảnh; chưa gửi bài.');
        await input.setInputFiles(files, { timeout: 15_000 });
      }
    } finally { page.off('filechooser', receive); }
  }
  const ready = async () => {
    if (!(await dialog.isVisible()) || await dialog.getByText(UPLOAD_ERROR).filter({ visible: true }).count()) return false;
    if (await dialog.locator('[role="progressbar"], [aria-busy="true"]').filter({ visible: true }).count()) return false;
    const previews = (await sources(dialog)).filter(source => !originalSources.has(source));
    const removeCount = await dialog.getByRole('button', { name: REMOVE_PHOTO }).filter({ visible: true }).count() - originalRemoveCount;
    return previews.length >= files.length || removeCount === files.length;
  };
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (await dialog.getByText(UPLOAD_ERROR).filter({ visible: true }).count()) throw new Error('Facebook báo lỗi tải ảnh; chưa gửi bài.');
    const control = readyControl ?? dialog.getByRole('button', { name: /^(Post|Đăng|Submit|Gửi)$/i }).first();
    if (await ready() && await control.isVisible() && await control.isEnabled()) {
      stableSince ||= Date.now();
      if (Date.now() - stableSince >= 750) return ready;
    } else stableSince = 0;
    await page.waitForTimeout(150);
  }
  throw new Error('Chưa xác nhận tất cả ảnh tải xong trên Facebook; chưa gửi bài.');
}
