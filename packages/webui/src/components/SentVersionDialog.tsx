import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ShieldCheck, X } from 'lucide-react'
import {
  formatRedactionLabel, loadSentVersion, sentVersionSegments, sentVersionSlotLabel,
  type SentVersion, type SentVersionSlot,
} from '../textRedaction'
import { IconToggleButton } from './chatShared'

/** Whether the shown Session's model redacts text, so messages offer their sent version. */
export const SentVersionContext = createContext<{ sessionId: string; enabled: boolean }>({ sessionId: '', enabled: false })

/** One message to show; `callId` limits it to one tool call's input or result. */
export type SentVersionTarget = { seq: number; callId?: string }

const messageSeq = (meta: Record<string, unknown> | undefined): number | null => {
  const seq = meta?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : null
}

/** Targets for a message and, for tool calls, its result message. Empty when there is nothing to show. */
export function sentVersionTargets(items: Array<{ meta?: Record<string, unknown>; callId?: string } | undefined>): SentVersionTarget[] {
  const targets: SentVersionTarget[] = []
  for (const item of items) {
    const seq = item ? messageSeq(item.meta) : null
    if (seq !== null) targets.push(item!.callId ? { seq, callId: item!.callId } : { seq })
  }
  return targets
}

export const useSentVersionAvailable = () => {
  const { sessionId, enabled } = useContext(SentVersionContext)
  return enabled && !!sessionId
}

/** The message action that opens the sent version. Renders nothing for Sessions without redaction. */
export function SentVersionButton({ targets, size = 12 }: { targets: SentVersionTarget[]; size?: number }) {
  const { sessionId, enabled } = useContext(SentVersionContext)
  const [open, setOpen] = useState(false)
  if (!enabled || !sessionId || !targets.length) return null
  return <>
    <IconToggleButton onClick={(event) => { event.stopPropagation(); setOpen(true) }} active={open} title="Sent version">
      <ShieldCheck size={size} />
    </IconToggleButton>
    {open ? <SentVersionDialog sessionId={sessionId} targets={targets} onClose={() => setOpen(false)} /> : null}
  </>
}

function SlotText({ slot }: { slot: SentVersionSlot }) {
  return (
    <pre className="max-w-full whitespace-pre-wrap break-words rounded-lg bg-fw-section px-3 py-2 font-mono text-xs leading-relaxed text-fw-text-strong" data-sent-version-text>
      {sentVersionSegments(slot.text, slot.ranges).map((segment, index) => {
        if (!segment.range) return <span key={index}>{segment.text}</span>
        const label = formatRedactionLabel(segment.range.label)
        const description = segment.range.source === 'literal' ? `${label} · matched an earlier find` : `${label} · detected`
        return (
          <mark key={index} title={description} data-sent-version-range={segment.range.source} data-sent-version-label={segment.range.label}
            className={`rounded-sm px-0.5 text-inherit ${segment.range.source === 'literal' ? 'bg-fw-special/20 outline outline-1 outline-dashed outline-fw-special/60' : 'bg-fw-warning/25'}`}>
            {segment.text}
            <span className="sr-only"> ({description})</span>
          </mark>
        )
      })}
    </pre>
  )
}

const visibleSlots = (version: SentVersion, callId?: string): SentVersionSlot[] =>
  version.enabled ? version.slots.filter(slot => !callId || slot.callId === callId) : []

export function SentVersionDialog({ sessionId, targets, onClose }: { sessionId: string; targets: SentVersionTarget[]; onClose: () => void }) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [versions, setVersions] = useState<SentVersion[] | null>(null)
  const [error, setError] = useState(false)
  const key = targets.map(target => `${target.seq}:${target.callId || ''}`).join()

  useEffect(() => {
    const previousFocus = document.activeElement
    closeRef.current?.focus({ preventScroll: true })
    return () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }) }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setVersions(null)
    setError(false)
    Promise.all(targets.map(target => loadSentVersion(sessionId, target.seq, controller.signal)))
      .then(setVersions)
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [sessionId, key])

  const slots = versions ? versions.flatMap((version, index) => visibleSlots(version, targets[index].callId)) : []
  const known = slots.filter(slot => slot.available)
  const missing = slots.length - known.length
  const replaced = known.reduce((sum, slot) => sum + (slot.ranges?.length || 0), 0)
  const status = error ? 'error' : !versions ? 'loading' : !slots.length ? 'empty' : !known.length ? 'unavailable' : missing ? 'partial' : 'available'

  return createPortal(
    <div data-sent-version-overlay className="fixed inset-0 z-50 flex items-center justify-center bg-fw-overlay/50 p-2 sm:p-4"
      onClick={(event) => { event.stopPropagation(); onClose() }}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
      onKeyDown={(event) => event.stopPropagation()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-sent-version-dialog data-sent-version-state={status}
        className="flex max-h-[85vh] min-h-0 w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-fw-border bg-fw-surface shadow-2xl dark:bg-fw-canvas"
        onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-fw-border px-4 py-3">
          <div id={titleId} className="flex items-center gap-1.5 text-sm font-semibold text-fw-text-strong"><ShieldCheck className="h-4 w-4 text-fw-text-muted" aria-hidden="true" />Sent version</div>
          <button ref={closeRef} onClick={onClose} aria-label="Close" title="Close" className="rounded p-1 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-4 py-3" aria-busy={status === 'loading'}>
          <p role="status" className="text-xs text-fw-text-muted" data-sent-version-summary>
            {status === 'loading' ? 'Loading…'
              : status === 'error' ? 'The sent version could not be loaded.'
                : status === 'empty' ? 'This message has no text to redact.'
                  : status === 'unavailable' ? 'The sent version is no longer available, for example after a restart or a settings change.'
                    : replaced === 0 ? 'Sent unchanged.'
                      : `${replaced.toLocaleString('en')} ${replaced === 1 ? 'range was' : 'ranges were'} replaced before sending.`}
            {status === 'partial' ? ' Some parts are no longer available.' : ''}
          </p>
          {known.length && replaced ? (
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-fw-text-muted" aria-hidden="true">
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-fw-warning/25" />Detected</span>
              <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-fw-special/20 outline outline-1 outline-dashed outline-fw-special/60" />Matched an earlier find</span>
            </div>
          ) : null}
          {known.map((slot, index) => (
            <section key={index} className="space-y-1" data-sent-version-slot={slot.kind}>
              {slots.length > 1 || slot.kind !== 'text' ? <h3 className="truncate text-[11px] font-medium text-fw-text-muted">{sentVersionSlotLabel(slot)}</h3> : null}
              <SlotText slot={slot} />
            </section>
          ))}
        </div>
      </div>
    </div>, document.body,
  )
}
