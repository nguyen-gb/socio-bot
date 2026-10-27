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
  Drawer,
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
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import FacebookWorkspace from './facebook-workspace';
import TikTokWorkspace from './tiktok-workspace';
import { ActionButton, PageSectionTitle, StatusTag, tablePagination } from './admin-ui';
import { Icon, STATUS_LABELS, ACTION_LABELS } from './ui';
import { useToast, useToastError, useToastNotice } from './toast';
import { ContextNote as Alert } from './context-note';

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
type DashboardView = 'overview' | 'accounts' | 'proxies' | 'facebook' | 'tiktok' | 'schedules' | 'tasks';

const NAV_ITEMS: Array<{
  key: DashboardView;
  label: string;
  description: string;
}> = [
  { key: 'overview', label: 'Tổng quan', description: 'Tình hình vận hành' },
  { key: 'accounts', label: 'Profiles', description: 'Tài khoản & trình duyệt' },
  { key: 'proxies', label: 'Proxy', description: 'Kết nối & phân bổ' },
  { key: 'facebook', label: 'Facebook', description: 'Nhóm & chiến dịch' },
  { key: 'tiktok', label: 'TikTok', description: 'Search & hành động có duyệt' },
  { key: 'schedules', label: 'Lịch chạy', description: 'Tự động hóa định kỳ' },
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
  browserProfile?: { hasCookies?: boolean; hasPassword?: boolean; fingerprint?: BrowserFingerprintConfig };
  proxyBinding?: { proxy: { id: string; name: string; status: string } };
}

interface BrowserFingerprintConfig {
  mode?: 'auto' | 'native' | 'custom';
  localeMode?: 'configured' | 'native';
  locale: string;
  languages: string[];
  timezoneId: string;
}

