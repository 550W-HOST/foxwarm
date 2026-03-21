import { useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderOpen, SquareTerminal } from 'lucide-react'

type CreateTabKind = 'workspace' | 'terminal'

interface CreateTabButtonProps {
  kind: CreateTabKind
  defaultNodeId: string
  defaultPath: string
  sessionLabel: string
  onCreate: (options: { nodeId: string; path: string }) => void
}

export default function CreateTabButton({ kind, defaultNodeId, defaultPath, sessionLabel, onCreate }: CreateTabButtonProps) {
  const [open, setOpen] = useState(false)
  const [nodeId, setNodeId] = useState(defaultNodeId || 'master')
  const [path, setPath] = useState(defaultPath || '')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setNodeId(defaultNodeId || 'master')
  }, [defaultNodeId])

  useEffect(() => {
    setPath(defaultPath || '')
  }, [defaultPath])

  useEffect(() => {
    if (!open) return

    const handleClickOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const isWorkspace = kind === 'workspace'
  const Icon = isWorkspace ? FolderOpen : SquareTerminal
  const label = isWorkspace ? 'Workspace' : 'Terminal'
  const baseClass = 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'

  const handleDefaultCreate = () => {
    onCreate({ nodeId: defaultNodeId || 'master', path: defaultPath || '/' })
  }

  const handleCustomCreate = () => {
    onCreate({ nodeId: nodeId || 'master', path: path || '/' })
    setOpen(false)
  }

  return (
    <div className="relative" ref={rootRef}>
      <div className="flex w-full items-stretch gap-1">
        <button
          onClick={handleDefaultCreate}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${baseClass}`}
          title={`Create ${label.toLowerCase()} tab`}
        >
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </button>
        <button
          onClick={() => setOpen((value) => !value)}
          className={`inline-flex items-center justify-center rounded-lg px-2 transition-colors ${baseClass}`}
          title={`Custom ${label.toLowerCase()} tab`}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-80 rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-800">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">Create {label.toLowerCase()} tab</div>
          <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">Default context: {sessionLabel}</div>
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Node</label>
              <select
                value={nodeId}
                onChange={(event) => setNodeId(event.target.value)}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="master">master</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Path</label>
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder={isWorkspace ? '/home/ldmbot/git/foxwarm' : '/tmp'}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleCustomCreate}
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700"
              >
                Create tab
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}