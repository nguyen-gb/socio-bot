'use client';

import { cloneElement, isValidElement, type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Dropdown, Empty, Flex, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { ActionButton, CampaignDetailOverview, CampaignStartBar, CampaignSummary, PageSectionTitle, tablePagination } from './admin-ui';
import { Icon } from './ui';
import { ContextNote as Alert } from './context-note';
import { useToast, useToastError } from './toast';
import { CampaignImagePicker } from './facebook-post-images';

interface Account { id: string; username?: string; platform: string; status: string }
interface VideoRow { videoUrl: string; videoId?: string; title?: string; username?: string; profileUrl?: string; description?: string; thumbnailUrl?: string; likes?: number; publishedAt?: string; views?: number; comments?: number; statsSource?: 'TIKTOK_VIDEO_STATS' }
interface TikTokReportEntry {
  runId?: string;
  action?: string;
  status?: string;
  videoUrl?: string;
  username?: string;
  profileUrl?: string;
  postUrl?: string;
  displayName?: string;
  thumbnailUrl?: string;
  title?: string;
  description?: string;
  reason?: string;
  completedAt?: string;
}
interface TikTokPayload { name?: string; query?: string; username?: string; videoUrls?: string[]; text?: string; mediaAssetIds?: string[]; maxVideos?: number; maxFollowers?: number; maxReplies?: number; maxLikes?: number; minLikes?: number; intervalSeconds?: number; intervalMinSeconds?: number; intervalMaxSeconds?: number; excludeVideoUrls?: string[]; excludeUsernames?: string[]; resumeCompletedCount?: number; completedCountsByVideo?: Record<string, number> }
interface TaskItem { id: string; batchId?: string | null; action: string; status: string; approvalStatus?: string; attemptCount?: number; createdAt: string; lastError?: string; pausedAt?: string | null; cancelledAt?: string | null; createdBy?: { id: string; email: string; displayName?: string | null } | null; account: Account; payload?: TikTokPayload; runs?: Array<{ startedAt?: string; result?: unknown }> }
interface TikTokCampaign { id: string; tasks: TaskItem[]; representative: TaskItem; status: string }
interface TikTokWorkspaceProps { accounts: Account[]; canOperate: boolean; canAdmin: boolean; onNavigateProfiles: () => void }
type CreateMode = 'SEARCH' | 'AUTO_COMMENT' | 'ACTION' | 'MESSAGE_FOLLOWERS';
type ActionMode = 'COMMENT' | 'REPLY' | 'LIKE';

const terminalStatuses = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'REQUIRES_ACTION']);

async function apiJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({})) as T & { message?: string | string[] };
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Phiên đăng nhập đã hết hạn.');
  }
  if (!response.ok) throw new Error(Array.isArray(payload.message) ? payload.message.join('. ') : payload.message ?? 'Yêu cầu thất bại');
  return payload;
}

function numberLabel(value?: number): string {
  return value == null ? '—' : value.toLocaleString('vi-VN');
}

function resultObject(task?: TaskItem): Record<string, unknown> | undefined {
  const result = task?.runs?.[0]?.result;
  return result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
}

function reportEntries(task?: TaskItem): TikTokReportEntry[] {
  const report = resultObject(task)?.report;
  if (!report || typeof report !== 'object' || Array.isArray(report)) return [];
  const entries = (report as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is TikTokReportEntry => Boolean(entry && typeof entry === 'object'));
}

function reportTarget(entry: TikTokReportEntry): ReactNode {
  // Prefer the most specific target. A video report can also contain the
  // creator profile, but the report row should take the user to the exact
  // video that was acted on.
  const url = entry.videoUrl ?? entry.postUrl ?? entry.profileUrl;
  if (!url) return 'Đối tượng không xác định';

  const isVideo = Boolean(entry.videoUrl);
  const label = isVideo
    ? entry.title ?? entry.description ?? (entry.username ? `@${entry.username.replace(/^@/, '')}` : 'Video TikTok')
    : entry.displayName ?? (entry.username ? `@${entry.username.replace(/^@/, '')}` : entry.postUrl ? 'Bài viết' : 'Trang cá nhân');

  return <Flex gap={8} align="flex-start" style={{ minWidth: 240 }}>
    {entry.thumbnailUrl ? <img src={entry.thumbnailUrl} alt="" loading="lazy" width={42} height={56} style={{ objectFit: 'cover', borderRadius: 4, flex: '0 0 auto' }} /> : null}
    <Space orientation="vertical" size={0} style={{ minWidth: 0 }}>
      <Typography.Text strong>{label}</Typography.Text>
      <a href={url} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }} title={url}>{url}</a>
    </Space>
  </Flex>;
}

function reportStatus(status?: string): ReactNode {
  const normalized = status?.toUpperCase();
  const success = normalized === 'SENT' || normalized === 'LIKED';
  return <Tag color={success ? 'green' : normalized === 'FAILED' ? 'red' : 'orange'}>{success ? 'Thành công' : normalized === 'FAILED' ? 'Thất bại' : normalized ?? 'Không rõ'}</Tag>;
}

function reportEntryKey(entry: TikTokReportEntry): string {
  return [
    entry.runId ?? 'RUN',
    entry.action ?? 'ACTION',
    entry.status ?? 'STATUS',
    entry.username ?? entry.profileUrl ?? entry.videoUrl ?? entry.postUrl ?? 'TARGET',
    entry.completedAt ?? 'TIME',
    entry.reason ?? '',
  ].join('|');
}

function isStaleBrowserRun(task: TaskItem): boolean {
  const startedAt = task.runs?.[0]?.startedAt;
  return task.status === 'RUNNING' && Boolean(startedAt) && Date.now() - new Date(startedAt!).getTime() >= 18 * 60_000;
}

function checkpointCanContinue(task: TaskItem): boolean {
  if (!['AUTO_COMMENT_TIKTOK_HOME', 'COMMENT_TIKTOK_VIDEOS', 'REPLY_TIKTOK_COMMENTS', 'LIKE_TIKTOK_COMMENTS', 'MESSAGE_TIKTOK_FOLLOWERS'].includes(task.action)) return false;
  if (resultObject(task)?.checkpointUncertain === true) return false;
  const entries = reportEntries(task);
  const successful = entries.filter(entry => entry.status === 'SENT' || entry.status === 'LIKED');
  return successful.length > 0 && !entries.some(entry => entry.status === 'IN_PROGRESS' || entry.status === 'UNKNOWN');
}

function resultVideos(task?: TaskItem): VideoRow[] {
  const videos = resultObject(task)?.videos;
  if (!Array.isArray(videos)) return [];
  return videos.filter((item): item is VideoRow => Boolean(item && typeof item === 'object' && typeof (item as VideoRow).videoUrl === 'string')).map(video => video.statsSource === 'TIKTOK_VIDEO_STATS'
    ? video
    : { ...video, views: undefined, comments: undefined });
}

function retrySafety(task: TaskItem): 'SAFE' | 'VERIFY' | 'BLOCKED' {
  if (!['FAILED', 'REQUIRES_ACTION'].includes(task.status) && !isIncompleteTikTokCampaign(task) && !isStaleBrowserRun(task)) return 'BLOCKED';
  if (task.action === 'SEARCH_TIKTOK_VIDEOS') return 'SAFE';
  const result = resultObject(task);
  return task.attemptCount === 0 || result?.sideEffectStarted === false || checkpointCanContinue(task) ? 'SAFE' : 'VERIFY';
}

function actionLabel(action: string): string {
  return {
    SEARCH_TIKTOK_VIDEOS: 'Search video',
    AUTO_COMMENT_TIKTOK_HOME: 'Auto-comment For You',
    COMMENT_TIKTOK_VIDEOS: 'Comment video đã chọn',
    REPLY_TIKTOK_COMMENTS: 'Reply comment video đã chọn',
    LIKE_TIKTOK_COMMENTS: 'Tim comment video đã chọn',
    MESSAGE_TIKTOK_FOLLOWERS: 'IB follower của kênh',
  }[action] ?? action;
}

