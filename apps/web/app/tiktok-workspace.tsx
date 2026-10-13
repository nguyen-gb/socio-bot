'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Card, Empty, Flex, Input, InputNumber, Modal, Select, Space, Table, Tag, Tooltip, Typography, type ButtonProps } from 'antd';
import { Icon } from './ui';
import { ContextNote as Alert } from './context-note';
import { useToast, useToastError } from './toast';

interface Account { id: string; username?: string; platform: string; status: string }
interface MediaAsset { id: string; fileName: string; contentType: string; status: string }
interface VideoRow { videoUrl: string; videoId?: string; username?: string; description?: string; thumbnailUrl?: string; likes?: number; views?: number; comments?: number; statsSource?: 'TIKTOK_VIDEO_STATS' }
interface TikTokPayload { name?: string; query?: string; username?: string; videoUrls?: string[]; text?: string; mediaAssetIds?: string[]; maxVideos?: number; maxFollowers?: number; maxReplies?: number; maxLikes?: number; minLikes?: number; intervalSeconds?: number }
interface TaskItem { id: string; action: string; status: string; approvalStatus?: string; attemptCount?: number; createdAt: string; lastError?: string; pausedAt?: string | null; cancelledAt?: string | null; account: Account; payload?: TikTokPayload; runs?: Array<{ result?: unknown }> }
interface TikTokWorkspaceProps { accounts: Account[]; canOperate: boolean; canAdmin: boolean; onNavigateProfiles: () => void }
type CreateMode = 'SEARCH' | 'AUTO_COMMENT' | 'ACTION' | 'MESSAGE_FOLLOWERS';
type ActionMode = 'COMMENT' | 'REPLY' | 'LIKE';
type CampaignActionIcon = 'close' | 'pause' | 'play' | 'refresh' | 'view';

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

function resultVideos(task?: TaskItem): VideoRow[] {
  const videos = resultObject(task)?.videos;
  if (!Array.isArray(videos)) return [];
  return videos.filter((item): item is VideoRow => Boolean(item && typeof item === 'object' && typeof (item as VideoRow).videoUrl === 'string')).map(video => video.statsSource === 'TIKTOK_VIDEO_STATS'
    ? video
    : { ...video, views: undefined, comments: undefined });
}