interface FingerprintFormValue {
  mode: 'auto' | 'native';
  configureLocale: boolean;
  locale: string;
  languages: string[];
  timezoneId: string;
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
  runs?: Array<{ startedAt?: string; completedAt?: string; result?: { groupCount?: number; complete?: boolean; [key: string]: unknown } }>;
  account: Account;
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
  fingerprint: FingerprintFormValue;
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

const fingerprintPresets: Record<string, { languages: string[]; timezones: string[] }> = {
  'vi-VN': { languages: ['vi-VN', 'vi'], timezones: ['Asia/Ho_Chi_Minh'] },
  'en-US': { languages: ['en-US', 'en'], timezones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'] },
  'en-GB': { languages: ['en-GB', 'en'], timezones: ['Europe/London'] },
  'ja-JP': { languages: ['ja-JP', 'ja'], timezones: ['Asia/Tokyo'] },
  'ko-KR': { languages: ['ko-KR', 'ko'], timezones: ['Asia/Seoul'] },
  'th-TH': { languages: ['th-TH', 'th'], timezones: ['Asia/Bangkok'] },
  'id-ID': { languages: ['id-ID', 'id'], timezones: ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura'] },
  'zh-CN': { languages: ['zh-CN', 'zh'], timezones: ['Asia/Shanghai'] },
  'zh-TW': { languages: ['zh-TW', 'zh'], timezones: ['Asia/Taipei'] },
  'de-DE': { languages: ['de-DE', 'de'], timezones: ['Europe/Berlin'] },
  'fr-FR': { languages: ['fr-FR', 'fr'], timezones: ['Europe/Paris'] },
  'es-ES': { languages: ['es-ES', 'es'], timezones: ['Europe/Madrid'] },
};

function fingerprintPreset(locale: string) {
  const base = locale.split('-')[0] ?? locale;
  return fingerprintPresets[locale] ?? { languages: [locale, base], timezones: ['UTC'] };
}

function defaultFingerprintForm(locale = 'vi-VN'): FingerprintFormValue {
  const preset = fingerprintPreset(locale);
  return {
    mode: 'auto',
    configureLocale: true,
    locale,
    languages: [...preset.languages],
    timezoneId: preset.timezones[0] ?? 'UTC',
  };
}

function fingerprintToForm(value?: BrowserFingerprintConfig): FingerprintFormValue {
  if (!value) return defaultFingerprintForm();
  const preset = fingerprintPreset(value.locale);
  return {
    mode: value.mode === 'native' ? 'native' : 'auto',
    configureLocale: value.localeMode !== 'native',
    locale: value.locale,
    languages: value.languages.filter((language) => preset.languages.includes(language)).length
      ? value.languages.filter((language) => preset.languages.includes(language))
      : [...preset.languages],
    timezoneId: preset.timezones.includes(value.timezoneId) ? value.timezoneId : preset.timezones[0] ?? 'UTC',
  };
}

function normalizeFingerprintForm(value: Partial<FingerprintFormValue>): BrowserFingerprintConfig {
  const defaults = defaultFingerprintForm(value.locale ?? 'vi-VN');
  const merged = { ...defaults, ...value };
  const preset = fingerprintPreset(merged.locale);
  const languages = merged.languages.filter((language) => preset.languages.includes(language));
  return {
    mode: merged.mode,
    localeMode: merged.configureLocale ? 'configured' : 'native',
    locale: merged.locale,
    languages: languages.length ? languages : [...preset.languages],
    timezoneId: preset.timezones.includes(merged.timezoneId) ? merged.timezoneId : preset.timezones[0] ?? 'UTC',
  };
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

function formatProxyLatency(latencyMs?: number | null) {
  if (latencyMs == null) return 'Chưa kiểm tra';
  if (latencyMs >= 1000) return `${(latencyMs / 1000).toFixed(latencyMs >= 10_000 ? 1 : 2)} s`;
  return `${latencyMs.toLocaleString('vi-VN')} ms`;
}

export default function DashboardClient() {
  const router = useRouter();
  const screens = Grid.useBreakpoint();
  const cache = useQueryClient();
  const { modal } = AntApp.useApp();
  const message = useToast();
  const [accountForm] = Form.useForm<AccountFormValue>();
  const [proxyForm] = Form.useForm<ProxyFormValue>();
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [proxyModalOpen, setProxyModalOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [accountInitialValues, setAccountInitialValues] = useState<AccountFormValue>({
    platform: 'FACEBOOK',
    label: '',
    openAfterCreate: true,
    fingerprint: defaultFingerprintForm(),
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
  const [taskAction, setTaskAction] = useState<string>('ALL');
  const [taskAccount, setTaskAccount] = useState<string>('ALL');
  const [taskDateRange, setTaskDateRange] = useState<string>('ALL');
  const [selectedTask, setSelectedTask] = useState<TaskItem>();
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
    () => {
      const cutoff = taskDateRange === '7D'
        ? Date.now() - 7 * 24 * 60 * 60 * 1000
        : taskDateRange === '30D'
          ? Date.now() - 30 * 24 * 60 * 60 * 1000
          : undefined;
      return (tasks.data ?? []).filter((task) =>
        (taskStatus === 'ALL' || task.status === taskStatus)
        && (taskAction === 'ALL' || task.action === taskAction)
        && (taskAccount === 'ALL' || task.account.id === taskAccount)
        && (cutoff === undefined || new Date(task.createdAt).getTime() >= cutoff),
      );
    },
    [taskAccount, taskAction, taskDateRange, taskStatus, tasks.data],
  );
  const currentView = NAV_ITEMS.find((item) => item.key === activeView)!;
  const setupProgress = [accountRows.length > 0, accountRows.some(account => account.status === 'READY'), (tasks.data ?? []).length > 0]
    .filter(Boolean).length;
  const taskActionOptions = useMemo(
    () => [...new Set((tasks.data ?? []).map((task) => task.action))].map((value) => ({ value, label: ACTION_LABELS[value] ?? value })),
    [tasks.data],
  );
  const taskAccountOptions = useMemo(
    () => [...new Map((tasks.data ?? []).map((task) => [task.account.id, task.account.username ?? task.account.id]))]
      .map(([value, label]) => ({ value, label })),
    [tasks.data],
  );
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
      const errorMessageText = caught instanceof Error ? caught.message : String(caught);
      // Let the modal's loading transition finish before showing the toast so the
      // dialog action is immediately usable again after a failed save.
      window.setTimeout(() => setError(errorMessageText), 250);
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
      fingerprint: defaultFingerprintForm(),
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
      fingerprint: fingerprintToForm(account.browserProfile?.fingerprint),
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
      fingerprint: normalizeFingerprintForm(values.fingerprint),
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
      content: `${account.username ?? account.id} và toàn bộ tác vụ/lịch của profile sẽ bị xóa. Hãy đóng browser trước khi tiếp tục.`,
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

  const createSchedule = async () => {
    const account = accountRows.find((item) => item.id === scheduleAccount);
    if (!account) return;
    const result = await perform('schedule-create', () => mutate('/api/control/schedules', 'POST', {
      name: scheduleName,
      cronExpression: scheduleCron,
      timezone: scheduleTimezone,
      action: { platform: account.platform, accountId: account.id, action: scheduleAction, payload: {} },
    }), ['schedules']);
    if (result !== undefined) {
      setScheduleModalOpen(false);
      setScheduleName('');
    }
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

  const queryError =
    accounts.error?.message ??
    proxies.error?.message ??
    sessions.error?.message ??
    schedules.error?.message ?? tasks.error?.message ?? me.error?.message;
  useToastNotice(queryError, 'dashboard-load-error', 'error',
    ![accounts, proxies, sessions, schedules, tasks, me].some(query => query.isFetching));

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
        <nav className="nav" aria-label="Điều hướng chính">
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
            <span className={`live-indicator ${queryError ? 'offline' : ''}`} role="status" aria-live="polite"><i />{queryError ? 'Lỗi tải dữ liệu' : accounts.isLoading ? 'Đang đồng bộ' : 'Đã đồng bộ'}</span>
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
        {queryError ? <Alert
          className="connection-alert"
          title="Một số dữ liệu chưa tải được"
          description={`Chi tiết: ${queryError}`}
          action={<Button size="small" onClick={() => void cache.invalidateQueries()}>Thử lại</Button>}
        /> : null}


        {activeView === 'facebook' ? <div id="facebook" className="dashboard-row"><FacebookWorkspace accounts={accountRows} canOperate={canOperate} canAdmin={canAdmin} onNavigateProfiles={() => navigate('accounts')} /></div> : null}
        {activeView === 'tiktok' ? <div id="tiktok" className="dashboard-row"><TikTokWorkspace accounts={accountRows} canOperate={canOperate} canAdmin={canAdmin} onNavigateProfiles={() => navigate('accounts')} /></div> : null}
        {activeView === 'overview' && setupProgress < 3 ? <div className="overview-welcome"><div><span className="welcome-kicker">VẬN HÀNH ĐƠN GIẢN HƠN</span><h3>Mọi tài khoản. Một không gian.</h3><p>Hoàn tất vài bước để bắt đầu theo dõi profile, kết nối và chiến dịch từ một nơi.</p><Button onClick={() => navigate('facebook')} icon={<Icon name="arrow" />}>Đến chiến dịch Facebook</Button></div></div> : null}
        {activeView === 'overview' ? <>
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
              title={<PageSectionTitle title="Browser đang hoạt động" description="Phiên thao tác thủ công và browser đang chạy tác vụ" />}
              extra={<Button type="link" onClick={() => navigate('accounts')}>Xem profiles →</Button>}
            >
              {activeSessions.length ? (
                <div className="session-list">
                  {activeSessions.slice(0, 5).map((session) => (
                    <div className="session-item" key={session.id}>
                      <span className="session-platform">{session.account.platform.slice(0, 1)}</span>
                      <div><strong>{session.account.username ?? session.account.id}</strong><small>{session.mode === 'AUTOMATION' ? 'Đang chạy tác vụ' : session.account.platform}{session.processId ? ` · PID ${session.processId}` : ''} · hết hạn {new Date(session.expiresAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</small></div>
                      <StatusTag value={session.status} />
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
            {setupProgress === 3 ? <div className="overview-ready-strip"><span className="ready-check">✓</span><div><strong>Workspace đã sẵn sàng</strong><small>Profile, kết nối và tác vụ đã được thiết lập.</small></div><Button type="link" onClick={() => navigate('facebook')}>Đến chiến dịch →</Button></div> : <Card className="overview-card setup-card" title={<PageSectionTitle title="Bắt đầu cùng Socio" description="Ba bước để chạy chiến dịch đầu tiên" />}>
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
            </Card>}
          </Col>
        </Row>
        </> : null}

        {activeView === 'accounts' ? <Card
          id="accounts"
          className="dashboard-row resource-card"
          title={<PageSectionTitle title="Danh sách profiles" description={`${accountRows.length} profile · mỗi profile có dữ liệu trình duyệt riêng`} />}
          extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm profile" allowClear value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} placeholder="Tìm profile hoặc proxy..." /><Select aria-label="Lọc trạng thái profile" className="status-filter" value={accountStatus} onChange={setAccountStatus} options={['ALL', 'READY', 'LOGIN_REQUIRED', 'CHALLENGED', 'RUNNING', 'ERROR'].map(value => ({ value, label: value === 'ALL' ? 'Mọi trạng thái' : STATUS_LABELS[value] }))} /><Button icon={<Icon name="plus" />} type="primary" disabled={!canAdmin} onClick={openAccountModal}>Thêm profile</Button></Space>}
        >
          <Table
            rowKey="id"
            loading={accounts.isLoading}
            dataSource={filteredAccounts}
            pagination={tablePagination('profile')}
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
              { title: 'Trạng thái', dataIndex: 'status', render: (value: string) => <StatusTag value={value} /> },
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
        </Card> : null}

        {activeView === 'proxies' ? <Card
          id="proxies"
          className="dashboard-row resource-card"
          title={<PageSectionTitle title="Hạ tầng proxy" description={`${(proxies.data ?? []).length} proxy · có thể phân bổ cho nhiều profile`} />}
          extra={<Space className="card-toolbar"><Input.Search aria-label="Tìm proxy" allowClear value={proxySearch} onChange={(event) => setProxySearch(event.target.value)} placeholder="Tìm tên hoặc địa chỉ proxy..." /><Button icon={<Icon name="plus" />} type="primary" disabled={!canAdmin} onClick={openProxyModal}>Thêm proxy</Button></Space>}
        >
          <Table
            rowKey="id"
            loading={proxies.isLoading}
            dataSource={filteredProxies}
            pagination={tablePagination('proxy')}
            size="middle"
            scroll={{ x: 1075 }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={proxySearch ? 'Không tìm thấy proxy phù hợp' : 'Chưa có proxy'} /> }}
            columns={[
              { title: 'Tên', width: 150, dataIndex: 'name', render: (value: string) => <strong>{value}</strong> },
              { title: 'Địa chỉ', width: 290, render: (_: unknown, item: ProxyItem) => <code>{`${item.protocol.toLowerCase()}://${item.host}:${item.port.toString()}`}</code> },
              { title: 'Xác thực', width: 105, render: (_: unknown, item: ProxyItem) => item.hasAuthentication ? <Tag>Có xác thực</Tag> : <span className="muted">Không</span> },
              { title: 'Trạng thái', width: 125, dataIndex: 'status', render: (value: string) => <StatusTag value={value} labels={{ HEALTHY: 'Kết nối được', UNHEALTHY: 'Không kết nối', UNKNOWN: 'Chưa kiểm tra' }} /> },
              { title: 'Chất lượng', width: 105, render: (_: unknown, item: ProxyItem) => <span className={item.latencyMs != null && item.latencyMs >= 1500 ? 'proxy-latency proxy-latency-warning' : 'proxy-latency'}>{formatProxyLatency(item.latencyMs)}</span> },
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
        </Card> : null}

        {activeView === 'schedules' ? <Card id="schedules" className="dashboard-row resource-card" title={<PageSectionTitle title="Lịch chạy" description="Kiểm tra phiên và profile theo lịch định kỳ." />} extra={<Button type="primary" icon={<Icon name="plus" />} disabled={!canOperate} onClick={() => { setError(undefined); setScheduleModalOpen(true); }}>Tạo lịch</Button>}>
          <Modal title="Tạo lịch tự động" open={scheduleModalOpen} onCancel={() => { if (!busy) setScheduleModalOpen(false); }} width={720} footer={<Button className="schedule-submit" type="primary" disabled={!canOperate || !scheduleName.trim() || !scheduleAccount} loading={busy === 'schedule-create'} onClick={() => void createSchedule()}>Tạo lịch</Button>}>
          <div className="form-row">
            <div className="compact-field"><span>Tên lịch</span><Input aria-label="Tên lịch" value={scheduleName} placeholder="Ví dụ: Kiểm tra mỗi giờ" onChange={(event) => setScheduleName(event.target.value)} /></div>
            <div className="compact-field"><span>Profile</span><Select aria-label="Profile cho lịch" value={scheduleAccount} placeholder="Chọn profile" onChange={setScheduleAccount} options={accountRows.map((account) => ({ value: account.id, label: `${account.platform} · ${account.username ?? account.id}` }))} /></div>
            <div className="compact-field"><span>Biểu thức cron</span><Input aria-label="Biểu thức cron" value={scheduleCron} placeholder="0 * * * *" onChange={(event) => setScheduleCron(event.target.value)} /></div>
            <div className="compact-field"><span>Múi giờ</span><Input aria-label="Múi giờ" value={scheduleTimezone} placeholder="Asia/Bangkok" onChange={(event) => setScheduleTimezone(event.target.value)} /></div>
            <div className="compact-field"><span>Tác vụ</span><Select aria-label="Tác vụ cho lịch" value={scheduleAction} onChange={setScheduleAction} options={['HEALTH_CHECK', 'GET_PROFILE'].map((value) => ({ value, label: ACTION_LABELS[value] }))} /></div>
          </div>
          </Modal>
          <Table size="middle" rowKey="id" dataSource={schedules.data ?? []} pagination={tablePagination('lịch')} scroll={{ x: 900 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có lịch chạy nào"><Button type="primary" icon={<Icon name="plus" />} disabled={!canOperate} onClick={() => { setError(undefined); setScheduleModalOpen(true); }}>Tạo lịch chạy</Button></Empty> }} columns={[
            { title: 'Tên', dataIndex: 'name' },
            { title: 'Tài khoản', render: (_: unknown, item: ScheduleItem) => item.account.username ?? item.account.id },
            { title: 'Cron', render: (_: unknown, item: ScheduleItem) => <code>{`${item.cronExpression} · ${item.timezone}`}</code> },
            { title: 'Tác vụ', dataIndex: 'action', render: (value: string) => ACTION_LABELS[value] ?? value },
            { title: 'Hoạt động', render: (_: unknown, item: ScheduleItem) => <Tag color={item.enabled ? 'green' : 'default'}>{item.enabled ? 'BẬT' : 'TẮT'}</Tag> },
            { title: 'Lần kế tiếp', render: (_: unknown, item: ScheduleItem) => item.nextRunAt ? new Date(item.nextRunAt).toLocaleString('vi-VN') : '-' },
            { title: 'Thao tác', width: 120, render: (_: unknown, item: ScheduleItem) => <Space><ActionButton label={item.enabled ? 'Tắt lịch' : 'Bật lịch'} icon={item.enabled ? 'pause' : 'play'} disabled={!canOperate} onClick={() => void perform(`toggle-${item.id}`, () => mutate(`/api/control-action/schedules/${item.id}/${item.enabled ? 'disable' : 'enable'}`), ['schedules'])} /><ActionButton label="Chạy ngay" icon="play" disabled={!canOperate} onClick={() => void perform(`trigger-${item.id}`, () => mutate(`/api/control-action/schedules/${item.id}/trigger`), ['tasks'])} /><ActionButton label="Xóa lịch" icon="delete" danger disabled={!canAdmin} onClick={() => modal.confirm({ title: `Xóa lịch “${item.name}”?`, content: 'Lịch sẽ không chạy lại sau khi bị xóa.', okText: 'Xóa lịch', cancelText: 'Giữ lại', okButtonProps: { danger: true }, onOk: async () => { const result = await perform(`delete-${item.id}`, () => mutate(`/api/control-action/schedules/${item.id}`, 'DELETE'), ['schedules']); if (result === undefined) throw new Error('Không thể xóa lịch'); } })} /></Space> },
          ]} />
        </Card> : null}

        {activeView === 'tasks' ? <Card id="tasks" className="dashboard-row resource-card" title={<PageSectionTitle title="Tác vụ gần đây" description="Theo dõi thực thi và các tác vụ cần xử lý." />} extra={<Space className="card-toolbar"><Select aria-label="Lọc trạng thái tác vụ" className="status-filter" value={taskStatus} onChange={setTaskStatus} options={['ALL', 'DRAFT', 'PAUSED', 'SCHEDULED', 'QUEUED', 'RUNNING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((value) => ({ value, label: value === 'ALL' ? 'Tất cả trạng thái' : STATUS_LABELS[value] }))} /><Select aria-label="Lọc tác vụ theo loại" className="status-filter" value={taskAction} onChange={setTaskAction} options={[{ value: 'ALL', label: 'Mọi loại tác vụ' }, ...taskActionOptions]} /><Select aria-label="Lọc tác vụ theo profile" className="status-filter" value={taskAccount} onChange={setTaskAccount} options={[{ value: 'ALL', label: 'Mọi profile' }, ...taskAccountOptions]} /><Select aria-label="Lọc tác vụ theo thời gian" className="status-filter" value={taskDateRange} onChange={setTaskDateRange} options={[{ value: 'ALL', label: 'Mọi thời gian' }, { value: '7D', label: '7 ngày qua' }, { value: '30D', label: '30 ngày qua' }]} /></Space>}>
          <Table className="tasks-table" rowKey="id" loading={tasks.isLoading} dataSource={filteredTasks} pagination={tablePagination('tác vụ')} size="middle" scroll={{ x: 1_270 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có tác vụ phù hợp" /> }} columns={[
            { title: 'Tài khoản', width: 160, ellipsis: true, render: (_: unknown, item: TaskItem) => item.account.username ?? item.account.id },
            { title: 'Tác vụ', width: 210, ellipsis: true, dataIndex: 'action', render: (value: string) => ACTION_LABELS[value] ?? value },
            { title: 'Trạng thái', width: 120, dataIndex: 'status', render: (value: string) => <StatusTag value={value} /> },
            { title: 'Phê duyệt', width: 110, dataIndex: 'approvalStatus', render: (value: string) => STATUS_LABELS[value] ?? value },
            { title: 'Ngày tạo', width: 150, render: (_: unknown, item: TaskItem) => new Date(item.createdAt).toLocaleString('vi-VN') },
            { title: 'Chi tiết', width: 520, render: (_: unknown, item: TaskItem) => <div className="task-detail-cell">{item.action === 'SYNC_FACEBOOK_GROUPS' && typeof item.runs?.[0]?.result?.groupCount === 'number' ? <Typography.Text>Đã đồng bộ {item.runs[0].result.groupCount} nhóm{item.runs[0].result.complete === false ? ' · Chưa đọc hết danh sách' : ''}</Typography.Text> : null}{item.lastError ? <Typography.Text type="secondary" className="task-error" title={item.lastError}>{summarizeTaskError(item.lastError)}</Typography.Text> : item.action === 'SYNC_FACEBOOK_GROUPS' && item.runs?.[0]?.result?.complete ? <Typography.Text type="secondary">Đã quét hết danh sách nhóm Facebook tải được.</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>}<Space wrap>{!item.campaignId && item.approvalStatus === 'PENDING' ? <><ActionButton label="Duyệt" icon="approve" disabled={!canAdmin} onClick={() => void perform(`approve-${item.id}`, () => mutate(`/api/tasks/${item.id}/approve`), ['tasks'])} /><ActionButton label="Từ chối" icon="reject" danger disabled={!canAdmin} onClick={() => void perform(`reject-${item.id}`, () => mutate(`/api/tasks/${item.id}/reject`), ['tasks'])} /></> : null}<ActionButton label="Xem chi tiết tác vụ" icon="view" onClick={() => setSelectedTask(item)} /></Space></div> },
          ]} />
        </Card> : null}
      </Layout.Content>
      </Layout>

      <Drawer
        title={<PageSectionTitle title="Chi tiết tác vụ" description={selectedTask ? ACTION_LABELS[selectedTask.action] ?? selectedTask.action : 'Thông tin thực thi'} />}
        open={Boolean(selectedTask)}
        onClose={() => setSelectedTask(undefined)}
        size={520}
      >
        {selectedTask ? <Space orientation="vertical" size={18} className="task-drawer-content">
          <div className="task-drawer-grid">
            <div><span>Tài khoản</span><strong>{selectedTask.account.username ?? selectedTask.account.id}</strong></div>
            <div><span>Trạng thái</span><StatusTag value={selectedTask.status} /></div>
            <div><span>Phê duyệt</span><strong>{STATUS_LABELS[selectedTask.approvalStatus ?? ''] ?? selectedTask.approvalStatus ?? '—'}</strong></div>
            <div><span>Ngày tạo</span><strong>{new Date(selectedTask.createdAt).toLocaleString('vi-VN')}</strong></div>
          </div>
          {selectedTask.campaignId ? <Typography.Text type="secondary">Campaign: {selectedTask.campaignId}</Typography.Text> : null}
          <div>
            <Typography.Text strong>Kết quả / lỗi gần nhất</Typography.Text>
            {selectedTask.lastError ? <Typography.Paragraph className="task-drawer-error" copyable={{ text: selectedTask.lastError }}>{selectedTask.lastError}</Typography.Paragraph> : <Typography.Paragraph type="secondary">Chưa có lỗi được ghi nhận.</Typography.Paragraph>}
          </div>
          {selectedTask.runs?.[0] ? <div>
            <Typography.Text strong>Log lần chạy gần nhất</Typography.Text>
            <pre className="task-drawer-result">{JSON.stringify(selectedTask.runs[0].result ?? {}, null, 2)}</pre>
          </div> : null}
        </Space> : null}
      </Drawer>

      <Modal
        title={editingAccount ? 'Chỉnh sửa profile' : 'Thêm profile'}
        open={accountModalOpen}
        width={640}
        centered
        destroyOnHidden
        confirmLoading={busy === (editingAccount ? `account-edit-${editingAccount.id}` : 'account-create')}
        okText={editingAccount ? 'Lưu thay đổi' : 'Tạo profile'}
        okButtonProps={{ 'aria-label': editingAccount ? 'Lưu thay đổi' : 'Tạo profile' }}
        cancelText="Hủy"
        onOk={() => accountForm.validateFields().then((values) => submitAccount(values)).catch(() => undefined)}
        onCancel={() => { if (!busy) setAccountModalOpen(false); }}
      >
        <Form<AccountFormValue>
          id="account-form"
          key={editingAccount?.id ?? 'new-account'}
          form={accountForm}
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
          <Divider titlePlacement="start">Môi trường trình duyệt theo profile</Divider>
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item
                name={['fingerprint', 'mode']}
                label="Desktop bundle"
                getValueProps={(value: FingerprintFormValue['mode'] | undefined) => ({ checked: value !== 'native' })}
                getValueFromEvent={(checked: boolean) => (checked ? 'auto' : 'native')}
              >
                <Switch />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name={['fingerprint', 'configureLocale']} label="Locale / Languages / Timezone" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item noStyle dependencies={[[ 'fingerprint', 'locale' ], [ 'fingerprint', 'configureLocale' ]] as never}>
            {({ getFieldValue }) => {
              const locale = String(getFieldValue(['fingerprint', 'locale']) ?? 'vi-VN');
              const configureLocale = Boolean(getFieldValue(['fingerprint', 'configureLocale']) ?? true);
              const preset = fingerprintPreset(locale);
              return (
                <Row gutter={16}>
                  <Col xs={24} sm={8}>
                    <Form.Item name={['fingerprint', 'locale']} label="Locale" rules={[{ required: configureLocale }]}>
                      <Select
                        disabled={!configureLocale}
                        options={Object.keys(fingerprintPresets).map((value) => ({ value, label: value }))}
                        onChange={(nextLocale: string) => {
                          const next = fingerprintPreset(nextLocale);
                          accountForm.setFieldsValue({ fingerprint: { ...accountForm.getFieldValue('fingerprint'), locale: nextLocale, languages: [...next.languages], timezoneId: next.timezones[0] ?? 'UTC' } });
                        }}
                      />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={8}>
                    <Form.Item name={['fingerprint', 'languages']} label="Languages" rules={[{ required: configureLocale, type: 'array', min: 1 }]}>
                      <Select disabled={!configureLocale} mode="multiple" options={preset.languages.map((value) => ({ value, label: value }))} />
                    </Form.Item>
                  </Col>
                  <Col xs={24} sm={8}>
                    <Form.Item name={['fingerprint', 'timezoneId']} label="Timezone" rules={[{ required: configureLocale }]}>
                      <Select disabled={!configureLocale} options={preset.timezones.map((value) => ({ value, label: value }))} />
                    </Form.Item>
                  </Col>
                </Row>
              );
            }}
          </Form.Item>
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
        okButtonProps={{ 'aria-label': 'Lưu proxy' }}
        cancelText="Hủy"
        onOk={() => proxyForm.validateFields().then((values) => submitProxy(values)).catch(() => undefined)}
        onCancel={() => { if (!busy) setProxyModalOpen(false); }}
      >
        <Form<ProxyFormValue>
          id="proxy-form"
          form={proxyForm}
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

function summarizeTaskError(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 420 ? `${compact.slice(0, 417)}…` : compact;
}
