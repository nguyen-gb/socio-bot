'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Avatar,
  Button,
  Card,
  Checkbox,
  Col,
  Divider,
  Empty,
  Flex,
  Form,
  Grid,
  Input,
  InputNumber,
  Layout,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  type ButtonProps,
  type UploadProps,
} from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import FacebookWorkspace from './facebook-workspace';
import { Icon, STATUS_LABELS, ACTION_LABELS } from './ui';
import { useToast, useToastError, useToastNotice } from './toast';
import { ContextNote as Alert } from './context-note';

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
type DashboardView = 'overview' | 'accounts' | 'proxies' | 'facebook' | 'schedules' | 'media' | 'tasks';

const NAV_ITEMS: Array<{
  key: DashboardView;
  label: string;
  description: string;
}> = [
  { key: 'overview', label: 'Tổng quan', description: 'Tình hình vận hành' },
  { key: 'accounts', label: 'Profiles', description: 'Tài khoản & trình duyệt' },
  { key: 'proxies', label: 'Proxy', description: 'Kết nối & phân bổ' },
  { key: 'facebook', label: 'Facebook', description: 'Nhóm & chiến dịch' },
  { key: 'schedules', label: 'Lịch chạy', description: 'Tự động hóa định kỳ' },
  { key: 'media', label: 'Nội dung', description: 'Thư viện ảnh & video' },
  { key: 'tasks', label: 'Tác vụ', description: 'Theo dõi thực thi' },
];

interface BrowserSession {
  id: string;
  mode?: 'LOGIN' | 'AUTOMATION';
  processId?: number;
  status: string;
  expiresAt: string;
  account: { id: string; platform: string; username?: string };
}

interface Account {
  id: string;
  username?: string;
  externalId?: string;
  platform: string;
  status: string;
  browserProfile?: { hasCookies?: boolean; hasPassword?: boolean };
  proxyBinding?: { proxy: { id: string; name: string; status: string } };
}

interface ProxyItem {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number;
  status: string;
  latencyMs?: number;
  hasAuthentication?: boolean;
  accountBindings?: Array<{
    account: Pick<Account, 'id' | 'username' | 'platform' | 'status'>;
  }>;
}

interface ScheduleItem {
  id: string;
  name: string;
  cronExpression: string;
  timezone: string;
  action: string;
  enabled: boolean;
  nextRunAt?: string;
  account: Account;
}

interface TaskItem {
  id: string;
  action: string;
  status: string;
  createdAt: string;
  approvalStatus?: string;
  campaignId?: string;
  lastError?: string;
  account: Account;
}

interface MediaAsset {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: string;
  status: string;
}

interface AccountFormValue {
  platform: string;
  label: string;
  externalId?: string;
  proxyId?: string;
  login?: string;
  password?: string;
  cookies?: string;
  openAfterCreate?: boolean;
}

interface ProxyFormValue {
  name: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  accountIds?: string[];
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store' });
  if (response.status === 401) window.location.assign('/login');
  const payload = (await response.json().catch(() => ({}))) as T & {
    message?: string | string[];
  };
  if (!response.ok) throw new Error(errorMessage(payload.message, response.status));
  return payload;
}

async function mutate<T>(path: string, method = 'POST', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & {
    message?: string | string[];
  };
  if (!response.ok) throw new Error(errorMessage(payload.message, response.status));
  return payload;
}

function errorMessage(message: string | string[] | undefined, status: number) {
  if (Array.isArray(message)) return message.join('. ');
  return message ?? `Yêu cầu thất bại (${status.toString()})`;
}

type ActionIconName = 'open' | 'close' | 'edit' | 'delete' | 'test' | 'play' | 'pause' | 'approve' | 'reject' | 'logout' | 'refresh';

function ActionIcon({ name }: { name: ActionIconName }) {
  return <Icon name={name} size={17} />;
}

function ActionButton({ label, icon, ...props }: Omit<ButtonProps, 'children' | 'icon'> & { label: string; icon: ActionIconName }) {
  return (
    <Tooltip title={label}>
      <span className="action-tooltip">
        <Button {...props} aria-label={label} icon={<ActionIcon name={icon} />} />
      </span>
    </Tooltip>
  );
}