function campaignProgress(task: TaskItem): { completed?: number; requested?: number } {
  const result = resultObject(task);
  const entries = reportEntries(task);
  const checkpointSent = entries.filter(entry => entry.status === 'SENT' || entry.status === 'LIKED').length;
  const completed = result && typeof result.totalSent === 'number' ? result.totalSent : result && typeof result.sent === 'number' ? result.sent : result && typeof result.liked === 'number' ? result.liked : checkpointSent > 0 ? checkpointSent : undefined;
  const configuredReplyTarget = (task.payload?.videoUrls?.length ?? 0) * (task.payload?.maxReplies ?? 0);
  const configuredLikeTarget = (task.payload?.videoUrls?.length ?? 0) * (task.payload?.maxLikes ?? 0);
  const configuredMessageTarget = task.payload?.maxFollowers ?? 0;
  const requested = task.action === 'REPLY_TIKTOK_COMMENTS' && configuredReplyTarget > 0
    ? configuredReplyTarget
    : task.action === 'LIKE_TIKTOK_COMMENTS' && configuredLikeTarget > 0
      ? configuredLikeTarget
      : task.action === 'MESSAGE_TIKTOK_FOLLOWERS' && configuredMessageTarget > 0
        ? configuredMessageTarget
        : result && typeof result.totalRequested === 'number' ? result.totalRequested : result && typeof result.requested === 'number' ? result.requested : undefined;
  return { completed, requested };
}

function isIncompleteTikTokCampaign(task: TaskItem): boolean {
  if (task.action === 'SEARCH_TIKTOK_VIDEOS') return false;
  const { completed, requested } = campaignProgress(task);
  return completed != null && requested != null && requested > 0 && completed < requested;
}

function taskTag(task: TaskItem) {
  if (task.approvalStatus === 'PENDING') return <Tag color="orange">Chờ duyệt</Tag>;
  if (task.cancelledAt && task.status === 'RUNNING') return <Tag color="red">Đang hủy</Tag>;
  if (task.status === 'SUCCEEDED' && isIncompleteTikTokCampaign(task)) return <Tag color="red">Chưa đủ chỉ tiêu</Tag>;
  if (task.status === 'SUCCEEDED') return <Tag color="green">Hoàn tất</Tag>;
  if (isStaleBrowserRun(task)) return <Tag color="red">Browser hết thời hạn</Tag>;
  if (['FAILED', 'REQUIRES_ACTION'].includes(task.status)) {
    const verificationNeeded = task.status === 'REQUIRES_ACTION'
      && (retrySafety(task) === 'VERIFY' || /timed out|timeout|hết thời hạn/i.test(task.lastError ?? ''));
    return <Tag color="red">{task.status === 'REQUIRES_ACTION' ? (verificationNeeded ? 'Cần kiểm tra kết quả' : 'Cần thao tác') : 'Lỗi'}</Tag>;
  }
  if (task.pausedAt && task.status === 'RUNNING') return <Tag color="orange">Đang tạm dừng</Tag>;
  if (task.status === 'PAUSED') return <Tag color="orange">Đã tạm dừng</Tag>;
  if (task.status === 'RUNNING') return <Tag color="blue">Đang chạy</Tag>;
  if (task.status === 'QUEUED' || task.status === 'SCHEDULED') return <Tag color="blue">Đang chờ</Tag>;
  return <Tag>{task.status}</Tag>;
}

function groupedCampaignStatus(tasks: TaskItem[]): string {
  if (tasks.some(task => task.cancelledAt && task.status === 'RUNNING')) return 'CANCELLING';
  if (tasks.some(task => task.pausedAt && task.status === 'RUNNING')) return 'PAUSING';
  if (tasks.some(task => task.approvalStatus === 'PENDING')) return 'PENDING';
  if (tasks.some(task => task.status === 'RUNNING')) return 'RUNNING';
  if (tasks.some(task => ['QUEUED', 'SCHEDULED'].includes(task.status))) return 'QUEUED';
  if (tasks.some(task => task.status === 'REQUIRES_ACTION')) return 'REQUIRES_ACTION';
  if (tasks.some(task => task.status === 'FAILED')) return 'FAILED';
  if (tasks.some(isIncompleteTikTokCampaign)) return 'FAILED';
  if (tasks.some(task => task.status === 'PAUSED')) return 'PAUSED';
  if (tasks.every(task => task.status === 'CANCELLED')) return 'CANCELLED';
  if (tasks.every(task => task.status === 'SUCCEEDED')) return 'SUCCEEDED';
  return tasks[0]?.status ?? 'DRAFT';
}

const tiktokStatusLabels: Record<string, string> = {
  ALL: 'Tất cả trạng thái', PENDING: 'Chờ duyệt', DRAFT: 'Bản nháp', QUEUED: 'Đang chờ', SCHEDULED: 'Đã lên lịch',
  RUNNING: 'Đang chạy', PAUSING: 'Đang yêu cầu dừng', PAUSED: 'Đã tạm dừng', SUCCEEDED: 'Hoàn tất', FAILED: 'Lỗi',
  REQUIRES_ACTION: 'Cần thao tác', CANCELLING: 'Đang yêu cầu hủy', CANCELLED: 'Đã hủy',
};

function groupedCampaignTag(campaign: TikTokCampaign) {
  const color = campaign.status === 'SUCCEEDED' ? 'green' : ['FAILED', 'REQUIRES_ACTION', 'CANCELLING', 'CANCELLED'].includes(campaign.status) ? 'red' : ['RUNNING', 'QUEUED'].includes(campaign.status) ? 'blue' : 'orange';
  return <Tag color={color}>{tiktokStatusLabels[campaign.status] ?? campaign.status}</Tag>;
}

function campaignResult(task: TaskItem): string {
  const result = resultObject(task);
  const { completed, requested } = campaignProgress(task);
  const configuredReplyTarget = (task.payload?.videoUrls?.length ?? 0) * (task.payload?.maxReplies ?? 0);
  const configuredLikeTarget = (task.payload?.videoUrls?.length ?? 0) * (task.payload?.maxLikes ?? 0);
  const configuredMessageTarget = task.payload?.maxFollowers ?? 0;
  if (task.action === 'SEARCH_TIKTOK_VIDEOS') return result && typeof result.count === 'number' ? `${result.count} video` : 'Chưa có kết quả';
  if (task.action === 'COMMENT_TIKTOK_VIDEOS' || task.action === 'AUTO_COMMENT_TIKTOK_HOME') return completed != null ? `Đã comment ${completed}/${requested ?? task.payload?.maxVideos ?? 0}` : 'Chưa chạy';
  if (task.action === 'REPLY_TIKTOK_COMMENTS') return completed != null ? `Đã reply ${completed}/${requested ?? configuredReplyTarget}` : 'Chưa chạy';
  if (task.action === 'LIKE_TIKTOK_COMMENTS') return completed != null ? `Đã tim ${completed}/${requested ?? configuredLikeTarget}` : 'Chưa chạy';
  if (task.action === 'MESSAGE_TIKTOK_FOLLOWERS') return completed != null ? `Đã IB ${completed}/${requested ?? configuredMessageTarget}` : 'Chưa chạy';
  return '—';
}

function campaignResultReason(task: TaskItem): string | undefined {
  const result = resultObject(task);
  const { completed, requested } = campaignProgress(task);
  // A successful campaign that reached its configured target can still have
  // a stale per-video failure in a checkpoint/report. The summary must show
  // the final aggregate result, not that intermediate error beside N/N.
  if (task.status === 'SUCCEEDED' && completed != null && requested != null && completed >= requested) return undefined;

  // A retry intentionally carries the previous checkpoint/report so already
  // completed targets are not repeated. `lastError`, however, belongs to the
  // current attempt and must win over a failed entry retained from an older
  // run; otherwise every retry appears to show the first failure forever.
  const currentAttemptError = task.lastError?.trim();
  if (currentAttemptError) return currentAttemptError;

  // When the campaign is incomplete, the latest failed target is more useful
  // than the adapter's firstFailureReason because later targets may fail for
  // a different, more actionable reason.
  const reportReason = [...reportEntries(task)].reverse().find(entry => entry.status === 'FAILED' && entry.reason?.trim())?.reason?.trim();
  if (reportReason) return reportReason;
  const resultReason = result && typeof result.reason === 'string' ? result.reason.trim() : '';
  if (resultReason) return resultReason;
  if (task.action === 'REPLY_TIKTOK_COMMENTS') {
    const configuredReplyTarget = (task.payload?.videoUrls?.length ?? 0) * (task.payload?.maxReplies ?? 0);
    if (configuredReplyTarget > 0 && completed === 0) return 'Không tìm thấy comment TikTok có thể reply hoặc danh sách comment chưa tải được.';
  }
  if (task.action === 'LIKE_TIKTOK_COMMENTS') {
    const configuredLikeTarget = (task.payload?.videoUrls?.length ?? 0) * (task.payload?.maxLikes ?? 0);
    if (configuredLikeTarget > 0 && completed === 0) return 'Không tìm thấy comment TikTok có nút tim hoặc danh sách comment chưa tải được.';
  }
  if (task.action === 'MESSAGE_TIKTOK_FOLLOWERS') {
    const configuredMessageTarget = task.payload?.maxFollowers ?? 0;
    if (configuredMessageTarget > 0 && completed === 0) return 'Không tìm thấy follower khả dụng hoặc danh sách follower chưa tải được.';
  }
  return undefined;
}

