import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, FileText, RefreshCw, Settings } from 'lucide-react'
import { useTheme } from '../theme/useTheme'
import ReloadAppButton from './ReloadAppButton'
import { MENU_VIEWPORT_GUTTER, clampAnchoredMenuHorizontally, readHorizontalViewportBounds } from './menuPositioning'

interface GlobalUiSettingsMenuProps {
  menuAlign?: 'start' | 'end'
  menuSide?: 'top' | 'bottom'
  /** `toolbar` places the dropdown part beside the gear; `rail` stacks it below the gear for the collapsed sidebar. */
  variant?: 'toolbar' | 'rail'
  onOpenSetup: () => void
  onOpenLogs?: () => void
  setupActive?: boolean
}

/** Split button: the gear opens Setup, the attached chevron opens the color-mode and Application menu. */
export default function GlobalUiSettingsMenu({ menuAlign = 'end', menuSide = 'bottom', variant = 'toolbar', onOpenSetup, onOpenLogs, setupActive = false }: GlobalUiSettingsMenuProps) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const rail = variant === 'rail'
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
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
      if (event.key === 'Escape') {
        setOpen(false)
        menuTriggerRef.current?.focus()
      }
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
      if (menuSide === 'top') {
        const viewportTop = window.visualViewport?.offsetTop || 0
        menu.style.maxHeight = `${Math.max(0, anchorRect.top - viewportTop - MENU_VIEWPORT_GUTTER - 8)}px`
      } else {
        menu.style.maxHeight = ''
      }
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
  }, [menuAlign, menuSide, open])

  const menuButtonClass = 'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover'
  const menuAlignClass = menuAlign === 'start' ? 'left-0' : 'right-0'

  return (
    <div ref={rootRef} className="relative">
      <div
        data-global-ui-settings-split
        className={`flex overflow-hidden rounded-lg border ${rail ? 'flex-col' : 'flex-row'} ${setupActive ? 'border-fw-accent-border dark:border-fw-accent-border' : 'border-fw-border dark:border-fw-border'}`}
      >
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            onOpenSetup()
          }}
          className={`inline-flex items-center justify-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fw-focus-ring/40 ${rail ? 'h-8 w-8' : 'h-[34px] w-8'} ${setupActive ? 'bg-fw-accent-surface text-fw-accent dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent' : 'text-fw-text hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse'}`}
          title="Open setup"
          aria-label="Open setup"
          aria-current={setupActive ? 'page' : undefined}
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          ref={menuTriggerRef}
          type="button"
          onClick={() => setOpen(current => !current)}
          className={`inline-flex items-center justify-center text-fw-text-muted transition hover:bg-fw-hover hover:text-fw-text-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fw-focus-ring/40 dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse ${rail ? 'h-4 w-8 border-t' : 'h-[34px] w-5 border-l'} ${setupActive ? 'border-fw-accent-border dark:border-fw-accent-border' : 'border-fw-border dark:border-fw-border'} ${open ? 'bg-fw-hover text-fw-text-strong dark:text-fw-text-inverse' : ''}`}
          title="UI settings"
          aria-label="Open UI settings"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
        >
          <ChevronDown className={`${rail ? 'h-3 w-3' : 'h-3.5 w-3.5'} transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="dialog"
          aria-label="UI settings"
          data-global-ui-settings-menu
          className={`absolute ${menuAlignClass} ${menuSide === 'top' ? 'bottom-full mb-2 overflow-y-auto' : 'top-full mt-2'} z-50 w-72 rounded-lg border border-fw-border bg-fw-surface shadow-lg dark:border-fw-border dark:bg-fw-surface dark:text-fw-text-strong`}
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
                  className={`flex-1 rounded px-2 py-1 text-xs capitalize ${theme.selection.colorMode === mode ? 'bg-fw-accent text-fw-accent-text' : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised dark:text-fw-text dark:hover:bg-fw-hover'}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="px-4 py-3">
            <div className="mb-2 text-xs font-medium text-fw-text-muted">Application</div>
            <div className="space-y-1">
              <ReloadAppButton className={menuButtonClass}>
                <span className="inline-flex items-center gap-2"><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Reload WebUI</span>
              </ReloadAppButton>
              {onOpenLogs && <button type="button" className={menuButtonClass} onClick={() => { onOpenLogs(); setOpen(false) }}><span className="inline-flex items-center gap-2"><FileText className="h-3.5 w-3.5" aria-hidden="true" />Open logs</span></button>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
