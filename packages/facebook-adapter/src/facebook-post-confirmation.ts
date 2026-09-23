export interface FacebookPostConfirmation {
  status: 'PUBLISHED' | 'PENDING_APPROVAL' | 'REJECTED';
  postUrl?: string;
  reason?: string;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();

export function isTaskPostRequest(body: string, groupUrl: string, text: string, actorId: string): boolean {
  try {
    const params = new URLSearchParams(body);
    if (params.get('fb_api_req_friendly_name') !== 'ComposerStoryCreateMutation') return false;
    const input = record(record(JSON.parse(params.get('variables') ?? '')).input);
    return !!actorId && record(input.audience).to_id === new URL(groupUrl).pathname.split('/')[2]
      && input.actor_id === actorId && typeof record(input.message).text === 'string'
      && normalized(record(input.message).text as string) === normalized(text);
  } catch { return false; }
}

// Inspect only the response to the UI's own, task-scoped creation request. This
// never sends API requests and an HTTP 200 alone is not publication evidence.
export function readPostConfirmation(body: string, groupUrl: string, text: string): FacebookPostConfirmation | undefined {
  for (const line of body.trim().replace(/^for\s*\(;;\);\s*/, '').split('\n')) {
    let envelope: Record<string, unknown>;
    try { envelope = record(JSON.parse(line)); } catch { continue; }
    if (Array.isArray(envelope.errors) && envelope.errors.length) return { status: 'REJECTED', reason: 'Facebook báo lỗi khi tạo bài; cần kiểm tra trước khi thử lại.' };
    const created = record(record(envelope.data).story_create);
    const story = record(created.story);
    const target = record(story.to);
    let postUrl: string | undefined;
    try {
      const link = new URL(String(story.url));
      const expected = new URL(groupUrl);
      if (link.protocol === 'https:' && ['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(link.hostname)
        && !link.username && !link.password && (!link.port || link.port === '443')
        && link.pathname.startsWith(expected.pathname)
        && /^(posts|permalink)\/[0-9]+\/?$/.test(link.pathname.slice(expected.pathname.length))) {
        link.search = ''; link.hash = ''; postUrl = link.href;
      }
    } catch { /* Unknown response shape is not success. */ }
    if (target.id !== new URL(groupUrl).pathname.split('/')[2]) continue;
    if (story.is_marked_as_spam_by_admin_assistant === true) return { status: 'REJECTED', postUrl, reason: 'Facebook giữ bài trong mục spam của nhóm. Không gửi lại; hãy kiểm tra công cụ quản trị.' };
    if (Object.keys(record(story.if_viewer_can_learn_more_about_pending_post)).length) return { status: 'PENDING_APPROVAL', postUrl };
    const pendingCard = record(target.if_viewer_can_see_pending_content_card);
    const pendingInfo = record(record(record(record(pendingCard.group_pending_action_card_renderer).group).if_viewer_can_see_pending_content_card).pending_post_info);
    // Public groups can accept membership but still hold a new participant's
    // posts. The creation response may include a feed edge visible only to
    // that author; it is not public publication while participation is pending.
    if (Object.keys(record(pendingCard.if_viewer_cannot_add_pending_participation_content_in_forum)).length
      && typeof pendingInfo.pending_content_section_title === 'string'
      && /Pending admin approval|Chờ.*(?:quản trị|phê duyệt)/i.test(pendingInfo.pending_content_section_title)) return { status: 'PENDING_APPROVAL', postUrl };
    if (typeof story.scheduled_publish_time === 'number' && story.scheduled_publish_time > 0) return { status: 'REJECTED', postUrl, reason: 'Facebook đang lên lịch bài thay vì đăng ngay. Kiểm tra bài đã lên lịch, không gửi lại.' };
    const node = record(record(created.group_feed_story_edge).node);
    const message = record(record(record(record(node.comet_sections).content).story).message);
    if (!postUrl || typeof node.post_id !== 'string' || !/^[0-9]+$/.test(node.post_id)
      || new URL(postUrl).pathname.split('/').filter(Boolean).at(-1) !== node.post_id
      || typeof message.text !== 'string' || normalized(message.text) !== normalized(text)) continue;
    return { status: 'PUBLISHED', postUrl };
  }
  return undefined;
}
