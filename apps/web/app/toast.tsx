'use client';

import { App } from 'antd';
import { useCallback, useEffect, useMemo, useRef } from 'react';

export function useToast() {
  const { notification } = App.useApp();
  return useMemo(() => {
    const show = (type: 'success' | 'error' | 'info' | 'warning', content: string, key?: string) => {
      notification.open({ type, title: content, key, className: 'socio-toast', duration: type === 'error' ? 7 : 4,
        placement: 'topRight', pauseOnHover: true, showProgress: true });
    };
    return {
      success: (content: string) => show('success', content),
      error: (content: string, key?: string) => show('error', content, key),
      info: (content: string, key?: string) => show('info', content, key),
      warning: (content: string, key?: string) => show('warning', content, key),
      dismiss: (key: string) => notification.destroy(key),
    };
  }, [notification]);
}

// Background polling should notify once per distinct error, then reset on recovery.
export function useToastNotice(content: string | null | undefined, key: string, type: 'error' | 'info' = 'error', settled = true) {
  const toast = useToast();
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (content && content !== previous.current) toast[type](content, key);
    if (content || settled) previous.current = content;
  }, [content, key, type, toast, settled]);
}

export function useToastError() {
  const toast = useToast();
  return useCallback((content: string | undefined) => { if (content) toast.error(content); }, [toast]);
}
