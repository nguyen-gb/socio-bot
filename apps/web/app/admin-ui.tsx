'use client';

import { Button, Tag, Tooltip, type ButtonProps } from 'antd';
import type { ReactNode } from 'react';
import { Icon, STATUS_LABELS, type IconName } from './ui';

type ActionIconName = Extract<IconName, 'open' | 'close' | 'edit' | 'delete' | 'test' | 'play' | 'pause' | 'approve' | 'reject' | 'logout' | 'refresh' | 'view'>;

export function PageSectionTitle({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="section-title">
      <strong>{title}</strong>
      {description ? <small>{description}</small> : null}
    </div>
  );
}

export function ActionButton({ label, icon, ...props }: Omit<ButtonProps, 'children' | 'icon'> & { label: string; icon: ActionIconName }) {
  return (
    <Tooltip title={label} placement="top">
      <span className="action-tooltip">
        <Button {...props} aria-label={label} icon={<Icon name={icon} size={17} />} />
      </span>
    </Tooltip>
  );
}

export function StatusTag({ value, labels = STATUS_LABELS }: { value: string; labels?: Record<string, string> }) {
  const color = ['READY', 'HEALTHY', 'SUCCEEDED', 'JOINED', 'PUBLISHED', 'SENT'].includes(value)
    ? 'green'
    : ['ERROR', 'FAILED', 'UNHEALTHY', 'CRASHED', 'CANCELLED'].includes(value)
      ? 'red'
      : ['RUNNING', 'STARTING', 'QUEUED', 'SCHEDULED'].includes(value)
        ? 'blue'
        : ['REQUIRES_ACTION', 'LOGIN_REQUIRED', 'CHALLENGED', 'PENDING', 'PENDING_APPROVAL'].includes(value)
          ? 'orange'
          : 'default';

  return <Tag color={color}>{labels[value] ?? value}</Tag>;
}

export const TABLE_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

export function tablePagination(label: string, defaultPageSize = 20) {
  return {
    defaultPageSize,
    pageSizeOptions: TABLE_PAGE_SIZE_OPTIONS,
    showSizeChanger: true,
    showTotal: (total: number) => `${total} ${label}`,
  };
}
