import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { WorkbenchHeaderDragArea, WorkbenchPaneControls, WorkbenchTabClose, WorkbenchTabIcon, useWorkbenchTabHeader } from './WorkbenchTabHeader'

interface ContentHeaderProps {
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  onBack?: () => void
  sticky?: boolean
  compact?: boolean
  below?: ReactNode
}

export default function ContentHeader({ icon, title, subtitle, actions, onBack, sticky = false, compact = false, below }: ContentHeaderProps) {
  const tabHeader = useWorkbenchTabHeader()
  if (compact) return (
    <div data-mobile-chat-header className="mobile-chat-floating-header mobile-top-fade pointer-events-none absolute inset-x-0 top-0 z-40">
      <div className="grid min-w-0 grid-cols-[84px_minmax(0,1fr)_84px] items-center gap-1 px-3 py-2">
        {onBack && <button type="button" onClick={onBack} title="Back" aria-label="Back to sessions" className="mobile-glass-surface mobile-header-back pointer-events-auto inline-flex h-11 w-11 shrink-0 items-center justify-center text-fw-text-strong"><ArrowLeft size={20} /></button>}
        {!onBack && <span aria-hidden="true" />}
        <h1 className="min-w-0 truncate text-center text-sm font-semibold text-fw-text-strong">{title}</h1>
        {actions ? <div className="mobile-glass-surface mobile-header-capsule pointer-events-auto justify-self-end flex h-11 shrink-0 items-center gap-0 px-0.5">
          {actions && <div className="mobile-header-actions flex shrink-0 items-center">{actions}</div>}
        </div> : <span aria-hidden="true" />}
      </div>
      {below && <div className="pointer-events-auto px-3 pb-3">{below}</div>}
    </div>
  )
  return (
    <div className={`${sticky ? 'sticky top-0 z-40 ' : ''}border-b border-fw-border bg-fw-workbench-header-surface dark:border-fw-border dark:bg-fw-workbench-header-surface`}>
      <WorkbenchHeaderDragArea className={`flex items-center justify-between ${compact ? 'h-14 gap-2 px-2' : 'h-16 gap-3 px-3'}`}>
        <div className={`flex min-w-0 flex-1 items-center ${compact ? 'gap-1' : 'gap-3'}`}>
          {tabHeader ? <WorkbenchTabClose className="rounded-lg p-2 text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover" /> : onBack && (
            <button
              onClick={onBack}
              className={`${compact ? 'inline-flex h-11 w-11 shrink-0 items-center justify-center' : 'p-2'} rounded-lg text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover`}
              title="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}

          {!compact && <WorkbenchTabIcon className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-fw-neutral-surface text-fw-text dark:bg-fw-surface-raised/70 dark:text-fw-text-strong">
            {icon}
          </WorkbenchTabIcon>}

          <div className="min-w-0">
            <div className={`truncate font-semibold text-fw-text-strong ${compact ? 'text-base' : 'text-lg'}`}>{title}</div>
            {subtitle && (
              <div className="truncate text-sm text-fw-text-muted">
                {subtitle}
              </div>
            )}
          </div>
        </div>

        {(actions || tabHeader) && (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <WorkbenchPaneControls />
          </div>
        )}
      </WorkbenchHeaderDragArea>

      {below && (
        <div className="px-3 pb-3">
          {below}
        </div>
      )}
    </div>
  )
}