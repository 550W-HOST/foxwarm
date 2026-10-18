import type { TimelineView } from '../chatPreferences'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Code2, Menu, MoreVertical, Search, SquareTerminal } from 'lucide-react'
import { CONTEXT_SCROLLBAR_SETTINGS_EVENT, readContextScrollbarSettings, writeContextScrollbarSettings } from '../contextScrollbarSettings'
import { MENU_VIEWPORT_GUTTER, clampAnchoredMenuHorizontally, readHorizontalViewportBounds } from './menuPositioning'

type SendKeyMode = 'modEnter' | 'enter'

interface SessionUiSettingsMenuProps {
  mobile?: boolean
  onFind?: () => void
  onOpenCode?: () => void
  onOpenTerminal?: () => void
  sendKeyMode: SendKeyMode
  onSendKeyModeChange: (mode: SendKeyMode) => void
  timelineView: TimelineView
  onTimelineViewChange: (mode: TimelineView) => void
  showUsageBadge: boolean
  onShowUsageBadgeChange: (enabled: boolean) => void
  showInterAgentMessages?: boolean
  onShowInterAgentMessagesChange?: (enabled: boolean) => void
  showCommentary?: boolean
  onShowCommentaryChange?: (enabled: boolean) => void
  fullWidth?: boolean
  onFullWidthChange?: (enabled: boolean) => void
  showUserMessageMetadata: boolean
  onShowUserMessageMetadataChange: (enabled: boolean) => void
  onOpenDebugInfo: () => void
}