function Field({ label, children, required = false }: { label: string; children: ReactNode; required?: boolean }) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ id?: string }>, { id })
    : children;
  return <div className="tiktok-field"><label htmlFor={id}>{label}{required ? <span className="field-required" aria-hidden="true"> *</span> : null}</label>{control}</div>;
}

function NumberField({ label, value, onChange, min, max, placeholder, required = false }: { label: string; value?: number; onChange: (value: number | undefined) => void; min?: number; max?: number; placeholder?: string; required?: boolean }) {
  const id = useId();
  return <div className="tiktok-field tiktok-number-field"><label htmlFor={id}>{label}{required ? <span className="field-required" aria-hidden="true"> *</span> : null}</label><InputNumber id={id} min={min} max={max} value={value} onChange={next => onChange(next ?? undefined)} placeholder={placeholder} /></div>;
}

function IntervalRangeField({ value, onChange, required = false }: { value: [number, number]; onChange: (value: [number, number]) => void; required?: boolean }) {
  const minimumId = useId();
  const maximumId = useId();
  return <div className="tiktok-field tiktok-interval-field">
    <label htmlFor={minimumId}>Chờ ngẫu nhiên (giây){required ? <span className="field-required" aria-hidden="true"> *</span> : null}</label>
    <div className="tiktok-interval-inputs">
      <div className="tiktok-interval-input"><span>Từ</span><InputNumber id={minimumId} aria-label="Thời gian chờ tối thiểu" min={5} max={86_400} value={value[0]} onChange={next => { const minimum = next ?? 8; onChange([minimum, Math.max(minimum, value[1])]); }} /></div>
      <span className="tiktok-interval-separator" aria-hidden="true">–</span>
      <div className="tiktok-interval-input"><span>Đến</span><InputNumber id={maximumId} aria-label="Thời gian chờ tối đa" min={value[0]} max={86_400} value={value[1]} onChange={next => onChange([value[0], Math.max(value[0], next ?? 12)])} /></div>
    </div>
  </div>;
}

interface TikTokTaskPlan { accountId: string; payload: Record<string, unknown> }

function splitCount(total: number, count: number): number[] {
  const allocations = Array.from({ length: count }, () => 0);
  for (let index = 0; index < Math.max(0, Math.floor(total)); index += 1) allocations[index % count]! += 1;
  return allocations;
}

function distributeTikTokTasks(action: string, payload: Record<string, unknown>, accountIds: string[]): TikTokTaskPlan[] {
  if (!accountIds.length) return [];
  if (action === 'SEARCH_TIKTOK_VIDEOS') return [{ accountId: accountIds[0]!, payload }];

  if (action === 'AUTO_COMMENT_TIKTOK_HOME' || action === 'MESSAGE_TIKTOK_FOLLOWERS') {
    const field = action === 'AUTO_COMMENT_TIKTOK_HOME' ? 'maxVideos' : 'maxFollowers';
    const total = typeof payload[field] === 'number' ? payload[field] as number : 0;
    return splitCount(total, accountIds.length)
      .map((allocated, index) => allocated > 0 ? { accountId: accountIds[index]!, payload: { ...payload, [field]: allocated } } : undefined)
      .filter((plan): plan is TikTokTaskPlan => Boolean(plan));
  }

  if (['COMMENT_TIKTOK_VIDEOS', 'REPLY_TIKTOK_COMMENTS', 'LIKE_TIKTOK_COMMENTS'].includes(action)) {
    const videoUrls = Array.isArray(payload.videoUrls)
      ? payload.videoUrls.filter((value): value is string => typeof value === 'string')
      : [];
    const assigned = accountIds.map(() => [] as string[]);
    videoUrls.forEach((videoUrl, index) => assigned[index % assigned.length]!.push(videoUrl));
    const plans: Array<TikTokTaskPlan | undefined> = assigned.map((urls, index) => urls.length > 0 ? {
      accountId: accountIds[index]!,
      payload: { ...payload, videoUrls: urls, ...(action === 'COMMENT_TIKTOK_VIDEOS' ? { maxVideos: urls.length } : {}) },
    } : undefined);
    return plans.filter((plan): plan is TikTokTaskPlan => Boolean(plan));
  }

  return accountIds.map(accountId => ({ accountId, payload }));
}

