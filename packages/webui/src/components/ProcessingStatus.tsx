import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import RuntimeFox from './RuntimeFox'
import FoxThinkingText from './FoxThinkingText'
import type { TimelineView } from '../chatPreferences'
import { isRuntimeStateInactiveName, type SessionRuntimeState } from '../sessionRuntimeState'
import { getRuntimeStatusView, type RuntimeStatusView } from '../runtimeStatus'

import type { SessionControlAction, SessionControlFeedback } from '../../../shared/src/sessionControlFeedback'

interface ProcessingStatusProps {
  sessionBusy: boolean
  runtimeState?: SessionRuntimeState
  sessionQueueLength: number
  turnIncomplete: boolean
  loading: boolean
  isMobile: boolean
  timelineView?: TimelineView
  pendingControl?: SessionControlAction | null
  controlFeedback?: SessionControlFeedback | null
  failure?: { title: string; details?: string } | null
  onContinue?: () => void
  onCancelCompaction?: () => void
}

const controlButtonClass = 'inline-flex shrink-0 items-center rounded-md px-2 text-fw-text-muted transition-colors hover:bg-fw-hover hover:text-fw-text-strong focus-visible:underline disabled:cursor-not-allowed'
const toneClasses = { accent: 'text-fw-accent', special: 'text-fw-special', warning: 'text-fw-warning', danger: 'text-fw-danger', muted: 'text-fw-text-muted' }
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

