'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Checkbox, Dropdown, Empty, Flex, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';

import { Icon } from './ui';
import { ActionButton, CampaignDetailOverview, CampaignStartBar, CampaignSummary, PageSectionTitle, StatusTag, tablePagination } from './admin-ui';
import { useToast, useToastError } from './toast';
import { ContextNote as Alert } from './context-note';
import { readApiJson } from '../lib/api-response';
import { facebookGroupId, facebookGroupLabel } from '../lib/facebook-group-label';
import { FacebookImagePicker, FacebookPostImages } from './facebook-post-images';

interface Account { id: string; username?: string; platform: string; status: string }
interface Group { id: string; accountId: string; groupUrl: string; groupName?: string | null; status: string; lastSyncedAt: string; account: Account }
interface GroupCollection { id: string; name: string; description?: string | null; createdAt: string; updatedAt: string; items: Array<{ groupUrl: string }> }
interface OptInRecipient { id: string; groupUrl: string; profileUrl: string; displayName: string; consentSource: string; consentNote?: string | null; consentRecordedAt: string; revokedAt?: string | null }
interface JobResult { sideEffectStarted?: boolean; publicationStatus?: string; membershipStatus?: string; messageStatus?: string; commentStatus?: string; postsFound?: number; postsCommented?: number; posts?: Array<{ postUrl?: string; commentStatus?: string; postStatus?: string; reason?: string }>; commentsScanned?: number; phoneCount?: number; phoneNumbers?: string[]; repliesRequested?: number; repliesSent?: number; commentsAvailable?: number; replyStatus?: string; postUrl?: string; groupUrl?: string; profileUrl?: string; displayName?: string; complete?: boolean }
interface Job { id: string; retrySafety?: 'SAFE' | 'VERIFY' | 'BLOCKED'; attemptCount?: number; status: string; approvalStatus: string; lastError?: string; payload: { groupUrl?: string; postUrl?: string; profileUrl?: string; displayName?: string; maxReplies?: number; maxPosts?: number }; account: Account; runs: Array<{ errorCode?: string; result?: JobResult }> }
interface Campaign { id: string; name: string; kind: string; approvedAt?: string; pausedAt?: string; cancelledAt?: string; createdAt: string; createdBy?: { id: string; email: string; displayName?: string | null } | null; payload: { text?: string; postUrl?: string; postUrls?: string[]; recipientMode?: 'RANDOM' | 'OPT_IN'; recipientSource?: 'REACTORS' | 'COMMENTERS' | 'REACTORS_AND_COMMENTERS'; maxReplies?: number; maxRecipientsPerPost?: number; mediaAssetIds?: string[]; intervalSeconds: number; selection?: 'ALL' | 'CUSTOM' | 'COLLECTIONS'; collectionIds?: string[]; collectionNames?: string[]; groupUrls?: string[]; daysRecent?: number; minReactions?: number; maxReactions?: number; minComments?: number; maxComments?: number; maxPosts?: number }; tasks: Job[] }
interface Values { name: string; accountScope?: 'ALL' | 'SELECTED'; accountId?: string; accountIds: string[]; syncScope?: 'ALL' | 'SELECTED'; postUrl?: string; postUrls?: string; recipientMode?: 'RANDOM' | 'OPT_IN'; recipientSource?: 'REACTORS' | 'COMMENTERS' | 'REACTORS_AND_COMMENTERS'; groupUrls?: string; selectedGroupUrls?: string[]; messageGroupUrls?: string[]; collectionIds?: string[]; text?: string; mediaAssetIds?: string[]; selection?: 'ALL' | 'CUSTOM' | 'COLLECTIONS'; maxGroupsPerAccount?: number; maxRecipientsPerGroup?: number; maxRecipientsPerPost?: number; maxReplies?: number; daysRecent?: number; minReactions?: number; maxReactions?: number; minComments?: number; maxComments?: number; maxPosts?: number; intervalSeconds: number }
interface CollectionValues { name: string; description?: string; groupUrls: string[] }
interface OptInValues { groupUrl: string; profileUrl: string; displayName: string; consentSource: string; consentNote?: string; consentRecordedAt: string }

function SyncedGroupPicker({ groups, accounts, loading }: { groups: Group[]; accounts: Account[]; loading: boolean }) {
  const form = Form.useFormInstance<Values>();
  const accountIds = Form.useWatch('accountIds', form) as string[] | undefined;
  const selected = Form.useWatch('selectedGroupUrls', form) as string[] | undefined;
  const options = useMemo(() => {
    const eligible = new Set(accounts.filter(account => account.platform === 'FACEBOOK' && account.status === 'READY'
      && (!accountIds?.length || accountIds.includes(account.id))).map(account => account.id));
    const inventory = new Map<string, { name: string; profiles: Map<string, string> }>();
    for (const group of groups) {
      if (!eligible.has(group.accountId)) continue;
      const displayName = facebookGroupLabel(group);
      const entry = inventory.get(group.groupUrl) ?? { name: displayName, profiles: new Map<string, string>() };
      if (entry.name === facebookGroupId(group.groupUrl)) entry.name = displayName;
      entry.profiles.set(group.accountId, group.account.username ?? group.accountId);
      inventory.set(group.groupUrl, entry);
    }
    return [...inventory].map(([url, entry]) => ({ value: url, label: `${entry.name} (${entry.profiles.size} profile)`,
      searchText: `${entry.name} ${url} ${[...entry.profiles.values()].join(' ')}`.toLocaleLowerCase(), title: url }))
      .sort((a, b) => a.label.localeCompare(b.label, 'vi'));
  }, [groups, accounts, accountIds]);
  useEffect(() => {
    const available = new Set(options.map(option => option.value));
    if (selected?.some(url => !available.has(url))) form.setFieldValue('selectedGroupUrls', selected.filter(url => available.has(url)));
  }, [options, selected, form]);
  return <Form.Item name="selectedGroupUrls" label="Nhóm đã đồng bộ" extra="Chọn tối đa 100 nhóm từ danh sách của profile được chọn, kể cả nhóm chờ duyệt. Khi chạy, hệ thống kiểm tra khung soạn bài và nút gửi, không chặn theo trạng thái tham gia. Khi đổi profile, nhóm không còn phù hợp sẽ được bỏ chọn."
    rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất một nhóm đã đồng bộ' }, { type: 'array', max: 100, message: 'Chọn tối đa 100 nhóm' }]}>
    <Select mode="multiple" allowClear showSearch maxTagCount="responsive" maxCount={100} loading={loading} options={options}
      placeholder="Tìm và chọn nhóm trong danh sách" optionFilterProp="searchText"
      notFoundContent={loading ? 'Đang tải nhóm...' : 'Không có nhóm phù hợp. Hãy đồng bộ nhóm cho profile đã chọn.'} />
  </Form.Item>;
}

function CollectionPicker({ collections, loading }: { collections: GroupCollection[]; loading: boolean }) {
  return <Form.Item name="collectionIds" label="Tập hợp nhóm" extra="Có thể chọn nhiều tập hợp; nhóm bị trùng giữa các tập hợp chỉ được đăng một lần."
    rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất một tập hợp nhóm' }]}>
    <Select mode="multiple" allowClear showSearch maxTagCount="responsive" maxCount={50} loading={loading} optionFilterProp="label"
      placeholder="Ví dụ: Hải sản, Quần áo..." notFoundContent="Chưa có tập hợp nhóm. Tạo tập hợp trong tab Tập hợp nhóm."
      options={collections.map(collection => ({ value: collection.id, label: `${collection.name} (${collection.items.length} nhóm)` }))} />
  </Form.Item>;
}

async function request<T>(path: string, body?: unknown, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'): Promise<T> {
  const requestMethod = method ?? (body === undefined ? 'GET' : 'POST');
  const response = await fetch(`/api/facebook/${path}`, {
    method: requestMethod, cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  }
  const data = await readApiJson<T & { message?: string | string[] }>(response, `/api/facebook/${path}`);
  if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join('. ') : data.message ?? 'Yêu cầu thất bại');
  return data as T;
}

const labels: Record<string, string> = {
  JOINED: 'Đã tham gia', PENDING: 'Chờ duyệt', UNKNOWN: 'Chưa xác nhận', REQUIRES_ACTION: 'Cần thao tác',
  PAUSED: 'Đã dừng', PAUSING: 'Đang dừng', CANCELLING: 'Đang hủy', DRAFT: 'Bản nháp', NO_TASKS: 'Chưa có tác vụ', SCHEDULED: 'Đã lên lịch', QUEUED: 'Đang chờ', RUNNING: 'Đang chạy', SUCCEEDED: 'Hoàn tất', FAILED: 'Lỗi', CANCELLED: 'Đã hủy',
  PUBLISHED: 'Đã đăng', PENDING_APPROVAL: 'Bài chờ duyệt', SENT: 'Đã gửi',
};
function status(value: string) {
  return <StatusTag value={value} labels={labels} />;
}

function campaignKindLabel(campaign: Campaign) {
  if (campaign.kind === 'SYNC') return 'Đồng bộ nhóm';
  if (campaign.kind === 'JOIN') return 'Tham gia nhóm';
  if (campaign.kind === 'MESSAGE') return campaign.payload.recipientMode === 'OPT_IN' ? 'Nhắn người đã opt-in' : 'Nhắn thành viên nhóm';
  if (campaign.kind === 'MESSAGE_REACTORS') return 'Nhắn người react/bình luận';
  if (campaign.kind === 'SCAN_COMMENTS') return 'Quét SĐT bình luận';
  if (campaign.kind === 'REPLY_COMMENTS') return 'Trả lời bình luận';
  if (campaign.kind === 'COMMENT_GROUP_POSTS') return 'Bình luận bài viết trong nhóm';
  return 'Đăng bài vào nhóm';
}

function targetLink(url: string, label: string, className?: string) {
  return <Space orientation="vertical" size={0} style={{ minWidth: 0, maxWidth: 340 }}>
    <a className={className} href={url} target="_blank" rel="noreferrer" title={url}>{label}</a>
    <Typography.Text type="secondary" style={{ overflowWrap: 'anywhere', fontSize: 12 }}>{url}</Typography.Text>
  </Space>;
}

function campaignStatus(campaign: Campaign) {
  const jobs = campaign.tasks;
  if (campaign.cancelledAt) return jobs.some(job => job.status === 'RUNNING') ? 'CANCELLING' : 'CANCELLED';
  if (campaign.pausedAt) return jobs.some(job => job.status === 'RUNNING') ? 'PAUSING' : 'PAUSED';
  if (jobs.length && jobs.every((job) => job.status === 'CANCELLED')) return 'CANCELLED';
  if (!campaign.approvedAt) return 'DRAFT';
  if (!jobs.length) return 'NO_TASKS';
  if (jobs.some((job) => job.status === 'RUNNING')) return 'RUNNING';
  if (jobs.some((job) => ['QUEUED', 'SCHEDULED'].includes(job.status))) return 'SCHEDULED';
  if (jobs.some((job) => ['REQUIRES_ACTION', 'FAILED'].includes(job.status))) return 'REQUIRES_ACTION';
  if (jobs.some(job => job.status === 'CANCELLED')) return 'CANCELLED';
  return 'SUCCEEDED';
}

