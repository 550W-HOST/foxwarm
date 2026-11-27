import { createContext, useContext, useId, useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ClipboardList, MessagesSquare } from 'lucide-react'
import { clampContentStyle, SessionHashLink } from './chatShared'
import { taskEventLabel, taskMessageLayout, type SessionCommunication } from './sessionCommunications'
import { useThreadCardHeightTransition } from './useThreadCardHeightTransition'
import { useThreadCardOverflowFade } from './useThreadCardOverflowFade'

export const SessionMessageNamesContext = createContext<Record<string, string>>({})

/** Opens Tasks with one Task selected; absent where Tasks is unavailable, such as scoped identities. */
export const TaskLinkContext = createContext<((taskId: string) => void) | null>(null)

/**
 * `children` renders the full body. `renderPreview` renders another text, used while collapsed when a
 * Task notification starts with generated lead lines, so the preview starts at its content.
 */
export default function SessionMessageCard({ communication, children, renderPreview, searchReveal = false }: { communication: SessionCommunication; children: ReactNode; renderPreview?: (text: string) => ReactNode; searchReveal?: boolean }) {
  // Retain the control after a manual collapse, including its keyboard focus.
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const revealed = expanded === true || searchReveal
  const { ref, prepare } = useThreadCardHeightTransition(revealed)
  const fade = useThreadCardOverflowFade<HTMLDivElement>('bottom', !revealed)
  const bodyId = useId()
  const names = useContext(SessionMessageNamesContext)
  const sent = communication.direction === 'sent'
  const peer = communication.peerSessionId
  const openTask = useContext(TaskLinkContext)
  const task = communication.task
  const user = communication.origin === 'user'
  const label = user ? 'you' : typeof names[peer] === 'string' && names[peer] || (peer === '<parent>' ? 'Parent session' : peer === '<main>' ? 'Main session' : peer)
  const Icon = task ? ClipboardList : MessagesSquare
  const layout = taskMessageLayout(communication)
  // The collapsed preview omits the lead lines, so the card can always reveal them.
  const preview = !revealed && layout?.preview && renderPreview ? renderPreview(layout.preview) : null
  return <div ref={ref} role="region" data-session-communication={communication.direction} data-task-event={task?.event} aria-label={user ? 'From you' : `${sent ? 'To' : 'From'} Session ${label}`}
    className="my-1 min-w-0 rounded-lg border border-fw-system-border bg-fw-system-surface/35 px-3 py-2.5 dark:bg-fw-system-surface/10">
    <header className="mb-2 flex min-w-0 items-center gap-1.5 text-xs text-fw-text-muted">
      <Icon size={14} aria-hidden="true" className="shrink-0" />
      {sent ? <ArrowUpRight size={13} aria-hidden="true" className="shrink-0" /> : <ArrowDownLeft size={13} aria-hidden="true" className="shrink-0" />}
      <span>{sent ? 'To' : 'From'}</span>
      <span className="min-w-0 truncate font-medium" title={user ? undefined : peer}>{user || peer.startsWith('<') ? label : <SessionHashLink sessionId={peer} displayName={label} className="text-fw-text-strong" />}</span>
      {task && <><span aria-hidden="true">·</span><span className="shrink-0" data-task-event-label>{taskEventLabel(task)}</span></>}
      {layout && <><span aria-hidden="true">·</span><span className="min-w-0 truncate text-fw-text" data-task-title title={layout.title}>{layout.title}</span></>}
      {communication.origin === 'background' && <><span aria-hidden="true">·</span><span className="shrink-0" data-background-delivery>From a background run</span></>}
      {(communication.truncated || task && openTask) && <span className="ml-auto flex shrink-0 items-center gap-2">
        {communication.truncated && <span className="text-fw-text-muted">Preview</span>}
        {task && openTask && <button type="button" data-task-link={task.taskId} title={task.title || task.taskId} aria-label={`Open Task ${task.taskId}`}
          className="rounded px-1 py-0.5 font-mono text-[11px] text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong focus-visible:outline focus-visible:outline-fw-focus-ring"
          onClick={() => openTask(task.taskId)}>{task.taskId}</button>}
      </span>}
    </header>
    <div id={bodyId} ref={fade.ref} {...fade.overflowFadeProps} data-search-surface="communication" data-search-part-index="0" className={`min-w-0 max-w-full ${revealed ? '' : '[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1'}`}
      style={revealed ? undefined : { ...clampContentStyle(3), ...fade.overflowFadeProps.style }} data-task-preview={preview ? '' : undefined}>{preview ?? children}</div>
    {(expanded !== null || revealed || preview || fade.overflowFadeProps['data-overflow-fade']) && <button type="button" aria-expanded={revealed} aria-controls={bodyId}
      aria-label={revealed ? 'Collapse message' : 'Expand message'}
      className="mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs text-fw-text-muted hover:bg-fw-hover focus-visible:outline focus-visible:outline-fw-focus-ring"
      onClick={() => { prepare(); setExpanded(value => !value) }}>
      <ChevronDown size={13} aria-hidden="true" className={revealed ? 'rotate-180' : ''} />{revealed ? 'Collapse message' : 'Expand message'}
    </button>}
  </div>
}
