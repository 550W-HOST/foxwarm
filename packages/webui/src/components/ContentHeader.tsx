import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'

interface ContentHeaderProps {
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  onBack?: () => void
  sticky?: boolean
  below?: ReactNode
}

export default function ContentHeader({ icon, title, subtitle, actions, onBack, sticky = false, below }: ContentHeaderProps) {
  return (
    <div className={`${sticky ? 'sticky top-0 z-30 ' : ''}border-b border-fw-border bg-fw-surface dark:border-fw-border dark:bg-fw-surface`}>
      <div className="flex h-16 items-center justify-between gap-3 px-3">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="rounded-lg p-2 text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover"
              title="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}

          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fw-neutral-surface text-fw-text dark:bg-fw-surface-raised/70 dark:text-fw-text-strong">
            {icon}
          </div>

          <div className="min-w-0">
            <div className="truncate text-lg font-semibold text-fw-text-strong">{title}</div>
            {subtitle && (
              <div className="truncate text-sm text-fw-text-muted">
                {subtitle}
              </div>
            )}
          </div>
        </div>

        {actions && (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
          </div>
        )}
      </div>

      {below && (
        <div className="px-3 pb-3">
          {below}
        </div>
      )}
    </div>
  )
}