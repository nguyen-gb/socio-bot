import { normalizeFacebookGroupUrl, type ActionResult } from '@socio/contracts';
import type { Locator, Page } from 'playwright';

export interface GroupSyncTiming {
  syncTimeoutMs?: number;
  syncQuietMs?: number;
  syncPollMs?: number;
}

export async function scanJoinedFacebookGroups(page: Page, check: () => Promise<ActionResult | undefined>, timing: GroupSyncTiming = {}): Promise<ActionResult> {
  const groups = new Map<string, string | null>();
  const deadline = Date.now() + (timing.syncTimeoutMs ?? 4 * 60_000);
  const quietMs = timing.syncQuietMs ?? 8000;
  let quietSince = 0;
  const finish = (complete: boolean, reason?: string, extra: Record<string, unknown> = {}): ActionResult => ({
    ok: complete,
    data: { ...extra, groups: [...groups].map(([groupUrl, groupName]) => ({ groupUrl, groupName })),
      groupCount: groups.size, complete, syncSource: 'JOINED_GROUPS_PAGE',
      ...(!complete ? { requiresAction: true, reason: reason ?? 'Facebook chưa tải hết danh sách nhóm. Đã lưu phần đọc được; hãy đồng bộ lại.' } : {}),
    },
  });
  while (Date.now() < deadline) {
    const interrupted = await check();
    if (interrupted) return finish(false, String(interrupted.data?.reason ?? 'Đồng bộ bị gián đoạn'), interrupted.data);
    const current = new URL(page.url());
    if (!['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(current.hostname) || !/^\/groups\/joins\/?$/.test(current.pathname)) {
      return finish(false, 'Facebook không mở đúng danh sách nhóm đã tham gia; đã dừng đồng bộ.');
    }
    const snapshot = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('[role="main"], main');
      if (!main) return { entries: [], empty: false, loading: true, atBottom: false, moved: false };
      const visible = (element: Element) => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      if (!visible(main)) return { entries: [], empty: false, loading: true, atBottom: false, moved: false };
      const headings = 'h1,h2,h3,h4,[role="heading"]';
      const recommendations = /^(Suggested(?: groups| for you)?|Recommended groups|Groups you may like|Discover(?: groups)?|Nhóm (?:gợi ý|đề xuất|dành cho bạn)|Gợi ý cho bạn|Khám phá nhóm)$/i;
      const excludedParents = new WeakMap<Element, boolean>();
      const eligible = (element: Element) => {
        if (!visible(element) || element.closest('nav,[role="navigation"],article,[role="article"],[role="feed"]')) return false;
        // Recommendation panels can share the main with the joined collection.
        for (let parent = element.parentElement; parent && parent !== main; parent = parent.parentElement) {
          let excluded = excludedParents.get(parent);
          if (excluded === undefined) {
            const heading = parent.querySelector(headings);
            const links = [...parent.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"]')];
            excluded = !!heading && recommendations.test((heading.textContent ?? '').trim())
              || !!links.length && new Set(links.map(link => link.pathname.replace(/\/$/, ''))).size === 1
                && [...parent.querySelectorAll('button,[role="button"]')].some(button => /^(Join|Join group|Tham gia|Tham gia nhóm)$/i.test((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()));
            excludedParents.set(parent, excluded);
          }
          if (excluded) return false;
        }
        return true;
      };
      const anchors = [...main.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"]')].filter(eligible);
      const entries = anchors.map(anchor => ({ url: anchor.href,
        name: (anchor.innerText || anchor.getAttribute('aria-label') || anchor.querySelector('img')?.getAttribute('alt') || '').replace(/\s+/g, ' ').trim(),
      }));
      const text = main.innerText;
      const empty = /You (?:haven.t|have not) joined any groups|You.re not (?:in|a member of) any groups|No groups joined|Bạn chưa tham gia nhóm nào|Bạn chưa tham gia bất kỳ nhóm nào/i.test(text);
      const loading = [...main.querySelectorAll('[role="progressbar"],[aria-busy="true"],[role="status"]')]
        .filter(visible).some(element => element.getAttribute('role') !== 'status' || /loading|đang tải/i.test(element.textContent ?? ''));
      // Facebook may scroll a nested list rather than the document, and may
      // unmount previous rows. Collect before moving every relevant container.
      const scrollers = new Set<Element>();
      for (const target of [main, ...anchors]) {
        for (let parent: Element | null = target; parent; parent = parent.parentElement) {
          if (parent.scrollHeight > parent.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(parent).overflowY)) scrollers.add(parent);
        }
      }
      if (document.scrollingElement) scrollers.add(document.scrollingElement);
      let moved = false;
      for (const element of scrollers) {
        const previous = element.scrollTop;
        // A sub-viewport step avoids skipping virtualized rows.
        element.scrollTop += Math.max(100, Math.floor(element.clientHeight * 0.8));
        moved ||= Math.abs(element.scrollTop - previous) > 1;
      }
      return { entries, empty, loading, moved,
        atBottom: [...scrollers].every(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 3),
      };
    });
    const previousSize = groups.size;
    for (const entry of snapshot.entries) {
      try {
        const groupUrl = normalizeFacebookGroupUrl(entry.url);
        const fallback = new URL(groupUrl).pathname.split('/')[2];
        const name = !entry.name || entry.name === fallback || /^(View group|Visit group|Xem nhóm|Truy cập nhóm)$/i.test(entry.name) ? null : entry.name.slice(0, 255);
        if (!groups.has(groupUrl) || name) groups.set(groupUrl, name ?? groups.get(groupUrl) ?? null);
      } catch { /* Only joined group root links, never posts or external links. */ }
    }
    // Facebook also labels each group-card overflow menu “Xem thêm”. Those
    // controls open a dialog (`aria-haspopup`) and are not list pagination;
    // treating them as load-more keeps the scanner perpetually non-quiet on
    // Vietnamese pages and eventually reports a false incomplete sync.
    const controls = page.getByRole('main').first().getByRole('button', { name: /^(See more|Load more|Show more|Xem thêm|Tải thêm|Hiển thị thêm)$/i })
      .and(page.locator(':not([aria-haspopup]):not(nav *, [role="navigation"] *, article *, [role="article"] *, [role="feed"] *)')).filter({ visible: true });
    let more: Locator | undefined;
    for (const control of await controls.all()) {
      const recommended = await control.evaluate(element => {
        const section = element.closest('section,[role="region"]');
        return !!section && /^(Suggested(?: groups| for you)?|Recommended groups|Groups you may like|Discover(?: groups)?|Nhóm (?:gợi ý|đề xuất|dành cho bạn)|Gợi ý cho bạn|Khám phá nhóm)$/i.test((section.querySelector('h1,h2,h3,[role="heading"]')?.textContent ?? '').trim());
      });
      if (!recommended) { more = control; break; }
    }
    if (more) {
      if (!snapshot.loading && await more.isEnabled()) {
        try { await more.click({ timeout: 2000 }); }
        catch { return finish(false, 'Không mở được phần nhóm tiếp theo. Đã lưu các nhóm đọc được; hãy đồng bộ lại.'); }
      }
    }
    if (groups.size !== previousSize || snapshot.moved || !snapshot.atBottom || snapshot.loading || more || (!groups.size && !snapshot.empty)) quietSince = 0;
    else {
      quietSince ||= Date.now();
      if (Date.now() - quietSince >= quietMs) return finish(true);
    }
    await page.waitForTimeout(timing.syncPollMs ?? 500);
  }
  return finish(false);
}
