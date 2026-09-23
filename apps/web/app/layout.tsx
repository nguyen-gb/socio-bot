import type { Metadata } from 'next';
import type { PropsWithChildren } from 'react';
import { Providers } from './providers';
import { StyleRegistry } from './style-registry';
import './styles.css';

export const metadata: Metadata = {
  title: 'Socio Workspace',
  description: 'Quản lý tài khoản, trình duyệt và chiến dịch trong một không gian làm việc.',
};

export default function RootLayout({ children }: PropsWithChildren) {
  return (
    <html lang="vi">
      <body>
        <StyleRegistry><Providers>{children}</Providers></StyleRegistry>
      </body>
    </html>
  );
}
