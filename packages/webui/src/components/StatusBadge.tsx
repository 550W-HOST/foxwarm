import type { ComponentPropsWithoutRef } from 'react'

type BadgeTone = 'muted' | 'accent' | 'success' | 'warning'

export function StatusBadge({ children, tone = 'muted', className = '', ...props }: ComponentPropsWithoutRef<'span'> & { tone?: BadgeTone }) {
  return <span {...props} className={`status-badge ${className}`} data-tone={tone}><span aria-hidden="true" />{children}</span>
}

export const TASK_STATUS_LABELS: Record<string, string> = { open: 'Open', active: 'Active', completed: 'Completed', cancelled: 'Cancelled' }

export function TaskStatusBadge({ status }: { status: string }) {
  const tone = status === 'active' ? 'accent' : status === 'completed' ? 'success' : 'muted'
  return <StatusBadge className="task-status" data-status={status} tone={tone}>{TASK_STATUS_LABELS[status] || status}</StatusBadge>
}

export function NodeStatusBadge({ online }: { online: boolean }) {
  return <StatusBadge data-status={online ? 'online' : 'offline'} tone={online ? 'accent' : 'muted'}>{online ? 'Online' : 'Offline'}</StatusBadge>
}
