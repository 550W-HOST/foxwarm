import { useEffect, useRef, useState } from 'react'
import { ChevronDown, SquareTerminal } from 'lucide-react'
import NodeTargetSelect from './NodeTargetSelect'
import { getNodeTargetAvailability, MASTER_NODE_TARGET, preserveSelectedNodeTarget, type WebUiNodeTarget } from '../nodeTargets'
import { selectLauncherDraftNode } from '../launcherDraft'

interface CreateTabButtonProps {
  defaultNodeId: string
  defaultPath: string
  onCreate: (options: { nodeId: string; path: string }) => void
  nodeTargets?: readonly WebUiNodeTarget[]
  nodeTargetsError?: string
  onRefreshNodeTargets?: () => void
}

export default function CreateTabButton({ defaultNodeId, defaultPath, onCreate, nodeTargets, nodeTargetsError, onRefreshNodeTargets }: CreateTabButtonProps) {
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

  const label = 'Terminal'
  const baseClass = 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700/60 dark:text-gray-200 dark:hover:bg-gray-700'
  const availableTargets = nodeTargets || [MASTER_NODE_TARGET]
  const selectedTarget = preserveSelectedNodeTarget(availableTargets, nodeId).find(node => node.id === nodeId)
  const selectedAvailability = selectedTarget ? getNodeTargetAvailability(selectedTarget, 'vscode-pty') : { available: false, reason: 'unavailable' }
  const customCreateAvailable = nodeTargets ? selectedAvailability.available : true

  const handleDefaultCreate = () => {
    onCreate({ nodeId: defaultNodeId || 'master', path: defaultPath || '/' })
  }

  const handleCustomCreate = () => {
    onCreate({ nodeId: nodeId || 'master', path: path || '/' })
    setOpen(false)
  }

  const handleNodeChange = (nextNodeId: string) => {
    const nextDraft = selectLauncherDraftNode({ nodeId, path }, nextNodeId)
    if (nextDraft.nodeId === nodeId) return
    setNodeId(nextDraft.nodeId)
    setPath(nextDraft.path)
  }

  return (
    <div className="relative" ref={rootRef}>
      <div className="flex w-full items-stretch gap-1">
        <button
          onClick={handleDefaultCreate}
          className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${baseClass}`}
          title={`Create ${label.toLowerCase()} tab`}
        >
          <SquareTerminal className="h-4 w-4" />
          <span>{label}</span>
        </button>
        <button
          onClick={() => {
            setOpen((value) => {
              if (!value) onRefreshNodeTargets?.()
              return !value
            })
          }}
          className={`inline-flex items-center justify-center rounded-lg px-2 transition-colors ${baseClass}`}
          title={`Custom ${label.toLowerCase()} tab`}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-700 dark:bg-gray-800">
          <div className="text-sm font-semibold text-gray-900 dark:text-white">Create {label.toLowerCase()} tab</div>
          <div className="mt-3 space-y-3">
            {nodeTargets && <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Node</label>
              <NodeTargetSelect
                value={nodeId}
                nodes={availableTargets}
                requiredService="vscode-pty"
                onChange={handleNodeChange}
              />
              {nodeTargetsError && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{nodeTargetsError}</div>}
              {!selectedAvailability.available && !nodeTargetsError && (
                <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">Selected node is {selectedAvailability.reason}.</div>
              )}
            </div>}
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Path</label>
              <input
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="/tmp"
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
                disabled={!customCreateAvailable}
                className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
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