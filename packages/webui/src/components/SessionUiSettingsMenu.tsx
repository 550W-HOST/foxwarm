import { useEffect, useRef, useState } from 'react'
import { Menu } from 'lucide-react'
import { CONTEXT_SCROLLBAR_SETTINGS_EVENT, readContextScrollbarSettings, writeContextScrollbarSettings } from '../contextScrollbarSettings'

type SendKeyMode = 'modEnter' | 'enter'

interface SessionUiSettingsMenuProps {
  sendKeyMode: SendKeyMode
  onSendKeyModeChange: (mode: SendKeyMode) => void
  groupTools: boolean
  onGroupToolsChange: (enabled: boolean) => void
  showUsageBadge: boolean
  onShowUsageBadgeChange: (enabled: boolean) => void
  showUserMessageMetadata: boolean
  onShowUserMessageMetadataChange: (enabled: boolean) => void
  onOpenDebugInfo: () => void
}

export default function SessionUiSettingsMenu({
  sendKeyMode,
  onSendKeyModeChange,
  groupTools,
  onGroupToolsChange,
  showUsageBadge,
  onShowUsageBadgeChange,
  showUserMessageMetadata,
  onShowUserMessageMetadataChange,
  onOpenDebugInfo,
}: SessionUiSettingsMenuProps) {
  const [open, setOpen] = useState(false)
  const [contextScrollbarSettings, setContextScrollbarSettings] = useState(readContextScrollbarSettings)
  const rootRef = useRef<HTMLDivElement | null>(null)
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
        className="rounded-lg p-2 text-fw-text hover:bg-fw-hover hover:text-fw-text-strong dark:text-fw-text-muted dark:hover:bg-fw-hover dark:hover:text-fw-text-inverse"
        title="Session options"
        aria-label="Open session options"
        aria-expanded={open}
      >
        <Menu size={20} />
      </button>
      {open && (
        <div data-session-ui-settings-menu className="absolute right-0 z-50 mt-2 max-h-[min(36rem,calc(100vh-5rem))] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-fw-border bg-fw-surface text-fw-text-strong shadow-lg dark:border-fw-border dark:bg-fw-surface dark:text-fw-text-strong">
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
                  className={`flex-1 rounded px-2 py-1 text-xs ${sendKeyMode === option.value ? 'bg-fw-accent text-fw-text-inverse' : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised dark:text-fw-text dark:hover:bg-fw-hover'}`}
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
              <button type="button" onClick={() => onGroupToolsChange(!groupTools)} className={toggleRowClass}>
                <span>Group tools</span>{toggle(groupTools)}
              </button>
              <button type="button" onClick={() => onShowUsageBadgeChange(!showUsageBadge)} className={toggleRowClass}>
                <span>Show usage badges</span>{toggle(showUsageBadge)}
              </button>
              <button
                type="button"
                disabled={contextScrollbarSettings.showMinimap && !contextScrollbarSettings.showScrollbar}
                onClick={() => {
                  const next = { ...contextScrollbarSettings, showMinimap: !contextScrollbarSettings.showMinimap }
                  setContextScrollbarSettings(writeContextScrollbarSettings(next))
                }}
                className={`${toggleRowClass} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span>Show minimap</span>{toggle(contextScrollbarSettings.showMinimap)}
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
