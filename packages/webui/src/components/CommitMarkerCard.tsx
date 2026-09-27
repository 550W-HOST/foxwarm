import { memo, useState } from 'react'
import { GitCommit, ExternalLink } from 'lucide-react'
import type { CodeCommitTarget } from '../commitMarker'

export type OpenCodeCommitHandler = (target: CodeCommitTarget) => void | Promise<void>

const CommitMarkerCard = memo(function CommitMarkerCard({ target, onOpen }: {
  target: CodeCommitTarget
  onOpen?: OpenCodeCommitHandler
}) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const open = async () => {
    if (!onOpen || opening) return
    setOpening(true)
    setError('')
    try {
      await onOpen(target)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="my-2 rounded-lg border border-fw-special-border bg-fw-special-surface/80 px-3 py-2 text-fw-special dark:border-fw-special-border dark:bg-fw-special-surface/30 dark:text-fw-special">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs text-fw-special dark:text-fw-special">
          <GitCommit size={14} className="shrink-0" aria-hidden="true" />
          <span className="shrink-0 font-semibold uppercase tracking-wide">Commit</span>
          <code className="shrink-0" title={target.commitId}>{target.commitId.slice(0, 12)}</code>
          <span className="min-w-0 truncate font-mono text-[11px] text-fw-special/80 dark:text-fw-special/80" title={`${target.nodeId}:${target.path}`}>
            {target.nodeId}:{target.path}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void open()}
          disabled={!onOpen || opening}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-fw-special-border bg-fw-surface px-2.5 py-1.5 text-xs font-medium text-fw-special shadow-sm transition hover:bg-fw-special-surface disabled:cursor-not-allowed disabled:opacity-50 dark:border-fw-special-border dark:bg-fw-special-surface/50 dark:text-fw-special dark:hover:bg-fw-special-surface/60"
          title={onOpen ? 'Open commit details in Code' : 'Code is unavailable'}
        >
          <ExternalLink size={13} aria-hidden="true" />
          {opening ? 'Opening…' : 'Open in Code'}
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-fw-danger dark:text-fw-danger">{error}</div>}
    </div>
  )
})

export default CommitMarkerCard