export default function DashboardClient() {
  const router = useRouter();
  const screens = Grid.useBreakpoint();
  const cache = useQueryClient();
  const { modal } = AntApp.useApp();
  const message = useToast();
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [accountInitialValues, setAccountInitialValues] = useState<AccountFormValue>({
    platform: 'FACEBOOK',
    label: '',
    openAfterCreate: true,
  });
  const [proxyInitialValues, setProxyInitialValues] = useState<ProxyFormValue>({
    name: '',
    protocol: 'HTTP',
    host: '',
    port: 8080,
    accountIds: [],
  });

  const setError = useToastError();
  const [busy, setBusy] = useState<string>();
  const [editingAccount, setEditingAccount] = useState<Account>();
  const [editingProxy, setEditingProxy] = useState<ProxyItem>();
  const [activeView, setActiveView] = useState<DashboardView>('overview');
  useEffect(() => {
    const syncView = () => {
      const key = window.location.hash.slice(1);
      setActiveView(NAV_ITEMS.some(item => item.key === key) ? key as DashboardView : 'overview');
    };
    syncView();
    window.addEventListener('hashchange', syncView);
    window.addEventListener('popstate', syncView);
    return () => { window.removeEventListener('hashchange', syncView); window.removeEventListener('popstate', syncView); };
  }, []);
  const navigate = (view: DashboardView) => {
    setActiveView(view);
    if (window.location.hash !== `#${view}`) window.history.pushState(null, '', `#${view}`);
  };
  const [accountSearch, setAccountSearch] = useState('');
  const [accountStatus, setAccountStatus] = useState('ALL');
  const [proxySearch, setProxySearch] = useState('');
  const [taskStatus, setTaskStatus] = useState<string>('ALL');
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleAccount, setScheduleAccount] = useState<string>();
  const [scheduleCron, setScheduleCron] = useState('0 * * * *');
  const [scheduleTimezone, setScheduleTimezone] = useState('Asia/Bangkok');
  const [scheduleAction, setScheduleAction] = useState('HEALTH_CHECK');

  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => getJson<Account[]>('/api/control/accounts'),
  });
  const proxies = useQuery({
    queryKey: ['proxies'],
    queryFn: () => getJson<ProxyItem[]>('/api/control/proxies'),
  });
  const sessions = useQuery({
    queryKey: ['login-sessions'],
    queryFn: () => getJson<BrowserSession[]>('/api/login-sessions'),
    refetchInterval: 3_000,
  });
  const schedules = useQuery({
    queryKey: ['schedules'],
    queryFn: () => getJson<ScheduleItem[]>('/api/control/schedules'),
  });
  const tasks = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getJson<TaskItem[]>('/api/control/tasks'),
  });
  const media = useQuery({
    queryKey: ['media'],
    queryFn: () => getJson<MediaAsset[]>('/api/media'),
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => getJson<{ role: Role; email?: string }>('/api/auth/me'),
  });

  const canOperate = ['OWNER', 'ADMIN', 'OPERATOR'].includes(me.data?.role ?? '');
  const canAdmin = ['OWNER', 'ADMIN'].includes(me.data?.role ?? '');
  const accountRows = accounts.data ?? [];
  const activeSessions = sessions.data ?? [];
  const activeByAccount = useMemo(
    () => new Map(activeSessions.map((session) => [session.account.id, session])),
    [activeSessions],
  );
  const filteredAccounts = useMemo(() => {
    const needle = accountSearch.trim().toLowerCase();
    return accountRows.filter(account => accountStatus === 'ALL' || account.status === accountStatus).filter((account) => !needle ||
      [account.username, account.externalId, account.platform, account.proxyBinding?.proxy.name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [accountRows, accountSearch, accountStatus]);
  const filteredProxies = useMemo(() => {
    const needle = proxySearch.trim().toLowerCase();
    if (!needle) return proxies.data ?? [];
    return (proxies.data ?? []).filter((proxy) =>
      [proxy.name, proxy.host, proxy.protocol]
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [proxies.data, proxySearch]);
  const filteredTasks = useMemo(
    () =>
      (tasks.data ?? []).filter(
        (task) => taskStatus === 'ALL' || task.status === taskStatus,
      ),
    [tasks.data, taskStatus],
  );
  const currentView = NAV_ITEMS.find((item) => item.key === activeView)!;
  const setupProgress = [accountRows.length > 0, accountRows.some(account => account.status === 'READY'), (tasks.data ?? []).length > 0]
    .filter(Boolean).length;
  const perform = async <T,>(
    key: string,
    operation: () => Promise<T>,
    refresh: string[] = [],
  ): Promise<T | undefined> => {
    setBusy(key);
    setError(undefined);
    try {
      const result = await operation();
      await Promise.all(
        refresh.map((queryKey) => cache.invalidateQueries({ queryKey: [queryKey] })),
      );
      const success = key.startsWith('account-edit-') ? 'Đã cập nhật profile'
        : key === 'account-create' ? 'Đã tạo profile'
        : key.startsWith('proxy-edit-') ? 'Đã cập nhật proxy'
        : key === 'proxy-create' ? 'Đã tạo proxy'
        : key.startsWith('login-') ? 'Đã yêu cầu mở browser'
        : key.startsWith('close-') ? 'Đã yêu cầu đóng browser'
        : key === 'schedule-create' ? 'Đã tạo lịch chạy'
        : key.startsWith('toggle-') ? 'Đã cập nhật trạng thái lịch'
        : key.startsWith('trigger-') ? 'Đã tạo tác vụ chạy ngay'
        : key.startsWith('delete-') ? 'Đã xóa lịch'
        : key.startsWith('approve-') ? 'Đã duyệt tác vụ'
        : key.startsWith('reject-') ? 'Đã từ chối tác vụ' : undefined;
      if (success) message.success(success);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  };

  const openAccountModal = () => {
    setError(undefined);
    setEditingAccount(undefined);
    setAccountInitialValues({
      platform: 'FACEBOOK',
      label: '',
      openAfterCreate: true,
    });
    setAccountModalOpen(true);
  };

  const editAccount = async (account: Account) => {
    const credentials = await perform(
      `account-credentials-${account.id}`,
      () => getJson<{ login?: string; password?: string; cookies?: string }>(`/api/control-action/accounts/${account.id}/credentials`),
    );
    if (!credentials) return;
    setEditingAccount(account);
    setAccountInitialValues({
      platform: account.platform,
      label: account.username ?? '',
      externalId: account.externalId,
      proxyId: account.proxyBinding?.proxy.id,
      login: credentials.login,
      password: credentials.password,
      cookies: credentials.cookies,
      openAfterCreate: false,
    });
    setAccountModalOpen(true);
  };

  const submitAccount = async (values: AccountFormValue) => {
    const authentication = {
      login: values.login?.trim() || undefined,
      password: values.password || undefined,
      cookies: values.cookies?.trim() || undefined,
    };
    const authenticationChanged = !editingAccount
      || authentication.login !== (accountInitialValues.login?.trim() || undefined)
      || authentication.password !== (accountInitialValues.password || undefined)
      || authentication.cookies !== (accountInitialValues.cookies?.trim() || undefined);
    const payload = {
      platform: !editingAccount || values.platform !== editingAccount.platform ? values.platform : undefined,
      username: values.label,
      externalId: values.externalId?.trim() || (editingAccount ? null : undefined),
      proxyId: values.proxyId || (editingAccount ? null : undefined),
      ...(authenticationChanged ? { authentication } : {}),
    };
    const saved = await perform(
      editingAccount ? `account-edit-${editingAccount.id}` : 'account-create',
      () =>
        mutate<Account>(
          editingAccount
            ? `/api/control/accounts/${editingAccount.id}`
            : '/api/control/accounts',
          editingAccount ? 'PATCH' : 'POST',
          payload,
        ),
      ['accounts', 'proxies'],
    );
    if (!saved) return;
    setAccountModalOpen(false);
    setEditingAccount(undefined);
    if (!editingAccount && values.openAfterCreate) await openBrowser(saved);
  };

  const openProxyModal = () => {
    setError(undefined);
    setEditingProxy(undefined);
    setProxyInitialValues({
      name: '',
      protocol: 'HTTP',
      host: '',
      port: 8080,
      accountIds: [],
    });
    setProxyModalOpen(true);
  };

  const editProxy = async (proxy: ProxyItem) => {
    const credentials = await perform(
      `proxy-credentials-${proxy.id}`,
      () => getJson<{ username?: string; password?: string }>(`/api/control-action/proxies/${proxy.id}/credentials`),
    );
    if (!credentials) return;
    setEditingProxy(proxy);
    setProxyInitialValues({
      name: proxy.name,
      protocol: proxy.protocol,
      host: proxy.host,
      port: proxy.port,
      username: credentials.username,
      password: credentials.password,
      accountIds: proxy.accountBindings?.map((binding) => binding.account.id) ?? [],
    });
    setProxyModalOpen(true);
  };

  const submitProxy = async (values: ProxyFormValue) => {
    const hasCredentials = Boolean(values.username && values.password);
    const saved = await perform(
      editingProxy ? `proxy-edit-${editingProxy.id}` : 'proxy-create',
      () =>
        mutate<ProxyItem>(
          editingProxy
            ? `/api/control/proxies/${editingProxy.id}`
            : '/api/control/proxies',
          editingProxy ? 'PATCH' : 'POST',
          {
          name: values.name,
          protocol: values.protocol,
          host: values.host,
          port: values.port,
          accountIds: values.accountIds ?? [],
          ...(hasCredentials
            ? { username: values.username, password: values.password }
            : {}),
          ...(editingProxy && !hasCredentials
            ? { clearAuthentication: true }
            : {}),
          },
        ),
      ['proxies', 'accounts'],
    );
    if (!saved) return;
    setProxyModalOpen(false);
    setEditingProxy(undefined);
  };

  const confirmDeleteAccount = (account: Account) => {
    modal.confirm({
      title: 'Xóa tài khoản và browser profile?',
      content: `${account.username ?? account.id} sẽ bị xóa. Hãy đóng browser trước khi tiếp tục.`,
      okText: 'Xóa',
      okButtonProps: { danger: true },
      cancelText: 'Hủy',
      onOk: async () => {
        const result = await perform(
          `account-delete-${account.id}`,
          () => mutate(`/api/control/accounts/${account.id}`, 'DELETE'),
          ['accounts', 'proxies', 'login-sessions'],
        );
        if (result === undefined) throw new Error('Không thể xóa profile');
        void message.success('Đã xóa profile');
      },
    });
  };

  const confirmDeleteProxy = (proxy: ProxyItem) => {
    modal.confirm({
      title: 'Xóa proxy?',
      content: `Proxy ${proxy.name} sẽ bị xóa và gỡ khỏi ${proxy.accountBindings?.length ?? 0} profile.`,
      okText: 'Xóa',
      okButtonProps: { danger: true },
      cancelText: 'Hủy',
      onOk: async () => {
        const result = await perform(
          `proxy-delete-${proxy.id}`,
          () => mutate(`/api/control/proxies/${proxy.id}`, 'DELETE'),
          ['proxies', 'accounts'],
        );
        if (result === undefined) throw new Error('Không thể xóa proxy');
        void message.success('Đã xóa proxy');
      },
    });
  };

  const openBrowser = async (account: Account) => {
    const active = activeByAccount.get(account.id);
    if (active) {
      router.push(`/sessions/${active.id}`);
      return;
    }
    const assignedProxy = account.proxyBinding?.proxy;
    if (assignedProxy && assignedProxy.status !== 'HEALTHY') {
      setError(`Proxy "${assignedProxy.name}" chưa kết nối được. Hãy kiểm tra proxy trước khi mở browser.`);
      navigate('proxies');
      return;
    }
    const session = await perform(
      `login-${account.id}`,
      () =>
        mutate<{ id: string }>('/api/login-sessions', 'POST', {
          accountId: account.id,
          ttlSeconds: 1_800,
        }),
      ['login-sessions', 'accounts'],
    );
    if (session) router.push(`/sessions/${session.id}`);
  };

  const closeBrowser = async (session: BrowserSession) => {
    await perform(
      `close-${session.id}`,
      () => mutate(`/api/login-sessions/${session.id}${session.status === 'CLOSING' ? '?force=true' : ''}`, 'DELETE'),
      ['login-sessions', 'accounts'],
    );
  };

  const testProxy = async (proxy: ProxyItem) => {
    setBusy(`test-${proxy.id}`);
    setError(undefined);
    try {
      const result = await mutate<{ ok: boolean; error?: string }>(`/api/control-action/proxies/${proxy.id}/test`);
      if (!result.ok) setError(result.error ?? 'Proxy không thể kết nối tới Facebook');
      else void message.success('Proxy kết nối thành công');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      await cache.invalidateQueries({ queryKey: ['proxies'] });
      setBusy(undefined);
    }
  };

  const uploadProps: UploadProps = {
    accept: 'image/jpeg,image/png,image/webp,video/mp4',
    showUploadList: false,
    customRequest: async ({ file, onError, onSuccess }) => {
      try {
        const body = new FormData();
        body.set('file', file as File);
        const response = await fetch('/api/media', { method: 'POST', body });
        if (!response.ok) throw new Error('Không thể tải media lên');
        await cache.invalidateQueries({ queryKey: ['media'] });
        onSuccess?.({});
        message.success('Đã tải nội dung lên');
      } catch (caught) {
        message.error(caught instanceof Error ? caught.message : String(caught));
        onError?.(caught instanceof Error ? caught : new Error(String(caught)));
      }
    },
  };

  const queryError =
    accounts.error?.message ??
    proxies.error?.message ??
    sessions.error?.message ??
    schedules.error?.message ?? tasks.error?.message ?? media.error?.message ?? me.error?.message;
  useToastNotice(queryError, 'dashboard-load-error', 'error',
    ![accounts, proxies, sessions, schedules, tasks, media, me].some(query => query.isFetching));

  return (
    <Layout className="app-shell">
      <Layout.Sider width={240} className="sidebar">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div><strong>Socio<span className="brand-version">workspace</span></strong></div>
        </div>
        <div className="workspace-summary">
          <span className="workspace-avatar">SC</span>
          <span><strong>Socio Workspace</strong><small>Không gian quản lý của bạn</small></span>
        </div>
        <div className="nav-label">Quản trị</div>
        <nav className="nav">
          {NAV_ITEMS.map((item, index) => <div key={item.key}>{index === 3 ? <div className="nav-label nav-group">Tự động hóa</div> : null}
            <button
              key={item.key}
              type="button"
              className={activeView === item.key ? 'active' : ''}
              aria-current={activeView === item.key ? 'page' : undefined}
              onClick={() => navigate(item.key)}
            >
              <span className="nav-glyph" aria-hidden><Icon name={item.key} /></span>
              <span><strong>{item.label}</strong></span>
              {item.key === 'tasks' && (tasks.data ?? []).filter((task) => task.status === 'RUNNING').length ? (
                <span className="nav-count">{(tasks.data ?? []).filter((task) => task.status === 'RUNNING').length}</span>
              ) : null}
            </button>
          </div>)}
        </nav>
        <div className="sidebar-status">
          <Icon name="shield" /><div><strong>{queryError ? 'Cần kiểm tra kết nối' : 'Không gian làm việc'}</strong><small>{activeSessions.length} browser đang mở</small></div>
        </div>
      </Layout.Sider>

      <Layout className="workspace">
        <header className="topbar">
          <div className="topbar-context">
            <span>Socio</span><b>/</b><strong>{currentView.label}</strong>
          </div>
          <select
            className="mobile-nav"
            value={activeView}
            aria-label="Chọn khu vực quản trị"
            onChange={(event) => navigate(event.currentTarget.value as DashboardView)}
          >
            {NAV_ITEMS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
          <div className="topbar-actions">
            <ActionButton label="Làm mới dữ liệu" icon="refresh" type="text" loading={accounts.isFetching} onClick={() => void cache.invalidateQueries()} />
            <span className={`live-indicator ${queryError ? 'offline' : ''}`}><i />{queryError ? 'Lỗi tải dữ liệu' : accounts.isLoading ? 'Đang đồng bộ' : 'Đã đồng bộ'}</span>
            <span className="topbar-divider" />
            <Avatar size={30}>{(me.data?.email ?? 'O').slice(0, 1).toUpperCase()}</Avatar>
            <div className="user-meta">
              <strong>{me.data?.email ?? 'Đang tải...'}</strong>
              <small>{['OWNER', 'ADMIN'].includes(me.data?.role ?? '') ? 'Quản trị viên' : me.data?.role === 'OPERATOR' ? 'Người vận hành' : 'Chỉ xem'}</small>
            </div>
            <ActionButton label="Đăng xuất" icon="logout" type="text" onClick={async () => {
              try {
                await mutate('/api/auth/logout', 'POST');
                message.success('Đã đăng xuất');
                router.replace('/login');
              } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
            }} />
          </div>
        </header>

      <Layout.Content className="content" data-view={activeView}>
        <Flex id="overview" justify="space-between" align="flex-end" className="page-header" wrap="wrap" gap={16}>
          <div>
            <Typography.Text className="eyebrow">KHÔNG GIAN LÀM VIỆC</Typography.Text>
            <Typography.Title level={2}>{currentView.label}</Typography.Title>
            <Typography.Text type="secondary">{currentView.description}</Typography.Text>
          </div>
          {activeView === 'overview' ? (
            <Space>
              <Button icon={<Icon name="proxies" />} onClick={openProxyModal} disabled={!canAdmin}>Thêm proxy</Button>
              <Button icon={<Icon name="plus" />} type="primary" onClick={openAccountModal} disabled={!canAdmin}>Thêm profile</Button>
            </Space>
          ) : null}
        </Flex>


        {activeView === 'facebook' ? <div id="facebook" className="dashboard-row"><FacebookWorkspace accounts={accountRows} canOperate={canOperate} canAdmin={canAdmin} onNavigateProfiles={() => navigate('accounts')} /></div> : null}
        {activeView === 'overview' ? <div className="overview-welcome"><div><span className="welcome-kicker">VẬN HÀNH ĐƠN GIẢN HƠN</span><h3>Mọi tài khoản. Một không gian.</h3><p>Quản lý profile, kết nối và chiến dịch từ một nơi — rõ ràng ở từng bước.</p><Button onClick={() => navigate('facebook')} icon={<Icon name="arrow" />}>Đến chiến dịch Facebook</Button></div><div className="welcome-summary"><span className="welcome-orbit"><Icon name="accounts" size={34} /></span><strong>{accountRows.filter(x => x.status === 'READY').length}<small>profile sẵn sàng</small></strong></div></div> : null}
        <Row gutter={[14, 14]} className="stats-grid">
          <Col xs={12} xl={6}><Card className="metric-card"><span className="metric-icon"><Icon name="accounts" /></span><Statistic title="Tổng profiles" value={accountRows.length} /><small>{accountRows.filter((x) => x.status === 'READY').length} sẵn sàng</small></Card></Col>
          <Col xs={12} xl={6}><Card className="metric-card"><span className="metric-icon"><Icon name="open" /></span><Statistic title="Browser đang mở" value={activeSessions.length} /><small>Cập nhật mỗi 3 giây</small></Card></Col>
          <Col xs={12} xl={6}><Card className="metric-card"><span className="metric-icon"><Icon name="proxies" /></span><Statistic title="Proxy kết nối tốt" value={(proxies.data ?? []).filter((x) => x.status === 'HEALTHY').length} suffix={`/${(proxies.data ?? []).length}`} /><small>Đã kiểm tra kết nối</small></Card></Col>
          <Col xs={12} xl={6}><Card className="metric-card"><span className="metric-icon"><Icon name="tasks" /></span><Statistic title="Tác vụ cần xử lý" value={(tasks.data ?? []).filter(x => ['REQUIRES_ACTION', 'FAILED'].includes(x.status)).length} /><small>{(tasks.data ?? []).length} tác vụ đã tạo</small></Card></Col>
        </Row>

        <Row gutter={[16, 16]} className="overview-grid">
          <Col xs={24} xl={16}>
            <Card
              className="overview-card"
              title={<SectionTitle title="Browser đang hoạt động" description="Phiên thao tác thủ công và browser đang chạy tác vụ" />}
              extra={<Button type="link" onClick={() => navigate('accounts')}>Xem profiles →</Button>}
            >
              {activeSessions.length ? (
                <div className="session-list">
                  {activeSessions.slice(0, 5).map((session) => (
                    <div className="session-item" key={session.id}>
                      <span className="session-platform">{session.account.platform.slice(0, 1)}</span>
                      <div><strong>{session.account.username ?? session.account.id}</strong><small>{session.mode === 'AUTOMATION' ? 'Đang chạy tác vụ' : session.account.platform}{session.processId ? ` · PID ${session.processId}` : ''} · hết hạn {new Date(session.expiresAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</small></div>
                      {statusTag(session.status)}
                      <ActionButton label="Mở lại browser" icon="open" disabled={!canOperate || session.status === 'CLOSING' || session.mode === 'AUTOMATION'} onClick={() => router.push(`/sessions/${session.id}`)} />
                      <ActionButton label={session.status === 'CLOSING' ? 'Ép đóng browser' : 'Đóng browser'} icon="close" danger type="text" disabled={!canOperate} loading={busy === `close-${session.id}`} onClick={() => void closeBrowser(session)} />
                    </div>
                  ))}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có browser nào đang mở">
                  <Button onClick={() => navigate('accounts')}>Chọn một profile</Button>
                </Empty>
              )}
            </Card>
          </Col>
          <Col xs={24} xl={8}>
            <Card className="overview-card setup-card" title={<SectionTitle title="Bắt đầu cùng Socio" description="Ba bước để chạy chiến dịch đầu tiên" />}>
              <div className="setup-progress">
                <strong>{setupProgress}/3 bước hoàn tất</strong>
                <span>{Math.round((setupProgress / 3) * 100)}%</span>
              </div>
              <div className="progress-track"><i style={{ width: `${(setupProgress / 3) * 100}%` }} /></div>
              {[
                { done: accountRows.length > 0, label: 'Thêm browser profile', view: 'accounts' as DashboardView },
                { done: accountRows.some(account => account.status === 'READY'), label: 'Đăng nhập và xác minh profile', view: 'accounts' as DashboardView },
                { done: (tasks.data ?? []).length > 0, label: 'Tạo chiến dịch đầu tiên', view: 'facebook' as DashboardView },
              ].map((step) => (
                <button key={step.label} type="button" className="setup-step" onClick={() => navigate(step.view)}>
                  <span className={step.done ? 'done' : ''}>{step.done ? '✓' : '○'}</span>
                  <strong>{step.label}</strong>
                  <small>→</small>
                </button>
              ))}
            </Card>
          </Col>
        </Row>

        <Card
          id="accounts"
          className="dashboard-row resource-card"
          title={<SectionTitle title="Danh sách profiles" description={`${accountRows.length} profile · mỗi profile có dữ liệu trình duyệt riêng`} />}
          extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm profile" allowClear value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} placeholder="Tìm profile hoặc proxy..." /><Select aria-label="Lọc trạng thái profile" className="status-filter" value={accountStatus} onChange={setAccountStatus} options={['ALL', 'READY', 'LOGIN_REQUIRED', 'CHALLENGED', 'RUNNING', 'ERROR'].map(value => ({ value, label: value === 'ALL' ? 'Mọi trạng thái' : STATUS_LABELS[value] }))} /><Button icon={<Icon name="plus" />} type="primary" disabled={!canAdmin} onClick={openAccountModal}>Thêm profile</Button></Space>}
        >
          <Table
            rowKey="id"
            loading={accounts.isLoading}
            dataSource={filteredAccounts}
            pagination={{ pageSize: 8, hideOnSinglePage: true, showTotal: (total) => `${total} profile` }}
            size="middle"
            scroll={{ x: 850 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={accountSearch ? 'Không tìm thấy profile phù hợp' : 'Chưa có profile nào'} /> }}
            columns={[
              {
                title: 'Tài khoản',
                width: 220,
                render: (_: unknown, item: Account) => (
                  <div className="primary-cell">
                    <span className={`platform-badge platform-${item.platform.toLowerCase()}`}>{item.platform.slice(0, 1)}</span>
                    <div><strong>{item.username ?? item.id}</strong><small>{item.externalId ?? 'Chưa có external ID'}</small></div>
                  </div>
                ),
              },
              { title: 'Nền tảng', dataIndex: 'platform', render: (value: string) => <Tag>{value}</Tag> },
              { title: 'Đăng nhập', width: 190, render: (_: unknown, item: Account) => loginFlow(item.browserProfile) },
              { title: 'Trạng thái', dataIndex: 'status', render: statusTag },
              { title: 'Proxy', render: (_: unknown, item: Account) => item.proxyBinding?.proxy.name ?? <span className="muted">Không dùng</span> },
              {
                title: 'Thao tác',
                width: 200,
                fixed: screens.md ? 'right' : undefined,
                render: (_: unknown, item: Account) => {
                  const active = activeByAccount.get(item.id);
                  return (
                    <Space>
                      <ActionButton
                        label={active ? 'Mở lại browser' : 'Mở browser'}
                        icon="open"
                        type={active ? 'default' : 'primary'}
                        disabled={!canOperate || active?.status === 'CLOSING' || active?.mode === 'AUTOMATION'}
                        loading={busy === `login-${item.id}`}
                        onClick={() => void openBrowser(item)}
                      />
                      {active ? (
                        <ActionButton
                          label={active.status === 'CLOSING' ? 'Ép đóng browser' : 'Đóng browser'}
                          icon="close"
                          danger
                          disabled={!canOperate}
                          loading={busy === `close-${active.id}`}
                          onClick={() => void closeBrowser(active)}
                        />
                      ) : null}
                      <ActionButton
                        label="Sửa profile"
                        icon="edit"
                        disabled={!canAdmin || Boolean(active)}
                        loading={busy === `account-credentials-${item.id}`}
                        onClick={() => void editAccount(item)}
                      />
                      <ActionButton
                        label="Xóa profile"
                        icon="delete"
                        danger
                        disabled={!canAdmin || Boolean(active)}
                        loading={busy === `account-delete-${item.id}`}
                        onClick={() => confirmDeleteAccount(item)}
                      />
                    </Space>
                  );
                },
              },
            ]}
          />
        </Card>

        <Card
          id="proxies"
          className="dashboard-row resource-card"
          title={<SectionTitle title="Hạ tầng proxy" description={`${(proxies.data ?? []).length} proxy · có thể phân bổ cho nhiều profile`} />}
          extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm proxy" allowClear value={proxySearch} onChange={(event) => setProxySearch(event.target.value)} placeholder="Tìm tên hoặc địa chỉ proxy..." /><Button icon={<Icon name="plus" />} type="primary" disabled={!canAdmin} onClick={openProxyModal}>Thêm proxy</Button></Space>}
        >
          <Table
            rowKey="id"
            loading={proxies.isLoading}
            dataSource={filteredProxies}
            pagination={{ pageSize: 8, hideOnSinglePage: true, showTotal: (total) => `${total} proxy` }}
            size="middle"
            scroll={{ x: 1075 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={proxySearch ? 'Không tìm thấy proxy phù hợp' : 'Chưa có proxy'} /> }}
            columns={[
              { title: 'Tên', width: 150, dataIndex: 'name', render: (value: string) => <strong>{value}</strong> },
              { title: 'Địa chỉ', width: 290, render: (_: unknown, item: ProxyItem) => <code>{`${item.protocol.toLowerCase()}://${item.host}:${item.port.toString()}`}</code> },
              { title: 'Xác thực', width: 105, render: (_: unknown, item: ProxyItem) => item.hasAuthentication ? <Tag>Có xác thực</Tag> : <span className="muted">Không</span> },
              { title: 'Trạng thái', width: 125, dataIndex: 'status', render: statusTag },
              { title: 'Độ trễ', width: 85, render: (_: unknown, item: ProxyItem) => item.latencyMs === undefined || item.latencyMs === null ? '-' : `${item.latencyMs.toString()} ms` },
              {
                title: 'Profile đang dùng',
                width: 200,
                render: (_: unknown, item: ProxyItem) =>
                  item.accountBindings?.length ? (
                    <Space wrap size={[4, 4]}>
                      {item.accountBindings.map(({ account }) => (
                        <Tag key={account.id}>
                          {account.platform} · {account.username ?? account.id}
                        </Tag>
                      ))}
                    </Space>
                  ) : <span className="muted">Chưa gán profile</span>,
              },
              {
                title: 'Thao tác',
                width: 160,
                fixed: screens.md ? 'right' : undefined,
                render: (_: unknown, item: ProxyItem) => (
                  <Space>
                    <ActionButton label="Kiểm tra proxy" icon="test" disabled={!canOperate} loading={busy === `test-${item.id}`} onClick={() => void testProxy(item)} />
                    <ActionButton label="Sửa hoặc gán profile" icon="edit" disabled={!canAdmin} loading={busy === `proxy-credentials-${item.id}`} onClick={() => void editProxy(item)} />
                    <ActionButton
                      label="Xóa proxy"
                      icon="delete"
                      danger
                      disabled={!canAdmin}
                      loading={busy === `proxy-delete-${item.id}`}
                      onClick={() => confirmDeleteProxy(item)}
                    />
                  </Space>
                ),
              },
            ]}
          />
        </Card>

        <Card id="schedules" className="dashboard-row resource-card" title={<SectionTitle title="Lịch chạy" description="Kiểm tra phiên và profile theo lịch định kỳ." />} extra={<Button type="primary" icon={<Icon name="plus" />} disabled={!canOperate} onClick={() => { setError(undefined); setScheduleModalOpen(true); }}>Tạo lịch</Button>}>
          <Modal title="Tạo lịch tự động" open={scheduleModalOpen} onCancel={() => { if (!busy) setScheduleModalOpen(false); }} width={720} footer={null}>
          <div className="form-row">
            <div className="compact-field"><span>Tên lịch</span><Input aria-label="Tên lịch" value={scheduleName} placeholder="Ví dụ: Kiểm tra mỗi giờ" onChange={(event) => setScheduleName(event.target.value)} /></div>
            <div className="compact-field"><span>Profile</span><Select aria-label="Profile cho lịch" value={scheduleAccount} placeholder="Chọn profile" onChange={setScheduleAccount} options={accountRows.map((account) => ({ value: account.id, label: `${account.platform} · ${account.username ?? account.id}` }))} /></div>
            <div className="compact-field"><span>Biểu thức cron</span><Input aria-label="Biểu thức cron" value={scheduleCron} placeholder="0 * * * *" onChange={(event) => setScheduleCron(event.target.value)} /></div>
            <div className="compact-field"><span>Múi giờ</span><Input aria-label="Múi giờ" value={scheduleTimezone} placeholder="Asia/Bangkok" onChange={(event) => setScheduleTimezone(event.target.value)} /></div>
            <div className="compact-field"><span>Tác vụ</span><Select aria-label="Tác vụ cho lịch" value={scheduleAction} onChange={setScheduleAction} options={['HEALTH_CHECK', 'GET_PROFILE'].map((value) => ({ value, label: ACTION_LABELS[value] }))} /></div>
            <Button className="schedule-submit" type="primary" disabled={!canOperate || !scheduleName.trim() || !scheduleAccount} loading={busy === 'schedule-create'} onClick={async () => { const result = await perform('schedule-create', () => {
              const account = accountRows.find((item) => item.id === scheduleAccount)!;
              return mutate('/api/control/schedules', 'POST', { name: scheduleName, cronExpression: scheduleCron, timezone: scheduleTimezone, action: { platform: account.platform, accountId: account.id, action: scheduleAction, payload: {} } });
            }, ['schedules']); if (result !== undefined) { setScheduleModalOpen(false); setScheduleName(''); } }}>Tạo lịch</Button>
          </div>
          </Modal>
          <Table rowKey="id" dataSource={schedules.data ?? []} pagination={{ pageSize: 6, hideOnSinglePage: true }} scroll={{ x: 900 }} columns={[
            { title: 'Tên', dataIndex: 'name' },
            { title: 'Tài khoản', render: (_: unknown, item: ScheduleItem) => item.account.username ?? item.account.id },
            { title: 'Cron', render: (_: unknown, item: ScheduleItem) => <code>{`${item.cronExpression} · ${item.timezone}`}</code> },
            { title: 'Tác vụ', dataIndex: 'action', render: (value: string) => ACTION_LABELS[value] ?? value },
            { title: 'Hoạt động', render: (_: unknown, item: ScheduleItem) => <Tag color={item.enabled ? 'green' : 'default'}>{item.enabled ? 'BẬT' : 'TẮT'}</Tag> },
            { title: 'Lần kế tiếp', render: (_: unknown, item: ScheduleItem) => item.nextRunAt ? new Date(item.nextRunAt).toLocaleString('vi-VN') : '-' },
            { title: 'Thao tác', width: 120, render: (_: unknown, item: ScheduleItem) => <Space><ActionButton label={item.enabled ? 'Tắt lịch' : 'Bật lịch'} icon={item.enabled ? 'pause' : 'play'} disabled={!canOperate} onClick={() => void perform(`toggle-${item.id}`, () => mutate(`/api/control-action/schedules/${item.id}/${item.enabled ? 'disable' : 'enable'}`), ['schedules'])} /><ActionButton label="Chạy ngay" icon="play" disabled={!canOperate} onClick={() => void perform(`trigger-${item.id}`, () => mutate(`/api/control-action/schedules/${item.id}/trigger`), ['tasks'])} /><ActionButton label="Xóa lịch" icon="delete" danger disabled={!canAdmin} onClick={() => modal.confirm({ title: `Xóa lịch “${item.name}”?`, content: 'Lịch sẽ không chạy lại sau khi bị xóa.', okText: 'Xóa lịch', cancelText: 'Giữ lại', okButtonProps: { danger: true }, onOk: async () => { const result = await perform(`delete-${item.id}`, () => mutate(`/api/control-action/schedules/${item.id}`, 'DELETE'), ['schedules']); if (result === undefined) throw new Error('Không thể xóa lịch'); } })} /></Space> },
          ]} />
        </Card>

        <Card id="media" className="dashboard-row resource-card" title={<SectionTitle title="Thư viện nội dung" description="Quản lý media và chuyển đến khu vực soạn chiến dịch." />}>
          <Row gutter={[18, 18]} className="composer-grid">
            <Col xs={24} xl={16}>
              <div className="composer-panel">
                <span className="summary-icon"><Icon name="media" size={28} /></span>
                <Typography.Title level={4} style={{ margin: 0 }}>Nội dung cho chiến dịch</Typography.Title>
                <Typography.Paragraph type="secondary" style={{ margin: 0 }}>Tải ảnh và video vào thư viện để quản lý tập trung. Đăng bài vào nhóm được thực hiện trong khu vực Facebook, nơi bạn chọn profile, nhóm đích và duyệt nội dung trước khi chạy.</Typography.Paragraph>
                <Alert type="info" showIcon title="Hiện tại chiến dịch nhóm hỗ trợ bài chữ." description="Đính kèm media và đăng trực tiếp lên trang cá nhân chưa được hỗ trợ." />
                <Flex><Button type="primary" icon={<Icon name="arrow" />} onClick={() => navigate('facebook')}>Soạn bài nhóm Facebook</Button></Flex>
              </div>
            </Col>
            <Col xs={24} xl={8}>
              <div className="media-library">
                <Flex justify="space-between" align="center"><div><strong>Thư viện media</strong><small>{(media.data ?? []).length} tệp đã tải lên</small></div><Upload {...uploadProps} disabled={!canOperate}><Button icon={<Icon name="upload" />} disabled={!canOperate}>Tải lên</Button></Upload></Flex>
                {(media.data ?? []).length ? (media.data ?? []).slice(0, 8).map((asset) => (
                  <div className="media-item" key={asset.id}><span>{asset.contentType.startsWith('video/') ? '▶' : '▧'}</span><div><strong>{asset.fileName}</strong><small>{asset.contentType} · {formatBytes(asset.sizeBytes)}</small></div>{statusTag(asset.status)}</div>
                )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có media" />}
              </div>
            </Col>
          </Row>
        </Card>

        <Card id="tasks" className="dashboard-row resource-card" title={<SectionTitle title="Tác vụ gần đây" description="Theo dõi thực thi và các tác vụ cần xử lý." />} extra={<Select aria-label="Lọc trạng thái tác vụ" className="status-filter" value={taskStatus} onChange={setTaskStatus} options={['ALL', 'DRAFT', 'PAUSED', 'SCHEDULED', 'QUEUED', 'RUNNING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((value) => ({ value, label: value === 'ALL' ? 'Tất cả trạng thái' : STATUS_LABELS[value] }))} />}>
          <Table rowKey="id" loading={tasks.isLoading} dataSource={filteredTasks} pagination={{ pageSize: 10, hideOnSinglePage: true }} size="middle" scroll={{ x: 800 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có tác vụ phù hợp" /> }} columns={[
            { title: 'Tài khoản', render: (_: unknown, item: TaskItem) => item.account.username ?? item.account.id },
            { title: 'Tác vụ', dataIndex: 'action', render: (value: string) => ACTION_LABELS[value] ?? value },
            { title: 'Trạng thái', dataIndex: 'status', render: statusTag },
            { title: 'Phê duyệt', dataIndex: 'approvalStatus', render: (value: string) => STATUS_LABELS[value] ?? value },
            { title: 'Ngày tạo', render: (_: unknown, item: TaskItem) => new Date(item.createdAt).toLocaleString('vi-VN') },
            { title: 'Chi tiết', dataIndex: 'lastError', render: (value?: string) => <Typography.Text type="secondary">{value ?? '—'}</Typography.Text> },
            { title: 'Quyết định', width: 100, render: (_: unknown, item: TaskItem) => item.campaignId ? <Button type="link" onClick={() => navigate('facebook')}>Chiến dịch</Button> : item.approvalStatus === 'PENDING' ? <Space><ActionButton label="Duyệt" icon="approve" disabled={!canAdmin} onClick={() => void perform(`approve-${item.id}`, () => mutate(`/api/tasks/${item.id}/approve`), ['tasks'])} /><ActionButton label="Từ chối" icon="reject" danger disabled={!canAdmin} onClick={() => void perform(`reject-${item.id}`, () => mutate(`/api/tasks/${item.id}/reject`), ['tasks'])} /></Space> : null },
          ]} />
        </Card>
      </Layout.Content>
      </Layout>

      <Modal
        title={editingAccount ? 'Chỉnh sửa profile' : 'Thêm profile'}
        open={accountModalOpen}
        width={640}
        centered
        destroyOnHidden
        confirmLoading={busy === (editingAccount ? `account-edit-${editingAccount.id}` : 'account-create')}
        okText={editingAccount ? 'Lưu thay đổi' : 'Tạo profile'}
        okButtonProps={{ form: 'account-form', htmlType: 'submit' }}
        cancelText="Hủy"
        onCancel={() => { if (!busy) setAccountModalOpen(false); }}
      >
        <Form<AccountFormValue>
          id="account-form"
          key={editingAccount?.id ?? 'new-account'}
          initialValues={accountInitialValues}
          preserve={false}
          layout="vertical"
          onFinish={(values) => void submitAccount(values)}
          requiredMark
        >
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item name="platform" label="Nền tảng" rules={[{ required: true }]}>
                <Select options={['FACEBOOK', 'INSTAGRAM', 'X', 'TIKTOK'].map((value) => ({ value }))} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="label" label="Tên hiển thị" rules={[{ required: true, message: 'Nhập tên để nhận biết tài khoản' }, { max: 255 }]}>
                <Input placeholder="Ví dụ: Fanpage chính" autoFocus />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item name="externalId" label="External ID">
                <Input placeholder="Tùy chọn" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="proxyId" label="Proxy">
                <Select allowClear placeholder="Không dùng proxy" options={(proxies.data ?? []).map((proxy) => ({ value: proxy.id, label: `${proxy.name} · ${proxy.host}:${proxy.port.toString()}` }))} />
              </Form.Item>
            </Col>
          </Row>
          <Divider titlePlacement="start">Thông tin đăng nhập</Divider>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                name="login"
                label="Email / username / số điện thoại"
                dependencies={['password']}
                rules={[({ getFieldValue }) => ({
                  validator: async (_, value?: string) => {
                    if (Boolean(value) === Boolean(getFieldValue('password'))) return;
                    throw new Error('Tài khoản và mật khẩu phải được nhập cùng nhau');
                  },
                })]}
              >
                <Input autoComplete="username" placeholder="Không bắt buộc" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="password"
                label="Mật khẩu"
                dependencies={['login']}
                rules={[({ getFieldValue }) => ({
                  validator: async (_, value?: string) => {
                    if (Boolean(value) === Boolean(getFieldValue('login'))) return;
                    throw new Error('Tài khoản và mật khẩu phải được nhập cùng nhau');
                  },
                })]}
              >
                <Input.Password autoComplete="current-password" placeholder="Không bắt buộc" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="cookies"
            label="Cookie"
            extra="Có thể dùng chuỗi name=value; name2=value2 hoặc JSON array xuất từ trình duyệt."
          >
            <Input.TextArea rows={5} className="code-input" placeholder="Không bắt buộc · c_user=...; xs=..." />
          </Form.Item>
          <Alert type="info" showIcon title="Thứ tự đăng nhập: Cookie → tài khoản/mật khẩu → bạn tiếp tục thao tác thủ công nếu vẫn chưa đăng nhập được. Dữ liệu được mã hóa khi lưu." />
          {!editingAccount ? (
            <Form.Item name="openAfterCreate" valuePropName="checked" className="modal-checkbox">
              <Checkbox>Mở browser ngay sau khi tạo</Checkbox>
            </Form.Item>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title={editingProxy ? 'Chỉnh sửa proxy' : 'Thêm proxy'}
        open={proxyModalOpen}
        width={600}
        centered
        destroyOnHidden
        confirmLoading={busy === (editingProxy ? `proxy-edit-${editingProxy.id}` : 'proxy-create')}
        okText="Lưu proxy"
        okButtonProps={{ form: 'proxy-form', htmlType: 'submit' }}
        cancelText="Hủy"
        onCancel={() => { if (!busy) setProxyModalOpen(false); }}
      >
        <Form<ProxyFormValue>
          id="proxy-form"
          key={editingProxy?.id ?? 'new-proxy'}
          initialValues={proxyInitialValues}
          preserve={false}
          layout="vertical"
          onFinish={(values) => void submitProxy(values)}
          requiredMark
        >
          <Form.Item name="name" label="Tên proxy" rules={[{ required: true, message: 'Nhập tên proxy' }]}>
            <Input placeholder="Ví dụ: SG residential 01" autoFocus />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} sm={8}>
              <Form.Item name="protocol" label="Giao thức" rules={[{ required: true }]}>
                <Select options={['HTTP', 'HTTPS', 'SOCKS5'].map((value) => ({ value }))} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={10}>
              <Form.Item name="host" label="Host / IP" rules={[{ required: true, message: 'Nhập host proxy' }]}>
                <Input placeholder="proxy.example.com" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={6}>
              <Form.Item name="port" label="Port" rules={[{ required: true }]}>
                <InputNumber min={1} max={65_535} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={16} className="credential-row">
            <Col xs={24} sm={12}>
              <Form.Item
                name="username"
                label="Username"
                dependencies={['password']}
                rules={[({ getFieldValue }) => ({
                  validator: async (_, value?: string) => {
                    if (Boolean(value) === Boolean(getFieldValue('password'))) return;
                    throw new Error('Username và password phải được nhập cùng nhau');
                  },
                })]}
              >
                <Input autoComplete="off" placeholder="Không bắt buộc" />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item
                name="password"
                label="Password"
                dependencies={['username']}
                rules={[({ getFieldValue }) => ({
                  validator: async (_, value?: string) => {
                    if (Boolean(value) === Boolean(getFieldValue('username'))) return;
                    throw new Error('Username và password phải được nhập cùng nhau');
                  },
                })]}
              >
                <Input.Password autoComplete="current-password" placeholder="Không bắt buộc" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item noStyle shouldUpdate={(previous, current) => previous.protocol !== current.protocol}>
            {({ getFieldValue }) => getFieldValue('protocol') === 'SOCKS5' ? (
              <Alert
                className="inline-alert"
                type="warning"
                showIcon
                title="Playwright chỉ hỗ trợ SOCKS5 không có username/password. Hãy để trống hai trường xác thực hoặc dùng HTTP/HTTPS."
              />
            ) : null}
          </Form.Item>
          <Form.Item
            name="accountIds"
            label="Các profile sử dụng proxy này"
            extra="Có thể chọn nhiều profile. Nếu profile đang dùng proxy khác, hệ thống sẽ chuyển sang proxy này."
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Chọn một hoặc nhiều profile"
              options={accountRows.map((account) => ({
                value: account.id,
                label: `${account.platform} · ${account.username ?? account.id}${
                  account.proxyBinding?.proxy.id &&
                  account.proxyBinding.proxy.id !== editingProxy?.id
                    ? ` · đang dùng ${account.proxyBinding.proxy.name}`
                    : ''
                }`,
              }))}
            />
          </Form.Item>
          <Alert type="info" showIcon title="Để trống username và password nếu proxy không yêu cầu xác thực. Dữ liệu được mã hóa khi lưu." />
        </Form>
      </Modal>
    </Layout>
  );
}

function SectionTitle({ title, description }: { title: string; description: string }) {
  return <div className="section-title"><strong>{title}</strong><small>{description}</small></div>;
}

function loginFlow(profile?: Account['browserProfile']) {
  return (
    <span className="login-flow">
      {[
        profile?.hasCookies ? 'Cookie' : undefined,
        profile?.hasPassword ? 'Tài khoản' : undefined,
        'Thủ công',
      ].filter(Boolean).join(' → ')}
    </span>
  );
}

function statusTag(value: string) {
  const color = ['READY', 'HEALTHY', 'SUCCEEDED'].includes(value)
    ? 'green'
    : ['ERROR', 'FAILED', 'UNHEALTHY', 'CRASHED'].includes(value)
      ? 'red'
      : ['RUNNING', 'STARTING'].includes(value)
        ? 'blue'
        : 'default';
  return <Tag color={value === 'REQUIRES_ACTION' || value === 'LOGIN_REQUIRED' || value === 'CHALLENGED' ? 'orange' : color}>{STATUS_LABELS[value] ?? value}</Tag>;
}

function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 1_024) return `${bytes || 0} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
