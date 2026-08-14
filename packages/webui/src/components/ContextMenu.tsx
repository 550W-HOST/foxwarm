import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type ContextMenuAnchorRect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type ContextMenuItem = {
  key: string
  label: ReactNode
  icon?: ReactNode
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  checked?: boolean
  trailingControl?: {
    label: ReactNode
    checked: boolean
    onSelect: () => void
    disabled?: boolean
  }
}

export type ContextMenuEntry = ContextMenuItem | { key: string; type: 'separator' }

interface ContextMenuProps {
  open: boolean
  entries: ContextMenuEntry[]
  point?: { x: number; y: number } | null
  anchorRect?: ContextMenuAnchorRect | null
  preferredPlacement?: 'point' | 'bottom-start' | 'bottom-end'
  onClose: () => void
}

const VIEWPORT_PADDING = 8
const ANCHOR_GAP = 6

export default function ContextMenu({
  open,
  entries,
  point,
  anchorRect,
  preferredPlacement = 'point',
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [hoveredSplitKey, setHoveredSplitKey] = useState<string | null>(null)

  const visibleEntries = useMemo(() => entries.filter(Boolean), [entries])

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    const handleResize = () => {
      onClose()
    }

    const handleScroll = () => {
      // A point-anchored context menu has a stable viewport position. Keep it
      // open when unrelated content (for example, a streaming chat) scrolls
      // underneath it. Rect-anchored menus still close because their trigger
      // can move with the scrolled content.
      if (preferredPlacement !== 'point') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('touchstart', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', handleResize)
    window.addEventListener('scroll', handleScroll, true)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('touchstart', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open, onClose, preferredPlacement])

  useLayoutEffect(() => {
    if (!open || !menuRef.current) {
      setPosition(null)
      return
    }

    const rect = menuRef.current.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    let left = point?.x ?? anchorRect?.left ?? VIEWPORT_PADDING
    let top = point?.y ?? anchorRect?.bottom ?? VIEWPORT_PADDING

    if (anchorRect) {
      if (preferredPlacement === 'bottom-end') {
        left = anchorRect.right - rect.width
      } else {
        left = anchorRect.left
      }
      top = anchorRect.bottom + ANCHOR_GAP

      if (top + rect.height > viewportHeight - VIEWPORT_PADDING && anchorRect.top - rect.height - ANCHOR_GAP >= VIEWPORT_PADDING) {
        top = anchorRect.top - rect.height - ANCHOR_GAP
      }
    }

    left = Math.min(Math.max(VIEWPORT_PADDING, left), Math.max(VIEWPORT_PADDING, viewportWidth - rect.width - VIEWPORT_PADDING))
    top = Math.min(Math.max(VIEWPORT_PADDING, top), Math.max(VIEWPORT_PADDING, viewportHeight - rect.height - VIEWPORT_PADDING))

    setPosition({ left, top })
  }, [anchorRect, open, point, preferredPlacement, visibleEntries.length])

  if (!open || visibleEntries.length === 0) {
    return null
  }

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[80] min-w-[220px] overflow-hidden rounded-xl border border-gray-200/90 bg-white/95 py-1.5 shadow-2xl ring-1 ring-black/5 backdrop-blur dark:border-gray-700/90 dark:bg-gray-800/95"
      style={position ? { left: `${position.left}px`, top: `${position.top}px` } : { left: 0, top: 0, visibility: 'hidden' }}
      role="menu"
    >
      {visibleEntries.map((entry) => {
        if ('type' in entry) {
          return <div key={entry.key} className="my-1 border-t border-gray-200/80 dark:border-gray-700/80" />
        }

        const toneClass = entry.danger
          ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
          : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/70'

        const itemClass = `flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors ${entry.disabled ? 'cursor-not-allowed opacity-50' : toneClass}`
        const splitItemClass = `flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-sm ${entry.disabled ? 'cursor-not-allowed opacity-50' : entry.danger ? 'text-red-600 dark:text-red-400' : 'text-gray-700 dark:text-gray-200'}`

        const itemButton = (
          <button
            key={entry.key}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={entry.checked}
            disabled={entry.disabled}
            onClick={() => {
              if (entry.disabled) return
              entry.onSelect?.()
              onClose()
            }}
            className={entry.trailingControl ? splitItemClass : `${itemClass} w-full`}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">{entry.icon}</span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
          </button>
        )

        if (!entry.trailingControl) {
          return itemButton
        }

        const control = entry.trailingControl
        return (
          <div
            key={entry.key}
            className={`foxwarm-context-menu-split-row flex w-full items-stretch transition-colors ${entry.disabled ? '' : entry.danger ? 'foxwarm-context-menu-split-row-danger' : ''} ${hoveredSplitKey === entry.key ? entry.danger ? 'bg-red-50 dark:bg-red-900/20' : 'bg-gray-100 dark:bg-gray-700/70' : ''}`}
            data-context-menu-split-row="true"
            data-context-menu-split-row-hovered={hoveredSplitKey === entry.key ? 'true' : 'false'}
            onMouseEnter={() => setHoveredSplitKey(entry.key)}
            onMouseLeave={() => setHoveredSplitKey(current => current === entry.key ? null : current)}
          >
            {itemButton}
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={control.checked}
              disabled={control.disabled}
              onClick={(event) => {
                event.stopPropagation()
                if (control.disabled) return
                control.onSelect()
                onClose()
              }}
              className={`mr-3 inline-flex shrink-0 items-center gap-1 text-sm transition-colors ${control.checked ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 hover:text-blue-700 dark:text-gray-200 dark:hover:text-blue-300'} ${control.disabled ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <span aria-hidden="true" className={`inline-flex h-3 w-3 items-center justify-center rounded-[1px] border-2 text-[8px] font-bold leading-none ${control.checked ? 'border-blue-600 bg-blue-600 text-white dark:border-blue-400 dark:bg-blue-400 dark:text-gray-950' : 'border-gray-500 bg-white text-transparent dark:border-gray-400 dark:bg-gray-900'}`}>✓</span>
              <span>{control.label}</span>
            </button>
          </div>
        )
      })}
    </div>,
    document.body,
  )
}