function retrySafety(task: TaskItem): 'SAFE' | 'VERIFY' | 'BLOCKED' {
  if (!['FAILED', 'REQUIRES_ACTION'].includes(task.status)) return 'BLOCKED';
  if (task.action === 'SEARCH_TIKTOK_VIDEOS') return 'SAFE';
  const result = resultObject(task);
  return task.attemptCount === 0 || result?.sideEffectStarted === false ? 'SAFE' : 'VERIFY';
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

function taskTag(task: TaskItem) {
  if (task.approvalStatus === 'PENDING') return <Tag color="orange">Chờ duyệt</Tag>;
  if (task.cancelledAt && task.status === 'RUNNING') return <Tag color="red">Đang hủy</Tag>;
  if (task.status === 'SUCCEEDED') return <Tag color="green">Hoàn tất</Tag>;
  if (['FAILED', 'REQUIRES_ACTION'].includes(task.status)) return <Tag color="red">{task.status === 'REQUIRES_ACTION' ? 'Cần thao tác' : 'Lỗi'}</Tag>;
  if (task.pausedAt && task.status === 'RUNNING') return <Tag color="orange">Đang tạm dừng</Tag>;
  if (task.status === 'PAUSED') return <Tag color="orange">Đã tạm dừng</Tag>;
  if (task.status === 'RUNNING') return <Tag color="blue">Đang chạy</Tag>;
  if (task.status === 'QUEUED' || task.status === 'SCHEDULED') return <Tag color="blue">Đang chờ</Tag>;
  return <Tag>{task.status}</Tag>;
}

function campaignResult(task: TaskItem): string {
  const result = resultObject(task);
  if (task.action === 'SEARCH_TIKTOK_VIDEOS') return result && typeof result.count === 'number' ? `${result.count} video` : 'Chưa có kết quả';
  if (task.action === 'COMMENT_TIKTOK_VIDEOS' || task.action === 'AUTO_COMMENT_TIKTOK_HOME') return result && typeof result.sent === 'number' ? `Đã comment ${result.sent}/${result.requested ?? 0}` : 'Chưa chạy';
  if (task.action === 'REPLY_TIKTOK_COMMENTS') return result && typeof result.sent === 'number' ? `Đã reply ${result.sent}/${result.requested ?? 0}` : 'Chưa chạy';
  if (task.action === 'LIKE_TIKTOK_COMMENTS') return result && typeof result.liked === 'number' ? `Đã tim ${result.liked}/${result.requested ?? 0}` : 'Chưa chạy';
  if (task.action === 'MESSAGE_TIKTOK_FOLLOWERS') return result && typeof result.sent === 'number' ? `Đã IB ${result.sent}/${result.requested ?? 0}` : 'Chưa chạy';
  return '—';
}

function MediaPicker({ assets, value, onChange, disabled }: { assets: MediaAsset[]; value: string[]; onChange: (value: string[]) => void; disabled?: boolean }) {
  const options = assets.filter(asset => asset.status === 'READY' && asset.contentType.startsWith('image/')).map(asset => ({ value: asset.id, label: `${asset.fileName} · ${asset.contentType}` }));
  return <Select mode="multiple" allowClear maxTagCount="responsive" value={value} onChange={onChange} disabled={disabled} options={options} placeholder="Không đính kèm ảnh" />;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="tiktok-field"><Typography.Text strong>{label}</Typography.Text>{children}</div>;
}

function NumberField({ label, value, onChange, min, max, placeholder }: { label: string; value?: number; onChange: (value: number | undefined) => void; min?: number; max?: number; placeholder?: string }) {
  return <div className="tiktok-field tiktok-number-field"><Typography.Text>{label}</Typography.Text><InputNumber min={min} max={max} value={value} onChange={next => onChange(next ?? undefined)} placeholder={placeholder} /></div>;
}

function CampaignActionButton({ label, icon, ...props }: Omit<ButtonProps, 'children' | 'icon'> & { label: string; icon: CampaignActionIcon }) {
  return <Tooltip title={label}><span className="action-tooltip"><Button {...props} aria-label={label} icon={<Icon name={icon} />} /></span></Tooltip>;
}

export default function TikTokWorkspace({ accounts, canOperate, canAdmin, onNavigateProfiles }: TikTokWorkspaceProps) {
  const toast = useToast();
  const setError = useToastError();
  const { modal } = App.useApp();
  const tiktokAccounts = useMemo(() => accounts.filter(account => account.platform === 'TIKTOK'), [accounts]);
  // Search is read-only and runs in a clean temporary browser context, so it
  // can use any TikTok account as a queue/tenant anchor without requiring a
  // logged-in account. Side-effect actions still require a READY/RUNNING one.
  const queueableAccounts = useMemo(() => tiktokAccounts.filter(account => account.status === 'READY' || account.status === 'RUNNING'), [tiktokAccounts]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>('SEARCH');
  const [accountId, setAccountId] = useState('');
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [maxVideos, setMaxVideos] = useState(30);
  const [minLikes, setMinLikes] = useState<number>();
  const [maxLikesFilter, setMaxLikesFilter] = useState<number>();
  const [minViews, setMinViews] = useState<number>();
  const [maxViews, setMaxViews] = useState<number>();
  const [homeText, setHomeText] = useState('');
  const [homeLimit, setHomeLimit] = useState(10);
  const [homeMinLikes, setHomeMinLikes] = useState(0);
  const [homeMaxLikes, setHomeMaxLikes] = useState<number>();
  const [followerUsername, setFollowerUsername] = useState('');
  const [followerLimit, setFollowerLimit] = useState(20);
  const [actionMode, setActionMode] = useState<ActionMode>('COMMENT');
  const [actionText, setActionText] = useState('');
  const [actionReplyLimit, setActionReplyLimit] = useState(10);
  const [actionLikeLimit, setActionLikeLimit] = useState(10);
  const [mediaAssetIds, setMediaAssetIds] = useState<string[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>();
  const [selectedVideoUrls, setSelectedVideoUrls] = useState<string[]>([]);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('ALL');
  const [approvingId, setApprovingId] = useState<string>();
  const [retryingId, setRetryingId] = useState<string>();
  const [cancellingId, setCancellingId] = useState<string>();
  const [pausingId, setPausingId] = useState<string>();
  const [resumingId, setResumingId] = useState<string>();
  const selectableAccounts = createMode === 'SEARCH' ? tiktokAccounts : queueableAccounts;

  useEffect(() => {
    if (!accountId && selectableAccounts[0]) setAccountId(selectableAccounts[0].id);
    if (accountId && !selectableAccounts.some(account => account.id === accountId)) setAccountId(selectableAccounts[0]?.id ?? '');
  }, [accountId, selectableAccounts]);

  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => apiJson<TaskItem[]>('/api/control/tasks'),
    refetchInterval: 5_000,
  });
  const media = useQuery({ queryKey: ['media'], queryFn: () => apiJson<MediaAsset[]>('/api/media') });
  const campaigns = useMemo(() => {
    const needle = campaignSearch.trim().toLocaleLowerCase();
    return (tasks.data ?? []).filter(task => task.action.startsWith('SEARCH_TIKTOK') || task.action.startsWith('AUTO_COMMENT_TIKTOK') || task.action.startsWith('COMMENT_TIKTOK') || task.action.startsWith('REPLY_TIKTOK') || task.action.startsWith('LIKE_TIKTOK') || task.action.startsWith('MESSAGE_TIKTOK')).filter(task => campaignFilter === 'ALL' || task.status === campaignFilter || campaignFilter === 'PENDING' && task.approvalStatus === 'PENDING').filter(task => !needle || [task.payload?.name, task.payload?.query, task.payload?.username, task.account.username, actionLabel(task.action)].filter(Boolean).some(value => String(value).toLocaleLowerCase().includes(needle)));
  }, [campaignFilter, campaignSearch, tasks.data]);
  const selectedCampaign = campaigns.find(task => task.id === selectedCampaignId);
  const selectedResults = resultVideos(selectedCampaign);
  const selectedSourceAccount = selectedCampaign?.account.id ?? accountId;
  const selectedCount = selectedVideoUrls.length;
  const searchCount = campaigns.filter(task => task.action === 'SEARCH_TIKTOK_VIDEOS').length;
  const pendingCount = campaigns.filter(task => task.approvalStatus === 'PENDING').length;
  const completedCount = campaigns.filter(task => task.status === 'SUCCEEDED').length;

  const resetCreate = (mode: CreateMode) => {
    setCreateMode(mode); setCreateOpen(true); setError(undefined);
    if (mode === 'SEARCH') { setName(''); setQuery(''); setSelectedCampaignId(undefined); setSelectedVideoUrls([]); }
    if (mode === 'AUTO_COMMENT') { setName(''); setHomeText(''); }
    if (mode === 'MESSAGE_FOLLOWERS') { setName(''); setFollowerUsername(''); setFollowerLimit(20); setActionText(''); setMediaAssetIds([]); }
  };

  const createTask = async (action: string, payload: Record<string, unknown>, successText: string, runImmediately = false) => {
    if (!canOperate || !accountId) return;
    try {
      const task = await apiJson<{ id: string }>('/api/tasks', { idempotencyKey: `${action.toLowerCase()}-${crypto.randomUUID()}`, action: { platform: 'TIKTOK', accountId, action, payload } });
      if (runImmediately) await apiJson(`/api/tasks/${task.id}/approve`, {});
      await tasks.refetch();
      setCreateOpen(false);
      setSelectedCampaignId(task.id);
      setSelectedVideoUrls([]);
      toast.success(action === 'SEARCH_TIKTOK_VIDEOS'
        ? `${successText} đã được đưa vào chạy ngay.`
        : runImmediately
          ? `${successText} đã được duyệt và xếp hàng để chạy.`
          : `${successText} đã được tạo và đang chờ duyệt.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const submitSearch = () => {
    if (!name.trim() || !query.trim()) return;
    void createTask('SEARCH_TIKTOK_VIDEOS', { name, query, maxVideos, ...(minLikes == null ? {} : { minLikes }), ...(maxLikesFilter == null ? {} : { maxLikes: maxLikesFilter }), ...(minViews == null ? {} : { minViews }), ...(maxViews == null ? {} : { maxViews }) }, 'Campaign Search video');
  };

  const submitHomeComment = (runImmediately = false) => {
    if (!name.trim() || !homeText.trim()) return;
    return createTask('AUTO_COMMENT_TIKTOK_HOME', { name, text: homeText, mediaAssetIds, maxVideos: homeLimit, minLikes: homeMinLikes, ...(homeMaxLikes == null ? {} : { maxLikes: homeMaxLikes }), intervalSeconds: 120 }, 'Campaign auto-comment', runImmediately);
  };

  const submitFollowerMessage = (runImmediately = false) => {
    if (!name.trim() || !followerUsername.trim() || (!actionText.trim() && !mediaAssetIds.length)) return;
    return createTask('MESSAGE_TIKTOK_FOLLOWERS', { name, username: followerUsername, text: actionText, mediaAssetIds, maxFollowers: followerLimit, intervalSeconds: 120 }, 'Campaign IB follower TikTok', runImmediately);
  };

  const submitAction = (runImmediately = false) => {
    if (!name.trim() || !selectedVideoUrls.length || !accountId) return;
    if (actionMode !== 'LIKE' && !actionText.trim()) return;
    const shared = { name, videoUrls: selectedVideoUrls, intervalSeconds: 120 };
    const action = actionMode === 'COMMENT' ? 'COMMENT_TIKTOK_VIDEOS' : actionMode === 'REPLY' ? 'REPLY_TIKTOK_COMMENTS' : 'LIKE_TIKTOK_COMMENTS';
    const payload = actionMode === 'COMMENT'
      ? { ...shared, text: actionText, mediaAssetIds, maxVideos: selectedVideoUrls.length }
      : actionMode === 'REPLY'
        ? { ...shared, text: actionText, mediaAssetIds, maxReplies: actionReplyLimit }
        : { ...shared, maxLikes: actionLikeLimit };
    return createTask(action, payload, `Campaign ${actionLabel(action)}`, runImmediately);
  };

  const openSearchResults = (campaign: TaskItem) => {
    setSelectedCampaignId(campaign.id); setSelectedVideoUrls([]);
  };

  const startActionFromSelection = () => {
    if (!selectedVideoUrls.length || !selectedCampaign) return;
    setAccountId(selectedSourceAccount);
    setCreateMode('ACTION'); setCreateOpen(true); setActionMode('COMMENT'); setActionText(''); setMediaAssetIds([]);
    setName(`Hành động trên ${selectedVideoUrls.length.toString()} video`);
  };

  const createDialogTitle = createMode === 'SEARCH' ? 'Search video' : createMode === 'AUTO_COMMENT' ? 'Auto-comment For You' : createMode === 'MESSAGE_FOLLOWERS' ? 'IB follower của kênh TikTok' : 'Hành động trên video đã chọn';
  const createDialogSubmitDisabled = createMode === 'SEARCH'
    ? !canOperate || !accountId || !name.trim() || !query.trim()
    : createMode === 'AUTO_COMMENT'
      ? !canOperate || !accountId || !name.trim() || !homeText.trim()
      : createMode === 'MESSAGE_FOLLOWERS'
        ? !canOperate || !accountId || !name.trim() || !followerUsername.trim() || (!actionText.trim() && !mediaAssetIds.length)
        : !canOperate || !accountId || !name.trim() || !selectedVideoUrls.length || actionMode !== 'LIKE' && !actionText.trim();
  const saveDraft = () => {
    if (createMode === 'AUTO_COMMENT') void submitHomeComment(false);
    else if (createMode === 'MESSAGE_FOLLOWERS') void submitFollowerMessage(false);
    else if (createMode === 'ACTION') void submitAction(false);
  };
  const runNow = () => modal.confirm({
    title: 'Tạo và chạy campaign TikTok ngay?',
    content: 'Campaign sẽ được duyệt ngay sau khi tạo và xếp vào hàng đợi của profile. Comment, reply, tim comment hoặc IB là hành động thật và chỉ thực hiện khi đến lượt; campaign khác đang chạy vẫn được giữ nguyên thứ tự.',
    okText: 'Tạo & chạy',
    cancelText: 'Quay lại',
    onOk: () => createMode === 'AUTO_COMMENT' ? submitHomeComment(true) : createMode === 'MESSAGE_FOLLOWERS' ? submitFollowerMessage(true) : submitAction(true),
  });
  const approveCampaign = (task: TaskItem) => modal.confirm({
    title: 'Duyệt và xếp hàng campaign TikTok?',
    content: 'Campaign sẽ thực hiện comment, reply hoặc tim comment thật khi đến lượt. Nếu profile đang có campaign khác, campaign này sẽ nối vào cuối hàng đợi.',
    okText: 'Duyệt & xếp hàng',
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
    if (task.action !== 'SEARCH_TIKTOK_VIDEOS' && task.account.status !== 'READY') {
      onNavigateProfiles();
      return;
    }
    const isActionRetry = task.action !== 'SEARCH_TIKTOK_VIDEOS';
    modal.confirm({
      title: isActionRetry ? 'Chạy lại campaign TikTok?' : 'Chạy lại Search video?',
      content: isActionRetry ? 'Hệ thống chỉ cho chạy lại khi lần trước xác nhận chưa bắt đầu side effect. Campaign hiện tại sẽ được duyệt và xếp hàng lại; comment, reply, tim comment hoặc IB là hành động thật.' : 'Campaign Search hiện tại sẽ được đưa vào chạy lại với cùng từ khóa và giới hạn. Search chỉ đọc metadata, không comment, không like và không gửi tin nhắn.',
      okText: isActionRetry ? 'Chạy lại campaign' : 'Chạy lại Search',
      cancelText: 'Quay lại',
      onOk: async () => {
        setRetryingId(task.id);
        try {
          const retried = await apiJson<{ id: string }>(`/api/tasks/${task.id}/${isActionRetry ? 'retry-action' : 'retry'}`, {});
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
    content: task.status === 'RUNNING' ? 'Tác vụ đang chạy sẽ kết thúc an toàn; hệ thống không khởi chạy phần tiếp theo.' : 'Phần chưa chạy sẽ bị hủy và không thể tiếp tục campaign này.',
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
      toast.success(task.status === 'RUNNING' ? 'Đã yêu cầu tạm dừng; tác vụ đang chạy sẽ kết thúc an toàn.' : 'Đã tạm dừng campaign TikTok.');
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
  const createDialogContent = <>
    <div className="tiktok-form-grid tiktok-form-grid-2">
    <Field label="Profile neo campaign"><Select value={accountId || undefined} onChange={setAccountId} options={selectableAccounts.map(account => ({ value: account.id, label: `${account.username ?? account.id}${createMode === 'SEARCH' && account.status !== 'READY' && account.status !== 'RUNNING' ? ' · user-data tạm, không cần đăng nhập' : account.status === 'RUNNING' ? ' · đang chạy, sẽ xếp hàng' : ''}` }))} placeholder="Chọn profile TikTok" /></Field>
      <Field label="Tên campaign"><Input value={name} onChange={event => setName(event.target.value)} placeholder="Ví dụ: Search áo khoác tháng 10" /></Field>
    </div>

    {createMode === 'SEARCH' ? <>
      <DividerLike title="Thiết lập Search video" />
      <div className="tiktok-search-row">
        <Field label="Từ khóa"><Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Ví dụ: áo khoác nam" /></Field>
        <NumberField label="Số video tối đa" value={maxVideos} onChange={value => setMaxVideos(value ?? 30)} min={1} max={100} />
      </div>
      <div className="tiktok-filter-grid">
        <NumberField label="Tim tối thiểu" value={minLikes} onChange={setMinLikes} min={0} placeholder="Bỏ qua" />
        <NumberField label="Tim tối đa" value={maxLikesFilter} onChange={setMaxLikesFilter} min={0} placeholder="Bỏ qua" />
        <NumberField label="View tối thiểu" value={minViews} onChange={setMinViews} min={0} placeholder="Bỏ qua" />
        <NumberField label="View tối đa" value={maxViews} onChange={setMaxViews} min={0} placeholder="Bỏ qua" />
      </div>
      <Alert type="info" showIcon title="Search là campaign đọc dữ liệu và chạy ngay" description="Search dùng user-data tạm, không cần profile đăng nhập, không lưu bản nháp và không cần duyệt. Kết quả metadata sẽ được lưu vào campaign để bạn có thể chọn video sau; bạn cũng có thể đóng dialog mà không tạo campaign hành động." />
    </> : null}

    {createMode === 'AUTO_COMMENT' ? <>
      <DividerLike title="Thiết lập auto-comment For You" />
      <Field label="Nội dung comment"><Input.TextArea rows={4} value={homeText} onChange={event => setHomeText(event.target.value)} placeholder="Nội dung comment" /></Field>
      <div className="tiktok-filter-grid tiktok-filter-grid-3">
        <NumberField label="Số video" value={homeLimit} onChange={value => setHomeLimit(value ?? 10)} min={1} max={100} />
        <NumberField label="Tim từ" value={homeMinLikes} onChange={value => setHomeMinLikes(value ?? 0)} min={0} />
        <NumberField label="Tim đến" value={homeMaxLikes} onChange={setHomeMaxLikes} min={0} placeholder="Không giới hạn" />
      </div>
      <Field label="Ảnh đính kèm"><MediaPicker assets={media.data ?? []} value={mediaAssetIds} onChange={setMediaAssetIds} disabled={!canOperate} /></Field>
    </> : null}

    {createMode === 'MESSAGE_FOLLOWERS' ? <>
      <DividerLike title="Thiết lập IB follower" />
      <Alert type="warning" showIcon title="Tin nhắn sẽ được gửi thật sau khi campaign được duyệt" description="TikTok có thể giới hạn việc nhắn tin nếu hai tài khoản không đủ điều kiện kết nối. Hệ thống chỉ thử trong giới hạn đã chọn và lưu lại kết quả từng follower." />
      <Field label="Username kênh TikTok"><Input value={followerUsername} onChange={event => setFollowerUsername(event.target.value)} placeholder="Ví dụ: @kenh_cua_ban" /></Field>
      <NumberField label="Số follower tối đa" value={followerLimit} onChange={value => setFollowerLimit(value ?? 20)} min={1} max={100} />
      <Field label="Nội dung tin nhắn"><Input.TextArea rows={4} value={actionText} onChange={event => setActionText(event.target.value)} placeholder="Nội dung IB gửi tới follower" /></Field>
      <Field label="Ảnh đính kèm"><MediaPicker assets={media.data ?? []} value={mediaAssetIds} onChange={setMediaAssetIds} disabled={!canOperate} /></Field>
    </> : null}

    {createMode === 'ACTION' ? <>
      <DividerLike title="Danh sách video đã chọn" />
      <Alert type="info" showIcon title={`${selectedVideoUrls.length} video đã chọn`} description="Đây là campaign riêng cho các video bạn vừa chọn từ một Search campaign. Bạn có thể lưu nháp hoặc tạo, duyệt và xếp hàng chạy ngay sau bước xác nhận." />
      <DividerLike title="Chọn hành động" />
      <Field label="Loại hành động"><Select value={actionMode} onChange={value => setActionMode(value as ActionMode)} options={[{ value: 'COMMENT', label: 'Comment video' }, { value: 'REPLY', label: 'Reply comment trên video' }, { value: 'LIKE', label: 'Tim comment trên video' }]} /></Field>
      {actionMode !== 'LIKE' ? <>
        <Field label={actionMode === 'COMMENT' ? 'Nội dung comment' : 'Nội dung reply'}><Input.TextArea rows={4} value={actionText} onChange={event => setActionText(event.target.value)} placeholder={actionMode === 'COMMENT' ? 'Nội dung comment' : 'Nội dung reply'} /></Field>
        <Field label="Ảnh đính kèm"><MediaPicker assets={media.data ?? []} value={mediaAssetIds} onChange={setMediaAssetIds} disabled={!canOperate} /></Field>
      </> : null}
      <div className="tiktok-action-limit">{actionMode === 'REPLY' ? <NumberField label="Số reply / video" value={actionReplyLimit} onChange={value => setActionReplyLimit(value ?? 10)} min={1} max={50} /> : null}{actionMode === 'LIKE' ? <NumberField label="Số tim comment / video" value={actionLikeLimit} onChange={value => setActionLikeLimit(value ?? 10)} min={1} max={50} /> : null}</div>
    </> : null}
  </>;

  return <div className="tiktok-workspace">
    <div className="tiktok-intro">
      <span className="tiktok-intro-icon"><Icon name="search" /></span>
      <div>
        <strong>Search video → chọn video → campaign hành động hoặc IB follower</strong>
        <p>Search chỉ đọc metadata và chạy bằng user-data tạm, không dùng profile TikTok đã đăng nhập. Bạn có thể chọn video để tạo campaign comment, reply, tim comment hoặc nhập username một kênh để tạo campaign IB follower riêng.</p>
      </div>
      <Tag color="blue">Có IB follower</Tag>
    </div>
    {!tiktokAccounts.length ? <Card><Empty description="Chưa có profile TikTok"><Button type="primary" onClick={onNavigateProfiles}>Mở Profiles</Button></Empty></Card> : null}

    <div className="tiktok-summary">
      <div><span className="summary-icon"><Icon name="tasks" /></span><span><strong>{campaigns.length}</strong><small>campaign TikTok</small></span></div>
      <div><span className="summary-icon"><Icon name="search" /></span><span><strong>{searchCount}</strong><small>campaign Search</small></span></div>
      <div><span className="summary-icon"><Icon name="approve" /></span><span><strong>{pendingCount}</strong><small>đang chờ duyệt</small></span></div>
      <div><span className="summary-icon"><Icon name="play" /></span><span><strong>{completedCount}</strong><small>đã hoàn tất</small></span></div>
    </div>

    <div className="facebook-actions">
      <div><strong>Quản lý campaign TikTok</strong><p>Search đọc dữ liệu và chạy ngay; campaign comment, reply hoặc tim comment có thể lưu nháp hoặc tạo, duyệt và xếp hàng chạy ngay sau khi xác nhận.</p></div>
      <Space wrap><Button type="primary" onClick={() => resetCreate('SEARCH')} disabled={!canOperate || !tiktokAccounts.length}>Search video</Button><Button onClick={() => resetCreate('AUTO_COMMENT')} disabled={!canOperate || !queueableAccounts.length}>Auto-comment</Button><Button onClick={() => resetCreate('MESSAGE_FOLLOWERS')} disabled={!canOperate || !queueableAccounts.length}>IB follower</Button></Space>
    </div>

      <Card className="resource-card" title={<div className="section-title"><strong>Danh sách campaign TikTok</strong><small>Search và các campaign hành động được lưu riêng để theo dõi như Facebook</small></div>} extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm campaign TikTok" allowClear value={campaignSearch} onChange={event => setCampaignSearch(event.target.value)} placeholder="Tìm tên hoặc từ khóa..." /><Select aria-label="Lọc campaign TikTok" className="status-filter" value={campaignFilter} onChange={setCampaignFilter} options={['ALL', 'PENDING', 'DRAFT', 'QUEUED', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED', 'REQUIRES_ACTION', 'CANCELLED'].map(value => ({ value, label: value === 'ALL' ? 'Tất cả trạng thái' : value === 'PENDING' ? 'Chờ duyệt' : value }))} /></Space>}>
          <Table<TaskItem> rowKey="id" loading={tasks.isLoading} dataSource={campaigns} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 1_050 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có campaign TikTok" /> }} columns={[
            { title: 'Campaign', render: (_: unknown, task: TaskItem) => <div className="campaign-name"><strong>{task.payload?.name ?? actionLabel(task.action)}</strong><small>{task.payload?.query ?? actionLabel(task.action)}</small></div> },
            { title: 'Loại', render: (_: unknown, task: TaskItem) => <Tag>{actionLabel(task.action)}</Tag> },
            { title: 'Profile', render: (_: unknown, task: TaskItem) => task.account.username ?? task.account.id },
            { title: 'Kết quả', render: (_: unknown, task: TaskItem) => <Space orientation="vertical" size={2}><span>{campaignResult(task)}</span>{task.lastError ? <Typography.Text type="secondary">{task.lastError}</Typography.Text> : null}</Space> },
            { title: 'Trạng thái', render: (_: unknown, task: TaskItem) => taskTag(task) },
            { title: 'Ngày tạo', render: (_: unknown, task: TaskItem) => new Date(task.createdAt).toLocaleString('vi-VN') },
            { title: 'Thao tác', width: 190, render: (_: unknown, task: TaskItem) => {
              const finished = ['SUCCEEDED', 'CANCELLED'].includes(task.status);
              const retryState = retrySafety(task);
              const pauseable = !finished && !task.pausedAt && !task.cancelledAt && ['RUNNING', 'SCHEDULED', 'QUEUED'].includes(task.status);
              const pauseRequested = task.status === 'RUNNING' && Boolean(task.pausedAt);
              const resumable = task.status === 'PAUSED' && !task.cancelledAt;
              return <Space wrap size={6}>
                {finished ? <CampaignActionButton label="Xem" icon="view" onClick={() => setSelectedCampaignId(task.id)} /> : null}
                {!finished && task.approvalStatus === 'PENDING' ? <CampaignActionButton label="Duyệt & xếp hàng" icon="play" type="primary" disabled={!canAdmin || approvingId === task.id} loading={approvingId === task.id} onClick={() => approveCampaign(task)} /> : null}
                {!finished && retryState !== 'BLOCKED' ? <CampaignActionButton label={retryState === 'VERIFY' ? 'Cần kiểm tra trước khi chạy lại' : task.action === 'SEARCH_TIKTOK_VIDEOS' || task.account.status === 'READY' ? 'Chạy lại' : 'Mở Profiles'} icon="refresh" disabled={(task.action === 'SEARCH_TIKTOK_VIDEOS' ? !canOperate : !canAdmin) || retryState === 'VERIFY' || retryingId === task.id} loading={retryingId === task.id} onClick={() => retryTask(task)} /> : null}
                {pauseable ? <CampaignActionButton label={task.status === 'RUNNING' ? 'Tạm dừng sau khi tác vụ hiện tại kết thúc' : 'Tạm dừng campaign'} icon="pause" disabled={!canAdmin || pausingId === task.id} loading={pausingId === task.id} onClick={() => void pauseTask(task)} /> : null}
                {pauseRequested ? <CampaignActionButton label="Đang chờ tác vụ hiện tại kết thúc để tạm dừng" icon="pause" disabled /> : null}
                {resumable ? <CampaignActionButton label="Tiếp tục campaign" icon="play" disabled={!canAdmin || resumingId === task.id} loading={resumingId === task.id} onClick={() => void resumeTask(task)} /> : null}
                {!finished && !task.cancelledAt ? <CampaignActionButton label={task.status === 'RUNNING' ? 'Hủy phần còn lại' : 'Hủy campaign'} icon="close" danger disabled={!canAdmin || cancellingId === task.id} loading={cancellingId === task.id} onClick={() => cancelTask(task)} /> : null}
                {!finished && task.cancelledAt ? <CampaignActionButton label="Đang chờ tác vụ hiện tại kết thúc để hủy" icon="close" danger disabled /> : null}
              </Space>;
            } },
          ]} />
        </Card>
    {selectedCampaign ? <Modal className="tiktok-result-modal" title={<div className="section-title"><strong>{selectedCampaign.payload?.name ?? actionLabel(selectedCampaign.action)}</strong><small>{selectedCampaign.action === 'SEARCH_TIKTOK_VIDEOS' ? 'Chọn video trong kết quả Search nếu muốn mở campaign hành động riêng' : 'Chi tiết campaign và kết quả thực thi'}</small></div>} open onCancel={() => setSelectedCampaignId(undefined)} footer={null} destroyOnHidden width={1_100}>
          {selectedCampaign.action === 'SEARCH_TIKTOK_VIDEOS' ? <>
            <Alert type={selectedCampaign.status === 'SUCCEEDED' ? 'info' : 'warning'} showIcon title={selectedCampaign.status === 'SUCCEEDED' ? `${selectedResults.length} video đã được lưu trong campaign` : 'Campaign Search cần xử lý trước khi có kết quả'} description={selectedCampaign.status === 'SUCCEEDED' ? 'Search campaign chỉ lưu metadata. Nếu cần, chọn các video rồi mở dialog campaign hành động; nếu không thì chỉ cần đóng phần kết quả này.' : selectedCampaign.lastError ?? 'Search dùng user-data tạm và không yêu cầu profile TikTok đăng nhập; chỉ cần chạy lại nếu UI TikTok gặp lỗi.'} action={selectedCampaign.status === 'SUCCEEDED' ? undefined : <Space>{['FAILED', 'REQUIRES_ACTION'].includes(selectedCampaign.status) ? <Button type="primary" disabled={!canOperate} loading={retryingId === selectedCampaign.id} onClick={() => retryTask(selectedCampaign)}>Chạy lại Search</Button> : null}</Space>} />
            <Alert type="info" showIcon title="Nguồn số liệu Search" description="Trang Search của TikTok chỉ cung cấp số tim trên card. View và comment chỉ hiển thị khi TikTok trả về video stats xác thực; hệ thống không dùng số tim thay thế." />
            <Table<VideoRow> rowKey="videoUrl" size="small" scroll={{ x: 900 }} dataSource={selectedResults} pagination={{ pageSize: 8, hideOnSinglePage: true }} rowSelection={{ selectedRowKeys: selectedVideoUrls, onChange: keys => setSelectedVideoUrls(keys.map(String)) }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có video metadata" /> }} columns={[
              { title: 'Video', render: (_: unknown, video: VideoRow) => <Flex gap={10} align="center"><div className="tiktok-thumb">{video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" /> : '♪'}</div><div className="tiktok-video-cell"><a href={video.videoUrl} target="_blank" rel="noreferrer">{video.username ?? video.videoId ?? 'Mở video'}</a><small>{video.description ?? video.videoUrl}</small></div></Flex> },
              { title: 'Tim', dataIndex: 'likes', render: (value: number) => numberLabel(value) },
              { title: 'View', dataIndex: 'views', render: (value: number) => numberLabel(value) },
              { title: 'Cmt', dataIndex: 'comments', render: (value: number) => numberLabel(value) },
            ]} />
            <Flex justify="space-between" align="center" wrap gap={12}><Typography.Text type="secondary">{selectedCount} video được chọn</Typography.Text><Button type="primary" disabled={!selectedCount || !canOperate} onClick={startActionFromSelection}>Hành động trên video đã chọn</Button></Flex>
          </> : <Flex justify="space-between" wrap gap={12}><Space orientation="vertical"><Typography.Text>Loại: {actionLabel(selectedCampaign.action)}</Typography.Text><Typography.Text type="secondary">{campaignResult(selectedCampaign)}</Typography.Text></Space></Flex>}
    </Modal> : null}
    <Modal className="tiktok-create-modal" title={createDialogTitle} open={createOpen} onCancel={() => setCreateOpen(false)} destroyOnHidden width={820} footer={createMode === 'SEARCH' ? <Space><Button onClick={() => setCreateOpen(false)}>Đóng</Button><Button type="primary" disabled={createDialogSubmitDisabled} onClick={submitSearch}>Search video</Button></Space> : <Space><Button onClick={() => setCreateOpen(false)}>Đóng</Button><Button disabled={createDialogSubmitDisabled} onClick={saveDraft}>Lưu bản nháp</Button><Button type="primary" disabled={!canAdmin || createDialogSubmitDisabled} onClick={runNow}>Tạo & chạy ngay</Button></Space>}>
      <div className="tiktok-dialog-body">{createDialogContent}</div>
    </Modal>
  </div>;
}

function DividerLike({ title }: { title: string }) {
  return <div className="tiktok-divider"><Typography.Text strong>{title}</Typography.Text></div>;
}
