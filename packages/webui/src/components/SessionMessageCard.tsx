import { createContext, useContext, useId, useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronDown, MessagesSquare } from 'lucide-react'
import { clampContentStyle, SessionHashLink } from './chatShared'
import type { SessionCommunication } from './sessionCommunications'
import { useThreadCardHeightTransition } from './useThreadCardHeightTransition'
import { useThreadCardOverflowFade } from './useThreadCardOverflowFade'

export const SessionMessageNamesContext = createContext<Record<string, string>>({})

export default function SessionMessageCard({ communication, children, searchReveal = false }: { communication: SessionCommunication; children: ReactNode; searchReveal?: boolean }) {
  // Retain the control after a manual collapse, including its keyboard focus.
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const revealed = expanded === true || searchReveal
  const { ref, prepare } = useThreadCardHeightTransition(revealed)
  const fade = useThreadCardOverflowFade<HTMLDivElement>('bottom', !revealed)
  const bodyId = useId()
  const names = useContext(SessionMessageNamesContext)
  const sent = communication.direction === 'sent'
  const peer = communication.peerSessionId
  const label = typeof names[peer] === 'string' && names[peer] || (peer === '<parent>' ? 'Parent session' : peer === '<main>' ? 'Main session' : peer)
  return <div ref={ref} role="region" data-session-communication={communication.direction} aria-label={`${sent ? 'To' : 'From'} Session ${label}`}
    className="my-1 min-w-0 rounded-lg border border-fw-system-border bg-fw-system-surface/35 px-3 py-2.5 dark:bg-fw-system-surface/10">
    <header className="mb-2 flex min-w-0 items-center gap-1.5 text-xs text-fw-text-muted">
      <MessagesSquare size={14} aria-hidden="true" className="shrink-0" />
      {sent ? <ArrowUpRight size={13} aria-hidden="true" className="shrink-0" /> : <ArrowDownLeft size={13} aria-hidden="true" className="shrink-0" />}
      <span>{sent ? 'To' : 'From'}</span>
      <span className="min-w-0 truncate font-medium" title={peer}>{peer.startsWith('<') ? label : <SessionHashLink sessionId={peer} displayName={label} className="text-fw-text-strong" />}</span>
      {communication.truncated && <span className="ml-auto shrink-0 text-fw-text-muted">Preview</span>}
    </header>
    <div id={bodyId} ref={fade.ref} {...fade.overflowFadeProps} data-search-surface="communication" className={`min-w-0 max-w-full ${revealed ? '' : '[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1'}`}
      style={revealed ? undefined : { ...clampContentStyle(3), ...fade.overflowFadeProps.style }}>{children}</div>
    {(expanded !== null || revealed || fade.overflowFadeProps['data-overflow-fade']) && <button type="button" aria-expanded={revealed} aria-controls={bodyId}
      aria-label={revealed ? 'Collapse message' : 'Expand message'}
      className="mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-fw-text-muted hover:bg-fw-hover focus-visible:outline focus-visible:outline-fw-focus-ring"
      onClick={() => { prepare(); setExpanded(value => !value) }}>
      <ChevronDown size={13} aria-hidden="true" className={revealed ? 'rotate-180' : ''} />{revealed ? 'Collapse message' : 'Expand message'}
    </button>}
  </div>
}
