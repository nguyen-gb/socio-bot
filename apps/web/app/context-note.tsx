import type { CSSProperties, ReactNode } from 'react';

// Persistent form instructions and confirmations are content, not notifications.
export function ContextNote({ title, description, action, className = '', style }: {
  type?: string; showIcon?: boolean; title: ReactNode; description?: ReactNode;
  action?: ReactNode; className?: string; style?: CSSProperties;
}) {
  return <div className={`context-note ${className}`} style={style}>
    <div><div className="context-note-title">{title}</div>{description ? <div className="context-note-description">{description}</div> : null}</div>
    {action ? <div className="context-note-action">{action}</div> : null}
  </div>;
}
