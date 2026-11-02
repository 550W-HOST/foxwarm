import { memo } from 'react'
import { ExternalLink, Network, X } from 'lucide-react'
import {
  SEQUENCE_AXIS_WIDTH,
  formatSequenceDuration,
  sequenceLinkTitle,
  type SequenceArrow,
  type SequenceBar,
  type SequenceData,
  type SequenceLayout,
} from '../sessionSequence'

export type SequenceSelection = { type: 'bar'; bar: SequenceBar } | { type: 'arrow'; arrow: SequenceArrow } | null

export const SEQUENCE_LINK_COLORS: Record<string, string> = {
  message: 'var(--foxwarm-color-accent)',
  task: 'var(--foxwarm-color-warning)',
  spawn: 'var(--foxwarm-color-success)',
  user: 'var(--foxwarm-color-info)',
  channel: 'var(--foxwarm-color-info)',
  timer: 'var(--foxwarm-color-special)',
  event: 'var(--foxwarm-color-text-subtle)',
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const formatTime = (time: number) => timeFormat.format(new Date(time))
const formatDate = (time: number) => dateFormat.format(new Date(time))

/** Long queue waits beyond this are drawn as a dashed tail along the receiver's lifeline. */
const QUEUE_DELAY_MS = 2000

function ArrowShape({ arrow, selected, onSelect }: { arrow: SequenceArrow; selected: boolean; onSelect: () => void }) {
  const { link } = arrow
  const color = SEQUENCE_LINK_COLORS[link.kind] || SEQUENCE_LINK_COLORS.event
  const inferred = link.pairing === 'inferred'
  const pending = link.consumedAt === undefined && (link.state === 'queued' || link.state === 'unread')
  const direction = arrow.x2 > arrow.x1 ? 1 : -1
  const endX = arrow.x2 - direction * 5
  const queued = !pending && arrow.delayMs > QUEUE_DELAY_MS && arrow.y2 - arrow.y1 > 6
  // A queued delivery reaches the receiver's lane at send time and waits until it is read.
  const arrivalY = queued ? arrow.y1 : arrow.y2
  const width = selected ? 2.5 : 1.5
  const label = `${sequenceLinkTitle(link)}${link.preview ? `: ${link.preview}` : ''}`
  return (
    <g role="button" tabIndex={0} aria-label={label} onClick={onSelect} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }}
      className="cursor-pointer outline-none" data-sequence-arrow={link.key} data-pairing={link.pairing || ''} data-kind={link.kind}>
      <title>{label}</title>
      <line x1={arrow.x1} y1={arrow.y1} x2={endX} y2={arrivalY} stroke="transparent" strokeWidth={10} />
      <line x1={arrow.x1} y1={arrow.y1} x2={endX} y2={arrivalY} stroke={color} strokeWidth={width} strokeDasharray={inferred ? '5 4' : undefined} opacity={selected ? 1 : 0.85} />
      {queued ? <line x1={arrow.x2 - direction * 3} y1={arrow.y1} x2={arrow.x2 - direction * 3} y2={arrow.y2} stroke={color} strokeWidth={width} strokeDasharray="2 3" opacity={0.7} data-sequence-queue /> : null}
      {pending
        ? <circle cx={arrow.x2} cy={arrow.y2} r={4} fill="var(--foxwarm-color-surface)" stroke={color} strokeWidth={1.5} />
        : <path d={`M ${arrow.x2 - direction * 3} ${arrow.y2} l ${-direction * 7} -4 l 0 8 z`} fill={color} />}
      <circle cx={arrow.x1} cy={arrow.y1} r={2} fill={color} />
    </g>
  )
}

