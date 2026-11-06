import { memo, useState, type MouseEvent, type ReactNode } from 'react'
import { ToolTag, clampContentStyle, type ToolTagItem } from './chatShared'
import SessionMessageCard from './SessionMessageCard'
import { ToolGroupSummaryCard } from './ToolTimelineItems'
import { formatSequenceDuration, sequenceLinkTitle, sequenceWaitMs, type SequenceData, type SequenceItem, type SequenceLink } from '../sessionSequence'

/** Peer ID used for Sessions outside the caller's view; mapped to a name in the card names context. */
export const OTHER_SESSION_PEER = '<other session>'

export interface SequenceItemActions {
  highlightKey: string | null
  onHighlight: (key: string | null) => void
  onOpen: (sessionId: string, seq?: number) => void
}

// Controls inside an item keep their own action; tool groups expand instead of navigating.
const opensSession = (event: MouseEvent) => !(event.target as HTMLElement).closest('button, a, [role="button"], [data-tool-group-card]')

function ItemShell({ item, actions, linkKey, children, className = '' }: { item: SequenceItem; actions: SequenceItemActions; linkKey?: string; children: ReactNode; className?: string }) {
  return (
    <div
      data-sequence-item={item.type}
      data-sequence-link={linkKey}
      data-sequence-seq={item.seq}
      title={item.seq !== undefined ? 'Open the session at this point' : undefined}
      className={`min-w-0 cursor-pointer rounded-lg ${className}`}
      onClick={event => { if (opensSession(event)) actions.onOpen(item.sessionId, item.seq) }}
      onMouseEnter={linkKey ? () => actions.onHighlight(linkKey) : undefined}
      onMouseLeave={linkKey ? () => actions.onHighlight(null) : undefined}
      onFocusCapture={linkKey ? () => actions.onHighlight(linkKey) : undefined}
      onBlurCapture={linkKey ? () => actions.onHighlight(null) : undefined}
    >
      {children}
    </div>
  )
}

const TextItem = ({ item }: { item: Extract<SequenceItem, { type: 'text' }> }) => (
  <p data-sequence-phase={item.commentary ? 'commentary' : 'final'} style={clampContentStyle(3)}
    className={item.commentary
      ? 'my-0 border-l-2 border-fw-border pl-2 text-[12px] leading-[18px] text-fw-text-muted'
      : 'my-0 text-[13px] leading-5 text-fw-text-strong'}>
    {item.text}
  </p>
)

const toolTag = (tool: { name?: string; status?: string }): ToolTagItem => ({ name: tool.name || 'tool', label: tool.name || 'tool', tone: tool.status === 'error' ? 'error' : 'neutral', toolCall: true })

const ToolsItem = memo(function ToolsItem({ item, onOpen }: { item: Extract<SequenceItem, { type: 'tools' }>; onOpen: SequenceItemActions['onOpen'] }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <ToolGroupSummaryCard items={item.tools.map(toolTag)} expanded={expanded} onExpand={() => setExpanded(value => !value)}>
      <div className="space-y-0.5 py-0.5">
        {item.tools.map(tool => (
          <div key={`${tool.seq}|${tool.call ?? 0}`} className="flex min-w-0 items-center gap-1.5 rounded px-0.5 text-[11px] hover:bg-fw-hover" data-sequence-tool={tool.name}
            title="Open the session at this point" onClick={event => { event.stopPropagation(); onOpen(tool.sessionId, tool.callSeq ?? tool.seq) }}>
            <ToolTag {...toolTag(tool)} />
            <span className="min-w-0 flex-1 truncate text-fw-text-muted" title={tool.preview}>{tool.preview || (tool.subCalls?.length ? tool.subCalls.map(call => call.name).join(', ') : '')}</span>
            {tool.status === 'error' ? <span className="shrink-0 text-fw-danger">{tool.error || 'Failed'}</span> : tool.status === 'canceled' ? <span className="shrink-0 text-fw-text-subtle">Canceled</span> : null}
          </div>
        ))}
      </div>
    </ToolGroupSummaryCard>
  )
})

const RunningItem = ({ item, now }: { item: Extract<SequenceItem, { type: 'running' }>; now: number }) => (
  <div className="flex min-w-0 items-center gap-1.5 px-1 text-[11px] text-fw-text-muted" data-sequence-running={item.event.kind}>
    <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-fw-accent" />
    {item.event.kind === 'tool'
      ? <><ToolTag name={item.event.name || 'tool'} label={item.event.name || 'tool'} toolCall /><span className="min-w-0 flex-1 truncate">{item.event.preview}</span></>
      : <span>Responding</span>}
    <span className="ml-auto shrink-0 tabular-nums">{formatSequenceDuration(Math.max(0, now - item.event.start))}</span>
  </div>
)