export default function FacebookWorkspace({ accounts, canOperate, canAdmin, onNavigateProfiles }: { accounts: Account[]; canOperate: boolean; canAdmin: boolean; onNavigateProfiles: () => void }) {
  const message = useToast();
  const client = useQueryClient();
  const [mode, setMode] = useState<'sync' | 'join' | 'post' | 'comment-group' | 'message' | 'message-reactors' | 'scan-comments' | 'reply-comments' | null>(null);
  const [key, setKey] = useState('');
  const setError = useToastError();
  const [busy, setBusy] = useState(false);
  const [uploadingImages, setUploadingImages] = useState(false);
  const [tab, setTab] = useState('campaigns');
  const [campaignSearch, setCampaignSearch] = useState('');
  const [campaignFilter, setCampaignFilter] = useState('ALL');
  const [campaignLimit, setCampaignLimit] = useState(50);
  const [groupSearch, setGroupSearch] = useState('');
  const [filter, setFilter] = useState<string>();
  const [collectionSearch, setCollectionSearch] = useState('');
  const [collectionEditor, setCollectionEditor] = useState<GroupCollection | 'new'>();
  const [optInEditor, setOptInEditor] = useState<OptInRecipient | 'new'>();
  const [optInFilter, setOptInFilter] = useState<'ACTIVE' | 'REVOKED' | 'ALL'>('ACTIVE');
  const [review, setReview] = useState<Campaign>();
  const [retryReview, setRetryReview] = useState<Campaign>();
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [verifiedUnsent, setVerifiedUnsent] = useState(false);
  const [controlBusy, setControlBusy] = useState<string>();
  const [form] = Form.useForm<Values>();
  const [collectionForm] = Form.useForm<CollectionValues>();
  const [optInForm] = Form.useForm<OptInValues>();
  const recipientMode = Form.useWatch('recipientMode', form) as Values['recipientMode'];
  const submitIntent = useRef<'DRAFT' | 'RUN'>('DRAFT');
  const { modal } = App.useApp();
  const groups = useQuery({ queryKey: ['facebook-groups'], queryFn: () => request<Group[]>('groups'), refetchInterval: 10000 });
  const collections = useQuery({ queryKey: ['facebook-group-collections'], queryFn: () => request<GroupCollection[]>('group-collections') });
  const optInRecipients = useQuery({ queryKey: ['facebook-opt-in-recipients'], queryFn: () => request<OptInRecipient[]>('opt-in-recipients') });
  const campaigns = useQuery({
    queryKey: ['facebook-campaigns', campaignLimit],
    queryFn: () => request<Campaign[]>(`campaigns?take=${campaignLimit}`),
    refetchInterval: query => ((query.state.data as Campaign[] | undefined) ?? []).some(campaign =>
      campaign.tasks.some(task => ['QUEUED', 'SCHEDULED', 'RUNNING'].includes(task.status)),
    ) ? 5000 : false,
  });
  const loadError = (groups.error ?? collections.error ?? optInRecipients.error ?? campaigns.error)?.message;
  const facebookAccounts = accounts.filter((account) => account.platform === 'FACEBOOK' && account.status !== 'DISABLED');
  const ready = facebookAccounts.filter((account) => account.status === 'READY');
  const refresh = async () => { await Promise.all(['facebook-groups', 'facebook-group-collections', 'facebook-opt-in-recipients', 'facebook-campaigns', 'tasks', 'accounts'].map((name) => client.invalidateQueries({ queryKey: [name] }))); };
  const open = (next: typeof mode) => { setKey(crypto.randomUUID()); setError(undefined); setMode(next); };
  const submit = async (values: Values) => {
    if (busy || uploadingImages) return;
    const runImmediately = submitIntent.current === 'RUN';
    submitIntent.current = 'DRAFT';
    setBusy(true); setError(undefined);
    try {
      const { groupUrls, selectedGroupUrls, messageGroupUrls, postUrls, syncScope, accountScope, accountId, accountIds, ...fields } = values;
      const scopedAccountIds = mode === 'reply-comments'
        ? (accountId ? [accountId] : [])
        : accountScope === 'SELECTED' ? accountIds : [];
      const endpoint = mode === 'scan-comments' ? 'posts/scan-comments' : mode === 'reply-comments' ? 'posts/reply-comments' : mode === 'message-reactors' ? 'posts/message-reactors' : mode === 'comment-group' ? 'groups/comment-posts' : `groups/${mode}`;
      const result = await request<{ count?: number; id?: string }>(endpoint, {
        ...fields, accountIds: scopedAccountIds, idempotencyKey: key,
        ...(mode === 'sync' ? { scope: syncScope ?? 'ALL', accountIds: syncScope === 'SELECTED' ? values.accountIds : [] } : {}),
        ...(mode === 'join' ? { groupUrls: [...new Set((groupUrls ?? '').split(/\r?\n/).map((url) => url.trim()).filter(Boolean))] } : {}),
        ...(mode === 'post' && values.selection === 'CUSTOM' ? { groupUrls: selectedGroupUrls ?? [] } : {}),
        ...(mode === 'comment-group' ? { groupUrls: selectedGroupUrls ?? [] } : {}),
        ...(mode === 'message' ? { groupUrls: messageGroupUrls ?? [] } : {}),
        ...(mode === 'scan-comments' || mode === 'message-reactors' ? { postUrls: [...new Set((postUrls ?? '').split(/[\r\n,]+/).map((url) => url.trim()).filter(Boolean))] } : {}),
      });
      if (runImmediately) {
        if (!result.id) throw new Error('Campaign đã tạo nhưng chưa nhận được mã để duyệt. Hãy mở danh sách campaign và chạy lại.');
        try {
          await request(`campaigns/${result.id}/approve`, {});
        } catch (approvalError) {
          // Creation already succeeded. Close the editor so later edits never
          // reuse the same idempotency key against the old payload.
          setTab('campaigns');
          setMode(null);
          await refresh();
          const reason = approvalError instanceof Error ? approvalError.message : String(approvalError);
          throw new Error(`Bản nháp đã được tạo nhưng chưa thể duyệt: ${reason}. Hãy xử lý rồi duyệt từ danh sách campaign.`);
        }
      }
      setTab('campaigns'); setMode(null); await refresh();
       void message.success(runImmediately ? 'Đã tạo, duyệt và xếp hàng campaign để chạy.' : mode === 'sync' ? 'Đã lưu bản nháp đồng bộ. Duyệt campaign để bắt đầu quét nhóm.' : mode === 'scan-comments' ? 'Đã lưu bản nháp quét bình luận. Duyệt để bắt đầu.' : mode === 'reply-comments' ? 'Đã lưu bản nháp rep bình luận. Duyệt để bắt đầu.' : mode === 'message-reactors' ? 'Đã lưu bản nháp nhắn người react/bình luận. Duyệt để bắt đầu.' : mode === 'comment-group' ? 'Đã lưu bản nháp bình luận bài viết. Duyệt để bắt đầu.' : 'Đã lưu bản nháp. Duyệt campaign để bắt đầu chạy.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const submitCampaignForm = () => {
    void form.validateFields().then((values) => submit(values)).catch(() => undefined);
  };
  const collectionGroupOptions = useMemo(() => {
    const inventory = new Map<string, { name: string; profiles: Set<string> }>();
    for (const group of groups.data ?? []) {
      const name = facebookGroupLabel(group);
      const entry = inventory.get(group.groupUrl) ?? { name, profiles: new Set<string>() };
      if (entry.name === facebookGroupId(group.groupUrl)) entry.name = name;
      entry.profiles.add(group.accountId);
      inventory.set(group.groupUrl, entry);
    }
    return [...inventory].map(([value, entry]) => ({ value, label: `${entry.name} (${entry.profiles.size} profile)`, searchText: `${entry.name} ${value}`.toLocaleLowerCase() }))
      .sort((a, b) => a.label.localeCompare(b.label, 'vi'));
  }, [groups.data]);
  const joinedGroupOptions = useMemo(() => {
    const joined = new Set((groups.data ?? []).filter(group => group.status === 'JOINED').map(group => group.groupUrl));
    return collectionGroupOptions.filter(option => joined.has(option.value));
  }, [collectionGroupOptions, groups.data]);
  const openCollection = (collection?: GroupCollection) => {
    setError(undefined);
    setCollectionEditor(collection ?? 'new');
  };
  const saveCollection = async (values: CollectionValues) => {
    if (!collectionEditor) return;
    setBusy(true); setError(undefined);
    try {
      const editing = collectionEditor !== 'new';
      await request(editing ? `group-collections/${collectionEditor.id}` : 'group-collections', values, editing ? 'PATCH' : 'POST');
      setCollectionEditor(undefined); await refresh(); void message.success(editing ? 'Đã cập nhật tập hợp nhóm' : 'Đã tạo tập hợp nhóm');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const openOptIn = (recipient?: OptInRecipient) => {
    setError(undefined);
    optInForm.setFieldsValue(recipient ? {
      groupUrl: recipient.groupUrl,
      profileUrl: recipient.profileUrl,
      displayName: recipient.displayName,
      consentSource: recipient.consentSource,
      consentNote: recipient.consentNote ?? undefined,
      consentRecordedAt: new Date(recipient.consentRecordedAt).toISOString().slice(0, 16),
    } : { groupUrl: undefined, profileUrl: undefined, displayName: undefined, consentSource: undefined, consentNote: undefined, consentRecordedAt: new Date().toISOString().slice(0, 16) });
    setOptInEditor(recipient ?? 'new');
  };
  const saveOptIn = async (values: OptInValues) => {
    setBusy(true); setError(undefined);
    try {
      const body = { ...values, consentRecordedAt: new Date(values.consentRecordedAt).toISOString() };
      const editing = optInEditor && optInEditor !== 'new';
      const path = editing ? `opt-in-recipients/${optInEditor.id}${optInEditor.revokedAt ? '/reactivate' : ''}` : 'opt-in-recipients';
      await request(path, body, editing && !optInEditor.revokedAt ? 'PATCH' : 'POST');
      setOptInEditor(undefined); optInForm.resetFields(); await refresh();
      void message.success(editing ? optInEditor.revokedAt ? 'Đã cập nhật bằng chứng và khôi phục đồng ý.' : 'Đã cập nhật người nhận opt-in.' : 'Đã thêm người nhận và lưu bằng chứng đồng ý.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const revokeOptIn = (recipient: OptInRecipient) => modal.confirm({
    title: `Thu hồi đồng ý của ${recipient.displayName}?`,
    content: 'Người này sẽ không còn được chọn cho campaign opt-in mới.',
    okText: 'Thu hồi', okButtonProps: { danger: true }, cancelText: 'Giữ lại',
    onOk: async () => { await request(`opt-in-recipients/${recipient.id}`, undefined, 'DELETE'); await refresh(); },
  });
  const submitCollectionForm = () => {
    void collectionForm.validateFields().then((values) => saveCollection(values)).catch(() => undefined);
  };
  const deleteCollection = (collection: GroupCollection) => modal.confirm({
    title: `Xóa tập hợp “${collection.name}”?`, content: 'Chỉ xóa cách gom nhóm; danh sách nhóm đã đồng bộ và các chiến dịch cũ vẫn được giữ nguyên.', okText: 'Xóa tập hợp', cancelText: 'Giữ lại', okButtonProps: { danger: true },
    onOk: async () => { try { await request(`group-collections/${collection.id}`, undefined, 'DELETE'); await refresh(); void message.success('Đã xóa tập hợp nhóm'); } catch (caught) { void message.error(caught instanceof Error ? caught.message : String(caught)); throw caught; } },
  });
  const groupLabelByUrl = useMemo(() => new Map(collectionGroupOptions.map(option => [option.value, option.label.replace(/ \(\d+ profile\)$/, '')])), [collectionGroupOptions]);
  const approve = async () => {
    if (!review) return;
    setBusy(true); setError(undefined);
    try { await request(`campaigns/${review.id}/approve`, {}); setReview(undefined); await refresh(); void message.success('Đã duyệt và lên lịch chiến dịch'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    let values: Values;
    try { values = await form.validateFields(); } catch { return; }
    const selectedIds = mode === 'sync'
      ? values.syncScope === 'SELECTED' ? values.accountIds : ready.map(account => account.id)
      : mode === 'reply-comments'
        ? (values.accountId ? [values.accountId] : [])
        : values.accountScope === 'SELECTED' ? values.accountIds : ready.map(account => account.id);
    const unavailable = selectedIds.filter(id => !ready.some(account => account.id === id));
    if (!selectedIds.length || unavailable.length) {
      setError(unavailable.length ? 'Một số profile đã chọn chưa sẵn sàng. Hãy hoàn tất đăng nhập hoặc xác minh trước khi duyệt.' : 'Không có profile sẵn sàng để xếp hàng campaign.');
      return;
    }
    const postUrls = (values.postUrls ?? '').split(/[\r\n,]+/).map(url => url.trim()).filter(Boolean);
    const groupUrls = mode === 'join'
      ? (values.groupUrls ?? '').split(/\r?\n/).map(url => url.trim()).filter(Boolean)
      : mode === 'message' ? values.messageGroupUrls ?? [] : values.selectedGroupUrls ?? [];
    const targetLabel = mode === 'post' && values.selection === 'ALL' ? 'Tất cả nhóm phù hợp'
      : mode === 'post' && values.selection === 'COLLECTIONS' ? `${values.collectionIds?.length ?? 0} tập hợp nhóm`
      : mode === 'reply-comments' ? '1 bài viết'
      : postUrls.length ? `${postUrls.length} bài viết`
      : groupUrls.length ? `${groupUrls.length} nhóm`
      : mode === 'message' ? 'Tất cả nhóm đã tham gia' : 'Phạm vi theo cấu hình';
    modal.confirm({
      title: 'Kiểm tra trước khi xếp hàng campaign',
      content: <Space orientation="vertical" size={10} style={{ width: '100%' }}>
        <Typography.Text><strong>{values.name || 'Campaign đồng bộ nhóm'}</strong></Typography.Text>
        <Typography.Text>{selectedIds.length} profile · {targetLabel}</Typography.Text>
        {values.text ? <Typography.Paragraph ellipsis={{ rows: 3 }} style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{values.text}</Typography.Paragraph> : null}
        <Alert type="warning" showIcon title="Campaign sẽ được duyệt và xếp hàng" description="Hành động thật chỉ bắt đầu khi đến lượt của từng profile; campaign đang chạy trước đó vẫn giữ nguyên thứ tự." />
      </Space>,
      okText: 'Duyệt & xếp hàng',
      cancelText: 'Quay lại chỉnh sửa',
      onOk: () => { submitIntent.current = 'RUN'; return submit(values); },
    });
  };
  const retryKind = (job: Job) => job.retrySafety ?? (job.attemptCount === 0 || job.runs[0]?.result?.sideEffectStarted === false ? 'SAFE' : 'VERIFY');
  const isReady = (job: Job) => accounts.some(account => account.id === job.account.id && account.status === 'READY');
  const openRetry = (campaign: Campaign) => {
    setError(undefined); setVerifiedUnsent(false); setRetryReview(campaign);
    setSelectedTaskIds(campaign.tasks.filter(job => ['FAILED', 'REQUIRES_ACTION'].includes(job.status) && isReady(job) && retryKind(job) === 'SAFE').map(job => job.id));
  };
  const runControl = async (campaign: Campaign, action: 'pause' | 'resume') => {
    setControlBusy(campaign.id); setError(undefined);
    try {
      await request(`campaigns/${campaign.id}/${action}`, {});
      await refresh();
      void message.success(action === 'pause' ? 'Đã yêu cầu dừng. Chờ tác vụ đang chạy kết thúc an toàn.' : 'Đã tiếp tục phần còn lại của chiến dịch.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setControlBusy(undefined); }
  };
  const retry = async () => {
    if (!retryReview) return;
    setBusy(true); setError(undefined);
    try {
      await request(`campaigns/${retryReview.id}/retry`, { taskIds: selectedTaskIds, verifiedUnsentTaskIds: verifiedUnsent ? selectedTaskIds.filter(id => retryReview.tasks.some(job => job.id === id && retryKind(job) === 'VERIFY')) : [] });
      setRetryReview(undefined); await refresh(); void message.success('Đã lên lịch lại các tác vụ được chọn; phần hoàn thành được giữ nguyên.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const cancel = (campaign: Campaign) => modal.confirm({
    title: `Hủy chiến dịch “${campaign.name}”?`, content: 'Hủy phần chưa hoàn thành và không thể tiếp tục chiến dịch này. Thao tác đang chạy được kết thúc an toàn. Dùng Dừng nếu muốn tiếp tục sau.', okText: 'Hủy chiến dịch', cancelText: 'Giữ lại', okButtonProps: { danger: true },
    onOk: async () => { try { await request(`campaigns/${campaign.id}/cancel`, {}); await refresh(); message.success('Đã hủy chiến dịch'); } catch (caught) { void message.error(caught instanceof Error ? caught.message : String(caught)); throw caught; } },
  });
  const campaignSummary = (campaign: Campaign) => {
    const grouped = new Map<string, { target: string; url?: string; tasks: number; succeeded: number; commentsScanned: number; phoneCount: number; phoneNumbers: Set<string>; postsFound: number; postsCommented: number; repliesSent: number; repliesRequested: number; commentsAvailable: number; statuses: Set<string> }>();
    for (const job of campaign.tasks) {
      const result = job.runs[0]?.result;
      const target = job.payload.postUrl ?? job.payload.groupUrl ?? job.payload.profileUrl ?? 'Danh sách nhóm đã tham gia';
      const row = grouped.get(target) ?? { target, url: job.payload.postUrl ?? job.payload.groupUrl ?? job.payload.profileUrl, tasks: 0, succeeded: 0, commentsScanned: 0, phoneCount: 0, phoneNumbers: new Set<string>(), postsFound: 0, postsCommented: 0, repliesSent: 0, repliesRequested: 0, commentsAvailable: 0, statuses: new Set<string>() };
      row.tasks += 1;
      if (job.status === 'SUCCEEDED') row.succeeded += 1;
      row.statuses.add(job.status);
      for (const value of [result?.publicationStatus, result?.membershipStatus, result?.messageStatus, result?.commentStatus, result?.replyStatus]) {
        if (value) row.statuses.add(value);
      }
      row.commentsScanned += result?.commentsScanned ?? 0;
      row.postsFound += result?.postsFound ?? 0;
      row.postsCommented += result?.postsCommented ?? 0;
      row.phoneCount += result?.phoneCount ?? result?.phoneNumbers?.length ?? 0;
      row.repliesSent += result?.repliesSent ?? 0;
      row.repliesRequested += result?.repliesRequested ?? job.payload.maxReplies ?? 0;
      row.commentsAvailable += result?.commentsAvailable ?? 0;
      for (const phone of result?.phoneNumbers ?? []) row.phoneNumbers.add(phone);
      grouped.set(target, row);
    }
    return [...grouped.values()].map(row => ({ ...row, phoneNumbers: [...row.phoneNumbers] }));
  };
  const summaryTable = (campaign: Campaign) => {
    const rows = campaignSummary(campaign);
    if (!rows.length) return null;
    return <><Typography.Title level={5} style={{ marginTop: 0 }}>Tổng hợp kết quả theo đích</Typography.Title><Table className="campaign-table" size="small" rowKey="target" dataSource={rows} pagination={tablePagination('đích')} scroll={{ x: 700 }} columns={[
      { title: 'Đích', render: (_, row) => row.url ? targetLink(row.url, row.target) : row.target },
      { title: 'Tiến độ', render: (_, row) => `${row.succeeded}/${row.tasks} tác vụ hoàn tất` },
      { title: 'Kết quả', render: (_, row) => <Space orientation="vertical" size={2}>{row.postsFound ? <Typography.Text type="secondary">Đã cmt {row.postsCommented}/{row.postsFound} bài</Typography.Text> : null}{row.commentsScanned || row.phoneCount ? <Typography.Text type="secondary">{row.commentsScanned} bình luận · {row.phoneNumbers.length || row.phoneCount} SĐT</Typography.Text> : null}{row.phoneNumbers.length ? <Typography.Text copyable={{ text: row.phoneNumbers.join(', ') }} type="secondary">{row.phoneNumbers.join(', ')}</Typography.Text> : null}{row.repliesRequested ? <Typography.Text type="secondary">Đã rep {row.repliesSent}/{row.repliesRequested} lượt{row.commentsAvailable ? ` · ${row.commentsAvailable} bình luận có thể rep` : ''}</Typography.Text> : null}{!row.postsFound && !row.commentsScanned && !row.phoneCount && !row.phoneNumbers.length && !row.repliesRequested ? <Space size={4}>{[...row.statuses].map(value => <span key={value}>{status(value)}</span>)}</Space> : null}</Space> },
    ]} /></>;
  };
  const jobsTable = (jobs: Job[]) => <Table<Job> className="campaign-table" size="small" rowKey="id" dataSource={jobs} pagination={tablePagination('tác vụ')} scroll={{ x: 650 }} columns={[
    { title: 'Profile', render: (_, job) => <Space orientation="vertical" size={3}><strong>{job.account.username ?? job.account.id}</strong><Typography.Text type="secondary">{isReady(job) ? 'Profile sẵn sàng' : 'Profile chưa sẵn sàng'}</Typography.Text></Space> },
    { title: 'Đích', render: (_, job) => { const result = job.runs[0]?.result; const profileUrl = result?.profileUrl ?? job.payload.profileUrl; const displayName = result?.displayName ?? job.payload.displayName; const scopeUrl = result?.groupUrl ?? job.payload.groupUrl; return job.payload.postUrl ? targetLink(job.payload.postUrl, 'Bài viết cần quét') : profileUrl ? <Space orientation="vertical" size={2}>{targetLink(profileUrl, displayName ?? profileUrl)}<Typography.Text type="secondary">{scopeUrl ? groupLabelByUrl.get(scopeUrl) ?? scopeUrl : 'Người nhận từ bài viết'}</Typography.Text></Space> : scopeUrl ? targetLink(scopeUrl, scopeUrl) : 'Quét nhóm đã tham gia'; } },
    { title: 'Kết quả', render: (_, job) => { const result = job.runs[0]?.result; return <Space orientation="vertical" size={2}>{status(job.status)}{result?.publicationStatus ? status(result.publicationStatus) : null}{result?.membershipStatus ? status(result.membershipStatus) : null}{result?.messageStatus ? status(result.messageStatus) : null}{result?.commentStatus ? status(result.commentStatus) : null}{result?.replyStatus ? status(result.replyStatus) : null}{result?.profileUrl ? <Typography.Text type="secondary">Đã inbox: <a href={result.profileUrl} target="_blank" rel="noreferrer">{result.displayName ?? result.profileUrl}</a></Typography.Text> : null}{result?.postsFound != null ? <Typography.Text type="secondary">Đã cmt {result.postsCommented ?? 0}/{result.postsFound} bài</Typography.Text> : null}{result?.posts?.length ? <Space orientation="vertical" size={1}>{result.posts.slice(0, 12).map((post, index) => post.postUrl ? <Typography.Text key={`${post.postUrl}-${index}`} type="secondary">{post.commentStatus === 'SENT' || post.postStatus === 'SENT' ? 'Đã comment: ' : 'Bài: '}<a href={post.postUrl} target="_blank" rel="noreferrer">{post.postUrl}</a>{post.reason ? ` · ${post.reason}` : ''}</Typography.Text> : null)}{result.posts.length > 12 ? <Typography.Text type="secondary">… và {result.posts.length - 12} bài khác</Typography.Text> : null}</Space> : null}{result?.commentsScanned != null ? <Typography.Text type="secondary">Đã quét {result.commentsScanned} bình luận · {result.phoneCount ?? 0} SĐT</Typography.Text> : null}{result?.phoneNumbers?.length ? <Typography.Text copyable={{ text: result.phoneNumbers.join(', ') }} type="secondary">{result.phoneNumbers.join(', ')}</Typography.Text> : null}{result?.repliesRequested != null ? <Typography.Text type="secondary">Đã rep {result.repliesSent ?? 0}/{result.repliesRequested} lượt{result.commentsAvailable != null ? ` · ${result.commentsAvailable} bình luận có thể rep` : ''}</Typography.Text> : null}{job.lastError ? <Typography.Text type="secondary">{job.lastError}</Typography.Text> : null}</Space>; } },
  ]} />;
  const retryMode = Boolean(retryReview && campaignStatus(retryReview) === 'REQUIRES_ACTION');
  const facebookCampaigns = campaigns.data ?? [];
  const activeCampaignCount = facebookCampaigns.filter(campaign => ['SCHEDULED', 'RUNNING', 'PAUSING'].includes(campaignStatus(campaign))).length;
  const issueCampaignCount = facebookCampaigns.filter(campaign => campaignStatus(campaign) === 'REQUIRES_ACTION').length;
  const completedCampaignCount = facebookCampaigns.filter(campaign => campaignStatus(campaign) === 'SUCCEEDED').length;
  return <div className="facebook-workspace">
    <CampaignSummary items={[
      { label: 'Tổng chiến dịch', value: facebookCampaigns.length, icon: 'tasks' },
      { label: 'Đang chạy / chờ chạy', value: activeCampaignCount, icon: 'play' },
      { label: 'Lỗi / cần xử lý', value: issueCampaignCount, icon: 'reject' },
      { label: 'Đã hoàn tất', value: completedCampaignCount, icon: 'approve' },
    ]} />
    <CampaignStartBar title="Quản lý chiến dịch Facebook" description="Tạo chiến dịch mới, theo dõi tiến độ và xử lý kết quả theo từng profile." action={<Dropdown trigger={['click']} disabled={!canOperate || !facebookAccounts.length} menu={{ items: [
         { key: 'post', label: 'Đăng bài vào nhóm', icon: <Icon name="edit" /> },
         { key: 'join', label: 'Tham gia nhóm', icon: <Icon name="plus" /> },
         { key: 'sync', label: 'Đồng bộ nhóm', icon: <Icon name="refresh" /> },
         { type: 'divider' },
         { key: 'comment-group', label: 'Bình luận bài viết trong nhóm', icon: <Icon name="edit" /> },
         { key: 'reply-comments', label: 'Trả lời bình luận', icon: <Icon name="edit" /> },
         { key: 'message', label: 'Nhắn thành viên nhóm / người đã opt-in', icon: <Icon name="edit" />, disabled: !collectionGroupOptions.length },
         { key: 'message-reactors', label: 'Nhắn người react/bình luận', icon: <Icon name="edit" /> },
         { key: 'scan-comments', label: 'Quét số điện thoại bình luận', icon: <Icon name="search" /> },
       ], onClick: ({ key }) => open(key as Exclude<typeof mode, null>) }}>
         <Button type="primary" icon={<Icon name="plus" />} disabled={!canOperate || !facebookAccounts.length}>Tạo chiến dịch</Button>
       </Dropdown>} />
    {loadError ? <Alert type="error" showIcon title="Không tải được dữ liệu Facebook" description="Một phần dữ liệu chiến dịch chưa sẵn sàng. Hãy thử tải lại; chi tiết kỹ thuật vẫn được giữ trong log hệ thống." action={<Button onClick={() => void refresh()}>Thử lại</Button>} /> : null}
    {!ready.length ? <Alert type="info" showIcon title="Cần ít nhất một profile Facebook sẵn sàng" description="Mở browser trong Profiles để đăng nhập, kiểm tra phiên rồi đóng browser trước khi chạy chiến dịch." action={<Button onClick={onNavigateProfiles}>Mở Profiles</Button>} /> : null}
    <Tabs className="facebook-tabs" activeKey={tab} onChange={setTab} items={[{ key: 'campaigns', label: `Chiến dịch (${campaigns.data?.length ?? 0})` }, { key: 'groups', label: `Nhóm đã tham gia (${(groups.data ?? []).filter(group => group.status === 'JOINED').length})` }, { key: 'collections', label: `Tập hợp nhóm (${collections.data?.length ?? 0})` }, { key: 'opt-in', label: `Người nhận opt-in (${(optInRecipients.data ?? []).filter(recipient => !recipient.revokedAt).length})` }]} />
    {tab === 'groups' ? <Card className="resource-card" title={<PageSectionTitle title="Danh sách nhóm" description="Nhóm và trạng thái tham gia của từng profile" />} extra={<Input.Search aria-label="Tìm nhóm" placeholder="Tìm tên hoặc link nhóm..." allowClear value={groupSearch} onChange={event => setGroupSearch(event.target.value)} />}>
      <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}><Typography.Text type="secondary">Danh sách từ lần đồng bộ gần nhất</Typography.Text><Select aria-label="Lọc nhóm theo profile" allowClear placeholder="Tất cả profile" style={{ minWidth: 230 }} value={filter} onChange={setFilter} options={accounts.filter(account => account.platform === 'FACEBOOK').map(account => ({ value: account.id, label: account.username ?? account.id }))} /></Flex>
      <Table<Group> className="campaign-table" size="middle" rowKey="id" loading={groups.isLoading} dataSource={(groups.data ?? []).filter(group => (!filter || group.accountId === filter) && `${facebookGroupLabel(group)} ${group.groupUrl} ${group.account.username ?? ''}`.toLowerCase().includes(groupSearch.toLowerCase().trim()))} pagination={tablePagination('nhóm')} scroll={{ x: 700 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có nhóm phù hợp. Đồng bộ từ Facebook hoặc thử bộ lọc khác." /> }} columns={[
        { title: 'Nhóm', render: (_, group) => targetLink(group.groupUrl, facebookGroupLabel(group), 'group-link') },
        { title: 'Profile', render: (_, group) => group.account.username ?? group.accountId },
        { title: 'Trạng thái', dataIndex: 'status', render: status },
        { title: 'Cập nhật', render: (_, group) => new Date(group.lastSyncedAt).toLocaleString('vi-VN') },
      ]} />
    </Card> : tab === 'collections' ? <Card className="resource-card" title={<PageSectionTitle title="Tập hợp nhóm" description="Gom các nhóm cùng chủ đề để chọn nhanh khi đăng bài" />} extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm tập hợp" placeholder="Tìm tập hợp..." allowClear value={collectionSearch} onChange={event => setCollectionSearch(event.target.value)} /><Button type="primary" icon={<Icon name="plus" />} disabled={!canOperate || !collectionGroupOptions.length} onClick={() => openCollection()}>Tạo tập hợp</Button></Space>}>
      <Table<GroupCollection> className="campaign-table" size="middle" rowKey="id" loading={collections.isLoading} dataSource={(collections.data ?? []).filter(collection => `${collection.name} ${collection.description ?? ''}`.toLocaleLowerCase().includes(collectionSearch.toLocaleLowerCase().trim()))} pagination={tablePagination('tập hợp')} scroll={{ x: 700 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={collectionGroupOptions.length ? 'Chưa có tập hợp. Tạo tập hợp đầu tiên để chọn nhanh khi đăng bài.' : 'Đồng bộ nhóm Facebook trước khi tạo tập hợp.'} /> }} columns={[
        { title: 'Tên tập hợp', render: (_, collection) => <Space orientation="vertical" size={2}><strong>{collection.name}</strong>{collection.description ? <Typography.Text type="secondary">{collection.description}</Typography.Text> : null}</Space> },
        { title: 'Số nhóm', render: (_, collection) => <Tag>{collection.items.length} nhóm</Tag> },
        { title: 'Cập nhật', render: (_, collection) => new Date(collection.updatedAt).toLocaleString('vi-VN') },
        { title: 'Thao tác', width: 112, render: (_, collection) => <Space size={6}><Tooltip title="Sửa tập hợp"><Button aria-label={`Sửa ${collection.name}`} icon={<Icon name="edit" />} disabled={!canOperate} onClick={() => openCollection(collection)} /></Tooltip><Tooltip title={canAdmin ? 'Xóa tập hợp' : 'Cần quyền quản trị để xóa'}><Button aria-label={`Xóa ${collection.name}`} icon={<Icon name="delete" />} danger disabled={!canAdmin} onClick={() => deleteCollection(collection)} /></Tooltip></Space> },
      ]} />
    </Card> : tab === 'opt-in' ? <Card className="resource-card" title={<PageSectionTitle title="Người nhận đã đồng ý" description="Quản lý bằng chứng đồng ý trước khi dùng nguồn opt-in cho campaign nhắn tin" />} extra={<Space className="card-toolbar"><Select aria-label="Lọc người nhận opt-in" value={optInFilter} onChange={setOptInFilter} options={[{ value: 'ACTIVE', label: 'Còn hiệu lực' }, { value: 'REVOKED', label: 'Đã thu hồi' }, { value: 'ALL', label: 'Tất cả' }]} /><Button type="primary" icon={<Icon name="plus" />} disabled={!canOperate || !collectionGroupOptions.length} onClick={() => openOptIn()}>Thêm người nhận</Button></Space>}>
      <Table<OptInRecipient> className="campaign-table" size="middle" rowKey="id" loading={optInRecipients.isLoading} dataSource={(optInRecipients.data ?? []).filter(recipient => optInFilter === 'ALL' || (optInFilter === 'REVOKED') === Boolean(recipient.revokedAt))} pagination={tablePagination('người nhận')} scroll={{ x: 900 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có người nhận phù hợp bộ lọc." /> }} columns={[
        { title: 'Người nhận', render: (_, recipient) => <Space orientation="vertical" size={0}><strong>{recipient.displayName}</strong><a href={recipient.profileUrl} target="_blank" rel="noreferrer">{recipient.profileUrl}</a></Space> },
        { title: 'Nhóm', render: (_, recipient) => targetLink(recipient.groupUrl, groupLabelByUrl.get(recipient.groupUrl) ?? facebookGroupId(recipient.groupUrl)) },
        { title: 'Bằng chứng', render: (_, recipient) => <Space orientation="vertical" size={0}><span>{recipient.consentSource}</span><Typography.Text type="secondary">{new Date(recipient.consentRecordedAt).toLocaleString('vi-VN')}</Typography.Text></Space> },
        { title: 'Trạng thái', render: (_, recipient) => recipient.revokedAt ? <Tag color="default">Đã thu hồi</Tag> : <Tag color="green">Còn hiệu lực</Tag> },
        { title: 'Thao tác', width: 160, render: (_, recipient) => <Space size={6}><Button disabled={!canOperate} onClick={() => openOptIn(recipient)}>{recipient.revokedAt ? 'Sửa & khôi phục' : 'Sửa'}</Button>{!recipient.revokedAt ? <Button danger disabled={!canOperate} onClick={() => revokeOptIn(recipient)}>Thu hồi</Button> : null}</Space> },
      ]} />
    </Card> : <Card className="resource-card" title={<PageSectionTitle title="Danh sách chiến dịch Facebook" description="Mỗi dòng là một chiến dịch; mở chi tiết để xem kết quả của từng profile" />} extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm chiến dịch Facebook" placeholder="Tìm chiến dịch..." allowClear value={campaignSearch} onChange={event => setCampaignSearch(event.target.value)} /><Select aria-label="Lọc chiến dịch Facebook" className="status-filter" value={campaignFilter} onChange={setCampaignFilter} options={['ALL', 'DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSING', 'PAUSED', 'REQUIRES_ACTION', 'SUCCEEDED', 'CANCELLING', 'CANCELLED'].map(value => ({ value, label: value === 'ALL' ? 'Tất cả trạng thái' : labels[value] ?? value }))} /><Tooltip title="Làm mới chiến dịch"><Button aria-label="Làm mới chiến dịch" icon={<Icon name="refresh" />} onClick={() => void refresh()} /></Tooltip></Space>}>
       <Table<Campaign> className="campaign-table" size="middle" rowKey="id" loading={campaigns.isLoading} dataSource={(campaigns.data ?? []).filter(campaign => (campaignFilter === 'ALL' || campaignStatus(campaign) === campaignFilter) && campaign.name.toLowerCase().includes(campaignSearch.toLowerCase().trim())).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())} pagination={tablePagination('chiến dịch')} scroll={{ x: 1_270 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có chiến dịch. Tham gia nhóm hoặc soạn bài để tạo bản nháp đầu tiên." /> }} columns={[
        { title: 'Chiến dịch', width: 240, render: (_, campaign) => <div className="campaign-name"><strong>{campaign.name}</strong><small>{campaignKindLabel(campaign)}</small></div> },
        { title: 'Loại', width: 180, render: (_, campaign) => <Tag>{campaignKindLabel(campaign)}</Tag> },
        { title: 'Profile', width: 110, render: (_, campaign) => `${new Set(campaign.tasks.map(job => job.account.id)).size} profile` },
        { title: 'Tiến độ', width: 280, render: (_, campaign) => { const completed = campaign.tasks.filter(job => job.status === 'SUCCEEDED').length; const needsAction = campaign.tasks.filter(job => ['FAILED', 'REQUIRES_ACTION'].includes(job.status)).length; const hasTasks = campaign.tasks.length > 0; const currentStatus = campaignStatus(campaign); return <div className="campaign-result-cell"><span className="campaign-result-primary">{hasTasks ? `${completed}/${campaign.tasks.length} tác vụ hoàn tất` : 'Chưa có tác vụ'}</span><Typography.Text type="secondary">{needsAction ? `${needsAction} tác vụ cần xử lý` : currentStatus === 'DRAFT' ? 'Chờ duyệt để chạy' : currentStatus === 'NO_TASKS' ? 'Chiến dịch chưa được phân bổ tác vụ' : currentStatus === 'SUCCEEDED' ? 'Đã hoàn tất' : 'Đang xử lý'}</Typography.Text></div>; } },
        { title: 'Trạng thái', width: 130, render: (_, campaign) => status(campaignStatus(campaign)) },
        { title: 'Người tạo', width: 180, ellipsis: true, render: (_, campaign) => campaign.createdBy?.displayName || campaign.createdBy?.email || 'Dữ liệu cũ' },
        { title: 'Ngày tạo', width: 150, render: (_, campaign) => new Date(campaign.createdAt).toLocaleString('vi-VN') },
        { title: 'Thao tác', width: 180, fixed: 'right', render: (_, campaign) => { const currentStatus = campaignStatus(campaign); const hasPendingApproval = !campaign.approvedAt && !campaign.cancelledAt && campaign.tasks.some(job => job.approvalStatus === 'PENDING'); const active = !campaign.cancelledAt && campaign.tasks.some(job => ['SCHEDULED', 'QUEUED', 'RUNNING'].includes(job.status)); return <Space className="campaign-actions" wrap size={6}>
          {hasPendingApproval ? <ActionButton label="Duyệt & chạy" icon="approve" type="primary" disabled={!canAdmin} onClick={() => { setReview(campaign); setError(undefined); }} /> : null}
          {campaign.tasks.length ? <ActionButton label="Xem chi tiết" icon="view" disabled={!!controlBusy} onClick={() => openRetry(campaign)} /> : null}
          {currentStatus === 'REQUIRES_ACTION' ? <ActionButton label="Chạy lại" icon="refresh" disabled={!!controlBusy || !canAdmin} onClick={() => openRetry(campaign)} /> : null}
          {campaign.approvedAt && !campaign.cancelledAt && !campaign.pausedAt && active ? <ActionButton label="Tạm dừng chiến dịch" icon="pause" disabled={!canAdmin || !!controlBusy} loading={controlBusy === campaign.id} onClick={() => void runControl(campaign, 'pause')} /> : null}
          {campaign.pausedAt && !campaign.cancelledAt ? <ActionButton label="Tiếp tục chiến dịch" icon="play" disabled={!canAdmin || !!controlBusy || campaign.tasks.some(job => job.status === 'RUNNING')} loading={controlBusy === campaign.id} onClick={() => void runControl(campaign, 'resume')} /> : null}
          {!campaign.cancelledAt && campaign.tasks.some(job => ['DRAFT', 'SCHEDULED', 'QUEUED', 'RUNNING', 'PAUSED', 'FAILED', 'REQUIRES_ACTION'].includes(job.status)) ? <ActionButton label="Hủy chiến dịch" icon="close" danger disabled={!canAdmin || !!controlBusy} onClick={() => cancel(campaign)} /> : null}
        </Space>; } },
       ]} />
       {(campaigns.data?.length ?? 0) >= campaignLimit && campaignLimit < 2_000 ? <Flex justify="center" style={{ marginTop: 16 }}><Button loading={campaigns.isFetching} onClick={() => setCampaignLimit(limit => Math.min(2_000, limit + 50))}>Tải thêm chiến dịch cũ</Button></Flex> : null}
    </Card>}
    <Modal className="campaign-create-modal" title={mode === 'sync' ? 'Đồng bộ nhóm đã tham gia' : mode === 'join' ? 'Tham gia danh sách nhóm' : mode === 'message' ? recipientMode === 'OPT_IN' ? 'Nhắn người đã đồng ý nhận tin' : 'Nhắn thành viên nhóm' : mode === 'message-reactors' ? 'Nhắn người react/bình luận bài viết' : mode === 'scan-comments' ? 'Quét số điện thoại trong bình luận' : mode === 'reply-comments' ? 'Rep bình luận trong bài viết' : mode === 'comment-group' ? 'Cmt vào bài viết trong nhóm' : 'Đăng bài vào nhóm'} open={mode !== null} onCancel={() => { if (!busy && !uploadingImages) setMode(null); }} destroyOnHidden width={820} confirmLoading={busy} cancelButtonProps={{ disabled: busy || uploadingImages }} footer={<Space className="campaign-modal-actions"><Button onClick={() => setMode(null)} disabled={busy || uploadingImages}>Đóng</Button><Button disabled={busy || uploadingImages} onClick={() => { submitIntent.current = 'DRAFT'; submitCampaignForm(); }}>Lưu bản nháp</Button><Button type="primary" disabled={!canAdmin || !ready.length || busy || uploadingImages} onClick={() => void runNow()}>Duyệt & xếp hàng</Button></Space>}>
        <Form<Values> className="campaign-create-form" id="facebook-form" form={form} key={key} layout="vertical" preserve={false} disabled={busy} initialValues={{ accountScope: 'ALL', accountIds: [], syncScope: 'ALL', mediaAssetIds: [], recipientMode: 'RANDOM', recipientSource: 'REACTORS', intervalSeconds: 10, selection: 'ALL', maxGroupsPerAccount: 5, maxRecipientsPerGroup: 10, maxRecipientsPerPost: 10, daysRecent: 7, minReactions: 0, minComments: 0, maxPosts: 10 }} onFinish={(values) => void submit(values)}>
        {mode !== 'sync' ? <Form.Item name="name" label="Tên chiến dịch" rules={[{ required: true, whitespace: true }, { max: 120 }]}><Input placeholder="Ví dụ: Bài giới thiệu tháng 9" /></Form.Item> : null}
        {mode === 'sync' ? <>
          <Typography.Paragraph type="secondary">Quét danh sách nhóm đã tham gia trực tiếp trên Facebook của từng profile, bao gồm nhóm tham gia thủ công và nhóm ngoài chiến dịch. Profile cần sẵn sàng, browser đã đóng và proxy hoạt động.</Typography.Paragraph>
          <Form.Item name="syncScope" label="Phạm vi đồng bộ"><Select options={[{ value: 'ALL', label: `Tất cả profile Facebook sẵn sàng (${ready.length})` }, { value: 'SELECTED', label: 'Chọn profile cụ thể' }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.syncScope !== after.syncScope}>{({ getFieldValue }) => getFieldValue('syncScope') === 'SELECTED' ?
            <Form.Item name="accountIds" label="Profile cần đồng bộ" rules={[{ type: 'array', min: 1, required: true, message: 'Chọn ít nhất một profile để đồng bộ' }]}>
              <Select mode="multiple" allowClear showSearch optionFilterProp="label" maxCount={100} placeholder="Chọn một hoặc nhiều profile" options={ready.map(account => ({ value: account.id, label: account.username ?? account.id }))} />
            </Form.Item> : null}</Form.Item>
        </> : mode === 'reply-comments' ? <Form.Item name="accountId" label="Profile trả lời" extra="Một bài viết chỉ được giao cho một profile để tránh trả lời trùng." rules={[{ required: true, message: 'Chọn profile sẽ trả lời bình luận' }]}><Select showSearch optionFilterProp="label" placeholder="Chọn một profile" options={facebookAccounts.map(account => ({ value: account.id, label: `${account.username ?? account.id}${account.status === 'READY' ? '' : ` · ${labels[account.status] ?? account.status}`}` }))} /></Form.Item> : <>
          <Form.Item name="accountScope" label="Phạm vi profile"><Select options={[{ value: 'ALL', label: `Tất cả profile sẵn sàng (${ready.length})` }, { value: 'SELECTED', label: 'Chọn profile cụ thể' }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.accountScope !== after.accountScope}>{({ getFieldValue }) => getFieldValue('accountScope') === 'SELECTED' ? <Form.Item name="accountIds" label="Profile thực hiện" extra="Có thể lưu nháp với profile chưa sẵn sàng; profile phải READY trước khi duyệt." rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất một profile' }]}><Select mode="multiple" allowClear showSearch optionFilterProp="label" placeholder="Chọn một hoặc nhiều profile" options={facebookAccounts.map(account => ({ value: account.id, label: `${account.username ?? account.id}${account.status === 'READY' ? '' : ` · ${labels[account.status] ?? account.status}`}` }))} /></Form.Item> : null}</Form.Item>
        </>}
        {mode === 'join' ? <Form.Item name="groupUrls" label="Link nhóm (mỗi dòng một link)" extra="Tối đa 100 link. Link trùng sẽ được gộp." rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={7} placeholder={'https://www.facebook.com/groups/123456/\nhttps://www.facebook.com/groups/ten-nhom/'} /></Form.Item> : null}
        {mode === 'post' ? <>
          <Form.Item name="text" label="Nội dung bài viết" dependencies={['mediaAssetIds']} rules={[{ max: 20000 }, ({ getFieldValue }) => ({ validator: (_, value) => value?.trim() || getFieldValue('mediaAssetIds')?.length ? Promise.resolve() : Promise.reject(new Error('Nhập nội dung hoặc chọn ít nhất một ảnh')) })]}><Input.TextArea rows={5} showCount maxLength={20000} placeholder="Nhập nội dung bài viết..." /></Form.Item>
          <Form.Item name="mediaAssetIds" label="Ảnh đính kèm"><FacebookImagePicker disabled={busy} onUploadingChange={setUploadingImages} /></Form.Item>
          <Form.Item name="selection" label="Nhóm đăng bài"><Select options={[{ value: 'ALL', label: 'Tất cả nhóm đã tham gia' }, { value: 'COLLECTIONS', label: 'Chọn theo tập hợp nhóm' }, { value: 'CUSTOM', label: 'Tự chọn trong nhóm đã đồng bộ' }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.selection !== after.selection}>{({ getFieldValue }) => getFieldValue('selection') === 'CUSTOM' ? <SyncedGroupPicker groups={groups.data ?? []} accounts={accounts} loading={groups.isLoading} /> : getFieldValue('selection') === 'COLLECTIONS' ? <CollectionPicker collections={collections.data ?? []} loading={collections.isLoading} /> : null}</Form.Item>
          <Form.Item name="maxGroupsPerAccount" label="Tối đa số nhóm / account" extra="Các nhóm được giao tuần tự theo vòng tròn để số lượng giữa các account cân bằng; không chọn ngẫu nhiên." rules={[{ required: true, message: 'Nhập số nhóm tối đa cho mỗi account' }]}><InputNumber min={1} max={500} /></Form.Item>
        </> : null}
          {mode === 'comment-group' ? <>
          <Alert type="info" showIcon title="Bình luận các bài viết phù hợp trong nhóm" description="Profile sẽ mở bảng tin nhóm, lọc bài viết theo thời gian, số tim và số bình luận, sau đó bình luận từng bài phù hợp. Mỗi profile chỉ xử lý các nhóm mà profile đó đã tham gia." style={{ marginBottom: 16 }} />
          <Form.Item name="selectedGroupUrls" label="Nhóm cần bình luận" rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất một nhóm đã tham gia' }]}><Select mode="multiple" allowClear showSearch maxTagCount="responsive" maxCount={100} optionFilterProp="searchText" options={joinedGroupOptions} placeholder="Chọn nhóm đã tham gia" notFoundContent="Hãy đồng bộ và tham gia nhóm trước" /></Form.Item>
          <Form.Item name="text" label="Nội dung bình luận" dependencies={['mediaAssetIds']} rules={[{ max: 5000 }, ({ getFieldValue }) => ({ validator: (_, value) => value?.trim() || getFieldValue('mediaAssetIds')?.length ? Promise.resolve() : Promise.reject(new Error('Nhập nội dung hoặc chọn ít nhất một ảnh')) })]}><Input.TextArea rows={4} showCount maxLength={5000} placeholder="Nhập nội dung bình luận..." /></Form.Item>
          <Form.Item name="mediaAssetIds" label="Ảnh đính kèm"><FacebookImagePicker context="reply" disabled={busy} onUploadingChange={setUploadingImages} /></Form.Item>
          <Flex gap={12} wrap>
            <Form.Item name="daysRecent" label="Bài đăng trong số ngày gần nhất" rules={[{ required: true }]}><InputNumber min={1} max={365} /></Form.Item>
            <Form.Item name="maxPosts" label="Số bài tối đa / nhóm" rules={[{ required: true }]}><InputNumber min={1} max={50} /></Form.Item>
          </Flex>
          <Flex gap={12} wrap>
            <Form.Item name="minReactions" label="Số tim tối thiểu"><InputNumber min={0} max={10000000} /></Form.Item>
            <Form.Item name="maxReactions" label="Số tim tối đa"><InputNumber min={0} max={10000000} placeholder="Không giới hạn" /></Form.Item>
          </Flex>
          <Flex gap={12} wrap>
            <Form.Item name="minComments" label="Số bình luận tối thiểu"><InputNumber min={0} max={10000000} /></Form.Item>
            <Form.Item name="maxComments" label="Số bình luận tối đa"><InputNumber min={0} max={10000000} placeholder="Không giới hạn" /></Form.Item>
          </Flex>
          </> : null}
          {mode === 'message' ? <>
          <Form.Item name="recipientMode" label="Nguồn người nhận"><Select options={[{ value: 'RANDOM', label: 'Thành viên nhóm hiển thị ngẫu nhiên' }, { value: 'OPT_IN', label: 'Danh sách đã ghi nhận đồng ý nhận tin' }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.recipientMode !== after.recipientMode}>{({ getFieldValue }) => <Alert type="info" showIcon title={getFieldValue('recipientMode') === 'OPT_IN' ? 'Chỉ nhắn người đã đồng ý' : 'Chọn ngẫu nhiên thành viên nhóm'} description={getFieldValue('recipientMode') === 'OPT_IN' ? 'Hệ thống chỉ tạo tác vụ cho người nhận opt-in còn hiệu lực và thuộc nhóm đã chọn.' : 'Mỗi tác vụ mở danh sách thành viên của nhóm, chọn một profile chưa được nhắn rồi gửi tin.'} style={{ marginBottom: 16 }} />}</Form.Item>
          <Form.Item name="text" label="Nội dung tin nhắn" dependencies={['mediaAssetIds']} rules={[{ max: 5000 }, ({ getFieldValue }) => ({ validator: (_, value) => value?.trim() || getFieldValue('mediaAssetIds')?.length ? Promise.resolve() : Promise.reject(new Error('Nhập nội dung hoặc chọn ít nhất một ảnh')) })]}><Input.TextArea rows={5} showCount maxLength={5000} placeholder="Nhập nội dung tin nhắn..." /></Form.Item>
          <Form.Item name="mediaAssetIds" label="Ảnh đính kèm"><FacebookImagePicker context="message" disabled={busy} onUploadingChange={setUploadingImages} /></Form.Item>
          <Form.Item name="messageGroupUrls" label="Nhóm cần nhắn" extra="Để trống mặc định = tất cả nhóm đã tham gia của các profile được chọn. Chỉ chọn nhóm khi muốn giới hạn phạm vi." rules={[{ type: 'array', max: 100 }]}><Select mode="multiple" allowClear showSearch maxTagCount="responsive" maxCount={100} optionFilterProp="searchText" options={collectionGroupOptions} placeholder="Tất cả nhóm đã tham gia" /></Form.Item>
           <Form.Item noStyle shouldUpdate={(before, after) => before.recipientMode !== after.recipientMode}>{({ getFieldValue }) => <Form.Item name="maxRecipientsPerGroup" label="Số người cần nhắn / nhóm" extra={getFieldValue('recipientMode') === 'OPT_IN' ? 'Chỉ phân bổ người nhận có đồng ý còn hiệu lực trong nhóm; không chọn thành viên ngẫu nhiên.' : 'Hệ thống chia đều tổng số này cho các profile đã tham gia nhóm và tránh nhắn lặp người đã xử lý.'} rules={[{ required: true }]}><InputNumber min={1} max={50} /></Form.Item>}</Form.Item>
         </> : null}
          {mode === 'scan-comments' ? <>
           <Alert type="info" showIcon title="Quét số điện thoại trong bình luận" description="Profile sẽ mở bài viết, chọn hiển thị tất cả bình luận, tải thêm bình luận rồi trích xuất và loại trùng số điện thoại." style={{ marginBottom: 16 }} />
           <Form.Item name="postUrls" label="URL bài viết Facebook (mỗi dòng một bài)" extra="Tối đa 100 URL, ngăn cách bằng dòng mới hoặc dấu phẩy. Mỗi URL được tạo tác vụ riêng để lưu đúng danh sách SĐT tìm thấy." rules={[{ required: true, whitespace: true, message: 'Nhập ít nhất một URL bài viết Facebook' }]}><Input.TextArea rows={5} placeholder={'https://www.facebook.com/groups/.../posts/123\nhttps://www.facebook.com/groups/.../posts/456'} /></Form.Item>
          </> : null}
          {mode === 'message-reactors' ? <>
           <Alert type="info" showIcon title="Chọn ngẫu nhiên người react hoặc bình luận" description="Mỗi URL tạo một nhóm tác vụ riêng. Hệ thống mở bài viết, lấy người đã react và/hoặc người đã bình luận theo lựa chọn, bỏ qua chính profile và người đã nhắn trước đó, sau đó nhắn ngẫu nhiên." style={{ marginBottom: 16 }} />
           <Form.Item name="postUrls" label="Danh sách URL bài viết Facebook (mỗi dòng một bài)" extra="Tối đa 100 URL, có thể ngăn cách bằng dòng mới hoặc dấu phẩy. Số người cần nhắn được áp dụng cho từng bài viết." rules={[{ required: true, whitespace: true, message: 'Nhập ít nhất một URL bài viết Facebook' }]}><Input.TextArea rows={5} placeholder={'https://www.facebook.com/groups/.../posts/123\nhttps://www.facebook.com/groups/.../posts/456'} /></Form.Item>
           <Form.Item name="recipientSource" label="Nguồn người nhận" rules={[{ required: true }]}><Select options={[{ value: 'REACTORS', label: 'Người đã react bài viết' }, { value: 'COMMENTERS', label: 'Người đã bình luận trong bài viết' }, { value: 'REACTORS_AND_COMMENTERS', label: 'Cả người react và người bình luận' }]} /></Form.Item>
           <Form.Item name="text" label="Nội dung tin nhắn" dependencies={['mediaAssetIds']} rules={[{ max: 5000 }, ({ getFieldValue }) => ({ validator: (_, value) => value?.trim() || getFieldValue('mediaAssetIds')?.length ? Promise.resolve() : Promise.reject(new Error('Nhập nội dung hoặc chọn ít nhất một ảnh')) })]}><Input.TextArea rows={5} showCount maxLength={5000} placeholder="Nhập nội dung tin nhắn..." /></Form.Item>
           <Form.Item name="mediaAssetIds" label="Ảnh đính kèm"><FacebookImagePicker context="message" disabled={busy} onUploadingChange={setUploadingImages} /></Form.Item>
           <Form.Item name="maxRecipientsPerPost" label="Số thành viên cần nhắn / bài viết" extra="Tổng số lượt được chia đều cho các profile đã chọn. Ví dụ 2 profile và 10 người: mỗi profile nhắn 5 người." rules={[{ required: true }]}><InputNumber min={1} max={50} /></Form.Item>
          </> : null}
          {mode === 'reply-comments' ? <>
            <Alert type="info" showIcon title="Trả lời bình luận trong bài viết" description="Hệ thống giao bài viết cho một profile để tránh hai profile trả lời trùng cùng một bình luận, sau đó trả lời tối đa số lượt đã cấu hình." style={{ marginBottom: 16 }} />
            <Form.Item name="postUrl" label="URL bài viết Facebook" rules={[{ required: true, type: 'url', message: 'Nhập URL bài viết Facebook hợp lệ' }]}><Input placeholder="https://www.facebook.com/groups/.../posts/..." /></Form.Item>
            <Form.Item name="text" label="Nội dung rep" dependencies={['mediaAssetIds']} rules={[{ max: 5000 }, ({ getFieldValue }) => ({ validator: (_, value) => value?.trim() || getFieldValue('mediaAssetIds')?.length ? Promise.resolve() : Promise.reject(new Error('Nhập nội dung hoặc chọn ít nhất một ảnh')) })]}><Input.TextArea rows={4} showCount maxLength={5000} placeholder="Nhập nội dung trả lời bình luận..." /></Form.Item>
            <Form.Item name="mediaAssetIds" label="Ảnh đính kèm"><FacebookImagePicker context="reply" disabled={busy} onUploadingChange={setUploadingImages} /></Form.Item>
            <Form.Item name="maxReplies" label="Số lượt rep / bài viết" extra="Toàn bộ bài viết được giao cho một profile phù hợp để mỗi bình luận chỉ được xử lý một lần." rules={[{ required: true }]}><InputNumber min={1} max={50} /></Form.Item>
          </> : null}
          {mode !== 'sync' ? <Form.Item name="intervalSeconds" label="Khoảng cách giữa tác vụ cùng account (giây)" extra="Mặc định 10 giây, tối thiểu 5 giây. Đây là thời gian nghỉ giữa các tác vụ, không phải timeout chờ tải trang." rules={[{ required: true }]}><InputNumber min={5} max={mode === 'message' || mode === 'message-reactors' || mode === 'reply-comments' || mode === 'comment-group' ? 86400 : 3600} /></Form.Item> : null}
      </Form>
    </Modal>
    <Modal title={collectionEditor === 'new' ? 'Tạo tập hợp nhóm' : 'Chỉnh sửa tập hợp nhóm'} open={!!collectionEditor} destroyOnHidden width={680} confirmLoading={busy} okText={collectionEditor === 'new' ? 'Tạo tập hợp' : 'Lưu thay đổi'} cancelText="Đóng" onOk={submitCollectionForm} onCancel={() => { if (!busy) setCollectionEditor(undefined); }}>
      <Form<CollectionValues> key={collectionEditor === 'new' ? 'new' : collectionEditor?.id ?? 'closed'} id="facebook-collection-form" form={collectionForm} layout="vertical" preserve={false} disabled={busy}
        initialValues={collectionEditor && collectionEditor !== 'new'
          ? { name: collectionEditor.name, description: collectionEditor.description ?? '', groupUrls: collectionEditor.items.map(item => item.groupUrl) }
          : { name: '', description: '', groupUrls: [] }}
        onFinish={(values) => void saveCollection(values)}>
        <Form.Item name="name" label="Tên tập hợp" rules={[{ required: true, whitespace: true, message: 'Nhập tên tập hợp' }, { max: 80 }]}><Input autoFocus placeholder="Ví dụ: Hải sản, Quần áo, Phong thủy" /></Form.Item>
        <Form.Item name="description" label="Mô tả" rules={[{ max: 500 }]}><Input.TextArea rows={2} showCount maxLength={500} placeholder="Ghi chú ngắn để mọi người dễ nhận biết (không bắt buộc)" /></Form.Item>
        <Form.Item name="groupUrls" label="Nhóm trong tập hợp" extra="Một nhóm có thể nằm trong nhiều tập hợp. Danh sách này dùng chung cho tất cả profile." rules={[{ required: true, type: 'array', min: 1, message: 'Chọn ít nhất một nhóm' }, { type: 'array', max: 1000, message: 'Chọn tối đa 1000 nhóm' }]}>
          <Select mode="multiple" allowClear showSearch maxTagCount="responsive" maxCount={1000} optionFilterProp="searchText" options={collectionGroupOptions} placeholder="Tìm tên hoặc link nhóm để thêm" notFoundContent="Không có nhóm đã đồng bộ" />
        </Form.Item>
      </Form>
    </Modal>
    <Modal title={optInEditor === 'new' ? 'Thêm người nhận opt-in' : optInEditor?.revokedAt ? 'Sửa và khôi phục đồng ý' : 'Sửa người nhận opt-in'} open={!!optInEditor} destroyOnHidden width={620} confirmLoading={busy} okText={optInEditor && optInEditor !== 'new' && optInEditor.revokedAt ? 'Lưu & khôi phục' : 'Lưu người nhận'} cancelText="Đóng" onOk={() => void optInForm.validateFields().then(saveOptIn).catch(() => undefined)} onCancel={() => { if (!busy) { setOptInEditor(undefined); optInForm.resetFields(); } }}>
      <Alert type="warning" showIcon title="Chỉ lưu khi có bằng chứng đồng ý rõ ràng" description="Nguồn và thời điểm đồng ý được lưu cùng người nhận; có thể thu hồi bất cứ lúc nào." style={{ marginBottom: 16 }} />
      <Form<OptInValues> form={optInForm} layout="vertical" preserve={false} disabled={busy}>
        <Form.Item name="groupUrl" label="Nhóm liên quan" rules={[{ required: true, message: 'Chọn nhóm' }]}><Select showSearch optionFilterProp="searchText" options={collectionGroupOptions} placeholder="Chọn nhóm đã đồng bộ" /></Form.Item>
        <Form.Item name="profileUrl" label="URL Facebook người nhận" rules={[{ required: true, type: 'url', message: 'Nhập URL profile Facebook hợp lệ' }]}><Input placeholder="https://www.facebook.com/username/" /></Form.Item>
        <Form.Item name="displayName" label="Tên hiển thị" rules={[{ required: true, whitespace: true }, { max: 120 }]}><Input /></Form.Item>
        <Form.Item name="consentSource" label="Nguồn bằng chứng đồng ý" rules={[{ required: true, whitespace: true }, { max: 120 }]}><Input placeholder="Ví dụ: Form đăng ký, inbox xác nhận" /></Form.Item>
        <Form.Item name="consentRecordedAt" label="Thời điểm đồng ý" rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
        <Form.Item name="consentNote" label="Ghi chú bằng chứng" rules={[{ max: 1000 }]}><Input.TextArea rows={3} showCount maxLength={1000} /></Form.Item>
      </Form>
    </Modal>
    <Modal className="campaign-detail-modal" title={<PageSectionTitle title={retryReview?.name ?? 'Chi tiết chiến dịch Facebook'} description={retryMode ? 'Kết quả và tác vụ cần chạy lại' : 'Chi tiết chiến dịch và kết quả theo từng profile'} />} open={!!retryReview} width={1100} destroyOnHidden okText={retryMode ? 'Chạy lại tác vụ đã chọn' : 'Đóng'} cancelText="Đóng" confirmLoading={busy} okButtonProps={retryMode ? { disabled: !selectedTaskIds.length || !canAdmin } : undefined} onOk={() => { if (retryMode) void retry(); else setRetryReview(undefined); }} onCancel={() => { if (!busy) setRetryReview(undefined); }}>
      {retryMode && retryReview ? <>
        <CampaignDetailOverview items={[{ label: 'Loại', value: campaignKindLabel(retryReview) }, { label: 'Profile', value: new Set(retryReview.tasks.map(job => job.account.id)).size }, { label: 'Tác vụ hoàn tất', value: `${retryReview.tasks.filter(job => job.status === 'SUCCEEDED').length}/${retryReview.tasks.length}` }, { label: 'Trạng thái', value: status(campaignStatus(retryReview)) }]} />
        <Alert type="info" showIcon title="Tác vụ đã hoàn thành chỉ để xem; chỉ tác vụ chưa hoàn thành mới được chọn chạy lại." description="Profile phải sẵn sàng, proxy kết nối được và browser đã đóng. Với tin nhắn, kiểm tra hội thoại trước khi xác nhận chưa gửi để tránh gửi trùng." style={{ marginBottom: 16 }} />
        {retryReview.tasks.some(job => ['FAILED', 'REQUIRES_ACTION'].includes(job.status) && retryKind(job) === 'VERIFY') ? <Alert type="warning" showIcon title="Một số tác vụ chưa rõ kết quả gửi" description={<Checkbox checked={verifiedUnsent} onChange={event => { setVerifiedUnsent(event.target.checked); if (!event.target.checked) setSelectedTaskIds(ids => ids.filter(id => retryReview.tasks.some(job => job.id === id && retryKind(job) === 'SAFE'))); }}>Tôi đã kiểm tra trên Facebook: các tác vụ chưa rõ kết quả mà tôi chọn chưa gửi yêu cầu hoặc đăng bài thành công.</Checkbox>} style={{ marginBottom: 16 }} /> : null}
        <Typography.Paragraph type="secondary">{selectedTaskIds.length} tác vụ được chọn. Tác vụ đã hoàn thành không thể chọn; profile chưa sẵn sàng cũng không thể chọn. {!canAdmin ? 'Tài khoản hiện tại chỉ có quyền xem.' : <Button type="link" onClick={() => { setRetryReview(undefined); onNavigateProfiles(); }}>Mở Profiles</Button>}</Typography.Paragraph>
        {summaryTable(retryReview)}
        <Table<Job> rowKey="id" size="small" dataSource={[...retryReview.tasks].sort((a, b) => {
          const retryable = (job: Job) => Number(!['FAILED', 'REQUIRES_ACTION'].includes(job.status) || !isReady(job));
          return retryable(a) - retryable(b);
        })} pagination={tablePagination('tác vụ')} scroll={{ x: 850 }} rowSelection={{ selectedRowKeys: selectedTaskIds, onChange: keys => setSelectedTaskIds(keys.map(String)), getCheckboxProps: job => ({ disabled: !canAdmin || !['FAILED', 'REQUIRES_ACTION'].includes(job.status) || !isReady(job) || retryKind(job) === 'VERIFY' && !verifiedUnsent }) }} columns={[
          { title: 'Profile', render: (_, job) => <Space orientation="vertical" size={2}><strong>{job.account.username ?? job.account.id}</strong><Typography.Text type="secondary">{isReady(job) ? 'Sẵn sàng' : 'Cần đăng nhập / kiểm tra phiên'}</Typography.Text></Space> },
          { title: 'Đích', render: (_, job) => job.payload.postUrl ? targetLink(job.payload.postUrl, 'Bài viết cần quét') : job.payload.profileUrl ? targetLink(job.payload.profileUrl, job.payload.displayName ?? job.payload.profileUrl) : job.payload.groupUrl ? targetLink(job.payload.groupUrl, job.payload.groupUrl) : 'Quét nhóm đã tham gia' },
          { title: 'Kết quả', render: (_, job) => { const result = job.runs[0]?.result; return <Space orientation="vertical" size={2}>{status(job.status)}{result?.publicationStatus ? status(result.publicationStatus) : null}{result?.membershipStatus ? status(result.membershipStatus) : null}{result?.messageStatus ? status(result.messageStatus) : null}{result?.commentsScanned != null ? <Typography.Text type="secondary">Đã quét {result.commentsScanned} bình luận · {result.phoneCount ?? 0} SĐT</Typography.Text> : null}{result?.phoneNumbers?.length ? <Typography.Text copyable={{ text: result.phoneNumbers.join(', ') }} type="secondary">{result.phoneNumbers.join(', ')}</Typography.Text> : null}{result?.repliesRequested != null ? <Typography.Text type="secondary">Đã rep {result.repliesSent ?? 0}/{result.repliesRequested} lượt{result.commentsAvailable != null ? ` · ${result.commentsAvailable} bình luận có thể rep` : ''}</Typography.Text> : null}{job.lastError ? <Typography.Text type="secondary">{job.lastError}</Typography.Text> : null}</Space>; } },
          { title: 'Có thể chạy lại', render: (_, job) => job.status === 'SUCCEEDED' ? <Tag>Đã hoàn thành</Tag> : ['FAILED', 'REQUIRES_ACTION'].includes(job.status) ? retryKind(job) === 'SAFE' ? <Tag color="green">Có thể chọn</Tag> : <Tag color="orange">Cần xác nhận</Tag> : <Tag color="default">Chưa thể chạy lại</Tag> },
        ]} />
      </> : retryReview ? <>
        <CampaignDetailOverview items={[{ label: 'Loại', value: campaignKindLabel(retryReview) }, { label: 'Profile', value: new Set(retryReview.tasks.map(job => job.account.id)).size }, { label: 'Tác vụ hoàn tất', value: `${retryReview.tasks.filter(job => job.status === 'SUCCEEDED').length}/${retryReview.tasks.length}` }, { label: 'Trạng thái', value: status(campaignStatus(retryReview)) }]} />
        {summaryTable(retryReview)}
        {jobsTable(retryReview.tasks)}
      </> : null}
    </Modal>
    <Modal title="Duyệt & chạy chiến dịch Facebook" open={!!review} onCancel={() => { if (!busy) setReview(undefined); }} width={900} okText="Duyệt & chạy" cancelText="Quay lại" confirmLoading={busy} onOk={() => void approve()}>
       {review ? <><Alert type="warning" showIcon title={review.kind === 'SYNC' ? 'Thao tác này quét danh sách nhóm đã tham gia trên Facebook.' : review.kind === 'MESSAGE' || review.kind === 'MESSAGE_REACTORS' ? 'Thao tác này gửi tin nhắn thật trên Facebook.' : review.kind === 'SCAN_COMMENTS' ? 'Thao tác này mở bài viết và đọc các bình luận trên Facebook.' : review.kind === 'REPLY_COMMENTS' ? 'Thao tác này gửi trả lời thật vào bình luận trên Facebook.' : 'Thao tác này gửi yêu cầu tham gia hoặc đăng bài thật trên Facebook.'} description={review.kind === 'SYNC' ? 'Kiểm tra profile đã sẵn sàng, browser đã đóng và proxy hoạt động trước khi duyệt.' : review.kind === 'MESSAGE' ? review.payload.recipientMode === 'OPT_IN' ? 'Mỗi tác vụ nhắn đúng một người nhận opt-in còn hiệu lực. Kiểm tra bằng chứng đồng ý, nhóm và nội dung trước khi duyệt.' : 'Mỗi tác vụ chọn ngẫu nhiên một thành viên đang hiển thị trong danh sách của nhóm. Kiểm tra nhóm, nội dung, giới hạn và thời gian chờ; dừng nếu Facebook cảnh báo.' : review.kind === 'MESSAGE_REACTORS' ? 'Mỗi tác vụ lấy người react và/hoặc người bình luận theo nguồn đã chọn, bỏ qua profile đã nhắn và chia đều lượt nhắn cho các account. Kiểm tra bài viết, nguồn người nhận và giới hạn trước khi duyệt.' : review.kind === 'SCAN_COMMENTS' ? 'Mỗi bài viết chỉ được giao cho một profile để quét và trích xuất số điện thoại, tránh dữ liệu lặp.' : review.kind === 'REPLY_COMMENTS' ? 'Bài viết chỉ được giao cho một profile để tránh trả lời trùng bình luận; nếu Facebook không xác nhận kết quả, tác vụ sẽ dừng.' : 'Kiểm tra account, nhóm đích, nội dung và quyền đăng bài; tuân thủ quy tắc của nhóm. Không tự vượt CAPTCHA hay trả lời câu hỏi thành viên.'} style={{ marginBottom: 16 }} /><Typography.Paragraph>{review.name} · {new Set(review.tasks.map((job) => job.account.id)).size} account · {review.tasks.length} tác vụ · Cách nhau {review.payload.intervalSeconds}s/account</Typography.Paragraph>{review.payload.postUrls?.length ? <Typography.Paragraph>URL bài viết ({review.payload.postUrls.length}): {review.payload.postUrls.map((url, index) => <span key={url}>{index ? ' · ' : ''}<a href={url} target="_blank" rel="noreferrer">{url}</a></span>)}</Typography.Paragraph> : review.payload.postUrl ? <Typography.Paragraph>URL bài viết: <a href={review.payload.postUrl} target="_blank" rel="noreferrer">{review.payload.postUrl}</a></Typography.Paragraph> : null}{review.kind === 'MESSAGE_REACTORS' && review.payload.recipientSource ? <Typography.Paragraph>Nguồn người nhận: {review.payload.recipientSource === 'COMMENTERS' ? 'Người đã bình luận' : review.payload.recipientSource === 'REACTORS_AND_COMMENTERS' ? 'Người react và người bình luận' : 'Người đã react'}</Typography.Paragraph> : null}{review.payload.text ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' }}>{review.payload.text}</Typography.Paragraph> : null}{review.payload.maxReplies != null ? <Typography.Paragraph>Số lượt rep: {review.payload.maxReplies}</Typography.Paragraph> : null}{review.payload.maxRecipientsPerPost != null ? <Typography.Paragraph>Số thành viên cần nhắn: {review.payload.maxRecipientsPerPost}</Typography.Paragraph> : null}<FacebookPostImages ids={review.payload.mediaAssetIds} />{jobsTable(review.tasks)}</> : null}
    </Modal>
  </div>;
}