const ProcessingStatus = memo(function ProcessingStatus({ sessionBusy, runtimeState, sessionQueueLength, turnIncomplete, loading, isMobile, pendingControl, controlFeedback, failure, onContinue, onCancelCompaction }: ProcessingStatusProps) {
  const [now, setNow] = useState(Date.now)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; bottom?: number; top?: number; width: number; maxHeight: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const retry = runtimeState?.retry || runtimeState?.compaction?.retry
  useEffect(() => {
    if (!retry?.retryAt) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [retry?.retryAt])

  let view: RuntimeStatusView | null = getRuntimeStatusView(runtimeState, sessionBusy, now)
  const state = runtimeState?.state || (sessionBusy ? 'requesting-model' : 'idle')
  const continuable = isRuntimeStateInactiveName(state) && turnIncomplete && !loading
  const interrupted = state === 'idle' && continuable
  if (interrupted) view = { kind: failure ? 'error' : 'interrupted', tone: failure ? 'danger' : 'warning', label: failure?.title || 'Interrupted', details: failure?.details ? [['Error', failure.details]] : [] }
  if (loading && !view) view = { kind: 'request', tone: 'accent', label: 'Sending…', details: [] }
  if (pendingControl && !(pendingControl === 'continue' && runtimeState && !isRuntimeStateInactiveName(runtimeState.state))) view = {
    kind: pendingControl === 'stop' || pendingControl === 'cancel-compaction' ? 'stopping' : pendingControl === 'compact' ? 'compact' : 'request',
    tone: pendingControl === 'stop' || pendingControl === 'cancel-compaction' ? 'warning' : 'accent',
    label: pendingControl === 'stop' ? 'Stopping…' : pendingControl === 'cancel-compaction' ? 'Cancelling compaction…' : pendingControl === 'dequeue' ? 'Starting queued messages…' : pendingControl === 'compact' ? 'Starting compaction…' : 'Continuing…', details: view?.details || [],
  }
  const hasDetails = !!view?.details.length || !!runtimeState?.compaction && !!onCancelCompaction
  const visible = !!view

  useBrowserLayoutEffect(() => {
    if (!open || !visible) return
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(420, window.innerWidth - 24)
      if (rect.bottom < 0 || rect.top > window.innerHeight) { setOpen(false); return }
      const aboveSpace = rect.top - 12, belowSpace = window.innerHeight - rect.bottom - 12
      const above = aboveSpace >= 160 || aboveSpace >= belowSpace
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width,
        maxHeight: Math.max(32, Math.min(448, (above ? aboveSpace : belowSpace) - 8)),
        ...(above ? { bottom: Math.max(12, window.innerHeight - rect.top + 8) } : { top: Math.max(12, rect.bottom + 8) }),
      })
    }
    update()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => { window.removeEventListener('resize', update); document.removeEventListener('scroll', update, true) }
  }, [open, visible])
  useEffect(() => { if (!visible || !hasDetails) setOpen(false) }, [visible, hasDetails])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus({ preventScroll: true }) } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open])

  useEffect(() => { if (open && position) panel.current?.focus({ preventScroll: true }) }, [open, position !== null])

  const caption = view && <>
    <RuntimeFox kind={view.kind} />
    {view.playful ? <FoxThinkingText label={view.label} title={view.label} /> : <span className="min-w-0 truncate" title={view.label}>{view.label}</span>}
  </>
  return <div data-processing-status-slot className={sessionQueueLength > 0 ? 'flex min-h-14 items-end pt-4' : 'flex min-h-14 items-end'}>
    {(view || controlFeedback && controlFeedback.status !== 'accepted') && <div className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 ${isMobile ? 'w-full' : 'w-full max-w-[80%]'}`}>
      {view && <div role="status" aria-label={view.label} aria-atomic="true" className="fw-processing-main flex min-w-0 max-w-full items-center gap-3" data-processing-runtime-state={interrupted ? 'interrupted' : runtimeState?.state || (sessionBusy ? 'requesting-model' : 'idle')} data-runtime-presentation={view.kind}>
        {hasDetails ? <button data-runtime-caption ref={trigger} type="button" aria-label={`Runtime details: ${view.label}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(previous => !previous)} className={`inline-flex min-h-8 min-w-0 max-w-full items-center gap-2.5 text-left ${view.secondary ? 'text-sm' : 'text-lg'} leading-7 ${toneClasses[view.tone]} hover:opacity-80 focus-visible:underline`}>
          {caption}
        </button> : <div data-runtime-caption className={`inline-flex min-h-8 min-w-0 max-w-full items-center gap-2.5 ${view.secondary ? 'text-sm' : 'text-lg'} leading-7 ${toneClasses[view.tone]}`}>{caption}</div>}
        {continuable && onContinue && <button type="button" disabled={!!pendingControl} onClick={onContinue} className={`${controlButtonClass} h-8 text-sm`}>Continue</button>}
      </div>}
      {controlFeedback && controlFeedback.status !== 'accepted' && <div role={controlFeedback.status === 'error' ? 'alert' : 'status'} data-control-feedback className={`w-full text-xs ${controlFeedback.status === 'error' ? 'text-fw-danger' : 'text-fw-text-muted'}`}>{controlFeedback.message}{controlFeedback.details && <details className="mt-1 text-fw-text-muted"><summary className="w-fit cursor-pointer">Details</summary><p className="mt-1 whitespace-pre-wrap break-words">{controlFeedback.details}</p></details>}</div>}
    </div>}
    {open && view && createPortal(<div ref={panel} role="dialog" aria-label="Runtime details" tabIndex={-1} data-runtime-details className="fixed z-[100] max-h-[min(28rem,calc(100dvh-2rem))] overflow-y-auto rounded-lg border border-fw-border bg-fw-surface p-4 text-sm text-fw-text shadow-xl" style={{ ...position, visibility: position ? 'visible' : 'hidden' }}>
      <h3 className="mb-3 font-medium text-fw-text-strong">{view.label}</h3>
      <dl className="space-y-2">{view.details.map(([label, value], index) => <div key={`${label}:${index}`}><dt className="text-xs text-fw-text-muted">{label}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words text-xs">{value}</dd></div>)}</dl>
      {runtimeState?.compaction && onCancelCompaction && <button type="button" disabled={!!pendingControl} onClick={onCancelCompaction} className={`${controlButtonClass} mt-3 min-h-9 text-sm`}>Cancel compaction</button>}
    </div>, document.body)}
  </div>
})

export default ProcessingStatus
/** Queue controls belong to the final visible message, not the runtime status row. */
export const QueuedMessageStatus = memo(function QueuedMessageStatus({ count, alignment, isMobile, onRunQueued, disabled = false }: {
  count: number
  alignment: 'left' | 'right'
  isMobile: boolean
  onRunQueued?: () => void
  disabled?: boolean
}) {
  if (count <= 0) return null
  return (
    <div data-processing-queue-footer data-alignment={alignment} className={`mt-1.5 flex w-full min-w-0 ${alignment === 'right' ? 'justify-end' : 'justify-start'}`}>
      <div data-processing-queue-status role="status" className={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs leading-5 text-fw-text-muted ${isMobile ? 'max-w-full' : 'max-w-[80%]'} ${alignment === 'right' ? 'justify-end text-right' : 'justify-start text-left'}`}>
        <span>{count} queued</span>
        {onRunQueued && <button type="button" disabled={disabled} onClick={onRunQueued} className={`${controlButtonClass} text-xs leading-5`}>Run queued</button>}
      </div>
    </div>
  )
})