const SYSTEM_ICONS: Record<string, string> = { timer: 'system-timer', channel: 'system-inter-agent', task: 'system-event', event: 'system-event' }

function InputItem({ item }: { item: Extract<SequenceItem, { type: 'input' }> }) {
  const { link } = item
  if (item.variant === 'user') return (
    <div className="flex justify-end">
      <div className="foxwarm-user-message-bubble min-w-0 max-w-[90%] truncate rounded-lg bg-fw-user-surface px-2.5 py-1.5 text-[12px] text-fw-user-text" title={link.preview}>{link.preview || 'Message'}</div>
    </div>
  )
  const label = link.kind === 'channel' && link.from.label ? link.from.label : sequenceLinkTitle(link)
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-fw-text-muted">
      <ToolTag name={link.kind} label={label} tone="system" iconName={SYSTEM_ICONS[link.kind] || 'system-event'} className="max-w-[60%] [&>span]:truncate" />
      {link.preview ? <span className="min-w-0 flex-1 truncate" title={link.preview}>{link.preview}</span> : null}
    </div>
  )
}

function CardItem({ item, data, highlighted }: { item: Extract<SequenceItem, { type: 'card' }>; data: SequenceData; highlighted: boolean }) {
  const { link, direction } = item
  const peerEndpoint = direction === 'sent' ? link.to : link.from
  const opaque = data.peers.some(peer => peer.opaque && peer.id === peerEndpoint.sessionId)
  const peer = !peerEndpoint.sessionId || opaque ? OTHER_SESSION_PEER : peerEndpoint.sessionId
  const task = link.taskId ? data.tasks?.[link.taskId] : undefined
  const caption = [item.created ? sequenceLinkTitle(item.created) : null, link.kind === 'message' ? null : sequenceLinkTitle(link), task?.title].filter(Boolean).join(' · ') || null
  const wait = sequenceWaitMs(link)
  const pending = link.consumedAt === undefined && (link.state === 'queued' || link.state === 'unread')
  return (
    <div data-sequence-card={direction} data-sequence-created={item.created ? '' : undefined} data-highlighted={highlighted || undefined} data-pairing={link.pairing}
      className={`rounded-lg transition-shadow ${highlighted ? 'ring-2 ring-fw-accent/60' : ''}`}>
      <SessionMessageCard communication={{ key: link.key, direction, peerSessionId: peer, message: link.preview || '' }}>
        {caption || link.preview ? <p className="my-0 whitespace-pre-wrap break-words text-[12px] leading-[18px] text-fw-text">
          {caption ? <span className="font-medium text-fw-text-muted">{caption}{link.preview ? ': ' : ''}</span> : null}{link.preview}
        </p> : null}
      </SessionMessageCard>
      {pending || highlighted && (wait !== undefined || link.pairing === 'inferred') ? (
        <div className="-mt-0.5 flex flex-wrap gap-x-2 px-1 pb-0.5 text-[10px] text-fw-text-subtle" data-sequence-wait>
          {pending ? <span>Not read yet</span> : wait !== undefined ? <span>{wait < 1000 ? 'Read immediately' : `Read after ${formatSequenceDuration(wait)}`}</span> : null}
          {link.pairing === 'inferred' && highlighted ? <span>Matched by time</span> : null}
        </div>
      ) : null}
    </div>
  )
}

export const SequenceCell = memo(function SequenceCell({ items, data, now, actions }: { items: SequenceItem[]; data: SequenceData; now: number; actions: SequenceItemActions }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {items.map(item => {
        const linkKey = item.type === 'card' ? item.link.key : undefined
        return (
          <ItemShell key={item.key} item={item} actions={actions} linkKey={linkKey}>
            {item.type === 'text' ? <TextItem item={item} />
              : item.type === 'tools' ? <ToolsItem item={item} onOpen={actions.onOpen} />
              : item.type === 'running' ? <RunningItem item={item} now={now} />
              : item.type === 'input' ? <InputItem item={item} />
              : <CardItem item={item} data={data} highlighted={!!linkKey && actions.highlightKey === linkKey} />}
          </ItemShell>
        )
      })}
    </div>
  )
})

export type { SequenceLink }
