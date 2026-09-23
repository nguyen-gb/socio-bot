'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider, theme } from 'antd';
import viVN from 'antd/locale/vi_VN';
import { useEffect, useState, type PropsWithChildren } from 'react';

function toastContainer(): HTMLElement {
  let host = document.getElementById('socio-toast-root');
  if (!host) { host = document.createElement('div'); host.id = 'socio-toast-root'; }
  const parent = document.fullscreenElement ?? document.body;
  if (host.parentElement !== parent) parent.appendChild(host);
  return host;
}

export function Providers({ children }: PropsWithChildren) {
  useEffect(() => {
    const relocate = () => { if (document.getElementById('socio-toast-root')) toastContainer(); };
    document.addEventListener('fullscreenchange', relocate);
    return () => document.removeEventListener('fullscreenchange', relocate);
  }, []);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchInterval: 15_000,
            retry: 1,
            staleTime: 5_000,
          },
        },
      }),
  );

  return (
    <ConfigProvider
      locale={viVN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#217a67',
          colorInfo: '#217a67',
          colorSuccess: '#27845f',
          colorWarning: '#d97706',
          colorError: '#dc2626',
          colorBgBase: '#ffffff',
          colorBgLayout: '#f6f7f5',
          colorBgContainer: '#ffffff',
          colorBorder: '#dfe3df',
          colorText: '#252b28',
          colorTextSecondary: '#717972',
          borderRadius: 8,
          controlHeight: 40,
          fontSize: 14,
          fontFamily: '\"Segoe UI Variable\", \"Segoe UI\", ui-sans-serif, system-ui, sans-serif',
        },
        components: {
          Button: { fontWeight: 500, primaryShadow: 'none' },
          Card: { headerHeight: 64 },
          Table: { headerBg: '#f7f8f6', headerColor: '#737a73', cellPaddingBlock: 16 },
          Modal: { contentBg: '#ffffff', headerBg: '#ffffff' },
        },
      }}
    >
      <App notification={{ placement: 'topRight', maxCount: 4, top: 20, getContainer: toastContainer }}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </App>
    </ConfigProvider>
  );
}
