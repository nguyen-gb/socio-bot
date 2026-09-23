'use client';

import { Button, Card, Form, Input, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useToast, useToastError } from '../toast';

export default function LoginPage() {
  const router = useRouter();
  const setError = useToastError();
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  const submit = async (values: { email: string; password: string }) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      const payload = (await response.json()) as { message?: string };
      if (!response.ok) {
        throw new Error(payload.message ?? 'Đăng nhập thất bại');
      }
      toast.success('Đăng nhập thành công');
      router.replace('/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-story" aria-label="Giới thiệu Socio">
        <div className="brand"><span className="brand-mark">S</span><strong>Socio</strong></div>
        <div><span className="eyebrow">KHÔNG GIAN LÀM VIỆC CỦA BẠN</span><h1>Quản lý gọn gàng.<br />Vận hành rõ ràng.</h1><p>Tài khoản, trình duyệt và chiến dịch được tổ chức trong một không gian dễ theo dõi.</p><div className="login-story-note">Chuẩn bị · Kiểm tra · Duyệt · Thực thi</div></div>
        <small>Mọi chiến dịch đều bắt đầu từ một bản nháp.</small>
      </section>
      <section className="login-form-side">
      <Card className="login-card">
        <div className="brand login-brand">
          <span className="brand-mark">S</span>
          <div><strong>Socio</strong><small>Automation workspace</small></div>
        </div>
        <Typography.Title level={2}>Chào mừng trở lại</Typography.Title>
        <Typography.Paragraph type="secondary">
          Đăng nhập để tiếp tục vào không gian làm việc.
        </Typography.Paragraph>
        <Form layout="vertical" onFinish={(values) => void submit(values)}>
          <Form.Item name="email" label="Email" rules={[{ required: true }, { type: 'email' }]}>
            <Input autoComplete="email" placeholder="you@example.com" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="Mật khẩu" rules={[{ required: true, min: 12 }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            Đăng nhập
          </Button>
        </Form>
      </Card>
      </section>
    </main>
  );
}