export const SequenceCanvas = memo(function SequenceCanvas({ layout, bars, arrows, selection, onSelect }: {
  layout: SequenceLayout
  bars: SequenceBar[]
  arrows: SequenceArrow[]
  selection: SequenceSelection
  onSelect: (selection: SequenceSelection) => void
}) {
  const selectedKey = selection?.type === 'bar' ? selection.bar.key : selection?.type === 'arrow' ? selection.arrow.key : null
  return (
    <svg width={layout.width} height={layout.height} className="block select-none font-fw-ui" data-sequence-canvas>
      {layout.scale.ticks.map(tick => (
        <g key={`t${tick.y}`}>
          <line x1={SEQUENCE_AXIS_WIDTH - 6} x2={layout.width} y1={tick.y} y2={tick.y} stroke="var(--foxwarm-color-border-muted)" strokeWidth={tick.major ? 1 : 0.5} opacity={tick.major ? 0.8 : 0.5} />
          <text x={SEQUENCE_AXIS_WIDTH - 10} y={tick.y + 3} textAnchor="end" fontSize={10} fill="var(--foxwarm-color-text-subtle)" className="tabular-nums">{formatTime(tick.time)}</text>
        </g>
      ))}
      {layout.lanes.map(lane => (
        <line key={lane.id} x1={lane.x} x2={lane.x} y1={lane.startY} y2={layout.height} stroke="var(--foxwarm-color-border)" strokeWidth={lane.kind === 'session' ? 1 : 0.75} strokeDasharray={lane.kind === 'session' ? undefined : '3 4'} />
      ))}
      {layout.scale.breaks.map(item => (
        <g key={`b${item.y}`} data-sequence-break>
          <rect x={0} y={item.y - 9} width={layout.width} height={18} fill="var(--foxwarm-color-surface-sunken)" opacity={0.9} />
          <path d={`M ${SEQUENCE_AXIS_WIDTH} ${item.y - 3} l 6 6 l 6 -6 l 6 6`} stroke="var(--foxwarm-color-text-subtle)" fill="none" strokeWidth={1} />
          <text x={SEQUENCE_AXIS_WIDTH + 26} y={item.y + 3.5} fontSize={10} fill="var(--foxwarm-color-text-muted)">{formatSequenceDuration(item.to - item.from)} idle</text>
        </g>
      ))}
      {bars.map(bar => {
        const event = bar.event
        const fill = event.kind === 'llm' ? 'var(--foxwarm-color-accent)' : event.status === 'error' ? 'var(--foxwarm-color-danger)' : event.status === 'canceled' ? 'var(--foxwarm-color-text-subtle)' : 'var(--foxwarm-color-tool)'
        const selected = selectedKey === bar.key
        const label = event.kind === 'llm' ? 'Model request' : event.name || 'Tool'
        return (
          <rect key={bar.key} x={bar.x} y={bar.y} width={6} height={bar.height} rx={1.5} fill={fill} opacity={event.kind === 'llm' ? 0.55 : 0.9}
            stroke={selected ? 'var(--foxwarm-color-text-strong)' : event.live ? fill : 'none'} strokeWidth={selected ? 1.5 : 1} strokeDasharray={event.live ? '2 2' : undefined}
            role="button" tabIndex={0} aria-label={`${label}, ${formatSequenceDuration(event.end - event.start)}`} className="cursor-pointer outline-none"
            onClick={() => onSelect({ type: 'bar', bar })} onKeyDown={keyboard => { if (keyboard.key === 'Enter' || keyboard.key === ' ') { keyboard.preventDefault(); onSelect({ type: 'bar', bar }) } }}
            data-sequence-bar={bar.key} data-kind={event.kind}>
            <title>{`${label} · ${formatSequenceDuration(event.end - event.start)}${event.preview ? `\n${event.preview}` : ''}`}</title>
          </rect>
        )
      })}
      {arrows.map(arrow => <ArrowShape key={arrow.key} arrow={arrow} selected={selectedKey === arrow.key} onSelect={() => onSelect({ type: 'arrow', arrow })} />)}
    </svg>
  )
})

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex gap-3 py-1 text-xs"><dt className="w-24 shrink-0 text-fw-text-muted">{label}</dt><dd className="min-w-0 flex-1 break-words text-fw-text-strong">{children}</dd></div>
}

function OpenButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 rounded-lg border border-fw-border bg-fw-surface px-2.5 py-1.5 text-xs font-medium text-fw-text hover:bg-fw-hover"><ExternalLink className="h-3.5 w-3.5" />{label}</button>
}

