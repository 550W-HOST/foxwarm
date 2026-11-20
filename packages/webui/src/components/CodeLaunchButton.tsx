import { useEffect, useRef, useState } from 'react'
import { Code2, ExternalLink } from 'lucide-react'
import { SidebarNavItem } from './SidebarNav'
import { normalizeCodePath } from '../vscodeWeb'
import NodeTargetSelect from './NodeTargetSelect'
import { getNodeTargetAvailability, preserveSelectedNodeTarget, type WebUiNodeTarget } from '../nodeTargets'
import { selectLauncherDraftNode } from '../launcherDraft'
import { newWindowCopy, useAppWindow } from '../appWindow'

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
  inlineOptions?: boolean
  onCancel?: () => void
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
  inlineOptions = false,
  onCancel,
}: CodeLaunchButtonProps) {
  const [open, setOpen] = useState(inlineOptions)
  const [draftPath, setDraftPath] = useState(path)
  const [draftNodeId, setDraftNodeId] = useState(nodeId)
  const [pathError, setPathError] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const copy = newWindowCopy(useAppWindow())

  useEffect(() => {
    if (!open) {
      setDraftPath(path)
      setDraftNodeId(nodeId)
    }
  }, [nodeId, open, path])

  useEffect(() => {
    if (!open || inlineOptions) return
    const handleClickOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, inlineOptions])

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
      {!inlineOptions && (
        <SidebarNavItem
          icon={Code2}
          label="Code"
          active={active}
          dataNav="code"
          onClick={() => onOpen(nodeId, path)}
          title={openInNewWindow ? copy.codeTooltip : 'Open code'}
          trailing={openInNewWindow ? <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" /> : undefined}
          options={{
            open,
            label: 'Open code options',
            onToggle: () => {
              setPathError('')
              setOpen((value) => {
                if (!value) onRefreshNodeTargets?.()
                return !value
              })
            },
          }}
        />
      )}

      {open && (
        <div className={inlineOptions ? 'min-w-0' : 'absolute left-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-fw-border bg-fw-surface p-3 shadow-xl dark:border-fw-border dark:bg-fw-surface'}>
          {!inlineOptions && <div className="text-sm font-semibold text-fw-text-strong">Open code</div>}
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
              <span>{copy.codeOption}</span>
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
                onClick={() => { setOpen(false); onCancel?.() }}
                className="rounded-lg border border-fw-border-strong px-3 py-2 text-sm text-fw-text hover:bg-fw-hover dark:text-fw-text dark:hover:bg-fw-hover"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!selectedAvailability.available}
                className="rounded-lg bg-fw-accent px-3 py-2 text-sm text-fw-accent-text hover:bg-fw-accent disabled:cursor-not-allowed disabled:opacity-50"
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