export default function SessionUiSettingsMenu({
  mobile = false,
  onFind,
  onOpenCode,
  onOpenTerminal,
  sendKeyMode,
  onSendKeyModeChange,
  timelineView,
  onTimelineViewChange,
  showUsageBadge,
  onShowUsageBadgeChange,
  showInterAgentMessages = true,
  onShowInterAgentMessagesChange = () => {},
  showCommentary = true,
  onShowCommentaryChange = () => {},
  fullWidth = true,
  onFullWidthChange = () => {},
  showUserMessageMetadata,
  onShowUserMessageMetadataChange,
  onOpenDebugInfo,
}: SessionUiSettingsMenuProps) {
  const [open, setOpen] = useState(false)
  const [contextScrollbarSettings, setContextScrollbarSettings] = useState(readContextScrollbarSettings)
  const [menuOffset, setMenuOffset] = useState(0)
  const [menuPositioned, setMenuPositioned] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const modifierLabel = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl'
  const toggleRowClass = 'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover'

  useEffect(() => {
    const sync = () => setContextScrollbarSettings(readContextScrollbarSettings())
    window.addEventListener(CONTEXT_SCROLLBAR_SETTINGS_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(CONTEXT_SCROLLBAR_SETTINGS_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
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
      const chatRect = anchor.closest<HTMLElement>('.foxwarm-chat-root')?.getBoundingClientRect()
      const bounds = chatRect
        ? { left: Math.max(viewport.left, chatRect.left), right: Math.min(viewport.right, chatRect.right) }
        : viewport
      const safeBounds = bounds.right > bounds.left ? bounds : viewport
      menu.style.maxWidth = `${Math.max(0, safeBounds.right - safeBounds.left - MENU_VIEWPORT_GUTTER * 2)}px`
      const anchorRect = anchor.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const geometry = [anchorRect.left, anchorRect.right, menuRect.width, safeBounds.left, safeBounds.right].join(':')
      if (geometry !== lastGeometry) {
        lastGeometry = geometry
        const placement = clampAnchoredMenuHorizontally({
          anchorLeft: anchorRect.left,
          anchorRight: anchorRect.right,
          menuWidth: menuRect.width,
          viewport: safeBounds,
          align: 'end',
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
  }, [open])

  const toggle = (enabled: boolean) => (
    <span className={`ml-3 inline-flex h-4 w-7 items-center rounded-full transition ${enabled ? 'bg-fw-accent' : 'bg-fw-border-strong dark:bg-fw-text'}`}>
      <span className={`h-3 w-3 rounded-full bg-fw-surface transition ${enabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
    </span>
  )

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        className={`${mobile ? 'inline-flex h-11 w-11 items-center justify-center' : 'p-2'} rounded-lg text-fw-text hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse`}
        title="Session options"
        aria-label="Open session options"
        aria-expanded={open}
      >
        {mobile ? <MoreVertical size={20} /> : <Menu size={20} />}
      </button>
      {open && (
        <div
          ref={menuRef}
          data-session-ui-settings-menu
          className="absolute right-0 z-50 mt-2 max-h-[min(36rem,calc(var(--foxwarm-app-height,100vh)-5rem))] w-72 overflow-y-auto rounded-lg border border-fw-border bg-fw-surface text-fw-text-strong shadow-lg dark:border-fw-border dark:bg-fw-surface dark:text-fw-text-strong"
          style={{ transform: `translateX(${menuOffset}px)`, visibility: menuPositioned ? 'visible' : 'hidden' }}
        >
          {mobile && <div className="border-b border-fw-border p-2">
            {[
              {key: 'find', label: 'Find in chat', icon: Search, action: onFind},
              {key: 'code', label: 'Code', icon: Code2, action: onOpenCode},
              {key: 'terminal', label: 'Terminal', icon: SquareTerminal, action: onOpenTerminal},
            ].filter(item => item.action).map(({key, label, icon: Icon, action}) => <button key={key} type="button" onClick={() => {setOpen(false); action?.()}}
              className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm text-fw-text hover:bg-fw-hover"><Icon size={16} />{label}</button>)}
          </div>}
          <div className="border-b border-fw-border px-4 py-3 dark:border-fw-border">
            <div className="mb-2 text-xs font-medium text-fw-text-muted">Input</div>
            <div className="flex gap-1">
              {([
                { value: 'modEnter' as const, label: `${modifierLabel}+Enter` },
                { value: 'enter' as const, label: 'Enter' },
              ]).map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSendKeyModeChange(option.value)}
                  className={`flex-1 rounded px-2 py-1 text-xs ${sendKeyMode === option.value ? 'bg-fw-accent text-fw-accent-text' : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised dark:text-fw-text dark:hover:bg-fw-hover'}`}
                  title={`${option.label} sends`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="border-b border-fw-border px-4 py-3 dark:border-fw-border">
            <div className="mb-2 text-xs font-medium text-fw-text-muted">Chat</div>
            <div className="space-y-1">
              <fieldset className="pb-2">
                <legend className="px-2 py-1.5 text-xs text-fw-text">Timeline view</legend>
                <div className="flex gap-1" role="radiogroup" aria-label="Timeline view">
                  {(['detailed', 'grouped', 'conversation'] as const).map(mode => (
                    <button key={mode} type="button" role="radio" aria-checked={timelineView === mode}
                      onClick={() => onTimelineViewChange(mode)}
                      className={`flex-1 rounded px-2 py-1 text-xs ${timelineView === mode ? 'bg-fw-accent text-fw-accent-text' : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised dark:text-fw-text dark:hover:bg-fw-hover'}`}>
                      {mode[0].toUpperCase() + mode.slice(1)}
                    </button>
                  ))}
                </div>
              </fieldset>
              {timelineView === 'conversation' && <>
                <button type="button" role="switch" aria-checked={showInterAgentMessages} onClick={() => onShowInterAgentMessagesChange(!showInterAgentMessages)} className={toggleRowClass}>
                  <span>Show inter-agent messages</span>{toggle(showInterAgentMessages)}
                </button>
                <button type="button" role="switch" aria-checked={showCommentary} onClick={() => onShowCommentaryChange(!showCommentary)} className={toggleRowClass}>
                  <span>Show commentary</span>{toggle(showCommentary)}
                </button>
              </>}
              <button type="button" role="switch" aria-checked={fullWidth} onClick={() => onFullWidthChange(!fullWidth)} className={toggleRowClass}>
                <span>Full width</span>{toggle(fullWidth)}
              </button>
              {!mobile && <button type="button" onClick={() => onShowUsageBadgeChange(!showUsageBadge)} className={toggleRowClass}>
                <span>Show usage badges</span>{toggle(showUsageBadge)}
              </button>}
              <button
                type="button"
                role="switch"
                aria-checked={timelineView !== 'conversation' && contextScrollbarSettings.showMinimap}
                disabled={timelineView === 'conversation' || (contextScrollbarSettings.showMinimap && !contextScrollbarSettings.showScrollbar)}
                onClick={() => {
                  const next = { ...contextScrollbarSettings, showMinimap: !contextScrollbarSettings.showMinimap }
                  setContextScrollbarSettings(writeContextScrollbarSettings(next))
                }}
                className={`${toggleRowClass} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span>Show minimap</span>{toggle(timelineView !== 'conversation' && contextScrollbarSettings.showMinimap)}
              </button>
              <button type="button" onClick={() => onShowUserMessageMetadataChange(!showUserMessageMetadata)} className={toggleRowClass}>
                <span>Show user message metadata</span>{toggle(showUserMessageMetadata)}
              </button>
            </div>
          </div>

          <div className="px-4 py-3">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onOpenDebugInfo()
              }}
              className="w-full rounded px-2 py-1.5 text-left text-xs text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover"
            >
              debug info
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