export default function TikTokWorkspace({ accounts, canOperate, canAdmin, onNavigateProfiles }: TikTokWorkspaceProps) {
  const toast = useToast();
  const setError = useToastError();
  const { modal } = App.useApp();
  const tiktokAccounts = useMemo(() => accounts.filter(account => account.platform === 'TIKTOK'), [accounts]);
  const draftableAccounts = useMemo(() => tiktokAccounts.filter(account => account.status !== 'DISABLED'), [tiktokAccounts]);
  // Search is read-only and runs in a clean temporary browser context, so it
  // can use any TikTok account as a queue/tenant anchor without requiring a
  // logged-in account. Side-effect actions still require a READY/RUNNING one.
  const queueableAccounts = useMemo(() => tiktokAccounts.filter(account => account.status === 'READY' || account.status === 'RUNNING'), [tiktokAccounts]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>('SEARCH');
  const [accountScope, setAccountScope] = useState<'ALL' | 'SELECTED'>('ALL');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [maxVideos, setMaxVideos] = useState(100);
  const [minLikes, setMinLikes] = useState<number>();
  const [maxLikesFilter, setMaxLikesFilter] = useState<number>();
  const [minViews, setMinViews] = useState<number>();
  const [maxViews, setMaxViews] = useState<number>();
  const [homeText, setHomeText] = useState('');
  const [homeLimit, setHomeLimit] = useState(10);
  const [homeMinLikes, setHomeMinLikes] = useState(0);
  const [homeMaxLikes, setHomeMaxLikes] = useState<number>();
  const [homeIntervalRange, setHomeIntervalRange] = useState<[number, number]>([8, 12]);
  const [followerUsername, setFollowerUsername] = useState('');
  const [followerLimit, setFollowerLimit] = useState(20);
  const [followerIntervalRange, setFollowerIntervalRange] = useState<[number, number]>([8, 12]);
  const [actionMode, setActionMode] = useState<ActionMode>('COMMENT');
  const [actionText, setActionText] = useState('');
  const [actionReplyLimit, setActionReplyLimit] = useState(10);
  const [actionLikeLimit, setActionLikeLimit] = useState(10);
  const [actionIntervalRange, setActionIntervalRange] = useState<[number, number]>([8, 12]);
  const [mediaAssetIds, setMediaAssetIds] = useState<string[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>();
  const [selectedVideoUrls, setSelectedVideoUrls] = useState<string[]>([]);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('ALL');
  const [taskLimit, setTaskLimit] = useState(100);
  const [approvingId, setApprovingId] = useState<string>();
  const [retryingId, setRetryingId] = useState<string>();
  const [cancellingId, setCancellingId] = useState<string>();
  const [pausingId, setPausingId] = useState<string>();
  const [resumingId, setResumingId] = useState<string>();
  const [creatingTask, setCreatingTask] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [creationKey, setCreationKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (createMode === 'SEARCH') return;
    const available = new Set(draftableAccounts.map(account => account.id));
    setAccountIds(current => current.filter(id => available.has(id)));
  }, [createMode, draftableAccounts]);

  const tasks = useQuery({
    queryKey: ['tasks', taskLimit],
    queryFn: () => apiJson<TaskItem[]>(`/api/control/tasks?take=${taskLimit}`),
    refetchInterval: query => ((query.state.data as TaskItem[] | undefined) ?? []).some(task =>
      ['QUEUED', 'SCHEDULED', 'RUNNING'].includes(task.status),
    ) ? 5_000 : false,
  });
  const taskCampaigns = useMemo(() => {
    const needle = campaignSearch.trim().toLocaleLowerCase();
    const relevant = (tasks.data ?? []).filter(task => task.action.startsWith('SEARCH_TIKTOK') || task.action.startsWith('AUTO_COMMENT_TIKTOK') || task.action.startsWith('COMMENT_TIKTOK') || task.action.startsWith('REPLY_TIKTOK') || task.action.startsWith('LIKE_TIKTOK') || task.action.startsWith('MESSAGE_TIKTOK'));
    const grouped = new Map<string, TaskItem[]>();
    for (const task of relevant) grouped.set(task.batchId ?? task.id, [...(grouped.get(task.batchId ?? task.id) ?? []), task]);
    return [...grouped].map(([id, campaignTasks]): TikTokCampaign => ({ id, tasks: campaignTasks, representative: campaignTasks[0]!, status: groupedCampaignStatus(campaignTasks) }))
      .filter(campaign => campaignFilter === 'ALL' || campaign.status === campaignFilter)
      .filter(campaign => !needle || campaign.tasks.some(task => [task.payload?.name, task.payload?.query, task.payload?.username, task.account.username, actionLabel(task.action)].filter(Boolean).some(value => String(value).toLocaleLowerCase().includes(needle))))
      .sort((left, right) => new Date(right.representative.createdAt).getTime() - new Date(left.representative.createdAt).getTime());
  }, [campaignFilter, campaignSearch, tasks.data]);
  const selectedGroup = taskCampaigns.find(campaign => campaign.id === selectedCampaignId);
  const selectedCampaign = selectedGroup?.representative;
  const selectedResults = resultVideos(selectedCampaign);
  const selectedSourceAccount = selectedCampaign?.account.id ?? tiktokAccounts[0]?.id;
  const selectedCount = selectedVideoUrls.length;
  const selectedReportEntries = selectedGroup?.tasks.flatMap(reportEntries) ?? [];
  const runningCount = taskCampaigns.filter(campaign => ['RUNNING', 'QUEUED', 'SCHEDULED'].includes(campaign.status)).length;
  const failedCount = taskCampaigns.filter(campaign => ['FAILED', 'REQUIRES_ACTION'].includes(campaign.status)).length;
  const completedCount = taskCampaigns.filter(campaign => campaign.status === 'SUCCEEDED').length;

  // Search uses an anonymous browser context and only keeps a TikTok account
  // as the technical task owner. Other campaigns follow Facebook's flow:
  // empty selection means every READY/RUNNING profile, while explicit values
  // limit the campaign to the selected profiles.
  const targetAccountIds = createMode === 'SEARCH'
    ? (tiktokAccounts[0] ? [tiktokAccounts[0].id] : [])
    : accountScope === 'SELECTED' ? accountIds : draftableAccounts.map(account => account.id);
  const targetAccountsReady = createMode === 'SEARCH' || targetAccountIds.length > 0 && targetAccountIds.every(id => queueableAccounts.some(account => account.id === id));

  const resetCreate = (mode: CreateMode) => {
    setCreateMode(mode); setCreateOpen(true); setError(undefined);
    setCreationKey(crypto.randomUUID());
    setAccountScope('ALL'); setAccountIds([]);
    if (mode === 'SEARCH') { setName(''); setQuery(''); setSelectedCampaignId(undefined); setSelectedVideoUrls([]); }
    if (mode === 'AUTO_COMMENT') { setName(''); setHomeText(''); setHomeIntervalRange([8, 12]); }
    if (mode === 'MESSAGE_FOLLOWERS') { setName(''); setFollowerUsername(''); setFollowerLimit(20); setFollowerIntervalRange([8, 12]); setActionText(''); setMediaAssetIds([]); }
  };

  const createTask = async (action: string, payload: Record<string, unknown>, successText: string, runImmediately = false) => {
    const taskPlans = distributeTikTokTasks(action, payload, targetAccountIds);
    if (!canOperate || !taskPlans.length) return;
    setCreatingTask(true);
    try {
      const batch = await apiJson<{ tasks: Array<{ id: string; batchId?: string | null }> }>('/api/tasks/batch', {
        idempotencyKey: creationKey,
        tasks: taskPlans.map(plan => ({
          action: { platform: 'TIKTOK', accountId: plan.accountId, action, payload: plan.payload },
        })),
      });
      if (runImmediately) {
        try {
          await apiJson('/api/tasks/batch/approve', { taskIds: batch.tasks.map(task => task.id) });
        } catch (approvalError) {
          setCreateOpen(false);
          await tasks.refetch();
          const reason = approvalError instanceof Error ? approvalError.message : String(approvalError);
          throw new Error(`Batch đã được lưu nguyên vẹn nhưng chưa thể duyệt: ${reason}. Hãy duyệt từ danh sách campaign.`);
        }
      }
      await tasks.refetch();
      setCreateOpen(false);
      setSelectedCampaignId(batch.tasks[0]?.batchId ?? batch.tasks[0]?.id);
      setSelectedVideoUrls([]);
      toast.success(action === 'SEARCH_TIKTOK_VIDEOS'
        ? `${successText} đã được đưa vào chạy ngay.`
        : runImmediately
          ? `${successText} đã được duyệt và xếp hàng cho ${taskPlans.length} profile.`
          : `${successText} đã được tạo cho ${taskPlans.length} profile và đang chờ duyệt.`);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : String(caught);
      setError(detail);
    } finally {
      setCreatingTask(false);
    }
  };

  const submitSearch = () => {
    if (!name.trim() || !query.trim()) return;
    void createTask('SEARCH_TIKTOK_VIDEOS', { name, query, maxVideos, ...(minLikes == null ? {} : { minLikes }), ...(maxLikesFilter == null ? {} : { maxLikes: maxLikesFilter }), ...(minViews == null ? {} : { minViews }), ...(maxViews == null ? {} : { maxViews }) }, 'Campaign Search video');
  };

  const submitHomeComment = (runImmediately = false) => {
    if (!name.trim() || !homeText.trim()) return;
    return createTask('AUTO_COMMENT_TIKTOK_HOME', { name, text: homeText, maxVideos: homeLimit, minLikes: homeMinLikes, ...(homeMaxLikes == null ? {} : { maxLikes: homeMaxLikes }), intervalMinSeconds: homeIntervalRange[0], intervalMaxSeconds: homeIntervalRange[1] }, 'Campaign auto-comment', runImmediately);
  };

  const submitFollowerMessage = (runImmediately = false) => {
    if (!name.trim() || !followerUsername.trim() || (!actionText.trim() && !mediaAssetIds.length)) return;
    return createTask('MESSAGE_TIKTOK_FOLLOWERS', { name, username: followerUsername, text: actionText, mediaAssetIds, maxFollowers: followerLimit, intervalMinSeconds: followerIntervalRange[0], intervalMaxSeconds: followerIntervalRange[1] }, 'Campaign IB follower TikTok', runImmediately);
  };

  const submitAction = (runImmediately = false) => {
    if (!name.trim() || !selectedVideoUrls.length || !targetAccountIds.length) return;
    if (actionMode !== 'LIKE' && !actionText.trim()) return;
    const shared = { name, videoUrls: selectedVideoUrls, intervalMinSeconds: actionIntervalRange[0], intervalMaxSeconds: actionIntervalRange[1] };
    const action = actionMode === 'COMMENT' ? 'COMMENT_TIKTOK_VIDEOS' : actionMode === 'REPLY' ? 'REPLY_TIKTOK_COMMENTS' : 'LIKE_TIKTOK_COMMENTS';
    const payload = actionMode === 'COMMENT'
      ? { ...shared, text: actionText, maxVideos: selectedVideoUrls.length }
      : actionMode === 'REPLY'
        ? { ...shared, text: actionText, maxReplies: actionReplyLimit }
        : { ...shared, maxLikes: actionLikeLimit };
    return createTask(action, payload, `Campaign ${actionLabel(action)}`, runImmediately);
  };

  const openSearchResults = (campaign: TaskItem) => {
    setSelectedCampaignId(campaign.id); setSelectedVideoUrls([]);
  };

  const startActionFromSelection = () => {
    if (!selectedVideoUrls.length || !selectedCampaign) return;
    setAccountScope('SELECTED');
    setAccountIds(selectedSourceAccount && queueableAccounts.some(account => account.id === selectedSourceAccount) ? [selectedSourceAccount] : []);
    setCreateMode('ACTION'); setCreateOpen(true); setActionMode('COMMENT'); setActionText(''); setActionIntervalRange([8, 12]); setMediaAssetIds([]);
    setName(`Hành động trên ${selectedVideoUrls.length.toString()} video`);
  };

  const createDialogTitle = createMode === 'SEARCH' ? 'Search video' : createMode === 'AUTO_COMMENT' ? 'Auto-comment For You' : createMode === 'MESSAGE_FOLLOWERS' ? 'IB follower của kênh TikTok' : 'Hành động trên video đã chọn';
  const createDialogSubmitDisabled = createMode === 'SEARCH'
    ? creatingTask || uploadingImages || !canOperate || !targetAccountIds.length || !name.trim() || !query.trim()
    : createMode === 'AUTO_COMMENT'
      ? creatingTask || uploadingImages || !canOperate || !targetAccountIds.length || !name.trim() || !homeText.trim()
      : createMode === 'MESSAGE_FOLLOWERS'
        ? creatingTask || uploadingImages || !canOperate || !targetAccountIds.length || !name.trim() || !followerUsername.trim() || (!actionText.trim() && !mediaAssetIds.length)
        : creatingTask || uploadingImages || !canOperate || !targetAccountIds.length || !name.trim() || !selectedVideoUrls.length || actionMode !== 'LIKE' && !actionText.trim();
  const saveDraft = () => {
    if (createMode === 'AUTO_COMMENT') void submitHomeComment(false);
    else if (createMode === 'MESSAGE_FOLLOWERS') void submitFollowerMessage(false);
    else if (createMode === 'ACTION') void submitAction(false);
  };
  const runNow = () => modal.confirm({
    title: 'Kiểm tra trước khi xếp hàng campaign TikTok',
    content: <Space orientation="vertical" size={10} style={{ width: '100%' }}><Typography.Text><strong>{name}</strong></Typography.Text><Typography.Text>{targetAccountIds.length} profile · {createMode === 'AUTO_COMMENT' ? `${homeLimit} video tối đa` : createMode === 'MESSAGE_FOLLOWERS' ? `${followerLimit} follower tối đa` : `${selectedVideoUrls.length} video đã chọn`}</Typography.Text><Alert type="warning" showIcon title="Đây là hành động thật trên TikTok" description="Campaign sẽ được duyệt và xếp hàng; comment, reply, tim hoặc tin nhắn chỉ bắt đầu khi đến lượt của từng profile." /></Space>,
    okText: 'Duyệt & xếp hàng',
    cancelText: 'Quay lại chỉnh sửa',
    onOk: () => createMode === 'AUTO_COMMENT' ? submitHomeComment(true) : createMode === 'MESSAGE_FOLLOWERS' ? submitFollowerMessage(true) : submitAction(true),
  });
  const approveCampaign = (task: TaskItem) => modal.confirm({
    title: 'Duyệt và xếp hàng campaign TikTok?',
    content: 'Campaign sẽ thực hiện comment, reply hoặc tim comment thật khi đến lượt. Nếu profile đang có campaign khác, campaign này sẽ nối vào cuối hàng đợi.',
    okText: 'Duyệt & chạy',
    cancelText: 'Quay lại',
    onOk: async () => {
      setApprovingId(task.id);
      try {
        await apiJson(`/api/tasks/${task.id}/approve`, {});
        await tasks.refetch();
        toast.success('Đã duyệt và xếp hàng campaign TikTok.');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      } finally {
        setApprovingId(undefined);
      }
    },
  });
  const retryTask = (task: TaskItem) => {
    if (task.action !== 'SEARCH_TIKTOK_VIDEOS' && task.account.status !== 'READY' && !isStaleBrowserRun(task)) {
      onNavigateProfiles();
      return;
    }
    const isActionRetry = task.action !== 'SEARCH_TIKTOK_VIDEOS';
    const canContinue = isActionRetry && checkpointCanContinue(task);
    const requiresResultConfirmation = isActionRetry && retrySafety(task) === 'VERIFY';
    modal.confirm({
      title: canContinue ? 'Tiếp tục phần còn lại của campaign?' : requiresResultConfirmation ? 'Đã kiểm tra kết quả trên TikTok?' : isActionRetry ? 'Chạy lại campaign TikTok?' : 'Chạy lại Search video?',
      content: canContinue
        ? 'Hệ thống đã lưu các đối tượng đã hoàn tất và sẽ bỏ qua chúng, chỉ chạy phần còn lại trong chỉ tiêu.'
        : requiresResultConfirmation
          ? 'Browser đã hết thời hạn sau khi có thể đã thực hiện một hành động. Hãy mở TikTok, kiểm tra Inbox hoặc đối tượng đích và chỉ xác nhận nếu bạn đã kiểm tra kết quả. Sau khi xác nhận, campaign sẽ được chạy lại phần chưa có checkpoint chắc chắn; có thể phát sinh gửi trùng nếu kiểm tra chưa đầy đủ.'
          : isActionRetry
            ? 'Campaign hiện tại sẽ được duyệt và xếp hàng chạy lại; comment, reply, tim comment hoặc IB là hành động thật.'
            : 'Campaign Search hiện tại sẽ được đưa vào chạy lại với cùng từ khóa và giới hạn. Search chỉ đọc metadata, không comment, không like và không gửi tin nhắn.',
      okText: canContinue ? 'Tiếp tục phần còn lại' : requiresResultConfirmation ? 'Tôi đã kiểm tra, chạy lại' : isActionRetry ? 'Chạy lại campaign' : 'Chạy lại Search',
      cancelText: 'Quay lại',
      onOk: async () => {
        setRetryingId(task.id);
        try {
          const retried = await apiJson<{ id: string }>(`/api/tasks/${task.id}/${isActionRetry ? 'retry-action' : 'retry'}`, isActionRetry ? { confirmResultChecked: requiresResultConfirmation } : {});
          await tasks.refetch();
          setSelectedCampaignId(retried.id);
          setSelectedVideoUrls([]);
          toast.success(isActionRetry ? 'Đã đưa campaign TikTok hiện tại vào hàng đợi chạy lại.' : 'Đã đưa campaign Search hiện tại chạy lại.');
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
          throw caught;
        } finally {
          setRetryingId(undefined);
        }
      },
    });
  };
  const cancelTask = (task: TaskItem) => modal.confirm({
    title: `Hủy campaign “${task.payload?.name ?? actionLabel(task.action)}”?`,
    content: task.status === 'RUNNING' ? 'Campaign và browser đang chạy sẽ được dừng ngay; checkpoint hiện tại vẫn được giữ để đối chiếu.' : 'Phần chưa chạy sẽ bị hủy và không thể tiếp tục campaign này.',
    okText: 'Hủy campaign',
    cancelText: 'Giữ lại',
    okButtonProps: { danger: true },
    onOk: async () => {
      setCancellingId(task.id);
      try {
        await apiJson(`/api/tasks/${task.id}/cancel`, {});
        await tasks.refetch();
        toast.success('Đã cập nhật trạng thái hủy campaign TikTok.');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      } finally {
        setCancellingId(undefined);
      }
    },
  });
  const pauseTask = async (task: TaskItem) => {
    setPausingId(task.id);
    try {
      await apiJson(`/api/tasks/${task.id}/pause`, {});
      await tasks.refetch();
      toast.success('Đã tạm dừng campaign TikTok và yêu cầu đóng browser đang chạy.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPausingId(undefined);
    }
  };
  const resumeTask = async (task: TaskItem) => {
    setResumingId(task.id);
    try {
      await apiJson(`/api/tasks/${task.id}/resume`, {});
      await tasks.refetch();
      toast.success('Đã tiếp tục campaign TikTok và đưa phần còn lại vào hàng đợi.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setResumingId(undefined);
    }
  };
  const approveCampaignGroup = (campaign: TikTokCampaign) => modal.confirm({
    title: 'Duyệt và xếp hàng toàn bộ campaign TikTok?',
    content: `${campaign.tasks.length} tác vụ trên ${new Set(campaign.tasks.map(task => task.account.id)).size} profile sẽ được duyệt cùng nhau và xếp vào hàng đợi.`,
    okText: 'Duyệt & xếp hàng', cancelText: 'Quay lại',
    onOk: async () => {
      setApprovingId(campaign.id);
      try { await apiJson('/api/tasks/batch/approve', { taskIds: campaign.tasks.filter(task => task.approvalStatus === 'PENDING').map(task => task.id) }); await tasks.refetch(); toast.success('Đã duyệt và xếp hàng toàn bộ campaign TikTok.'); }
      catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); throw caught; }
      finally { setApprovingId(undefined); }
    },
  });
  const controlCampaignGroup = (campaign: TikTokCampaign, action: 'pause' | 'resume' | 'cancel') => {
    const eligible = campaign.tasks.filter(task => action === 'pause'
      ? !task.pausedAt && !task.cancelledAt && ['RUNNING', 'SCHEDULED', 'QUEUED'].includes(task.status)
      : action === 'resume' ? task.status === 'PAUSED' && !task.cancelledAt
        : !['SUCCEEDED', 'CANCELLED'].includes(task.status) && !task.cancelledAt);
    const execute = async () => {
      const setter = action === 'pause' ? setPausingId : action === 'resume' ? setResumingId : setCancellingId;
      setter(campaign.id);
      try { await Promise.all(eligible.map(task => apiJson(`/api/tasks/${task.id}/${action}`, {}))); await tasks.refetch(); toast.success(action === 'pause' ? 'Đã gửi yêu cầu tạm dừng toàn bộ campaign.' : action === 'resume' ? 'Đã tiếp tục toàn bộ phần còn lại của campaign.' : 'Đã gửi yêu cầu hủy toàn bộ campaign.'); }
      catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); throw caught; }
      finally { setter(undefined); }
    };
    if (action === 'cancel') modal.confirm({ title: `Yêu cầu hủy “${campaign.representative.payload?.name ?? actionLabel(campaign.representative.action)}”?`, content: 'Các tác vụ chưa chạy sẽ bị hủy; tác vụ đang chạy sẽ dừng tại điểm an toàn và giữ checkpoint.', okText: 'Yêu cầu hủy', cancelText: 'Giữ lại', okButtonProps: { danger: true }, onOk: execute });
    else void execute();
  };
  const createDialogContent = <>
    <div className={`tiktok-form-grid${createMode !== 'SEARCH' ? ' tiktok-form-grid-2' : ''}`}>
    {createMode !== 'SEARCH' ? <Field label="Phạm vi profile" required><Select value={accountScope} onChange={setAccountScope} options={[{ value: 'ALL', label: `Tất cả profile chưa bị vô hiệu hóa (${draftableAccounts.length})` }, { value: 'SELECTED', label: 'Chọn profile cụ thể' }]} /></Field> : null}
      <Field label="Tên chiến dịch" required><Input value={name} onChange={event => setName(event.target.value)} placeholder="Ví dụ: Search áo khoác tháng 10" /></Field>
    </div>
    {createMode !== 'SEARCH' && accountScope === 'SELECTED' ? <Field label="Profile thực hiện" required><Select mode="multiple" allowClear showSearch maxTagCount="responsive" maxCount={100} value={accountIds} onChange={setAccountIds} options={draftableAccounts.map(account => ({ value: account.id, label: `${account.username ?? account.id}${account.status === 'RUNNING' ? ' · đang chạy, sẽ xếp hàng' : account.status === 'READY' ? '' : ` · ${account.status}`}` }))} placeholder="Chọn một hoặc nhiều profile" optionFilterProp="label" notFoundContent="Không có profile TikTok" /></Field> : null}

    {createMode === 'SEARCH' ? <>
      <DividerLike title="Thiết lập Search video" />
      <div className="tiktok-search-row">
        <Field label="Từ khóa" required><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Ví dụ: áo khoác nam" /></Field>
        <NumberField label="Số video tối đa" required value={maxVideos} onChange={value => setMaxVideos(value ?? 100)} min={1} max={100} />
      </div>
      <div className="tiktok-filter-grid">
        <NumberField label="Tim tối thiểu" value={minLikes} onChange={setMinLikes} min={0} placeholder="Bỏ qua" />
        <NumberField label="Tim tối đa" value={maxLikesFilter} onChange={setMaxLikesFilter} min={0} placeholder="Bỏ qua" />
        <NumberField label="View tối thiểu" value={minViews} onChange={setMinViews} min={0} placeholder="Bỏ qua" />
        <NumberField label="View tối đa" value={maxViews} onChange={setMaxViews} min={0} placeholder="Bỏ qua" />
      </div>
      <Alert type="info" showIcon title="Search là campaign đọc dữ liệu và chạy ngay" description="Search dùng user-data tạm, không cần chọn hoặc đăng nhập profile TikTok, không lưu bản nháp và không cần duyệt. Kết quả metadata sẽ được lưu vào campaign để bạn có thể chọn video sau; bạn cũng có thể đóng dialog mà không tạo campaign hành động." />
    </> : null}

    {createMode === 'AUTO_COMMENT' ? <>
      <DividerLike title="Thiết lập auto-comment For You" />
      <Field label="Nội dung comment" required><Input.TextArea rows={4} value={homeText} onChange={event => setHomeText(event.target.value)} placeholder="Nội dung comment" /></Field>
      <div className="tiktok-compact-settings-row">
        <NumberField label="Số video" value={homeLimit} onChange={value => setHomeLimit(value ?? 10)} min={1} max={100} />
        <NumberField label="Tim từ" value={homeMinLikes} onChange={value => setHomeMinLikes(value ?? 0)} min={0} />
        <NumberField label="Tim đến" value={homeMaxLikes} onChange={setHomeMaxLikes} min={0} placeholder="Không giới hạn" />
        <IntervalRangeField value={homeIntervalRange} onChange={setHomeIntervalRange} />
      </div>
    </> : null}

    {createMode === 'MESSAGE_FOLLOWERS' ? <>
      <DividerLike title="Thiết lập IB follower" />
      <Alert type="warning" showIcon title="Tin nhắn sẽ được gửi thật sau khi campaign được duyệt" description="TikTok có thể giới hạn việc nhắn tin nếu hai tài khoản không đủ điều kiện kết nối. Hệ thống chỉ thử trong giới hạn đã chọn và lưu lại kết quả từng follower." />
      <Field label="Username kênh TikTok" required><Input value={followerUsername} onChange={event => setFollowerUsername(event.target.value)} placeholder="Ví dụ: @kenh_cua_ban" /></Field>
      <div className="tiktok-compact-settings-row">
        <NumberField label="Số follower tối đa" required value={followerLimit} onChange={value => setFollowerLimit(value ?? 20)} min={1} max={100} />
        <IntervalRangeField required value={followerIntervalRange} onChange={setFollowerIntervalRange} />
      </div>
      <Field label="Nội dung tin nhắn"><Input.TextArea rows={4} value={actionText} onChange={event => setActionText(event.target.value)} placeholder="Nội dung IB gửi tới follower" /></Field>
      <Field label="Ảnh đính kèm"><CampaignImagePicker platform="TikTok" context="message" value={mediaAssetIds} onChange={setMediaAssetIds} disabled={!canOperate || creatingTask} onUploadingChange={setUploadingImages} /></Field>
    </> : null}

    {createMode === 'ACTION' ? <>
      <DividerLike title="Danh sách video đã chọn" />
      <Alert type="info" showIcon title={`${selectedVideoUrls.length} video đã chọn`} description="Đây là campaign riêng cho các video bạn vừa chọn từ một Search campaign. Bạn có thể lưu nháp hoặc tạo, duyệt và xếp hàng chạy ngay sau bước xác nhận." />
      <DividerLike title="Chọn hành động" />
      <Field label="Loại hành động" required><Select value={actionMode} onChange={value => setActionMode(value as ActionMode)} options={[{ value: 'COMMENT', label: 'Comment video' }, { value: 'REPLY', label: 'Reply comment trên video' }, { value: 'LIKE', label: 'Tim comment trên video' }]} /></Field>
      {actionMode !== 'LIKE' ? <>
        <Field label={actionMode === 'COMMENT' ? 'Nội dung comment' : 'Nội dung reply'} required><Input.TextArea rows={4} value={actionText} onChange={event => setActionText(event.target.value)} placeholder={actionMode === 'COMMENT' ? 'Nội dung comment' : 'Nội dung reply'} /></Field>
      </> : null}
      <div className="tiktok-compact-settings-row">
        {actionMode === 'REPLY' ? <NumberField label="Số reply / video" value={actionReplyLimit} onChange={value => setActionReplyLimit(value ?? 10)} min={1} max={50} /> : null}
        {actionMode === 'LIKE' ? <NumberField label="Số tim comment / video" value={actionLikeLimit} onChange={value => setActionLikeLimit(value ?? 10)} min={1} max={50} /> : null}
        <IntervalRangeField value={actionIntervalRange} onChange={setActionIntervalRange} />
      </div>
    </> : null}
  </>;

  return <div className="tiktok-workspace">
    <CampaignSummary items={[
      { label: 'Tổng chiến dịch', value: taskCampaigns.length, icon: 'tasks' },
      { label: 'Đang chạy / chờ chạy', value: runningCount, icon: 'play' },
      { label: 'Lỗi / cần xử lý', value: failedCount, icon: 'reject' },
      { label: 'Đã hoàn tất', value: completedCount, icon: 'approve' },
    ]} />
    {!tiktokAccounts.length ? <Alert type="info" showIcon title="Chưa có profile TikTok" description="Thêm profile để Search video hoặc tạo chiến dịch hành động." action={<Button type="primary" onClick={onNavigateProfiles}>Mở Profiles</Button>} /> : null}

    <CampaignStartBar title="Quản lý chiến dịch TikTok" description="Tạo chiến dịch mới, theo dõi tiến độ và xử lý kết quả theo từng profile." action={<Dropdown trigger={['click']} disabled={!canOperate || !tiktokAccounts.length} menu={{ items: [
        { key: 'SEARCH', label: 'Search video', icon: <Icon name="search" /> },
        { key: 'AUTO_COMMENT', label: 'Auto-comment For You', icon: <Icon name="edit" />, disabled: !queueableAccounts.length },
        { key: 'MESSAGE_FOLLOWERS', label: 'IB follower của kênh', icon: <Icon name="edit" />, disabled: !queueableAccounts.length },
      ], onClick: ({ key }) => resetCreate(key as CreateMode) }}>
        <Button type="primary" icon={<Icon name="plus" />} disabled={!canOperate || !tiktokAccounts.length}>Tạo chiến dịch</Button>
      </Dropdown>} />

      <Card className="resource-card" title={<PageSectionTitle title="Danh sách chiến dịch TikTok" description="Mỗi dòng là một chiến dịch; mở chi tiết để xem kết quả của từng profile" />} extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm chiến dịch TikTok" allowClear value={campaignSearch} onChange={event => setCampaignSearch(event.target.value)} placeholder="Tìm tên hoặc từ khóa..." /><Select aria-label="Lọc chiến dịch TikTok" className="status-filter" value={campaignFilter} onChange={setCampaignFilter} options={['ALL', 'PENDING', 'DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'CANCELLED'].map(value => ({ value, label: tiktokStatusLabels[value] ?? value }))} /><ActionButton label="Làm mới chiến dịch" icon="refresh" onClick={() => void tasks.refetch()} /></Space>}>
          <Table<TikTokCampaign> className="campaign-table" size="middle" rowKey="id" loading={tasks.isLoading} dataSource={taskCampaigns} pagination={tablePagination('chiến dịch')} scroll={{ x: 1_180 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có chiến dịch TikTok" /> }} columns={[
            { title: 'Chiến dịch', width: 240, render: (_: unknown, campaign) => <div className="campaign-name"><strong>{campaign.representative.payload?.name ?? actionLabel(campaign.representative.action)}</strong><small>{campaign.representative.payload?.query ?? actionLabel(campaign.representative.action)}</small></div> },
            { title: 'Loại', width: 180, render: (_: unknown, campaign) => <Tag>{actionLabel(campaign.representative.action)}</Tag> },
            { title: 'Profile', width: 120, render: (_: unknown, campaign) => campaign.representative.action === 'SEARCH_TIKTOK_VIDEOS' ? <Typography.Text type="secondary">Không cần login</Typography.Text> : `${new Set(campaign.tasks.map(task => task.account.id)).size} profile` },
            { title: 'Tiến độ', width: 220, render: (_: unknown, campaign) => { const completedTasks = campaign.tasks.filter(task => task.status === 'SUCCEEDED' && !isIncompleteTikTokCampaign(task)).length; const pendingTasks = campaign.tasks.filter(task => ['FAILED', 'REQUIRES_ACTION'].includes(task.status) || isIncompleteTikTokCampaign(task)).length; return <div className="campaign-result-cell"><span className="campaign-result-primary">{completedTasks}/{campaign.tasks.length} tác vụ hoàn tất</span><Typography.Text type="secondary">{pendingTasks ? `${pendingTasks} tác vụ cần xử lý` : 'Theo dõi chi tiết theo profile'}</Typography.Text></div>; } },
            { title: 'Trạng thái', width: 150, render: (_: unknown, campaign) => groupedCampaignTag(campaign) },
            { title: 'Người tạo', width: 180, ellipsis: true, render: (_: unknown, campaign) => campaign.representative.createdBy?.displayName || campaign.representative.createdBy?.email || 'Dữ liệu cũ' },
            { title: 'Ngày tạo', width: 150, render: (_: unknown, campaign) => new Date(campaign.representative.createdAt).toLocaleString('vi-VN') },
            { title: 'Thao tác', width: 180, fixed: 'right', render: (_: unknown, campaign) => { const finished = ['SUCCEEDED', 'CANCELLED'].includes(campaign.status); return <Space wrap size={6}>
              <ActionButton label="Xem chi tiết" icon="view" onClick={() => setSelectedCampaignId(campaign.id)} />
              {campaign.status === 'PENDING' ? <ActionButton label="Duyệt & xếp hàng" icon="play" type="primary" disabled={!canAdmin || approvingId === campaign.id} loading={approvingId === campaign.id} onClick={() => approveCampaignGroup(campaign)} /> : null}
              {['RUNNING', 'QUEUED'].includes(campaign.status) ? <ActionButton label="Yêu cầu tạm dừng" icon="pause" disabled={!canAdmin || pausingId === campaign.id} loading={pausingId === campaign.id} onClick={() => controlCampaignGroup(campaign, 'pause')} /> : null}
              {campaign.status === 'PAUSED' ? <ActionButton label="Tiếp tục chiến dịch" icon="play" disabled={!canAdmin || resumingId === campaign.id} loading={resumingId === campaign.id} onClick={() => controlCampaignGroup(campaign, 'resume')} /> : null}
              {!finished ? <ActionButton label="Yêu cầu hủy" icon="close" danger disabled={!canAdmin || cancellingId === campaign.id} loading={cancellingId === campaign.id} onClick={() => controlCampaignGroup(campaign, 'cancel')} /> : null}
            </Space>; } },
          ]} />
          {(tasks.data?.length ?? 0) >= taskLimit && taskLimit < 2_000 ? <Flex justify="center" style={{ marginTop: 16 }}><Button loading={tasks.isFetching} onClick={() => setTaskLimit(limit => Math.min(2_000, limit + 100))}>Tải thêm chiến dịch cũ</Button></Flex> : null}
        </Card>
    {selectedCampaign ? <Modal className="tiktok-result-modal campaign-detail-modal" title={<PageSectionTitle title={selectedCampaign.payload?.name ?? actionLabel(selectedCampaign.action)} description={selectedCampaign.action === 'SEARCH_TIKTOK_VIDEOS' ? 'Chọn video trong kết quả Search để tạo chiến dịch hành động' : 'Chi tiết chiến dịch và kết quả theo từng profile'} />} open onCancel={() => setSelectedCampaignId(undefined)} footer={selectedCampaign.action === 'SEARCH_TIKTOK_VIDEOS' ? <Flex className="tiktok-selection-toolbar" justify="space-between" align="center" wrap gap={12}><Typography.Text type="secondary">{selectedCount} video được chọn</Typography.Text><Button type="primary" disabled={!selectedCount || !canOperate} onClick={startActionFromSelection}>Tạo chiến dịch từ video đã chọn</Button></Flex> : null} destroyOnHidden width={1_100}>
          {selectedCampaign.action === 'SEARCH_TIKTOK_VIDEOS' ? <>
            <CampaignDetailOverview items={[{ label: 'Loại', value: actionLabel(selectedCampaign.action) }, { label: 'Profile', value: 'Không cần đăng nhập' }, { label: 'Kết quả', value: `${selectedResults.length} video` }, { label: 'Trạng thái', value: taskTag(selectedCampaign) }]} />
            <Alert type={selectedCampaign.status === 'SUCCEEDED' ? 'info' : 'warning'} showIcon title={selectedCampaign.status === 'SUCCEEDED' ? `${selectedResults.length} video đã được lưu trong campaign` : 'Campaign Search cần xử lý trước khi có kết quả'} description={selectedCampaign.status === 'SUCCEEDED' ? 'Search campaign chỉ lưu metadata. Nếu cần, chọn các video rồi mở dialog campaign hành động; nếu không thì chỉ cần đóng phần kết quả này.' : selectedCampaign.lastError ?? 'Search dùng user-data tạm và không yêu cầu profile TikTok đăng nhập; chỉ cần chạy lại nếu UI TikTok gặp lỗi.'} action={selectedCampaign.status === 'SUCCEEDED' ? undefined : <Space>{['FAILED', 'REQUIRES_ACTION'].includes(selectedCampaign.status) ? <Button type="primary" disabled={!canOperate} loading={retryingId === selectedCampaign.id} onClick={() => retryTask(selectedCampaign)}>Chạy lại Search</Button> : null}</Space>} />
            <Alert type="info" showIcon title="Nguồn số liệu Search" description="Trang Search của TikTok chỉ cung cấp số tim trên card. View và comment chỉ hiển thị khi TikTok trả về video stats xác thực; hệ thống không dùng số tim thay thế." />
            <Table<VideoRow> className="campaign-table" rowKey="videoUrl" size="small" scroll={{ x: 900 }} dataSource={selectedResults} pagination={tablePagination('video')} rowSelection={{ preserveSelectedRowKeys: true, selectedRowKeys: selectedVideoUrls, onChange: keys => setSelectedVideoUrls(current => { const visibleKeys = new Set(selectedResults.map(video => video.videoUrl)); const preserved = current.filter(key => !visibleKeys.has(key)); return [...preserved, ...keys.map(String)]; }) }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có video metadata" /> }} columns={[
              { title: 'Video', render: (_: unknown, video: VideoRow) => { const username = video.username?.replace(/^@/, ''); const profileUrl = video.profileUrl ?? (username ? `https://www.tiktok.com/@${encodeURIComponent(username)}` : undefined); return <Flex gap={10} align="center"><div className="tiktok-thumb">{video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" /> : '♪'}</div><div className="tiktok-video-cell"><a href={video.videoUrl} target="_blank" rel="noreferrer">{video.title ?? video.description ?? video.videoId ?? 'Mở video'}</a><small>{profileUrl ? <a href={profileUrl} target="_blank" rel="noreferrer">{video.username}</a> : 'Không rõ người đăng'}</small><small>{video.publishedAt ?? 'Không rõ ngày đăng'}</small></div></Flex>; } },
              { title: 'Tim', dataIndex: 'likes', render: (value: number) => numberLabel(value) },
              { title: 'View', dataIndex: 'views', render: (value: number) => numberLabel(value) },
              { title: 'Cmt', dataIndex: 'comments', render: (value: number) => numberLabel(value) },
            ]} />
          </> : <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            <CampaignDetailOverview items={[{ label: 'Loại', value: actionLabel(selectedCampaign.action) }, { label: 'Profile', value: new Set((selectedGroup?.tasks ?? []).map(task => task.account.id)).size }, { label: 'Chờ ngẫu nhiên', value: `${selectedCampaign.payload?.intervalMinSeconds ?? selectedCampaign.payload?.intervalSeconds ?? 10}–${selectedCampaign.payload?.intervalMaxSeconds ?? selectedCampaign.payload?.intervalMinSeconds ?? selectedCampaign.payload?.intervalSeconds ?? 10} giây` }, { label: 'Tác vụ hoàn tất', value: `${selectedGroup?.tasks.filter(task => task.status === 'SUCCEEDED' && !isIncompleteTikTokCampaign(task)).length ?? 0}/${selectedGroup?.tasks.length ?? 0}` }, { label: 'Trạng thái', value: groupedCampaignTag(selectedGroup ?? { id: selectedCampaign.id, representative: selectedCampaign, tasks: [selectedCampaign], status: selectedCampaign.status }) }]} />
            <Table<TaskItem> className="campaign-table" rowKey="id" size="small" pagination={false} scroll={{ x: 760 }} dataSource={selectedGroup?.tasks ?? []} columns={[
              { title: 'Profile', render: (_: unknown, task) => task.account.username ?? task.account.id },
              { title: 'Kết quả', render: (_: unknown, task) => <Space orientation="vertical" size={2}><span>{campaignResult(task)}</span>{campaignResultReason(task) ? <Typography.Text type="secondary">{campaignResultReason(task)}</Typography.Text> : null}</Space> },
              { title: 'Trạng thái', render: (_: unknown, task) => taskTag(task) },
              { title: 'Xử lý', width: 80, render: (_: unknown, task) => ['FAILED', 'REQUIRES_ACTION'].includes(task.status) || isIncompleteTikTokCampaign(task) ? <ActionButton label={retrySafety(task) === 'VERIFY' ? 'Kiểm tra rồi chạy lại' : 'Tiếp tục phần còn lại'} icon="refresh" disabled={!canAdmin} loading={retryingId === task.id} onClick={() => retryTask(task)} /> : null },
            ]} />
            {selectedCampaign.status === 'REQUIRES_ACTION' || isStaleBrowserRun(selectedCampaign) ? <Alert
              type="warning"
              showIcon
              title={checkpointCanContinue(selectedCampaign) ? 'Browser đã dừng; có thể tiếp tục phần còn lại' : 'Browser đã dừng nhưng kết quả gửi chưa chắc chắn'}
              description={checkpointCanContinue(selectedCampaign)
                ? 'Các đối tượng đã hoàn tất được lưu trong báo cáo. Nhấn “Tiếp tục phần còn lại” để chỉ chạy phần chưa đủ chỉ tiêu.'
                : /timed out|timeout|hết thời hạn/i.test(selectedCampaign.lastError ?? '')
                  ? 'Hãy mở TikTok và kiểm tra Inbox hoặc đối tượng đích xem tin đã được gửi chưa. Chỉ chạy lại khi xác nhận chưa gửi để tránh gửi trùng.'
                : 'Kiểm tra kết quả trên TikTok trước khi chạy lại. Profile sẵn sàng chỉ có nghĩa là phiên đăng nhập còn hợp lệ.'}
              action={retrySafety(selectedCampaign) === 'VERIFY'
                ? <Button type="primary" disabled={!canAdmin} loading={retryingId === selectedCampaign.id} onClick={() => retryTask(selectedCampaign)}>Tôi đã kiểm tra, chạy lại</Button>
                : undefined}
              style={{ marginBottom: 4 }}
            /> : null}
            {selectedCampaign.payload?.text ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>Nội dung: {selectedCampaign.payload.text}</Typography.Paragraph> : null}
            {selectedReportEntries.length ? <Table<TikTokReportEntry> className="campaign-table" rowKey={reportEntryKey} size="small" pagination={tablePagination('kết quả')} scroll={{ x: 760 }} dataSource={selectedReportEntries} columns={[
              { title: 'Thao tác', dataIndex: 'action', render: (value: string) => value === 'MESSAGE' ? 'Inbox' : value === 'REPLY' ? 'Reply comment' : value === 'LIKE' ? 'Tim comment' : 'Comment' },
              { title: 'Đối tượng', render: (_: unknown, entry: TikTokReportEntry) => reportTarget(entry) },
              { title: 'Kết quả', dataIndex: 'status', render: (value: string) => reportStatus(value) },
              { title: 'Thời điểm', dataIndex: 'completedAt', render: (value: string) => value ? new Date(value).toLocaleString('vi-VN') : '—' },
              { title: 'Chi tiết', dataIndex: 'reason', render: (value: string) => value ? <Typography.Text type="secondary">{value}</Typography.Text> : '—' },
            ]} /> : <Alert type="info" showIcon title="Chưa có kết quả chi tiết" description="Chiến dịch cũ chỉ lưu số lượng tổng hợp. Các chiến dịch mới sẽ lưu từng người nhận hoặc từng video/bài viết cùng trạng thái thực thi." />}
          </Space>}
    </Modal> : null}
    <Modal className="tiktok-create-modal campaign-create-modal" title={createDialogTitle} open={createOpen} onCancel={() => { if (!creatingTask && !uploadingImages) setCreateOpen(false); }} destroyOnHidden width={820} footer={createMode === 'SEARCH' ? <Space className="campaign-modal-actions"><Button onClick={() => setCreateOpen(false)} disabled={creatingTask || uploadingImages}>Đóng</Button><Button type="primary" loading={creatingTask} disabled={createDialogSubmitDisabled} onClick={submitSearch}>Search video</Button></Space> : <Space className="campaign-modal-actions"><Button onClick={() => setCreateOpen(false)} disabled={creatingTask || uploadingImages}>Đóng</Button><Button loading={creatingTask} disabled={createDialogSubmitDisabled} onClick={saveDraft}>Lưu bản nháp</Button><Button type="primary" loading={creatingTask} disabled={!canAdmin || !targetAccountsReady || createDialogSubmitDisabled} onClick={runNow}>Duyệt & xếp hàng</Button></Space>}>
      <div className="tiktok-dialog-body">{!targetAccountsReady ? <Alert type="info" showIcon title="Có profile chưa sẵn sàng" description="Bạn vẫn có thể lưu bản nháp. Hãy đăng nhập hoặc hoàn tất xác minh profile trước khi duyệt và xếp hàng." action={<Button onClick={onNavigateProfiles}>Mở Profiles</Button>} /> : null}{createDialogContent}</div>
    </Modal>
  </div>;
}

function DividerLike({ title }: { title: string }) {
  return <div className="tiktok-divider"><Typography.Text strong>{title}</Typography.Text></div>;
}
