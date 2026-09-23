'use client';

import { useQuery } from '@tanstack/react-query';
import { Button, Card, Flex, Input, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Icon, STATUS_LABELS } from '../../ui';
import { RemoteViewport } from '../remote-viewport';
import { useToast, useToastError, useToastNotice } from '../../toast';

interface LoginSession {
  id: string;
  status: string;
  expiresAt: string;
  accessUrl: string | null;
  accessExpiresAt: string | null;
  lastError?: string | null;
}

interface FrameMessage {
  type: 'frame';
  data: string;
  width: number;
  height: number;
  tabId?: string;
}
interface BrowserState { type: 'browserState'; activeTabId: string; tabs: Array<{ id: string; title: string; url: string }>; canGoBack: boolean; canGoForward: boolean }

async function getSession(id: string): Promise<LoginSession> {
  const response = await fetch(`/api/login-sessions/${encodeURIComponent(id)}`, {
    cache: 'no-store',
  });
  if (response.status === 401) {
    window.location.assign('/login');
    throw new Error('Bạn cần đăng nhập lại');
  }
  const payload = (await response.json().catch(() => ({}))) as LoginSession & {
    message?: string;
  };
  if (!response.ok) throw new Error(payload.message ?? 'Không thể tải phiên browser');
  return payload;
}

