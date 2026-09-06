import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { RefreshCw, Settings } from 'lucide-react'
import { useTheme } from '../theme/useTheme'
import ReloadAppButton from './ReloadAppButton'
import { MENU_VIEWPORT_GUTTER, clampAnchoredMenuHorizontally, readHorizontalViewportBounds } from './menuPositioning'

interface GlobalUiSettingsMenuProps {
  menuAlign?: 'start' | 'end'
  onOpenSetup?: () => void
  setupActive?: boolean
}

export default function GlobalUiSettingsMenu({ menuAlign = 'end', onOpenSetup, setupActive = false }: GlobalUiSettingsMenuProps) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const [menuOffset, setMenuOffset] = useState(0)
  const [menuPositioned, setMenuPositioned] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) {
      setMenuOffset(0)
      setMenuPositioned(false)
      return
    }
    let animationFrame = 0
    let lastGeometry = ''
    const updatePosition = () => {
      const anchor = rootRef.current
      const menu = menuRef.current
      if (!anchor || !menu) return
      const viewport = readHorizontalViewportBounds()
      const maxWidth = Math.max(0, viewport.right - viewport.left - MENU_VIEWPORT_GUTTER * 2)
      menu.style.maxWidth = `${maxWidth}px`
      const anchorRect = anchor.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const geometry = [anchorRect.left, anchorRect.right, menuRect.width, viewport.left, viewport.right, menuAlign].join(':')
      if (geometry !== lastGeometry) {
        lastGeometry = geometry
        const placement = clampAnchoredMenuHorizontally({
          anchorLeft: anchorRect.left,
          anchorRight: anchorRect.right,
          menuWidth: menuRect.width,
          viewport,
          align: menuAlign,
        })
        setMenuOffset(current => Math.abs(current - placement.offset) < 0.25 ? current : placement.offset)
        setMenuPositioned(true)
      }
    }
    const watchGeometry = () => {
      updatePosition()
      animationFrame = window.requestAnimationFrame(watchGeometry)
    }
    watchGeometry()
    return () => window.cancelAnimationFrame(animationFrame)
  }, [menuAlign, open])

  const menuButtonClass = 'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover'
  const menuAlignClass = menuAlign === 'start' ? 'left-0' : 'right-0'

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-lg border transition ${setupActive ? 'border-fw-accent-border bg-fw-accent-surface text-fw-accent dark:border-fw-accent-border dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent' : 'border-fw-border text-fw-text hover:bg-fw-hover hover:text-fw-text-strong dark:border-fw-border dark:text-fw-text dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse'}`}
        title="UI settings"
        aria-label="Open UI settings"
        aria-pressed={setupActive}
      >
        <Settings className="h-4 w-4" />
      </button>

      {open && (
        <div
          ref={menuRef}
          data-global-ui-settings-menu
          className={`absolute ${menuAlignClass} top-full z-50 mt-2 w-72 rounded-lg border border-fw-border bg-fw-surface shadow-lg dark:border-fw-border dark:bg-fw-surface dark:text-fw-text-strong`}
          style={{ transform: `translateX(${menuOffset}px)`, visibility: menuPositioned ? 'visible' : 'hidden' }}
        >
          <div className="border-b border-fw-border px-4 py-3 dark:border-fw-border">
            <div className="mb-2 text-xs font-medium text-fw-text-muted">Color mode</div>
            <div className="flex gap-1">
              {(['auto', 'light', 'dark'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    theme.setColorMode(mode)
                    setOpen(false)
                  }}
                  className={`flex-1 rounded px-2 py-1 text-xs capitalize ${theme.selection.colorMode === mode ? 'bg-fw-accent text-fw-text-inverse' : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised dark:text-fw-text dark:hover:bg-fw-hover'}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 py-3">
            <div className="mb-2 text-xs font-medium text-fw-text-muted">Application</div>
            <div className="space-y-1">
              {onOpenSetup && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenSetup()
                    setOpen(false)
                  }}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${setupActive ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent' : 'text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover'}`}
                >
                  <span>WebUI: Open setup</span>
                  {setupActive && <span className="text-[10px] uppercase tracking-wide">active</span>}
                </button>
              )}
              <ReloadAppButton className={menuButtonClass}>
                <span>WebUI: reload</span>
                <RefreshCw className="h-3.5 w-3.5" />
              </ReloadAppButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
