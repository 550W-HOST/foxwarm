import type { MouseEvent, ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/** Row content starts here (row padding). */
export const SESSION_ROW_PADDING_PX = 12
/** Width of the disclosure column plus its gap before the title, in Normal density tree modes. */
export const SESSION_ROW_DISCLOSURE_PX = 22

/** Horizontal start of a level-0 row title. */
export const sessionRowTitleX = (disclosureColumn: boolean) => SESSION_ROW_PADDING_PX + (disclosureColumn ? SESSION_ROW_DISCLOSURE_PX : 0)

interface SessionListSectionHeaderProps {
  label: ReactNode
  /** Whether rows reserve a disclosure column before the title. */
  disclosureColumn: boolean
  collapsed?: boolean
  /** Omit for a header that cannot collapse. */
  onToggle?: () => void
  toggleLabel?: string
  /** Small indicator after the label, such as a Node's online dot. */
  status?: ReactNode
  count?: ReactNode
  actions?: ReactNode
  title?: string
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void
  /** Extra data attributes for the toggle button and the label. */
  toggleAttributes?: Record<`data-${string}`, string | undefined>
  labelAttributes?: Record<`data-${string}`, string | undefined>
}

/**
 * Section header on the row grid: the chevron sits in the rows' disclosure column (or in the
 * row padding when rows have none) and the label starts where row titles start, so a section
 * reads as a heading over its rows rather than as a tree level.
 */
export default function SessionListSectionHeader({ label, disclosureColumn, collapsed = false, onToggle, toggleLabel, status, count, actions, title, onContextMenu, toggleAttributes, labelAttributes }: SessionListSectionHeaderProps) {
  const titleX = sessionRowTitleX(disclosureColumn)
  // Without a disclosure column the chevron sits in the 12px row padding, so it is smaller.
  const chevronClass = disclosureColumn ? 'h-3.5 w-3.5' : 'h-3 w-3'
  const chevron = onToggle ? (
    <span
      aria-hidden="true"
      className="absolute inset-y-0 flex items-center justify-center"
      style={disclosureColumn ? { left: SESSION_ROW_PADDING_PX, width: 16 } : { left: 0, width: SESSION_ROW_PADDING_PX }}
    >
      {collapsed ? <ChevronRight className={chevronClass} /> : <ChevronDown className={chevronClass} />}
    </span>
  ) : null
  const content = (
    <>
      {chevron}
      <span className="min-w-0 truncate font-medium text-fw-text" title={title} data-session-section-label {...labelAttributes}>{label}</span>
      {status}
      {count !== undefined ? <span className="shrink-0 tabular-nums" data-session-group-count>{count}</span> : null}
    </>
  )
  return (
    <div className="group/header relative flex h-7 items-center gap-1 rounded text-xs text-fw-text-muted hover:bg-fw-hover" onContextMenu={onContextMenu} data-session-section-header>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded text-left focus:outline-none focus:ring-2 focus:ring-fw-focus-ring/40"
          style={{ paddingLeft: titleX }}
          data-session-section-toggle
          {...toggleAttributes}
        >
          {content}
        </button>
      ) : (
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5" style={{ paddingLeft: titleX }}>{content}</div>
      )}
      {actions}
    </div>
  )
}
