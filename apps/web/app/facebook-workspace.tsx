'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Checkbox, Dropdown, Empty, Flex, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';

import { Icon } from './ui';
import { ActionButton, PageSectionTitle, StatusTag, tablePagination } from './admin-ui';
import { useToast, useToastError, useToastNotice } from './toast';
import { ContextNote as Alert } from './context-note';
import { readApiJson } from '../lib/api-response';
import { facebookGroupId, facebookGroupLabel } from '../lib/facebook-group-label';
import { FacebookImagePicker, FacebookPostImages } from './facebook-post-images';

interface Account { id: string; username?: string; platform: string; status: string }
interface Group { id: string; accountId: string; groupUrl: string; groupName?: string | null; status: string; lastSyncedAt: string; account: Account }
interface GroupCollection { id: string; name: string; description?: string | null; createdAt: string; updatedAt: string; items: Array<{ groupUrl: string }> }
interface JobResult { sideEffectStarted?: boolean; publicationStatus?: string; membershipStatus?: string; messageStatus?: string; commentStatus?: string; postsFound?: number; postsCommented?: number; posts?: Array<{ postUrl?: string; commentStatus?: string; postStatus?: string; reason?: string }>; commentsScanned?: number; phoneCount?: number; phoneNumbers?: string[]; repliesRequested?: number; repliesSent?: number; commentsAvailable?: number; replyStatus?: string; postUrl?: string; groupUrl?: string; profileUrl?: string; displayName?: string; complete?: boolean }
interface Job { id: string; retrySafety?: 'SAFE' | 'VERIFY' | 'BLOCKED'; attemptCount?: number; status: string; approvalStatus: string; lastError?: string; payload: { groupUrl?: string; postUrl?: string; profileUrl?: string; displayName?: string; maxReplies?: number; maxPosts?: number }; account: Account; runs: Array<{ errorCode?: string; result?: JobResult }> }
interface Campaign { id: string; name: string; kind: string; approvedAt?: string; pausedAt?: string; cancelledAt?: string; createdAt: string; payload: { text?: string; postUrl?: string; postUrls?: string[]; recipientSource?: 'REACTORS' | 'COMMENTERS' | 'REACTORS_AND_COMMENTERS'; maxReplies?: number; maxRecipientsPerPost?: number; mediaAssetIds?: string[]; intervalSeconds: number; selection?: 'ALL' | 'CUSTOM' | 'COLLECTIONS'; collectionIds?: string[]; collectionNames?: string[]; groupUrls?: string[]; daysRecent?: number; minReactions?: number; maxReactions?: number; minComments?: number; maxComments?: number; maxPosts?: number }; tasks: Job[] }
interface Values { name: string; accountIds: string[]; syncScope?: 'ALL' | 'SELECTED'; postUrl?: string; postUrls?: string; recipientSource?: 'REACTORS' | 'COMMENTERS' | 'REACTORS_AND_COMMENTERS'; groupUrls?: string; selectedGroupUrls?: string[]; messageGroupUrls?: string[]; collectionIds?: string[]; text?: string; mediaAssetIds?: string[]; selection?: 'ALL' | 'CUSTOM' | 'COLLECTIONS'; maxGroupsPerAccount?: number; maxRecipientsPerGroup?: number; maxRecipientsPerPost?: number; maxReplies?: number; daysRecent?: number; minReactions?: number; maxReactions?: number; minComments?: number; maxComments?: number; maxPosts?: number; intervalSeconds: number }
interface CollectionValues { name: string; description?: string; groupUrls: string[] }

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
  const [groupSearch, setGroupSearch] = useState('');
  const [filter, setFilter] = useState<string>();
  const [collectionSearch, setCollectionSearch] = useState('');
  const [collectionEditor, setCollectionEditor] = useState<GroupCollection | 'new'>();
  const [review, setReview] = useState<Campaign>();
  const [retryReview, setRetryReview] = useState<Campaign>();
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [verifiedUnsent, setVerifiedUnsent] = useState(false);
  const [controlBusy, setControlBusy] = useState<string>();
  const [form] = Form.useForm<Values>();
  const [collectionForm] = Form.useForm<CollectionValues>();
  const submitIntent = useRef<'DRAFT' | 'RUN'>('DRAFT');
  const { modal } = App.useApp();
  const groups = useQuery({ queryKey: ['facebook-groups'], queryFn: () => request<Group[]>('groups'), refetchInterval: 10000 });
  const collections = useQuery({ queryKey: ['facebook-group-collections'], queryFn: () => request<GroupCollection[]>('group-collections') });
  const campaigns = useQuery({ queryKey: ['facebook-campaigns'], queryFn: () => request<Campaign[]>('campaigns'), refetchInterval: 5000 });
  useToastNotice((groups.error ?? collections.error ?? campaigns.error)?.message, 'facebook-load-error', 'error', !groups.isFetching && !collections.isFetching && !campaigns.isFetching);
  const ready = accounts.filter((account) => account.platform === 'FACEBOOK' && account.status === 'READY');
  const refresh = async () => { await Promise.all(['facebook-groups', 'facebook-group-collections', 'facebook-campaigns', 'tasks', 'accounts'].map((name) => client.invalidateQueries({ queryKey: [name] }))); };
  const open = (next: typeof mode) => { setKey(crypto.randomUUID()); setError(undefined); setMode(next); };
  const submit = async (values: Values) => {
    if (busy || uploadingImages) return;
    const runImmediately = mode !== 'post' && submitIntent.current === 'RUN';
    submitIntent.current = 'DRAFT';
    setBusy(true); setError(undefined);
    try {
      const { groupUrls, selectedGroupUrls, messageGroupUrls, postUrls, syncScope, ...fields } = values;
      const endpoint = mode === 'scan-comments' ? 'posts/scan-comments' : mode === 'reply-comments' ? 'posts/reply-comments' : mode === 'message-reactors' ? 'posts/message-reactors' : mode === 'comment-group' ? 'groups/comment-posts' : `groups/${mode}`;
      const result = await request<{ count?: number; id?: string }>(endpoint, {
        ...fields, idempotencyKey: key,
        ...(mode === 'sync' ? { scope: syncScope ?? 'ALL', accountIds: syncScope === 'SELECTED' ? values.accountIds : [] } : {}),
        ...(mode === 'join' ? { groupUrls: [...new Set((groupUrls ?? '').split(/\r?\n/).map((url) => url.trim()).filter(Boolean))] } : {}),
        ...(mode === 'post' && values.selection === 'CUSTOM' ? { groupUrls: selectedGroupUrls ?? [] } : {}),
        ...(mode === 'comment-group' ? { groupUrls: selectedGroupUrls ?? [] } : {}),
        ...(mode === 'message' ? { groupUrls: messageGroupUrls ?? [] } : {}),
        ...(mode === 'scan-comments' || mode === 'message-reactors' ? { postUrls: [...new Set((postUrls ?? '').split(/[\r\n,]+/).map((url) => url.trim()).filter(Boolean))] } : {}),
      });
      if (runImmediately) {
        if (!result.id) throw new Error('Campaign đã tạo nhưng chưa nhận được mã để duyệt. Hãy mở danh sách campaign và chạy lại.');
        await request(`campaigns/${result.id}/approve`, {});
      }
      setTab('campaigns'); setMode(null); await refresh();
       void message.success(mode === 'post' ? 'Đã lên lịch đăng bài ngay.' : runImmediately ? 'Đã tạo, duyệt và xếp hàng campaign để chạy.' : mode === 'sync' ? 'Đã lưu bản nháp đồng bộ. Duyệt campaign để bắt đầu quét nhóm.' : mode === 'scan-comments' ? 'Đã lưu bản nháp quét bình luận. Duyệt để bắt đầu.' : mode === 'reply-comments' ? 'Đã lưu bản nháp rep bình luận. Duyệt để bắt đầu.' : mode === 'message-reactors' ? 'Đã lưu bản nháp nhắn người react/bình luận. Duyệt để bắt đầu.' : mode === 'comment-group' ? 'Đã lưu bản nháp bình luận bài viết. Duyệt để bắt đầu.' : 'Đã lưu bản nháp. Duyệt campaign để bắt đầu chạy.');
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
  const runNow = () => modal.confirm({
    title: 'Tạo và chạy campaign ngay?',
    content: 'Campaign sẽ được duyệt ngay sau khi tạo và xếp vào hàng đợi của từng profile. Thao tác thật sẽ thực hiện khi đến lượt; campaign khác đang chạy vẫn được giữ nguyên thứ tự.',
    okText: 'Tạo & chạy',
    cancelText: 'Quay lại',
    onOk: () => { submitIntent.current = 'RUN'; submitCampaignForm(); },
  });
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
  return <div className="facebook-workspace">
    <div className="facebook-summary">
      <div><span className="summary-icon"><Icon name="accounts" /></span><span><strong>{ready.length}</strong><small>Profile sẵn sàng</small></span></div>
      <div><span className="summary-icon"><Icon name="facebook" /></span><span><strong>{(groups.data ?? []).filter(group => group.status === 'JOINED').length}</strong><small>Lượt nhóm đã tham gia</small></span></div>
      <div><span className="summary-icon"><Icon name="tasks" /></span><span><strong>{campaigns.data?.length ?? 0}</strong><small>Chiến dịch</small></span></div>
    </div>
    <div className="facebook-actions">
      <div><strong>Bắt đầu chiến dịch mới</strong><p>Chọn profile, chuẩn bị nội dung; bạn có thể lưu nháp hoặc tạo & chạy ngay sau bước xác nhận.</p></div>
       <Dropdown trigger={['click']} disabled={!canOperate || !ready.length} menu={{ items: [
         { key: 'post', label: 'Đăng bài vào nhóm', icon: <Icon name="edit" /> },
         { key: 'join', label: 'Tham gia nhóm', icon: <Icon name="plus" /> },
         { key: 'sync', label: 'Đồng bộ nhóm', icon: <Icon name="refresh" /> },
         { type: 'divider' },
         { key: 'comment-group', label: 'Bình luận bài viết trong nhóm', icon: <Icon name="edit" /> },
         { key: 'reply-comments', label: 'Trả lời bình luận', icon: <Icon name="edit" /> },
         { key: 'message', label: 'Nhắn thành viên ngẫu nhiên', icon: <Icon name="edit" />, disabled: !collectionGroupOptions.length },
         { key: 'message-reactors', label: 'Nhắn người react/bình luận', icon: <Icon name="edit" /> },
         { key: 'scan-comments', label: 'Quét số điện thoại bình luận', icon: <Icon name="search" /> },
       ], onClick: ({ key }) => open(key as Exclude<typeof mode, null>) }}>
         <Button type="primary" icon={<Icon name="plus" />} disabled={!canOperate || !ready.length}>Tạo chiến dịch</Button>
       </Dropdown>
    </div>
    {!ready.length ? <Alert type="info" showIcon title="Cần ít nhất một profile Facebook sẵn sàng" description="Mở browser trong Profiles để đăng nhập, kiểm tra phiên rồi đóng browser trước khi chạy chiến dịch." action={<Button onClick={onNavigateProfiles}>Mở Profiles</Button>} /> : null}
    <Tabs className="facebook-tabs" activeKey={tab} onChange={setTab} items={[{ key: 'campaigns', label: `Chiến dịch (${campaigns.data?.length ?? 0})` }, { key: 'groups', label: `Nhóm đã tham gia (${(groups.data ?? []).filter(group => group.status === 'JOINED').length})` }, { key: 'collections', label: `Tập hợp nhóm (${collections.data?.length ?? 0})` }]} />
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
    </Card> : <Card className="resource-card" title={<PageSectionTitle title="Danh sách campaign Facebook" description="Theo dõi kết quả, trạng thái và thao tác trên từng campaign" />} extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm chiến dịch Facebook" placeholder="Tìm chiến dịch..." allowClear value={campaignSearch} onChange={event => setCampaignSearch(event.target.value)} /><Select aria-label="Lọc campaign Facebook" className="status-filter" value={campaignFilter} onChange={setCampaignFilter} options={['ALL', 'DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSING', 'PAUSED', 'REQUIRES_ACTION', 'SUCCEEDED', 'CANCELLING', 'CANCELLED'].map(value => ({ value, label: value === 'ALL' ? 'Tất cả trạng thái' : labels[value] ?? value }))} /><Tooltip title="Làm mới campaign"><Button aria-label="Làm mới campaign" icon={<Icon name="refresh" />} onClick={() => void refresh()} /></Tooltip></Space>}>
       <Table<Campaign> className="campaign-table" size="middle" rowKey="id" loading={campaigns.isLoading} dataSource={(campaigns.data ?? []).filter(campaign => (campaignFilter === 'ALL' || campaignStatus(campaign) === campaignFilter) && campaign.name.toLowerCase().includes(campaignSearch.toLowerCase().trim())).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())} pagination={tablePagination('chiến dịch')} scroll={{ x: 1_270 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có chiến dịch. Tham gia nhóm hoặc soạn bài để tạo bản nháp đầu tiên." /> }} columns={[
        { title: 'Chiến dịch', width: 240, render: (_, campaign) => <div className="campaign-name"><strong>{campaign.name}</strong><small>{campaign.kind === 'POST' ? 'Đăng bài nhóm' : campaign.kind === 'SYNC' ? 'Đồng bộ nhóm' : `${new Set(campaign.tasks.map(job => job.account.id)).size} profile`}</small></div> },
        { title: 'Loại', width: 180, render: (_, campaign) => campaign.kind === 'SYNC' ? 'Đồng bộ nhóm' : campaign.kind === 'JOIN' ? 'Tham gia nhóm' : campaign.kind === 'MESSAGE' ? 'Nhắn thành viên ngẫu nhiên' : campaign.kind === 'MESSAGE_REACTORS' ? 'Nhắn người react/bình luận' : campaign.kind === 'SCAN_COMMENTS' ? 'Quét SĐT bình luận' : campaign.kind === 'REPLY_COMMENTS' ? 'Rep bình luận' : campaign.kind === 'COMMENT_GROUP_POSTS' ? 'Cmt bài viết trong nhóm' : 'Đăng bài nhóm' },
        { title: 'Profile', width: 110, render: (_, campaign) => `${new Set(campaign.tasks.map(job => job.account.id)).size} profile` },
        { title: 'Kết quả', width: 280, render: (_, campaign) => { const completed = campaign.tasks.filter(job => job.status === 'SUCCEEDED').length; const needsAction = campaign.tasks.filter(job => ['FAILED', 'REQUIRES_ACTION'].includes(job.status)).length; const hasTasks = campaign.tasks.length > 0; const currentStatus = campaignStatus(campaign); return <div className="campaign-result-cell"><span className="campaign-result-primary">{hasTasks ? `${completed}/${campaign.tasks.length} tác vụ hoàn tất` : 'Chưa có tác vụ'}</span><Typography.Text type="secondary">{needsAction ? `${needsAction} tác vụ cần xử lý` : currentStatus === 'DRAFT' ? 'Chờ duyệt để chạy' : currentStatus === 'NO_TASKS' ? 'Campaign chưa được phân bổ tác vụ' : currentStatus === 'SUCCEEDED' ? 'Đã hoàn tất' : 'Đang xử lý'}</Typography.Text></div>; } },
        { title: 'Trạng thái', width: 130, render: (_, campaign) => status(campaignStatus(campaign)) },
        { title: 'Ngày tạo', width: 150, render: (_, campaign) => new Date(campaign.createdAt).toLocaleString('vi-VN') },
        { title: 'Thao tác', width: 180, fixed: 'right', render: (_, campaign) => { const currentStatus = campaignStatus(campaign); const hasPendingApproval = !campaign.approvedAt && !campaign.cancelledAt && campaign.tasks.some(job => job.approvalStatus === 'PENDING'); const active = !campaign.cancelledAt && campaign.tasks.some(job => ['SCHEDULED', 'QUEUED', 'RUNNING'].includes(job.status)); return <Space className="campaign-actions" wrap size={6}>
          {hasPendingApproval ? <ActionButton label="Duyệt & chạy" icon="approve" type="primary" disabled={!canAdmin} onClick={() => { setReview(campaign); setError(undefined); }} /> : null}
          {campaign.tasks.length ? <ActionButton label="Xem kết quả" icon="view" disabled={!!controlBusy} onClick={() => openRetry(campaign)} /> : null}
          {currentStatus === 'REQUIRES_ACTION' ? <ActionButton label="Chạy lại" icon="refresh" disabled={!!controlBusy || !canAdmin} onClick={() => openRetry(campaign)} /> : null}
          {campaign.approvedAt && !campaign.cancelledAt && !campaign.pausedAt && active ? <ActionButton label="Tạm dừng campaign" icon="pause" disabled={!canAdmin || !!controlBusy} loading={controlBusy === campaign.id} onClick={() => void runControl(campaign, 'pause')} /> : null}
          {campaign.pausedAt && !campaign.cancelledAt ? <ActionButton label="Tiếp tục campaign" icon="play" disabled={!canAdmin || !!controlBusy || campaign.tasks.some(job => job.status === 'RUNNING')} loading={controlBusy === campaign.id} onClick={() => void runControl(campaign, 'resume')} /> : null}
          {!campaign.cancelledAt && campaign.tasks.some(job => ['DRAFT', 'SCHEDULED', 'QUEUED', 'RUNNING', 'PAUSED', 'FAILED', 'REQUIRES_ACTION'].includes(job.status)) ? <ActionButton label="Hủy campaign" icon="close" danger disabled={!canAdmin || !!controlBusy} onClick={() => cancel(campaign)} /> : null}
        </Space>; } },
      ]} />
    </Card>}
    <Modal title={mode === 'sync' ? 'Đồng bộ nhóm đã tham gia' : mode === 'join' ? 'Tham gia danh sách nhóm' : mode === 'message' ? 'Nhắn thành viên ngẫu nhiên' : mode === 'message-reactors' ? 'Nhắn người react/bình luận bài viết' : mode === 'scan-comments' ? 'Quét số điện thoại trong bình luận' : mode === 'reply-comments' ? 'Rep bình luận trong bài viết' : mode === 'comment-group' ? 'Cmt vào bài viết trong nhóm' : 'Đăng bài vào nhóm'} open={mode !== null} onCancel={() => { if (!busy && !uploadingImages) setMode(null); }} destroyOnHidden width={640} confirmLoading={busy} cancelButtonProps={{ disabled: busy || uploadingImages }} footer={mode === 'post' ? <Space><Button onClick={() => setMode(null)} disabled={busy || uploadingImages}>Đóng</Button><Button type="primary" disabled={uploadingImages} onClick={() => { submitIntent.current = 'DRAFT'; submitCampaignForm(); }}>Đăng bài ngay</Button></Space> : <Space><Button onClick={() => setMode(null)} disabled={busy || uploadingImages}>Đóng</Button><Button disabled={busy || uploadingImages} onClick={() => { submitIntent.current = 'DRAFT'; submitCampaignForm(); }}>Lưu bản nháp</Button><Button type="primary" disabled={!canAdmin || busy || uploadingImages} onClick={runNow}>Tạo & chạy ngay</Button></Space>}>
        <Form<Values> id="facebook-form" form={form} key={key} layout="vertical" preserve={false} disabled={busy} initialValues={{ accountIds: [], syncScope: 'ALL', mediaAssetIds: [], recipientSource: 'REACTORS', intervalSeconds: mode === 'message' || mode === 'message-reactors' || mode === 'comment-group' ? 120 : 60, selection: 'ALL', maxGroupsPerAccount: 5, maxRecipientsPerGroup: 10, maxRecipientsPerPost: 10, daysRecent: 7, minReactions: 0, minComments: 0, maxPosts: 10 }} onFinish={(values) => void submit(values)}>
        {mode !== 'sync' ? <Form.Item name="name" label="Tên chiến dịch" rules={[{ required: true, whitespace: true }, { max: 120 }]}><Input placeholder="Ví dụ: Bài giới thiệu tháng 9" /></Form.Item> : null}
        {mode === 'sync' ? <>
          <Typography.Paragraph type="secondary">Quét danh sách nhóm đã tham gia trực tiếp trên Facebook của từng profile, bao gồm nhóm tham gia thủ công và nhóm ngoài chiến dịch. Profile cần sẵn sàng, browser đã đóng và proxy hoạt động.</Typography.Paragraph>
          <Form.Item name="syncScope" label="Phạm vi đồng bộ"><Select options={[{ value: 'ALL', label: `Tất cả profile Facebook sẵn sàng (${ready.length})` }, { value: 'SELECTED', label: 'Chọn profile cụ thể' }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.syncScope !== after.syncScope}>{({ getFieldValue }) => getFieldValue('syncScope') === 'SELECTED' ?
            <Form.Item name="accountIds" label="Profile cần đồng bộ" rules={[{ type: 'array', min: 1, required: true, message: 'Chọn ít nhất một profile để đồng bộ' }]}>
              <Select mode="multiple" allowClear showSearch optionFilterProp="label" maxCount={100} placeholder="Chọn một hoặc nhiều profile" options={ready.map(account => ({ value: account.id, label: account.username ?? account.id }))} />
            </Form.Item> : null}</Form.Item>
        </> : <Form.Item name="accountIds" label="Account" extra="Để trống = tất cả account Facebook READY trong workspace."><Select mode="multiple" allowClear placeholder="Tất cả account READY" options={ready.map((account) => ({ value: account.id, label: account.username ?? account.id }))} /></Form.Item>}
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
          <Alert type="info" showIcon title="Chọn ngẫu nhiên thành viên nhóm" description="Mỗi tác vụ mở danh sách thành viên của nhóm, chọn ngẫu nhiên một profile đang hiển thị rồi gửi tin nhắn. Không cần tạo danh sách người nhận trước." style={{ marginBottom: 16 }} />
          <Form.Item name="text" label="Nội dung tin nhắn" dependencies={['mediaAssetIds']} rules={[{ max: 5000 }, ({ getFieldValue }) => ({ validator: (_, value) => value?.trim() || getFieldValue('mediaAssetIds')?.length ? Promise.resolve() : Promise.reject(new Error('Nhập nội dung hoặc chọn ít nhất một ảnh')) })]}><Input.TextArea rows={5} showCount maxLength={5000} placeholder="Nhập nội dung tin nhắn..." /></Form.Item>
          <Form.Item name="mediaAssetIds" label="Ảnh đính kèm"><FacebookImagePicker context="message" disabled={busy} onUploadingChange={setUploadingImages} /></Form.Item>
          <Form.Item name="messageGroupUrls" label="Nhóm cần nhắn" extra="Để trống mặc định = tất cả nhóm đã tham gia của các profile được chọn. Chỉ chọn nhóm khi muốn giới hạn phạm vi." rules={[{ type: 'array', max: 100 }]}><Select mode="multiple" allowClear showSearch maxTagCount="responsive" maxCount={100} optionFilterProp="searchText" options={collectionGroupOptions} placeholder="Tất cả nhóm đã tham gia" /></Form.Item>
           <Form.Item name="maxRecipientsPerGroup" label="Số thành viên cần nhắn / nhóm" extra="Hệ thống tự chia đều tổng số này cho các profile đã tham gia nhóm. Ví dụ 2 profile và 10 thành viên: mỗi profile nhắn 5 người; mỗi lượt chọn ngẫu nhiên một thành viên." rules={[{ required: true }]}><InputNumber min={1} max={50} /></Form.Item>
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
            <Alert type="info" showIcon title="Trả lời bình luận trong bài viết" description="Hệ thống mở bài viết, chọn tất cả bình luận rồi trả lời các bình luận đang có nút Trả lời. Tổng số lượt rep được chia đều cho các profile được chọn." style={{ marginBottom: 16 }} />
            <Form.Item name="postUrl" label="URL bài viết Facebook" rules={[{ required: true, type: 'url', message: 'Nhập URL bài viết Facebook hợp lệ' }]}><Input placeholder="https://www.facebook.com/groups/.../posts/..." /></Form.Item>
            <Form.Item name="text" label="Nội dung rep" dependencies={['mediaAssetIds']} rules={[{ max: 5000 }, ({ getFieldValue }) => ({ validator: (_, value) => value?.trim() || getFieldValue('mediaAssetIds')?.length ? Promise.resolve() : Promise.reject(new Error('Nhập nội dung hoặc chọn ít nhất một ảnh')) })]}><Input.TextArea rows={4} showCount maxLength={5000} placeholder="Nhập nội dung trả lời bình luận..." /></Form.Item>
            <Form.Item name="mediaAssetIds" label="Ảnh đính kèm"><FacebookImagePicker context="reply" disabled={busy} onUploadingChange={setUploadingImages} /></Form.Item>
            <Form.Item name="maxReplies" label="Số lượt rep / bài viết" extra="Tổng số lượt rep được chia đều cho các profile. Ví dụ 2 profile và 10 lượt: mỗi profile rep 5 bình luận." rules={[{ required: true }]}><InputNumber min={1} max={50} /></Form.Item>
          </> : null}
          {mode !== 'sync' ? <Form.Item name="intervalSeconds" label="Khoảng cách giữa tác vụ cùng account (giây)" extra="Tối thiểu 5 giây. Không tự thử lại khi kết quả gửi không rõ ràng." rules={[{ required: true }]}><InputNumber min={5} max={mode === 'message' || mode === 'message-reactors' || mode === 'reply-comments' || mode === 'comment-group' ? 86400 : 3600} /></Form.Item> : null}
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
    <Modal title={<PageSectionTitle title={retryReview?.name ?? 'Kết quả Facebook'} description={retryMode ? 'Kết quả và tác vụ cần chạy lại' : 'Chi tiết campaign và kết quả thực thi'} />} open={!!retryReview} width={1000} destroyOnHidden okText={retryMode ? 'Chạy lại tác vụ đã chọn' : 'Đóng'} cancelText="Đóng" confirmLoading={busy} okButtonProps={retryMode ? { disabled: !selectedTaskIds.length || !canAdmin } : undefined} onOk={() => { if (retryMode) void retry(); else setRetryReview(undefined); }} onCancel={() => { if (!busy) setRetryReview(undefined); }}>
      {retryMode && retryReview ? <>
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
        {summaryTable(retryReview)}
        {jobsTable(retryReview.tasks)}
      </> : null}
    </Modal>
    <Modal title="Duyệt & chạy chiến dịch Facebook" open={!!review} onCancel={() => { if (!busy) setReview(undefined); }} width={900} okText="Duyệt & chạy" cancelText="Quay lại" confirmLoading={busy} onOk={() => void approve()}>
       {review ? <><Alert type="warning" showIcon title={review.kind === 'SYNC' ? 'Thao tác này quét danh sách nhóm đã tham gia trên Facebook.' : review.kind === 'MESSAGE' || review.kind === 'MESSAGE_REACTORS' ? 'Thao tác này gửi tin nhắn thật trên Facebook.' : review.kind === 'SCAN_COMMENTS' ? 'Thao tác này mở bài viết và đọc các bình luận trên Facebook.' : review.kind === 'REPLY_COMMENTS' ? 'Thao tác này gửi trả lời thật vào bình luận trên Facebook.' : 'Thao tác này gửi yêu cầu tham gia hoặc đăng bài thật trên Facebook.'} description={review.kind === 'SYNC' ? 'Kiểm tra profile đã sẵn sàng, browser đã đóng và proxy hoạt động trước khi duyệt.' : review.kind === 'MESSAGE' ? 'Mỗi tác vụ chọn ngẫu nhiên một thành viên đang hiển thị trong danh sách của nhóm. Kiểm tra nhóm, nội dung, giới hạn và thời gian chờ; dừng nếu Facebook cảnh báo.' : review.kind === 'MESSAGE_REACTORS' ? 'Mỗi tác vụ lấy người react và/hoặc người bình luận theo nguồn đã chọn, bỏ qua profile đã nhắn và chia đều lượt nhắn cho các account. Kiểm tra bài viết, nguồn người nhận và giới hạn trước khi duyệt.' : review.kind === 'SCAN_COMMENTS' ? 'Profile sẽ chọn “Tất cả bình luận”, tải thêm bình luận nếu có và trích xuất số điện thoại. Không có thao tác đăng bài hoặc gửi tin nhắn.' : review.kind === 'REPLY_COMMENTS' ? 'Tổng số lượt rep được chia đều cho các profile. Kiểm tra bài viết, nội dung và số lượt trước khi duyệt; nếu Facebook không xác nhận kết quả, tác vụ sẽ dừng để tránh gửi trùng.' : 'Kiểm tra account, nhóm đích, nội dung và quyền đăng bài; tuân thủ quy tắc của nhóm. Không tự vượt CAPTCHA hay trả lời câu hỏi thành viên.'} style={{ marginBottom: 16 }} /><Typography.Paragraph>{review.name} · {new Set(review.tasks.map((job) => job.account.id)).size} account · {review.tasks.length} tác vụ · Cách nhau {review.payload.intervalSeconds}s/account</Typography.Paragraph>{review.payload.postUrls?.length ? <Typography.Paragraph>URL bài viết ({review.payload.postUrls.length}): {review.payload.postUrls.map((url, index) => <span key={url}>{index ? ' · ' : ''}<a href={url} target="_blank" rel="noreferrer">{url}</a></span>)}</Typography.Paragraph> : review.payload.postUrl ? <Typography.Paragraph>URL bài viết: <a href={review.payload.postUrl} target="_blank" rel="noreferrer">{review.payload.postUrl}</a></Typography.Paragraph> : null}{review.kind === 'MESSAGE_REACTORS' && review.payload.recipientSource ? <Typography.Paragraph>Nguồn người nhận: {review.payload.recipientSource === 'COMMENTERS' ? 'Người đã bình luận' : review.payload.recipientSource === 'REACTORS_AND_COMMENTERS' ? 'Người react và người bình luận' : 'Người đã react'}</Typography.Paragraph> : null}{review.payload.text ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' }}>{review.payload.text}</Typography.Paragraph> : null}{review.payload.maxReplies != null ? <Typography.Paragraph>Số lượt rep: {review.payload.maxReplies}</Typography.Paragraph> : null}{review.payload.maxRecipientsPerPost != null ? <Typography.Paragraph>Số thành viên cần nhắn: {review.payload.maxRecipientsPerPost}</Typography.Paragraph> : null}<FacebookPostImages ids={review.payload.mediaAssetIds} />{jobsTable(review.tasks)}</> : null}
    </Modal>
  </div>;
}
