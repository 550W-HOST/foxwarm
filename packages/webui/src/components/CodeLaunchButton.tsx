import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Code2, ExternalLink } from 'lucide-react'
import { normalizeCodePath } from '../vscodeWeb'

interface CodeLaunchButtonProps {
  path: string
  openInNewWindow: boolean
  active?: boolean
  onOpen: (path: string) => void
  onPathChange: (path: string) => void
  onOpenInNewWindowChange: (enabled: boolean) => void
}

export default function CodeLaunchButton({
  path,
  openInNewWindow,
  active = false,
  onOpen,
  onPathChange,
  onOpenInNewWindowChange,
}: CodeLaunchButtonProps) {
  const [open, setOpen] = useState(false)
  const [draftPath, setDraftPath] = useState(path)
  const [pathError, setPathError] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) setDraftPath(path)
  }, [open, path])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const baseClass = active
    ? 'bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-200 dark:hover:bg-blue-900/60'
    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'

  const submit = () => {
    const normalized = normalizeCodePath(draftPath)
    if (!normalized) {
      setPathError('Enter an absolute POSIX path.')
      return
    }
    setPathError('')
    onPathChange(normalized)
    onOpen(normalized)
    setOpen(false)
  }

  return (
    <div className="relative" ref={rootRef}>
      <div className="flex w-full items-stretch gap-1">
        <button
          type="button"
          onClick={() => onOpen(path)}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${baseClass}`}
          title={`Open code${openInNewWindow ? ' in a new browser tab' : ''}`}
        >
          <Code2 className="h-4 w-4" />
          <span>Code</span>
          {openInNewWindow && <ExternalLink className="h-3.5 w-3.5 opacity-70" aria-hidden="true" />}
        </button>
        <button
          type="button"
          onClick={() => {
            setPathError('')
            setOpen((value) => !value)
          }}
          className={`inline-flex items-center justify-center rounded-lg px-2 transition-colors ${baseClass}`}
          title="Code options"
          aria-label="Open code options"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-800">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">Open code</div>
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Node</label>
              <select
                value="master"
                disabled
                className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700 disabled:opacity-100 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
              >
                <option value="master">master</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Path</label>
              <input
                value={draftPath}
                onChange={(event) => {
                  setDraftPath(event.target.value)
                  setPathError('')
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submit()
                }}
                placeholder="/"
                aria-invalid={pathError ? 'true' : undefined}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
              {pathError && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{pathError}</div>}
            </div>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-1 py-1 text-sm text-gray-700 dark:text-gray-200">
              <span>Open in new browser tab</span>
              <input
                type="checkbox"
                checked={openInNewWindow}
                onChange={(event) => onOpenInNewWindowChange(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
              >
                Open code
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