export default function LoginSessionPage() {
  const params = useParams<{ sessionId: string }>();
  const router = useRouter();
  const socketRef = useRef<WebSocket | null>(null);
  const latestAccessUrl = useRef<string | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [frame, setFrame] = useState<string>();
  const [connection, setConnection] = useState('waiting');
  const [text, setText] = useState('');
  const setActionError = useToastError();
  const toast = useToast();
  const [closing, setClosing] = useState(false);
  const [closeRequested, setCloseRequested] = useState(false);
  const closeRequestedRef = useRef(false);
  useEffect(() => { closeRequestedRef.current = false; setCloseRequested(false); }, [params.sessionId]);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [browserState, setBrowserState] = useState<BrowserState>();
  const [address, setAddress] = useState('');
  const addressFocused = useRef(false);
  const activeTab = useRef<string | undefined>(undefined);
  const shell = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === shell.current) await document.exitFullscreen();
      else await shell.current?.requestFullscreen();
    } catch { setActionError('Trình duyệt không cho phép toàn màn hình. Hãy thử mở trang trong Chrome/Edge.'); }
  };

  const session = useQuery({
    queryKey: ['login-session', params.sessionId],
    queryFn: () => getSession(params.sessionId),
    refetchInterval: (query) =>
      ['AUTHENTICATED', 'CLOSED', 'EXPIRED', 'CRASHED'].includes(
        query.state.data?.status ?? '',
      )
        ? false
        : 2_000,
  });

  latestAccessUrl.current = session.data?.accessUrl ?? null;
  const terminal = ['AUTHENTICATED', 'CLOSED', 'EXPIRED', 'CRASHED'].includes(session.data?.status ?? '');
  const stopping = closeRequested || closing || session.data?.status === 'CLOSING';
  useEffect(() => {
    if (terminal || stopping) toast.dismiss('browser-connection-error');
  }, [terminal, stopping, toast]);
  useToastNotice(session.error?.message ?? session.data?.lastError, 'browser-session-error', 'error', !session.isFetching);
  useToastNotice(terminal ? 'Phiên browser đã kết thúc. Bạn có thể mở phiên mới từ Profiles.' : undefined, 'browser-session-ended', 'info');
  const canConnect = Boolean(session.data?.accessUrl) && !terminal && !stopping;
  useToastNotice(!terminal && !stopping && ['error', 'disconnected'].includes(connection)
    ? 'Mất kết nối màn hình browser. Hệ thống sẽ thử kết nối lại.' : undefined,
    'browser-connection-error', 'error', terminal || stopping || connection === 'connected');

  useEffect(() => {
    if (!canConnect) return;
    const accessUrl = latestAccessUrl.current;
    if (!accessUrl) return;

    let disposed = false;
    const socket = new WebSocket(accessUrl);
    socketRef.current = socket;
    setConnection('connecting');
    socket.onopen = () => { if (!disposed && !closeRequestedRef.current) setConnection('connected'); };
    socket.onmessage = (event) => {
      if (disposed || closeRequestedRef.current) return;
      try {
        const payload = JSON.parse(String(event.data)) as FrameMessage | BrowserState | { type: string; activeTabId?: string; message?: string };
        if (payload.type === 'tabChanging') {
          activeTab.current = payload.activeTabId; setFrame(undefined);
        }
        if (payload.type === 'browserState') {
          const state = payload as BrowserState;
          if (activeTab.current && activeTab.current !== state.activeTabId) setFrame(undefined);
          activeTab.current = state.activeTabId;
          setBrowserState(state);
          if (!addressFocused.current) setAddress(state.tabs.find(tab => tab.id === state.activeTabId)?.url ?? '');
        }
        if (payload.type === 'commandError') setActionError(payload.message);
        if (payload.type === 'frame') {
          const incoming = payload as FrameMessage;
          if (!incoming.tabId || !activeTab.current || incoming.tabId === activeTab.current) {
            activeTab.current = incoming.tabId ?? activeTab.current;
            setFrame(`data:image/jpeg;base64,${incoming.data}`);
          }
        }
      } catch {
        setConnection('error');
      }
    };
    socket.onerror = () => { if (!disposed && !closeRequestedRef.current) setConnection('reconnecting'); };
    socket.onclose = (event) => {
      if (socketRef.current === socket) socketRef.current = null;
      if (disposed) return;
      if (closeRequestedRef.current || (event.code === 1000 && event.reason === 'Session closed')) {
        closeRequestedRef.current = true;
        setCloseRequested(true);
        setConnection('closed');
        void session.refetch();
        return;
      }
      // The socket can disappear before polling observes a close requested
      // from Profiles/another screen. Check status before warning/reconnecting.
      void session.refetch().then(result => {
        if (disposed || closeRequestedRef.current) return;
        if (['CLOSING', 'AUTHENTICATED', 'CLOSED', 'EXPIRED', 'CRASHED'].includes(result.data?.status ?? '')) {
          setConnection('closed');
          return;
        }
        setConnection('disconnected');
        reconnectTimer.current = setTimeout(() => {
          if (!disposed && !closeRequestedRef.current) setConnectionAttempt(value => value + 1);
        }, 1_000);
      });
    };

    return () => {
      disposed = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [canConnect, connectionAttempt, params.sessionId]);

  const send = useCallback((command: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ ...command, targetTabId: activeTab.current }));
    }
  }, []);
  const control = (command: object) => {
    setActionError(undefined);
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(command));
  };
  const connected = !terminal && !stopping && connection === 'connected';
  const navigate = () => {
    const value = address.trim();
    if (!value) return;
    try {
      const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      addressFocused.current = false;
      control({ type: 'navigate', url: url.href });
    } catch { setActionError('Nhập địa chỉ HTTP/HTTPS hợp lệ, không chứa username/password.'); }
  };

  const closeSession = async () => {
    closeRequestedRef.current = true;
    setCloseRequested(true);
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    setClosing(true);
    setActionError(undefined);
    try {
      const response = await fetch(
        `/api/login-sessions/${encodeURIComponent(params.sessionId)}${session.data?.status === 'CLOSING' ? '?force=true' : ''}`,
        { method: 'DELETE' },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? 'Không thể đóng browser');
      }
      socketRef.current?.close();
      await session.refetch();
      toast.success('Đã yêu cầu đóng browser');
      setClosing(false);
    } catch (caught) {
      closeRequestedRef.current = false;
      setCloseRequested(false);
      setActionError(caught instanceof Error ? caught.message : String(caught));
      setClosing(false);
    }
  };


  return (
    <main className="session-page">
      <Flex justify="space-between" align="center" wrap="wrap" gap={16}>
        <div>
          <Typography.Text className="eyebrow">PHIÊN TRÌNH DUYỆT</Typography.Text>
          <Typography.Title level={2}>Trình duyệt từ xa</Typography.Title>
          <Space wrap>
            <Tag color={statusColor(session.data?.status)}>
              {STATUS_LABELS[session.data?.status ?? ''] ?? 'Đang tải'}
            </Tag>
            <Tag color={connected ? 'green' : !stopping && connection === 'error' ? 'red' : 'default'}>
              {connectionLabel(terminal ? 'closed' : stopping ? 'closing' : connection)}
            </Tag>
            {session.data?.expiresAt ? (
              <Typography.Text type="secondary">
                Hết hạn {new Date(session.data.expiresAt).toLocaleTimeString('vi-VN')}
              </Typography.Text>
            ) : null}
          </Space>
        </div>
        <Space>
          <Button icon={<Icon name="back" />} onClick={() => router.push('/#accounts')}>Về Profiles</Button>
          <Button
            danger
            type="primary"
            aria-label={session.data?.status === 'CLOSING' ? 'Ép đóng browser' : 'Đóng browser'}
            loading={closing}
            onClick={() => void closeSession()}
            disabled={!session.data || terminal}
          >
            {session.data?.status === 'CLOSING' ? 'Ép đóng browser' : 'Đóng browser'}
          </Button>
        </Space>
      </Flex>


      <div ref={shell} className={`remote-shell${fullscreen ? ' is-fullscreen' : ''}`}>
      <Card className="browser-card" styles={{ body: { padding: 0 } }}>
        <div className="browser-tabs-bar">
          <div className="browser-tabs" role="tablist" aria-label="Các tab trình duyệt">
            {(browserState?.tabs ?? []).map(tab => <div className={`browser-tab${tab.id === browserState?.activeTabId ? ' is-active' : ''}`} key={tab.id}>
              <button role="tab" aria-selected={tab.id === browserState?.activeTabId} disabled={!connected} title={tab.url} onClick={() => control({ type: 'selectTab', tabId: tab.id })}><Icon name="open" size={14} /><span>{tab.title || (tab.url === 'about:blank' ? 'Tab mới' : tab.url)}</span></button>
              <button className="browser-tab-close" aria-label={`Đóng tab ${tab.title || 'Tab mới'}`} disabled={!connected} onClick={() => control({ type: 'closeTab', tabId: tab.id })}><Icon name="close" size={13} /></button>
            </div>)}
            {!browserState?.tabs.length ? <span className="browser-tabs-placeholder">Đang kết nối trình duyệt…</span> : null}
          </div>
          <Tooltip title="Mở tab mới"><Button type="text" aria-label="Mở tab mới" icon={<Icon name="plus" />} disabled={!connected || (browserState?.tabs.length ?? 0) >= 20} onClick={() => control({ type: 'newTab' })} /></Tooltip>
          <Tooltip title={fullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}><Button type="text" aria-label={fullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'} icon={<Icon name={fullscreen ? 'collapse' : 'expand'} />} onClick={() => void toggleFullscreen()} /></Tooltip>
        </div>
        <div className="browser-toolbar">
          <Tooltip title="Quay lại"><Button type="text" aria-label="Quay lại trang trước" icon={<Icon name="back" />} disabled={!connected || !browserState?.canGoBack} onClick={() => control({ type: 'navigation', action: 'back' })} /></Tooltip>
          <Tooltip title="Tiến tới"><Button type="text" aria-label="Tiến tới trang sau" icon={<Icon name="arrow" />} disabled={!connected || !browserState?.canGoForward} onClick={() => control({ type: 'navigation', action: 'forward' })} /></Tooltip>
          <Tooltip title="Tải lại trang"><Button type="text" aria-label="Tải lại trang" icon={<Icon name="refresh" />} disabled={!connected} onClick={() => control({ type: 'navigation', action: 'reload' })} /></Tooltip>
          <form className="browser-url-form" onSubmit={event => { event.preventDefault(); navigate(); }}>
            <Input aria-label="Địa chỉ trang web" value={address === 'about:blank' ? '' : address} placeholder="Nhập địa chỉ trang web…" disabled={!connected} onFocus={() => { addressFocused.current = true; }} onBlur={() => { addressFocused.current = false; }} onChange={event => setAddress(event.target.value)} suffix={<button type="submit" className="browser-go" aria-label="Đi đến địa chỉ" disabled={!connected}><Icon name="arrow" size={16} /></button>} />
          </form>
          <Tooltip title="Kết nối lại màn hình"><Button aria-label="Kết nối lại màn hình" type="text" icon={<Icon name="test" />} onClick={() => setConnectionAttempt(value => value + 1)} disabled={terminal || stopping} /></Tooltip>
        </div>
        <RemoteViewport enabled={connected && Boolean(frame)} send={send}>
          {terminal ? <div className="browser-loading"><Icon name="close" size={32} /><strong>Phiên trình duyệt đã kết thúc</strong><small>Mở phiên mới từ Profiles để tiếp tục.</small></div> : session.error ? <div className="browser-loading"><strong>Không thể tải phiên trình duyệt</strong><small>Kiểm tra kết nối hoặc quay về Profiles.</small></div> : frame ? (
            <img src={frame} alt="Khung hình browser trực tiếp" draggable={false} />
          ) : (
            <div className="browser-loading">
              <Spin size="large" />
              <strong>{session.data?.status === 'STARTING' ? 'Đang khởi động Chromium...' : 'Đang chờ khung hình đầu tiên...'}</strong>
              <small>Phiên có thể cần vài giây để khôi phục profile.</small>
            </div>
          )}
        </RemoteViewport>
        <div className="remote-actions">
        <div className="remote-actions-heading"><strong>Điều khiển nhanh</strong><span>Cuộn hoặc kéo trực tiếp trên màn hình · Bấm vào trang để dùng bàn phím</span></div>
        <Flex gap={8} className="remote-input" wrap="wrap">
          <Input
            aria-label="Nội dung gửi vào trình duyệt"
            value={text}
            disabled={!connected}
            placeholder="Nhập nội dung rồi gửi vào trường đang focus trong browser"
            onChange={(event) => setText(event.target.value)}
            onPressEnter={() => {
              if (!text) return;
              send({ type: 'text', text });
              setText('');
            }}
          />
          <Button disabled={!connected || !text} onClick={() => {
            send({ type: 'text', text });
            setText('');
          }}>Gửi</Button>
          {(['Tab', 'Enter', 'Backspace', 'Escape'] as const).map((key) => (
            <Button key={key} disabled={!connected} onClick={() => send({ type: 'key', key })}>{key}</Button>
          ))}
          <Button
            disabled={!connected}
            onClick={() => send({ type: 'key', key: 'Tab', shift: true })}
          >
            Shift + Tab
          </Button>
        </Flex>
        </div>
      </Card>
      </div>
    </main>
  );
}

function statusColor(status?: string) {
  if (status === 'AUTHENTICATED') return 'green';
  if (status === 'RUNNING') return 'blue';
  if (status === 'CRASHED') return 'red';
  if (status === 'EXPIRED') return 'orange';
  if (status === 'CLOSED') return 'default';
  return 'cyan';
}

function connectionLabel(status: string) {
  return {
    waiting: 'Đang chờ browser',
    connecting: 'Đang kết nối',
    connected: 'Đã kết nối',
    disconnected: 'Mất kết nối',
    error: 'Lỗi kết nối',
    reconnecting: 'Đang kiểm tra kết nối',
    closing: 'Đang đóng browser',
    closed: 'Màn hình đã đóng',
  }[status] ?? status;
}