export function SequenceDetails({ selection, data, laneLabels, onClose, onOpen, onFocus }: {
  selection: SequenceSelection
  data: SequenceData | null
  laneLabels: Map<string, string>
  onClose: () => void
  onOpen: (sessionId: string, seq?: number) => void
  onFocus: (sessionId: string) => void
}) {
  const shell = (title: string, body: React.ReactNode) => (
    <aside className="h-fit rounded-xl border border-fw-border bg-fw-surface p-4" data-sequence-details>
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-fw-text-strong">{title}</h3>
        {selection ? <button type="button" aria-label="Close details" onClick={onClose} className="rounded-md p-1 text-fw-text-muted hover:bg-fw-hover"><X className="h-3.5 w-3.5" /></button> : null}
      </div>
      {body}
    </aside>
  )
  if (!selection) return shell('Details', <p className="text-xs text-fw-text-muted">Select a bar or an arrow to see what happened and open the session at that point.</p>)
  const known = new Set(data?.sessions.map(session => session.id) || [])
  const name = (id?: string, lane?: string) => lane && lane !== 'session' ? laneLabels.get(`@${lane}`) || lane : id ? laneLabels.get(id) || id : '—'
  if (selection.type === 'bar') {
    const { event } = selection.bar
    return shell(event.kind === 'llm' ? 'Model request' : event.name || 'Tool run', <>
      <dl>
        <Row label="Session">{name(event.sessionId)}</Row>
        <Row label="Started">{formatDate(event.start)}</Row>
        <Row label="Duration">{event.live ? `${formatSequenceDuration(event.end - event.start)} so far` : formatSequenceDuration(event.end - event.start)}</Row>
        {event.kind === 'tool' ? <Row label="Result">{event.live ? 'Running' : event.status === 'error' ? `Failed${event.error ? ` (${event.error})` : ''}` : event.status === 'canceled' ? 'Canceled' : 'Completed'}</Row> : null}
        {event.kind === 'llm' && event.calls ? <Row label="Tool calls">{event.calls}</Row> : null}
        {event.subCalls?.length ? <Row label="Script calls">{event.subCalls.map(call => call.name).join(', ')}</Row> : null}
        {!event.live ? <Row label="Message">#{event.callSeq ?? event.seq}</Row> : null}
      </dl>
      {event.preview ? <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-fw-surface-sunken p-2 text-xs text-fw-text">{event.preview}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <OpenButton label={event.live ? 'Open session' : 'Open at this point'} onClick={() => onOpen(event.sessionId, event.live ? undefined : event.callSeq ?? event.seq)} />
        <button type="button" onClick={() => onFocus(event.sessionId)} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-fw-text-muted hover:bg-fw-hover"><Network className="h-3.5 w-3.5" />Show connected</button>
      </div>
    </>)
  }
  const { link } = selection.arrow
  const task = link.taskId ? data?.tasks?.[link.taskId] : undefined
  const fromSession = link.from.lane === 'session' || !link.from.lane ? link.from.sessionId : undefined
  return shell(sequenceLinkTitle(link), <>
    <dl>
      <Row label="From">{name(link.from.sessionId, link.from.lane)}{link.from.label && link.from.lane !== 'session' ? ` · ${link.from.label}` : ''}</Row>
      <Row label="To">{name(link.to.sessionId)}</Row>
      <Row label="Sent">{formatDate(link.from.at ?? link.sentAt)}</Row>
      <Row label="Read">{link.consumedAt !== undefined ? `${formatDate(link.consumedAt)}${selection.arrow.delayMs >= 1000 ? ` · waited ${formatSequenceDuration(selection.arrow.delayMs)}` : ''}` : link.state === 'queued' ? 'Waiting in queue' : 'Not in the loaded history'}</Row>
      {task ? <Row label="Task">{task.title || link.taskId}{task.status ? ` · ${task.status}` : ''}</Row> : link.taskId ? <Row label="Task">{link.taskId}</Row> : null}
      {link.pairing === 'inferred' ? <Row label="Match">Matched by time and content</Row> : null}
    </dl>
    {link.preview ? <p className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-fw-surface-sunken p-2 text-xs text-fw-text">{link.preview}</p> : null}
    <div className="mt-3 flex flex-wrap gap-2">
      {fromSession && known.has(fromSession) ? <OpenButton label="Open sender" onClick={() => onOpen(fromSession, link.from.seq)} /> : null}
      {link.to.sessionId && known.has(link.to.sessionId) ? <OpenButton label="Open receiver" onClick={() => onOpen(link.to.sessionId!, link.to.seq)} /> : null}
    </div>
  </>)
}
