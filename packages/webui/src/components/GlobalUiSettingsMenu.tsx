import { useEffect, useRef, useState } from 'react'
import { Check, Settings } from 'lucide-react'
import type { SendKeyMode } from './chatShared'
import ReloadAppButton from './ReloadAppButton'

type ThemeMode = 'auto' | 'light' | 'dark'

interface GlobalUiSettingsMenuProps {
  themeMode: ThemeMode
  onThemeChange: (mode: ThemeMode) => void
  sendKeyMode: SendKeyMode
  onSendKeyModeChange: (mode: SendKeyMode) => void
}

export default function GlobalUiSettingsMenu({ themeMode, onThemeChange, sendKeyMode, onSendKeyModeChange }: GlobalUiSettingsMenuProps) {
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

          <div className="px-4 py-3">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Send key</div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => {
                  onSendKeyModeChange('mod-enter')
                  setOpen(false)
                }}
                className={`rounded px-2 py-1 text-xs ${sendKeyMode === 'mod-enter' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
              >
                Ctrl/Cmd+Enter
              </button>
              <button
                type="button"
                onClick={() => {
                  onSendKeyModeChange('enter')
                  setOpen(false)
                }}
                className={`rounded px-2 py-1 text-xs ${sendKeyMode === 'enter' ? 'bg-blue-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
              >
                Enter
              </button>
            </div>
            <div className="mt-2 flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
              <Check className="h-3.5 w-3.5 shrink-0" />
              <span>{sendKeyMode === 'enter' ? 'Enter sends; modifiers insert a new line.' : 'Ctrl/Cmd+Enter sends; Enter inserts a new line.'}</span>
            </div>
          </div>

          <div className="border-t border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">Application</div>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1 text-left text-xs text-gray-600 dark:text-gray-300">Clear cache and reload</div>
              <ReloadAppButton />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}