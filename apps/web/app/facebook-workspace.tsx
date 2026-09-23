'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, Checkbox, Empty, Flex, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';

import { Icon } from './ui';
import { useToast, useToastError, useToastNotice } from './toast';
import { ContextNote as Alert } from './context-note';
import { readApiJson } from '../lib/api-response';
import { facebookGroupId, facebookGroupLabel } from '../lib/facebook-group-label';

interface Account { id: string; username?: string; platform: string; status: string }
interface Group { id: string; accountId: string; groupUrl: string; groupName?: string | null; status: string; lastSyncedAt: string; account: Account }
interface Job { id: string; retrySafety?: 'SAFE' | 'VERIFY' | 'BLOCKED'; attemptCount?: number; status: string; approvalStatus: string; lastError?: string; payload: { groupUrl: string }; account: Account; runs: Array<{ errorCode?: string; result?: { sideEffectStarted?: boolean } & { publicationStatus?: string; membershipStatus?: string; complete?: boolean } }> }
interface Campaign { id: string; name: string; kind: string; approvedAt?: string; pausedAt?: string; cancelledAt?: string; createdAt: string; payload: { text?: string; intervalSeconds: number }; tasks: Job[] }
interface Values { name: string; accountIds: string[]; groupUrls?: string; selectedGroupUrls?: string[]; text?: string; selection?: 'ALL' | 'CUSTOM'; maxGroupsPerAccount?: number; intervalSeconds: number }

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

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/facebook/${path}`, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
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
  PAUSED: 'Đã dừng', PAUSING: 'Đang dừng', CANCELLING: 'Đang hủy', DRAFT: 'Bản nháp', SCHEDULED: 'Đã lên lịch', QUEUED: 'Đang chờ', RUNNING: 'Đang chạy', SUCCEEDED: 'Hoàn tất', FAILED: 'Lỗi', CANCELLED: 'Đã hủy',
  PUBLISHED: 'Đã đăng', PENDING_APPROVAL: 'Bài chờ duyệt',
};
function status(value: string) {
  return <Tag color={['JOINED', 'SUCCEEDED', 'PUBLISHED'].includes(value) ? 'green' : ['FAILED', 'REQUIRES_ACTION'].includes(value) ? 'orange' : undefined}>{labels[value] ?? value}</Tag>;
}
function campaignStatus(campaign: Campaign) {
  const jobs = campaign.tasks;
  if (campaign.cancelledAt) return jobs.some(job => job.status === 'RUNNING') ? 'CANCELLING' : 'CANCELLED';
  if (campaign.pausedAt) return jobs.some(job => job.status === 'RUNNING') ? 'PAUSING' : 'PAUSED';
  if (jobs.length && jobs.every((job) => job.status === 'CANCELLED')) return 'CANCELLED';
  if (!campaign.approvedAt) return 'DRAFT';
  if (jobs.some((job) => job.status === 'RUNNING')) return 'RUNNING';
  if (jobs.some((job) => ['QUEUED', 'SCHEDULED'].includes(job.status))) return 'SCHEDULED';
  if (jobs.some((job) => ['REQUIRES_ACTION', 'FAILED'].includes(job.status))) return 'REQUIRES_ACTION';
  if (jobs.some(job => job.status === 'CANCELLED')) return 'CANCELLED';
  return 'SUCCEEDED';
}

export default function FacebookWorkspace({ accounts, canOperate, canAdmin, onNavigateProfiles }: { accounts: Account[]; canOperate: boolean; canAdmin: boolean; onNavigateProfiles: () => void }) {
  const message = useToast();
  const client = useQueryClient();
  const [mode, setMode] = useState<'sync' | 'join' | 'post' | null>(null);
  const [key, setKey] = useState('');
  const setError = useToastError();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('campaigns');
  const [campaignSearch, setCampaignSearch] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [filter, setFilter] = useState<string>();
  const [review, setReview] = useState<Campaign>();
  const [retryReview, setRetryReview] = useState<Campaign>();
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [verifiedUnsent, setVerifiedUnsent] = useState(false);
  const [controlBusy, setControlBusy] = useState<string>();
  const groups = useQuery({ queryKey: ['facebook-groups'], queryFn: () => request<Group[]>('groups'), refetchInterval: 10000 });
  const campaigns = useQuery({ queryKey: ['facebook-campaigns'], queryFn: () => request<Campaign[]>('campaigns'), refetchInterval: 5000 });
  useToastNotice((groups.error ?? campaigns.error)?.message, 'facebook-load-error', 'error', !groups.isFetching && !campaigns.isFetching);
  const ready = accounts.filter((account) => account.platform === 'FACEBOOK' && account.status === 'READY');
  const refresh = async () => { await Promise.all(['facebook-groups', 'facebook-campaigns', 'tasks', 'accounts'].map((name) => client.invalidateQueries({ queryKey: [name] }))); };
  const open = (next: typeof mode) => { setKey(crypto.randomUUID()); setError(undefined); setMode(next); };
  const submit = async (values: Values) => {
    setBusy(true); setError(undefined);
    try {
      const { groupUrls, selectedGroupUrls, ...fields } = values;
      await request(`groups/${mode}`, {
        ...fields, idempotencyKey: key,
        ...(mode === 'join' ? { groupUrls: [...new Set((groupUrls ?? '').split(/\r?\n/).map((url) => url.trim()).filter(Boolean))] } : {}),
        ...(mode === 'post' && values.selection === 'CUSTOM' ? { groupUrls: selectedGroupUrls ?? [] } : {}),
      });
      setTab(mode === 'sync' ? 'groups' : 'campaigns'); setMode(null); await refresh();
      void message.success(mode === 'sync' ? 'Đã tạo tác vụ đồng bộ. Theo dõi kết quả trong Tác vụ.' : 'Đã lưu bản nháp. Duyệt danh sách đích trước khi chạy.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const approve = async () => {
    if (!review) return;
    setBusy(true); setError(undefined);
    try { await request(`campaigns/${review.id}/approve`, {}); setReview(undefined); await refresh(); void message.success('Đã duyệt và lên lịch chiến dịch'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const { modal } = App.useApp();
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
  const jobsTable = (jobs: Job[]) => <Table<Job> size="small" rowKey="id" dataSource={jobs} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 650 }} columns={[
    { title: 'Profile', render: (_, job) => <Space orientation="vertical" size={3}><strong>{job.account.username ?? job.account.id}</strong><Typography.Text type="secondary">{isReady(job) ? 'Profile sẵn sàng' : 'Profile chưa sẵn sàng'}</Typography.Text></Space> },
    { title: 'Nhóm đích', render: (_, job) => <a href={job.payload.groupUrl} target="_blank" rel="noreferrer">{job.payload.groupUrl}</a> },
    { title: 'Kết quả', render: (_, job) => <Space orientation="vertical" size={2}>{status(job.status)}{job.runs[0]?.result?.publicationStatus ? status(job.runs[0].result.publicationStatus) : null}{job.runs[0]?.result?.membershipStatus ? status(job.runs[0].result.membershipStatus) : null}{job.lastError ? <Typography.Text type="secondary">{job.lastError}</Typography.Text> : null}</Space> },
  ]} />;
  return <div className="facebook-workspace">
    <div className="facebook-summary">
      <div><span className="summary-icon"><Icon name="accounts" /></span><span><strong>{ready.length}</strong><small>Profile sẵn sàng</small></span></div>
      <div><span className="summary-icon"><Icon name="facebook" /></span><span><strong>{(groups.data ?? []).filter(group => group.status === 'JOINED').length}</strong><small>Lượt nhóm đã tham gia</small></span></div>
      <div><span className="summary-icon"><Icon name="tasks" /></span><span><strong>{campaigns.data?.length ?? 0}</strong><small>Chiến dịch</small></span></div>
    </div>
    <div className="facebook-actions">
      <div><strong>Bắt đầu chiến dịch mới</strong><p>Chọn profile, chuẩn bị nội dung và duyệt trước khi chạy.</p></div>
      <Space wrap><Button icon={<Icon name="refresh" />} disabled={!canOperate || !ready.length} onClick={() => open('sync')}>Đồng bộ nhóm</Button><Button icon={<Icon name="plus" />} disabled={!canOperate || !ready.length} onClick={() => open('join')}>Tham gia nhóm</Button><Button type="primary" icon={<Icon name="edit" />} disabled={!canOperate || !ready.length} onClick={() => open('post')}>Soạn bài nhóm</Button></Space>
    </div>
    {!ready.length ? <Alert type="info" showIcon title="Cần ít nhất một profile Facebook sẵn sàng" description="Mở browser trong Profiles để đăng nhập, kiểm tra phiên rồi đóng browser trước khi chạy chiến dịch." action={<Button onClick={onNavigateProfiles}>Mở Profiles</Button>} /> : null}
    <Tabs className="facebook-tabs" activeKey={tab} onChange={setTab} items={[{ key: 'campaigns', label: `Chiến dịch (${campaigns.data?.length ?? 0})` }, { key: 'groups', label: `Nhóm đã tham gia (${(groups.data ?? []).filter(group => group.status === 'JOINED').length})` }]} />
    {tab === 'groups' ? <Card className="resource-card" title={<div className="section-title"><strong>Danh sách nhóm</strong><small>Nhóm và trạng thái tham gia của từng profile</small></div>} extra={<Input.Search aria-label="Tìm nhóm" placeholder="Tìm tên hoặc link nhóm..." allowClear value={groupSearch} onChange={event => setGroupSearch(event.target.value)} />}>
      <Flex justify="space-between" align="center" wrap gap={12} style={{ marginBottom: 16 }}><Typography.Text type="secondary">Danh sách từ lần đồng bộ gần nhất</Typography.Text><Select aria-label="Lọc nhóm theo profile" allowClear placeholder="Tất cả profile" style={{ minWidth: 230 }} value={filter} onChange={setFilter} options={accounts.filter(account => account.platform === 'FACEBOOK').map(account => ({ value: account.id, label: account.username ?? account.id }))} /></Flex>
      <Table<Group> rowKey="id" loading={groups.isLoading} dataSource={(groups.data ?? []).filter(group => (!filter || group.accountId === filter) && `${facebookGroupLabel(group)} ${group.groupUrl} ${group.account.username ?? ''}`.toLowerCase().includes(groupSearch.toLowerCase().trim()))} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 700 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có nhóm phù hợp. Đồng bộ từ Facebook hoặc thử bộ lọc khác." /> }} columns={[
        { title: 'Nhóm', render: (_, group) => <a className="group-link" href={group.groupUrl} title={group.groupUrl} target="_blank" rel="noreferrer">{facebookGroupLabel(group)}</a> },
        { title: 'Profile', render: (_, group) => group.account.username ?? group.accountId },
        { title: 'Trạng thái', dataIndex: 'status', render: status },
        { title: 'Cập nhật', render: (_, group) => new Date(group.lastSyncedAt).toLocaleString('vi-VN') },
      ]} />
    </Card> : <Card className="resource-card" title={<div className="section-title"><strong>Chiến dịch của bạn</strong><small>Bản nháp cần được duyệt trước khi thực thi</small></div>} extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm chiến dịch" placeholder="Tìm chiến dịch..." allowClear value={campaignSearch} onChange={event => setCampaignSearch(event.target.value)} /><Tooltip title="Làm mới chiến dịch"><Button aria-label="Làm mới chiến dịch" icon={<Icon name="refresh" />} onClick={() => void refresh()} /></Tooltip></Space>}>
      <Table<Campaign> rowKey="id" loading={campaigns.isLoading} dataSource={(campaigns.data ?? []).filter(campaign => campaign.name.toLowerCase().includes(campaignSearch.toLowerCase().trim()))} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 760 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có chiến dịch. Tham gia nhóm hoặc soạn bài để tạo bản nháp đầu tiên." /> }} expandable={{ expandedRowRender: campaign => <>{campaign.tasks.some(job => job.status === 'REQUIRES_ACTION') ? <Alert type="warning" showIcon title="Một số profile cần thao tác" description="Đây là kết quả lần chạy trước, không phải trạng thái đăng nhập hiện tại. Khi profile sẵn sàng và browser đã đóng, chọn Chạy lại để xử lý các nhóm chưa hoàn thành." action={<Button onClick={onNavigateProfiles}>Mở Profiles</Button>} style={{ marginBottom: 16 }} /> : null}{campaign.payload.text ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{campaign.payload.text}</Typography.Paragraph> : null}{jobsTable(campaign.tasks)}</> }} columns={[
        { title: 'Chiến dịch', render: (_, campaign) => <div className="campaign-name"><strong>{campaign.name}</strong><small>{new Set(campaign.tasks.map(job => job.account.id)).size} profile · {new Date(campaign.createdAt).toLocaleDateString('vi-VN')}</small></div> },
        { title: 'Loại', render: (_, campaign) => campaign.kind === 'JOIN' ? 'Tham gia nhóm' : 'Đăng bài nhóm' },
        { title: 'Tiến độ', render: (_, campaign) => <div className="campaign-progress"><span>{campaign.tasks.filter(job => job.status === 'SUCCEEDED').length}/{campaign.tasks.length}</span><div className="progress-track"><i style={{ width: `${campaign.tasks.length ? campaign.tasks.filter(job => job.status === 'SUCCEEDED').length / campaign.tasks.length * 100 : 0}%` }} /></div></div> },
        { title: 'Trạng thái', render: (_, campaign) => status(campaignStatus(campaign)) },
        { title: 'Thao tác', width: 210, render: (_, campaign) => <Space wrap size={6}>
          {!campaign.approvedAt && !campaign.cancelledAt && campaign.tasks.some(job => job.approvalStatus === 'PENDING') ? <Button icon={<Icon name="approve" />} disabled={!canAdmin} onClick={() => { setReview(campaign); setError(undefined); }}>Duyệt</Button> : null}
          {campaign.approvedAt && !campaign.cancelledAt && !campaign.pausedAt && campaign.tasks.some(job => ['RUNNING', 'SCHEDULED', 'QUEUED'].includes(job.status)) ? <Tooltip title="Dừng tác vụ kế tiếp; chờ tác vụ đang chạy kết thúc an toàn"><Button icon={<Icon name="pause" />} aria-label={`Dừng ${campaign.name}`} disabled={!canAdmin || !!controlBusy} loading={controlBusy === campaign.id} onClick={() => void runControl(campaign, 'pause')}>Dừng</Button></Tooltip> : null}
          {campaign.pausedAt && !campaign.cancelledAt ? <Tooltip title={campaign.tasks.some(job => job.status === 'RUNNING') ? 'Chờ tác vụ đang chạy kết thúc' : 'Tiếp tục các tác vụ đang tạm dừng'}><Button icon={<Icon name="play" />} aria-label={`Tiếp tục ${campaign.name}`} disabled={!canAdmin || !!controlBusy || campaign.tasks.some(job => job.status === 'RUNNING')} loading={controlBusy === campaign.id} onClick={() => void runControl(campaign, 'resume')}>Tiếp tục</Button></Tooltip> : null}
          {campaign.approvedAt && !campaign.cancelledAt && campaign.tasks.some(job => ['FAILED', 'REQUIRES_ACTION'].includes(job.status)) ? <Tooltip title={campaign.pausedAt ? 'Tiếp tục chiến dịch trước khi chạy lại' : 'Chọn phần chưa hoàn thành để chạy lại'}><Button icon={<Icon name="refresh" />} aria-label={`Chạy lại ${campaign.name}`} disabled={!canAdmin || !!campaign.pausedAt || !!controlBusy} onClick={() => openRetry(campaign)}>Chạy lại</Button></Tooltip> : null}
          {!campaign.cancelledAt && campaign.tasks.some(job => ['DRAFT', 'SCHEDULED', 'QUEUED', 'RUNNING', 'PAUSED', 'FAILED', 'REQUIRES_ACTION'].includes(job.status)) ? <Tooltip title="Hủy chiến dịch"><Button icon={<Icon name="close" />} danger disabled={!canAdmin || !!controlBusy} aria-label={`Hủy ${campaign.name}`} onClick={() => cancel(campaign)} /></Tooltip> : null}
        </Space> },
      ]} />
    </Card>}
    <Modal title={mode === 'sync' ? 'Đồng bộ nhóm đã tham gia' : mode === 'join' ? 'Tham gia danh sách nhóm' : 'Đăng bài vào nhóm'} open={mode !== null} onCancel={() => { if (!busy) setMode(null); }} destroyOnHidden width={640} confirmLoading={busy} okText={mode === 'sync' ? 'Đồng bộ' : 'Lưu bản nháp'} cancelText="Đóng" okButtonProps={{ form: 'facebook-form', htmlType: 'submit' }}>
      <Form<Values> id="facebook-form" key={key} layout="vertical" preserve={false} initialValues={{ accountIds: [], intervalSeconds: 60, selection: 'ALL', maxGroupsPerAccount: 5 }} onFinish={(values) => void submit(values)}>
        {mode !== 'sync' ? <Form.Item name="name" label="Tên chiến dịch" rules={[{ required: true, whitespace: true }, { max: 120 }]}><Input placeholder="Ví dụ: Bài giới thiệu tháng 9" /></Form.Item> : null}
        <Form.Item name="accountIds" label="Account" extra="Để trống = tất cả account Facebook READY trong workspace."><Select mode="multiple" allowClear placeholder="Tất cả account READY" options={ready.map((account) => ({ value: account.id, label: account.username ?? account.id }))} /></Form.Item>
        {mode === 'join' ? <Form.Item name="groupUrls" label="Link nhóm (mỗi dòng một link)" extra="Tối đa 100 link. Link trùng sẽ được gộp." rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={7} placeholder={'https://www.facebook.com/groups/123456/\nhttps://www.facebook.com/groups/ten-nhom/'} /></Form.Item> : null}
        {mode === 'post' ? <>
          <Form.Item name="text" label="Nội dung bài viết" extra="Hỗ trợ bài chữ. Hệ thống mở khung soạn bài và chỉ gửi khi nút đăng khả dụng; không yêu cầu xác nhận đã tham gia nhóm." rules={[{ required: true, whitespace: true }, { max: 20000 }]}><Input.TextArea rows={7} showCount maxLength={20000} /></Form.Item>
          <Form.Item name="selection" label="Nhóm đăng bài"><Select options={[{ value: 'ALL', label: 'Tất cả nhóm đã tham gia' }, { value: 'CUSTOM', label: 'Tự chọn trong nhóm đã đồng bộ' }]} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(before, after) => before.selection !== after.selection}>{({ getFieldValue }) => getFieldValue('selection') === 'CUSTOM' ? <SyncedGroupPicker groups={groups.data ?? []} accounts={accounts} loading={groups.isLoading} /> : null}</Form.Item>
          <Form.Item name="maxGroupsPerAccount" label="Tối đa số nhóm / account" extra="Các nhóm được giao tuần tự theo vòng tròn để số lượng giữa các account cân bằng; không chọn ngẫu nhiên." rules={[{ required: true, message: 'Nhập số nhóm tối đa cho mỗi account' }]}><InputNumber min={1} max={500} /></Form.Item>
        </> : null}
        {mode !== 'sync' ? <Form.Item name="intervalSeconds" label="Khoảng cách giữa tác vụ cùng account (giây)" extra="Tối thiểu 30 giây. Không tự thử lại khi kết quả gửi không rõ ràng." rules={[{ required: true }]}><InputNumber min={30} max={3600} /></Form.Item> : null}
      </Form>
    </Modal>
    <Modal title="Chạy lại phần chưa hoàn thành" open={!!retryReview} width={900} destroyOnHidden okText="Chạy lại tác vụ đã chọn" cancelText="Quay lại" confirmLoading={busy} okButtonProps={{ disabled: !selectedTaskIds.length }} onOk={() => void retry()} onCancel={() => { if (!busy) setRetryReview(undefined); }}>
      <Alert type="info" showIcon title="Chỉ chạy lại các nhóm được chọn; giữ nguyên phần hoàn thành." description="Profile phải sẵn sàng, proxy kết nối tốt và browser đã đóng. Kết quả lần chạy trước và lịch sử vẫn được giữ lại." style={{ marginBottom: 16 }} />
      {retryReview?.tasks.some(job => ['FAILED', 'REQUIRES_ACTION'].includes(job.status) && retryKind(job) === 'VERIFY') ? <Alert type="warning" showIcon title="Một số tác vụ chưa rõ kết quả gửi" description={<Checkbox checked={verifiedUnsent} onChange={event => { setVerifiedUnsent(event.target.checked); if (!event.target.checked) setSelectedTaskIds(ids => ids.filter(id => retryReview.tasks.some(job => job.id === id && retryKind(job) === 'SAFE'))); }}>Tôi đã kiểm tra trên Facebook: các tác vụ chưa rõ kết quả mà tôi chọn chưa gửi yêu cầu hoặc đăng bài thành công.</Checkbox>} style={{ marginBottom: 16 }} /> : null}
      <Typography.Paragraph type="secondary">{selectedTaskIds.length} tác vụ được chọn. Profile chưa sẵn sàng không thể chọn. <Button type="link" onClick={() => { setRetryReview(undefined); onNavigateProfiles(); }}>Mở Profiles</Button></Typography.Paragraph>
      <Table<Job> rowKey="id" size="small" dataSource={retryReview?.tasks.filter(job => ['FAILED', 'REQUIRES_ACTION'].includes(job.status)) ?? []} pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 650 }} rowSelection={{ selectedRowKeys: selectedTaskIds, onChange: keys => setSelectedTaskIds(keys.map(String)), getCheckboxProps: job => ({ disabled: !isReady(job) || retryKind(job) === 'VERIFY' && !verifiedUnsent }) }} columns={[
        { title: 'Profile', render: (_, job) => <Space orientation="vertical" size={2}><strong>{job.account.username ?? job.account.id}</strong><Typography.Text type="secondary">{isReady(job) ? 'Sẵn sàng' : 'Cần đăng nhập / kiểm tra phiên'}</Typography.Text></Space> },
        { title: 'Nhóm', render: (_, job) => <a className="group-link" href={job.payload.groupUrl} target="_blank" rel="noreferrer">{job.payload.groupUrl}</a> },
        { title: 'Lần chạy trước', render: (_, job) => <Space orientation="vertical" size={3}>{status(job.status)}<Typography.Text type="secondary">{job.lastError}</Typography.Text></Space> },
        { title: 'Chạy lại', render: (_, job) => retryKind(job) === 'SAFE' ? <Tag color="green">Chưa gửi thao tác</Tag> : <Tag color="orange">Cần xác nhận chưa gửi</Tag> },
      ]} />
    </Modal>
    <Modal title="Duyệt & chạy chiến dịch Facebook" open={!!review} onCancel={() => { if (!busy) setReview(undefined); }} width={900} okText="Duyệt & chạy" cancelText="Quay lại" confirmLoading={busy} onOk={() => void approve()}>
      {review ? <><Alert type="warning" showIcon title="Thao tác này gửi yêu cầu tham gia hoặc đăng bài thật trên Facebook." description="Kiểm tra account, nhóm đích, nội dung và quyền đăng bài; tuân thủ quy tắc của nhóm. Không tự vượt CAPTCHA hay trả lời câu hỏi thành viên." style={{ marginBottom: 16 }} /><Typography.Paragraph>{review.name} · {new Set(review.tasks.map((job) => job.account.id)).size} account · {review.tasks.length} tác vụ · Cách nhau {review.payload.intervalSeconds}s/account</Typography.Paragraph>{review.payload.text ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' }}>{review.payload.text}</Typography.Paragraph> : null}{jobsTable(review.tasks)}</> : null}
    </Modal>
  </div>;
}
