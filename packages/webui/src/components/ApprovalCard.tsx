import { useEffect, useRef, useState } from 'react'
import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import {
  ApprovalDecisionError,
  approvalArgsText,
  approvalOriginLabel,
  approvalTargets,
  approvalTimeLeft,
  approvalToolLabel,
  buildApprovalDecisionBody,
  describeApprovalOutcome,
  approvalWorkingDirectoryLabel,
  fetchApprovalArgs,
  type ApprovalDecisionBody,
  type ToolApprovalMeta,
  type ToolApprovalRecord,
} from '../sessionApprovals'

function useNow(active: boolean, intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [active, intervalMs])
  return now
}

function ApprovalArguments({ record, sessionId }: { record: ToolApprovalRecord; sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const text = full ?? approvalArgsText(record)
  if (!text) return null
  const loadFull = async () => {
    setLoading(true)
    setError(null)
    try { setFull(JSON.stringify(await fetchApprovalArgs(sessionId, record.id), null, 2)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Arguments could not be loaded.') }
    finally { setLoading(false) }
  }
  return (
    <div className="mt-2 min-w-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="text-xs text-fw-text-muted hover:text-fw-text hover:underline">
        {open ? 'Hide arguments' : 'Show arguments'}
      </button>
      {open && (
        <>
          <pre data-approval-args className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md border border-fw-border-muted bg-fw-surface-sunken/50 px-2 py-1.5 font-mono text-xs text-fw-text">{text}</pre>
          {record.argsTruncated && full === null && (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fw-text-muted">
              <span>Shortened for display.</span>
              <button type="button" data-approval-args-full disabled={loading} onClick={() => void loadFull()} className="hover:text-fw-text hover:underline disabled:opacity-50">
                {loading ? 'Loading…' : 'Show all'}
              </button>
            </div>
          )}
          {error && <div role="alert" className="mt-1 text-xs text-fw-danger">{error}</div>}
        </>
      )}
    </div>
  )
}

/** Review and decision form for one pending tool approval. */
export function ApprovalDecisionForm({ record, sessionId, onDecide, focusToken = 0 }: {
  record: ToolApprovalRecord
  sessionId: string
  onDecide: (body: ApprovalDecisionBody) => Promise<void>
  /** Changing a nonzero value moves keyboard focus into the form. */
  focusToken?: number
}) {
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const now = useNow(!!record.expiresAt)
  useEffect(() => { setNote(''); setError(null) }, [record.id])
  useEffect(() => {
    if (!focusToken) return
    rootRef.current?.scrollIntoView({ block: 'nearest' })
    rootRef.current?.focus({ preventScroll: true })
  }, [focusToken])
  const send = async (decision: ApprovalDecisionBody['decision']) => {
    if (pending) return
    setPending(true)
    setError(null)
    try { await onDecide(buildApprovalDecisionBody(decision, note)) }
    catch (cause) {
      setError(cause instanceof ApprovalDecisionError && cause.notPending ? 'This request was already settled.' : cause instanceof Error ? cause.message : 'The decision could not be sent.')
    } finally { setPending(false) }
  }
  const targets = approvalTargets(record)
  const origin = approvalOriginLabel(record.origin)
  const timeLeft = approvalTimeLeft(record.expiresAt, now)
  const workingDirectory = approvalWorkingDirectoryLabel(record)
  return (
    <div ref={rootRef} tabIndex={-1} data-approval-form={record.id} className="min-w-0 outline-none">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-sm font-medium text-fw-text-strong">{approvalToolLabel(record.tool)}</span>
        {record.tool.executionNode && <span className="text-xs text-fw-text-muted">on {record.tool.executionNode}</span>}
        {origin && <span className="text-xs text-fw-text-muted">· {origin}</span>}
        {timeLeft && <span data-approval-deadline className="ml-auto text-xs text-fw-text-muted">{timeLeft}</span>}
      </div>
      {record.summary && <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs text-fw-text">{record.summary}</div>}
      {workingDirectory && <div data-approval-cwd className="mt-0.5 min-w-0 truncate font-mono text-xs text-fw-text-muted" title={workingDirectory}>{workingDirectory}</div>}
      {!!targets.length && (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-fw-text-muted">
          {targets.map(target => <li key={target} className="min-w-0 truncate font-mono" title={target}>{target}</li>)}
        </ul>
      )}
      {!!record.rules?.length && (
        <ul className="mt-1.5 flex flex-col gap-0.5 text-xs text-fw-text-muted">
          {record.rules.map(rule => (
            <li key={`${rule.layer}:${rule.id}`} className="min-w-0 break-words">
              <span className="text-fw-text">{rule.id === 'defaultAction' ? 'Default policy' : `Rule ${rule.id}`}</span>
              {rule.layer !== 'global' && <span> · {rule.layer.replace(/^agent:/, 'Agent ')}</span>}
              {rule.reason && <span> — {rule.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      <ApprovalArguments record={record} sessionId={sessionId} />
      {record.canDecide === false ? (
        <div className="mt-3 text-xs text-fw-text-muted">Waiting for an approver.</div>
      ) : (
        <>
          <label className="mt-2 block text-xs text-fw-text-muted">
            Note
            <textarea value={note} onChange={event => setNote(event.target.value)} rows={1} disabled={pending} placeholder="Optional note for the agent"
              className="mt-1 block w-full resize-y rounded-md border border-fw-border bg-fw-surface px-2 py-1.5 text-sm text-fw-text-strong outline-none placeholder:text-fw-text-muted focus:border-fw-accent-border focus:ring-1 focus:ring-fw-focus-ring" />
          </label>
          {error && <div role="alert" className="mt-2 text-xs text-fw-danger">{error}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" data-approval-decision="reject" disabled={pending} onClick={() => void send('reject')}
              className="rounded-md border border-fw-border px-2.5 py-1.5 text-sm text-fw-text hover:bg-fw-hover disabled:opacity-50">Reject</button>
            <span className="flex-1" />
            <button type="button" data-approval-decision="approve" disabled={pending} onClick={() => void send('approve')}
              className="rounded-md bg-fw-accent px-3 py-1.5 text-sm font-medium text-fw-accent-text hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
              {pending ? 'Sending…' : 'Approve'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Compact approval state on a tool call in the timeline. */
export function ToolApprovalNotice({ approval, onReview }: {
  approval: ToolApprovalMeta | ToolApprovalRecord
  onReview?: () => void
}) {
  const pending = approval.status === 'pending'
  const Icon = pending ? ShieldAlert : approval.status === 'approved' ? ShieldCheck : ShieldX
  const tone = pending ? 'text-fw-warning' : approval.status === 'approved' ? 'text-fw-text-muted' : 'text-fw-danger'
  return (
    <div data-tool-approval={approval.status} className="flex min-w-0 items-center gap-1.5 font-sans text-xs text-fw-text-muted" onClick={event => event.stopPropagation()}>
      <Icon size={13} aria-hidden="true" className={`shrink-0 ${tone}`} />
      <span className={`shrink-0 ${pending ? 'font-medium text-fw-warning' : ''}`}>{describeApprovalOutcome(approval)}</span>
      {approval.note && <span aria-hidden="true" className="shrink-0">·</span>}
      {approval.note && <span className="min-w-0 truncate" title={approval.note}>{approval.note}</span>}
      {pending && onReview && (
        <button type="button" data-tool-approval-review onClick={onReview} className="ml-1 shrink-0 rounded px-1.5 py-0.5 text-fw-text hover:bg-fw-hover hover:underline">Review</button>
      )}
    </div>
  )
}
