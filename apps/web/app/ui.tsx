export type IconName = 'overview' | 'accounts' | 'proxies' | 'facebook' | 'schedules' | 'media' | 'tasks' | 'open' | 'close' | 'edit' | 'delete' | 'test' | 'play' | 'pause' | 'approve' | 'reject' | 'logout' | 'plus' | 'refresh' | 'arrow' | 'search' | 'shield' | 'upload' | 'back' | 'expand' | 'collapse';
const paths: Record<IconName, string[]> = {
  expand: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
  collapse: ['M3 8h5V3M21 8h-5V3M8 21v-5H3M16 21v-5h5'],
  overview: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  accounts: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'],
  proxies: ['M5 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'm7 7 4 9M17 7l-4 9M8 5h8'],
  facebook: ['M15 21v-8h3l.5-4H15V7c0-1 .5-2 2-2h2V2h-3c-3 0-5 2-5 5v2H8v4h3v8'],
  schedules: ['M8 2v4M16 2v4M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', 'm9 15 2 2 4-4'],
  media: ['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'm3 17 6-6 4 4 3-3 5 5M16 7h.01'],
  tasks: ['M9 5h12M9 12h12M9 19h12M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2'],
  open: ['M14 3h7v7m-11 4L21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
  close: ['M18 6 6 18M6 6l12 12'], reject: ['M18 6 6 18M6 6l12 12'],
  edit: ['M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z'],
  delete: ['M3 6h18M8 6V4h8v2m-9 0 1 15h8l1-15M10 10v7m4-7v7'],
  test: ['M5 12a7 7 0 0 1 14 0M8 15a4 4 0 0 1 8 0M12 19h.01'],
  play: ['m8 5 11 7-11 7Z'], pause: ['M8 5v14M16 5v14'], approve: ['m5 12 4 4L19 6'],
  logout: ['M10 17l5-5-5-5M15 12H3M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4'],
  plus: ['M12 5v14M5 12h14'], refresh: ['M20 7v5h-5M4 17v-5h5', 'M6 6a8 8 0 0 1 13 2l1 4M4 12l1 4a8 8 0 0 0 13 2'],
  arrow: ['M5 12h14m-6-6 6 6-6 6'], back: ['M19 12H5m6-6-6 6 6 6'],
  search: ['M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
  shield: ['m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z', 'm8 12 3 3 5-6'], upload: ['M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5'],
};
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name].map((d, i) => <path key={i} d={d} />)}</svg>;
}
export const STATUS_LABELS: Record<string, string> = {
  PAUSED: 'Đã dừng',
  CREATED: 'Mới tạo', READY: 'Sẵn sàng', LOGIN_REQUIRED: 'Cần đăng nhập', RUNNING: 'Đang chạy', CHALLENGED: 'Cần xác minh', EXPIRED: 'Hết hạn', DISABLED: 'Đã tắt', ERROR: 'Lỗi',
  HEALTHY: 'Kết nối tốt', UNHEALTHY: 'Mất kết nối', DRAFT: 'Bản nháp', SCHEDULED: 'Đã lên lịch', QUEUED: 'Đang chờ', SUCCEEDED: 'Hoàn tất', FAILED: 'Thất bại', CANCELLED: 'Đã hủy', REQUIRES_ACTION: 'Cần thao tác',
  STARTING: 'Đang mở', AUTHENTICATED: 'Đã đăng nhập', IDLE: 'Đang chờ', CLOSING: 'Đang đóng', CLOSED: 'Đã đóng', CRASHED: 'Lỗi browser', PENDING: 'Chờ duyệt', APPROVED: 'Đã duyệt', REJECTED: 'Từ chối', NOT_REQUIRED: 'Không yêu cầu',
};
export const ACTION_LABELS: Record<string, string> = { HEALTH_CHECK: 'Kiểm tra phiên', GET_PROFILE: 'Kiểm tra profile', SYNC_FACEBOOK_GROUPS: 'Đồng bộ nhóm', JOIN_FACEBOOK_GROUP: 'Tham gia nhóm', POST_FACEBOOK_GROUP: 'Đăng bài nhóm', PUBLISH_POST: 'Bản nháp nội dung' };
