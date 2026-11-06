import type { ComponentType, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

/** Row shell of a sidebar navigation entry; the active entry is highlighted. */
export const sidebarNavRowClass = (active: boolean) => `group flex h-8 min-w-0 items-center rounded-md transition-colors ${active
  ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40'
  : 'text-fw-text hover:bg-fw-hover dark:text-fw-text-strong'}`

const mainClass = 'flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 text-left text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring/40 disabled:cursor-not-allowed disabled:opacity-50'

interface SidebarNavItemProps {
  icon: ComponentType<{ className?: string }>
  label: string
  active?: boolean
  onClick: () => void
  title?: string
  disabled?: boolean
  /** Trailing content inside the row, such as an indicator. */
  trailing?: ReactNode
  /** Options toggle at the row end. */
  options?: { open: boolean; label: string; onToggle: () => void }
  dataNav?: string
}

/** One icon + text navigation row, with an optional options chevron at the row end. */
export function SidebarNavItem({ icon: Icon, label, active = false, onClick, title, disabled, trailing, options, dataNav }: SidebarNavItemProps) {
  return (
    <div className={sidebarNavRowClass(active)} data-sidebar-nav={dataNav} data-active={active || undefined}>
      <button type="button" onClick={onClick} disabled={disabled} title={title} aria-current={active ? 'page' : undefined} className={mainClass}>
        <Icon className="h-4 w-4 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
        {trailing}
      </button>
      {options ? (
        <button
          type="button"
          onClick={options.onToggle}
          title={options.label}
          aria-label={options.label}
          aria-expanded={options.open}
          className="mr-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fw-text-muted hover:bg-fw-selected hover:text-fw-text-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring/40"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${options.open ? 'rotate-180' : ''}`} />
        </button>
      ) : null}
    </div>
  )
}
