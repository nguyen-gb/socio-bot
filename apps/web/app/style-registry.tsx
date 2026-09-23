'use client';

import { createCache, extractStyle, StyleProvider } from '@ant-design/cssinjs';
import { useServerInsertedHTML } from 'next/navigation';
import { useState, type PropsWithChildren } from 'react';

// Keep the server's first-screen styles in the same cache as Ant Design.
export function StyleRegistry({ children }: PropsWithChildren) {
  const [cache] = useState(() => createCache());
  useServerInsertedHTML(() => {
    const css = extractStyle(cache, { plain: true, once: true });
    if (!css || css.includes('.data-ant-cssinjs-cache-path{content:"";}')) return null;
    return <style data-rc-order="prepend" data-rc-priority="-1000" dangerouslySetInnerHTML={{ __html: css }} />;
  });
  return <StyleProvider cache={cache}>{children}</StyleProvider>;
}
