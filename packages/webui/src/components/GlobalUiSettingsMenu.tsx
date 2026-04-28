import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Settings } from 'lucide-react'
import ReloadAppButton from './ReloadAppButton'

type ThemeMode = 'auto' | 'light' | 'dark'
type SendKeyMode = 'modEnter' | 'enter'

interface GlobalUiSettingsMenuProps {
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  sendKeyMode: SendKeyMode
  onSendKeyModeChange: (mode: SendKeyMode) => void
  onOpenSetup?: () => void
  setupActive?: boolean
}

export default function GlobalUiSettingsMenu({ themeMode, onThemeChange, sendKeyMode, onSendKeyModeChange, onOpenSetup, setupActive = false }: GlobalUiSettingsMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [open])

  const menuButtonClass = 'flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-gray-600 hover:bg-gray-100 disabled:cursor-wait disabled:opacity-70 dark:text-gray-300 dark:hover:bg-gray-700'
  const modifierLabel = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl'

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 text-gray-600 transition hover:bg-gray-100 hover:text-gray-900 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-white"
        title="UI settings"
        aria-label="Open UI settings"
      >
        <Settings className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-56 rounded-lg border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Theme</div>
            <div className="flex gap-1">
              {(['auto', 'light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    onThemeChange(mode)
                    setOpen(false)
                  }}
                  className={`flex-1 rounded px-2 py-1 text-xs capitalize ${themeMode === mode ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Input</div>
            <div className="flex gap-1">
              {([
                { value: 'modEnter' as const, label: `${modifierLabel}+Enter` },
                { value: 'enter' as const, label: 'Enter' },
              ]).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onSendKeyModeChange(option.value)}
                  className={`flex-1 rounded px-2 py-1 text-xs ${sendKeyMode === option.value ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                  title={`${option.label} sends`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Application</div>
            <div className="space-y-1">
              {onOpenSetup && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenSetup()
                    setOpen(false)
                  }}
                  className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs ${setupActive ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'}`}
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
