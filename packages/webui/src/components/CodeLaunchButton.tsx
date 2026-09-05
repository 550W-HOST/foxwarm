import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Code2, ExternalLink } from 'lucide-react'
import { normalizeCodePath } from '../vscodeWeb'
import NodeTargetSelect from './NodeTargetSelect'
import { getNodeTargetAvailability, preserveSelectedNodeTarget, type WebUiNodeTarget } from '../nodeTargets'
import { selectLauncherDraftNode } from '../launcherDraft'

interface CodeLaunchButtonProps {
  path: string
  nodeId: string
  nodeTargets: readonly WebUiNodeTarget[]
  nodeTargetsError?: string
  openInNewWindow: boolean
  active?: boolean
  onOpen: (nodeId: string, path: string) => void
  onNodeChange: (nodeId: string) => void
  onPathChange: (path: string) => void
  onOpenInNewWindowChange: (enabled: boolean) => void
  onRefreshNodeTargets?: () => void
}

export default function CodeLaunchButton({
  path,
  nodeId,
  nodeTargets,
  nodeTargetsError,
  openInNewWindow,
  active = false,
  onOpen,
  onNodeChange,
  onPathChange,
  onOpenInNewWindowChange,
  onRefreshNodeTargets,
}: CodeLaunchButtonProps) {
  const [open, setOpen] = useState(false)
  const [draftPath, setDraftPath] = useState(path)
  const [draftNodeId, setDraftNodeId] = useState(nodeId)
  const [pathError, setPathError] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) {
      setDraftPath(path)
      setDraftNodeId(nodeId)
    }
  }, [nodeId, open, path])

  useEffect(() => {
    if (!open) return
    const handleClickOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const baseClass = active
    ? 'bg-fw-accent-surface text-fw-accent hover:bg-fw-accent-surface-strong dark:bg-fw-accent-surface-strong/40 dark:text-fw-accent dark:hover:bg-fw-accent-surface-strong/60'
    : 'bg-fw-neutral-surface text-fw-text hover:bg-fw-hover dark:bg-fw-surface-raised/60 dark:text-fw-text-strong dark:hover:bg-fw-hover'
  const selectedTarget = preserveSelectedNodeTarget(nodeTargets, draftNodeId).find(node => node.id === draftNodeId)
  const selectedAvailability = selectedTarget ? getNodeTargetAvailability(selectedTarget, 'vscode-fs') : { available: false, reason: 'unavailable' }

  const submit = () => {
    if (!selectedAvailability.available) return
    const normalized = normalizeCodePath(draftPath)
    if (!normalized) {
      setPathError('Enter an absolute POSIX path.')
      return
    }
    setPathError('')
    onNodeChange(draftNodeId)
    onPathChange(normalized)
    onOpen(draftNodeId, normalized)
    setOpen(false)
  }

  const handleNodeChange = (nextNodeId: string) => {
    const nextDraft = selectLauncherDraftNode({ nodeId: draftNodeId, path: draftPath }, nextNodeId)
    if (nextDraft.nodeId === draftNodeId) return
    setDraftNodeId(nextDraft.nodeId)
    setDraftPath(nextDraft.path)
    setPathError('')
  }

  return (
    <div className="relative" ref={rootRef}>
      <div className="flex w-full items-stretch gap-1">
        <button
          type="button"
          onClick={() => onOpen(nodeId, path)}
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
            setOpen((value) => {
              if (!value) onRefreshNodeTargets?.()
              return !value
            })
          }}
          className={`inline-flex items-center justify-center rounded-lg px-2 transition-colors ${baseClass}`}
          title="Code options"
          aria-label="Open code options"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-fw-border bg-fw-surface p-3 shadow-xl dark:border-fw-border dark:bg-fw-surface">
          <div className="text-sm font-semibold text-fw-text-strong">Open code</div>
          <div className="mt-3 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-fw-text-muted">Node</label>
              <NodeTargetSelect
                value={draftNodeId}
                nodes={nodeTargets}
                requiredService="vscode-fs"
                onChange={handleNodeChange}
              />
              {nodeTargetsError && <div className="mt-1 text-xs text-fw-danger dark:text-fw-danger">{nodeTargetsError}</div>}
              {!selectedAvailability.available && !nodeTargetsError && (
                <div className="mt-1 text-xs text-fw-warning dark:text-fw-warning">Selected node is {selectedAvailability.reason}.</div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-fw-text-muted">Path</label>
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
                className="w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-sm text-fw-text-strong dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-strong"
              />
              {pathError && <div className="mt-1 text-xs text-fw-danger dark:text-fw-danger">{pathError}</div>}
            </div>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-1 py-1 text-sm text-fw-text-strong">
              <span>Open in new browser tab</span>
              <input
                type="checkbox"
                checked={openInNewWindow}
                onChange={(event) => onOpenInNewWindowChange(event.target.checked)}
                className="h-4 w-4 rounded border-fw-border-strong text-fw-accent"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-2 text-sm text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!selectedAvailability.available}
                className="rounded-lg bg-fw-accent px-3 py-2 text-sm text-fw-text-inverse hover:bg-fw-accent disabled:cursor-not-allowed disabled:opacity-50"
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
