'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider } from 'antd';
import viVN from 'antd/locale/vi_VN';
import { useEffect, useState, type PropsWithChildren } from 'react';
import { socioTheme } from './design-system';

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
      theme={socioTheme}
    >
      <App notification={{ placement: 'topRight', maxCount: 4, top: 20, getContainer: toastContainer }}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </App>
    </ConfigProvider>
  );
}
