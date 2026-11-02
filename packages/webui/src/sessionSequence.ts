import type { SessionRuntimeState } from './sessionRuntimeState'

/** Response shape of POST /api/session-sequence. */
export interface SequenceSession {
  id: string
  displayName?: string
  agent?: string
  busy?: boolean
  queueLength?: number
  runtimeState?: SessionRuntimeState
  lastMessageTime?: number
  parentSessionId?: string
  firstSeq?: number
  lastSeq?: number
  maxSeq?: number
  firstAt?: number
  truncated?: boolean
  hasMore?: boolean
  startedAt?: number
  startKind?: string
}

export interface SequencePeer { id: string; opaque?: boolean; displayName?: string; agent?: string }

export interface SequenceSubCall { n: number; name: string; start: number; end: number; status: string }

export interface SequenceEvent {
  sessionId: string
  seq: number
  kind: 'llm' | 'tool'
  start: number
  end: number
  name?: string
  status?: 'ok' | 'error' | 'canceled'
  call?: number
  calls?: number
  callSeq?: number
  deliverySeq?: string
  preview?: string
  /** Assistant text phase, as in Conversation; absent for unmarked text. */
  phase?: 'commentary' | 'final_answer'
  error?: string
  subCalls?: SequenceSubCall[]
  /** Client-only: work still running, ending at the current time. */
  live?: boolean
}

export type SequenceSourceLane = 'session' | 'user' | 'channel' | 'timer' | 'system'

export interface SequenceEndpoint {
  lane?: SequenceSourceLane
  sessionId?: string
  seq?: number
  call?: number
  sub?: number
  at?: number
  outside?: boolean
  label?: string
}

export type SequenceLinkKind = 'message' | 'task' | 'spawn' | 'user' | 'channel' | 'timer' | 'event'

export interface SequenceLink {
  key: string
  kind: SequenceLinkKind
  from: SequenceEndpoint
  to: SequenceEndpoint
  sentAt: number
  consumedAt?: number
  pairing?: 'exact' | 'inferred'
  deliverySeq?: string
  preview?: string
  state?: 'queued' | 'unread'
  taskId?: string
  taskEvent?: string
  mode?: string
}

export interface SequenceData {
  since: number
  generatedAt: number
  sessions: SequenceSession[]
  peers: SequencePeer[]
  events: SequenceEvent[]
  links: SequenceLink[]
  cursors: Record<string, number>
  tasks?: Record<string, { title?: string; status?: string }>
  truncatedSessions?: boolean
  incremental?: boolean
}

export const SEQUENCE_WINDOWS = [
  { id: '1h', label: '1h', ms: 3_600_000 },
  { id: '6h', label: '6h', ms: 6 * 3_600_000 },
  { id: '24h', label: '24h', ms: 24 * 3_600_000 },
] as const
export type SequenceWindowId = typeof SEQUENCE_WINDOWS[number]['id']

export const sequenceEventKey = (event: SequenceEvent) => `${event.sessionId}|${event.seq}|${event.kind}|${event.call ?? 0}`

/**
 * Appends an incremental response. Links are keyed so a delivery first seen as queued on the
 * sender is replaced once the receiver consumes it; sender-side anchors survive when the
 * incremental response only has the receiver's half.
 */
export function mergeSequenceData(base: SequenceData, delta: SequenceData): SequenceData {
  const sessions = new Map(base.sessions.map(session => [session.id, session]))
  for (const session of delta.sessions) sessions.set(session.id, { ...sessions.get(session.id), ...session, firstSeq: sessions.get(session.id)?.firstSeq ?? session.firstSeq, firstAt: sessions.get(session.id)?.firstAt ?? session.firstAt, truncated: sessions.get(session.id)?.truncated ?? session.truncated })
  const peers = new Map(base.peers.map(peer => [peer.id, peer]))
  for (const peer of delta.peers) peers.set(peer.id, { ...peers.get(peer.id), ...peer })
  const events = new Map(base.events.map(event => [sequenceEventKey(event), event]))
  for (const event of delta.events) events.set(sequenceEventKey(event), event)
  const links = new Map(base.links.map(link => [link.key, link]))
  for (const link of delta.links) {
    const previous = links.get(link.key)
    if (!previous) { links.set(link.key, link); continue }
    const keepAnchor = previous.from.seq !== undefined && link.from.seq === undefined
    const from = keepAnchor ? { ...link.from, seq: previous.from.seq, call: previous.from.call, sub: previous.from.sub, at: previous.from.at } : link.from
    const consumed = link.consumedAt ?? previous.consumedAt
    links.set(link.key, { ...previous, ...link, from, to: { ...previous.to, ...link.to }, sentAt: keepAnchor ? previous.sentAt : link.sentAt, consumedAt: consumed, state: consumed !== undefined ? undefined : link.state })
  }
  const cursors = { ...base.cursors }
  for (const [id, seq] of Object.entries(delta.cursors || {})) cursors[id] = Math.max(cursors[id] ?? 0, seq)
  return {
    ...base,
    generatedAt: delta.generatedAt,
    sessions: [...sessions.values()],
    peers: [...peers.values()],
    events: [...events.values()],
    links: [...links.values()],
    cursors,
    tasks: { ...base.tasks, ...delta.tasks },
    truncatedSessions: base.truncatedSessions || delta.truncatedSessions,
  }
}

/** Session IDs referenced by links that are neither loaded lanes nor opaque peers. */
export function unloadedSequencePeers(data: SequenceData): string[] {
  const loaded = new Set(data.sessions.map(session => session.id))
  const opaque = new Set(data.peers.filter(peer => peer.opaque).map(peer => peer.id))
  const missing = new Set<string>()
  for (const link of data.links) for (const side of [link.from, link.to]) {
    if (side.sessionId && !loaded.has(side.sessionId) && !opaque.has(side.sessionId)) missing.add(side.sessionId)
  }
  return [...missing]
}

/** Work in progress from the runtime state, drawn until the current time. */
export function liveSequenceEvents(sessions: SequenceSession[], now: number): SequenceEvent[] {
  const result: SequenceEvent[] = []
  for (const session of sessions) {
    const state = session.runtimeState
    if (!state?.busy && !session.busy) continue
    if (state?.state === 'running-tool' && state.tool?.startedAt) {
      result.push({ sessionId: session.id, seq: (session.maxSeq ?? 0) + 1, kind: 'tool', name: state.tool.name, start: state.tool.startedAt, end: Math.max(now, state.tool.startedAt), status: 'ok', live: true, preview: state.tool.argsPreview })
    } else if (state?.state === 'requesting-model' && state.since) {
      result.push({ sessionId: session.id, seq: (session.maxSeq ?? 0) + 1, kind: 'llm', start: state.since, end: Math.max(now, state.since), live: true })
    }
  }
  return result
}

export const sessionLabel = (session: { id: string; displayName?: string }) => session.displayName || session.id.split('/').pop() || session.id

export type SequenceColumnState = 'running' | 'waiting' | 'idle'

export interface SequenceColumn {
  id: string
  label: string
  agent?: string
  depth: number
  state: SequenceColumnState
  /** Older activity in the window was cut by the per-Session row limit. */
  partial?: boolean
}

export function sequenceColumnState(session: SequenceSession): SequenceColumnState {
  const state = session.runtimeState
  if (state?.state === 'waiting') return 'waiting'
  if (state?.state === 'requesting-model' || state?.state === 'running-tool' || (state?.busy ?? session.busy)) return 'running'
  return 'idle'
}

/** Sessions in parent/child tree order, siblings by when they started. */
export function orderSequenceColumns(data: SequenceData): SequenceColumn[] {
  const sessions = new Map(data.sessions.map(session => [session.id, session]))
  const started = (session: SequenceSession) => session.startedAt ?? session.firstAt ?? session.lastMessageTime ?? Number.MAX_SAFE_INTEGER
  const byStart = (a: SequenceSession, b: SequenceSession) => started(a) - started(b) || a.id.localeCompare(b.id)
  const children = new Map<string, SequenceSession[]>()
  const roots: SequenceSession[] = []
  for (const session of data.sessions) {
    const parent = session.parentSessionId
    if (parent && parent !== session.id && sessions.has(parent)) children.set(parent, [...(children.get(parent) || []), session])
    else roots.push(session)
  }
  const columns: SequenceColumn[] = []
  const visited = new Set<string>()
  const visit = (session: SequenceSession, depth: number) => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    columns.push({ id: session.id, label: sessionLabel(session), agent: session.agent, depth, state: sequenceColumnState(session), partial: !!session.truncated })
    for (const child of (children.get(session.id) || []).sort(byStart)) visit(child, depth + 1)
  }
  for (const root of roots.sort(byStart)) visit(root, 0)
  for (const session of data.sessions) visit(session, 0)
  return columns
}

interface ItemBase { key: string; sessionId: string; time: number; seq?: number }

export type SequenceItem =
  | ItemBase & { type: 'text'; text: string; commentary: boolean }
  | ItemBase & { type: 'tools'; tools: SequenceEvent[] }
  | ItemBase & { type: 'running'; event: SequenceEvent }
  | ItemBase & { type: 'input'; link: SequenceLink; variant: 'user' | 'system' }
  | ItemBase & { type: 'card'; link: SequenceLink; direction: 'sent' | 'received'; created?: SequenceLink }

const isSessionEndpoint = (endpoint: SequenceEndpoint) => !endpoint.lane || endpoint.lane === 'session'
const readAt = (link: SequenceLink) => link.consumedAt ?? link.to.at ?? link.sentAt
const sentAt = (link: SequenceLink) => link.from.at ?? link.sentAt

/** Time a delivery waited between sending and being read, when it has been read. */
export const sequenceWaitMs = (link: SequenceLink): number | undefined => link.consumedAt === undefined ? undefined : Math.max(0, link.consumedAt - sentAt(link))

/**
 * Items of each Session column in time order. Deliveries appear in both the sender's and the
 * receiver's column (same link key); input from you, channels and timers appears in the
 * receiving column. A tool call shown as a delivery card is not repeated as a tool tag.
 */
export function sequenceColumnItems(data: SequenceData, now: number): Map<string, SequenceItem[]> {
  const loaded = new Set(data.sessions.map(session => session.id))
  const items = new Map<string, SequenceItem[]>([...loaded].map(id => [id, []]))
  const add = (item: SequenceItem) => items.get(item.sessionId)?.push(item)
  const delivered = new Set<string>()
  // A child's creation and its initial message or Task assignment read as one card.
  const createdBy = new Map<string, SequenceLink>()
  const spawns = new Set<SequenceLink>()
  for (const spawn of data.links) {
    if (spawn.kind !== 'spawn' || !spawn.to.sessionId) continue
    const first = data.links
      .filter(link => (link.kind === 'message' || link.kind === 'task') && link.from.sessionId === spawn.from.sessionId && link.to.sessionId === spawn.to.sessionId && isSessionEndpoint(link.from))
      .filter(link => spawn.from.seq !== undefined && link.from.seq === spawn.from.seq && (link.from.call ?? 1) === (spawn.from.call ?? 1) || Math.abs(sentAt(link) - sentAt(spawn)) <= 5_000)
      .sort((a, b) => sentAt(a) - sentAt(b))[0]
    if (!first || createdBy.has(first.key)) continue
    createdBy.set(first.key, spawn)
    spawns.add(spawn)
    if (spawn.from.seq !== undefined && spawn.from.sessionId) delivered.add(`${spawn.from.sessionId}|${spawn.from.seq}|${spawn.from.call ?? 1}`)
  }
  for (const link of data.links) {
    if (spawns.has(link)) continue
    const created = createdBy.get(link.key)
    const from = link.from
    const to = link.to
    if (!isSessionEndpoint(from)) {
      if (to.sessionId) add({ type: 'input', key: `in|${link.key}`, sessionId: to.sessionId, time: readAt(link), seq: to.seq, link, variant: link.kind === 'user' ? 'user' : 'system' })
      continue
    }
    if (from.sessionId && loaded.has(from.sessionId)) {
      add({ type: 'card', key: `out|${link.key}`, sessionId: from.sessionId, time: sentAt(link), seq: from.seq, link, direction: 'sent', created })
      if (from.seq !== undefined && from.sub === undefined) delivered.add(`${from.sessionId}|${from.seq}|${from.call ?? 1}`)
    }
    if (to.sessionId && loaded.has(to.sessionId) && to.sessionId !== from.sessionId) {
      add({ type: 'card', key: `in|${link.key}`, sessionId: to.sessionId, time: link.consumedAt === undefined ? sentAt(link) : readAt(link), seq: to.seq, link, direction: 'received', created })
    }
  }
  for (const event of data.events) {
    if (event.kind === 'llm') {
      if (event.preview) add({ type: 'text', key: `text|${event.sessionId}|${event.seq}`, sessionId: event.sessionId, time: event.end, seq: event.seq, text: event.preview, commentary: event.phase ? event.phase === 'commentary' : (event.calls ?? 0) > 0 })
      continue
    }
    if (event.callSeq !== undefined && delivered.has(`${event.sessionId}|${event.callSeq}|${event.call ?? 1}`) && event.status === 'ok') continue
    add({ type: 'tools', key: `tool|${sequenceEventKey(event)}`, sessionId: event.sessionId, time: event.start, seq: event.callSeq ?? event.seq, tools: [event] })
  }
  for (const event of liveSequenceEvents(data.sessions, now)) add({ type: 'running', key: `live|${event.sessionId}`, sessionId: event.sessionId, time: event.start, event })
  for (const list of items.values()) list.sort((a, b) => a.time - b.time || (a.seq ?? 0) - (b.seq ?? 0))
  return items
}

/** Row sizes tried in order; the first that keeps the row count within the limit wins. */
export const SEQUENCE_BUCKET_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 240, 720] as const

const localOffset = (time: number) => -new Date(time).getTimezoneOffset() * 60_000
const bucketStart = (time: number, size: number) => Math.floor((time + localOffset(time)) / size) * size - localOffset(time)

/** Smallest bucket (in ms) whose non-empty rows stay within `maxRows`. */
export function chooseSequenceBucket(times: number[], maxRows = 60): number {
  for (const minutes of SEQUENCE_BUCKET_MINUTES) {
    const size = minutes * 60_000
    if (new Set(times.map(time => bucketStart(time, size))).size <= maxRows) return size
  }
  return SEQUENCE_BUCKET_MINUTES.at(-1)! * 60_000
}

export interface SequenceRow {
  start: number
  end: number
  cells: Record<string, SequenceItem[]>
}

/**
 * Time-bucket rows across all columns. Empty buckets are omitted, so idle time disappears;
 * consecutive tool runs within a cell collapse into one counted group.
 */
export function buildSequenceRows(items: Map<string, SequenceItem[]>, bucketMs: number): SequenceRow[] {
  const rows = new Map<number, SequenceRow>()
  for (const [sessionId, list] of items) {
    for (const item of list) {
      const start = bucketStart(item.time, bucketMs)
      let row = rows.get(start)
      if (!row) rows.set(start, row = { start, end: start + bucketMs, cells: {} })
      const cell = row.cells[sessionId] ||= []
      const last = cell.at(-1)
      if (item.type === 'tools' && last?.type === 'tools') cell[cell.length - 1] = { ...last, tools: [...last.tools, ...item.tools] }
      else cell.push(item)
    }
  }
  return [...rows.values()].sort((a, b) => a.start - b.start)
}

export interface SequenceGrid {
  columns: SequenceColumn[]
  rows: SequenceRow[]
  bucketMs: number
}

export function buildSequenceGrid(data: SequenceData, now: number, maxRows = 60): SequenceGrid {
  const columns = orderSequenceColumns(data)
  const items = sequenceColumnItems(data, now)
  const bucketMs = chooseSequenceBucket([...items.values()].flatMap(list => list.map(item => item.time)), maxRows)
  return { columns, rows: buildSequenceRows(items, bucketMs), bucketMs }
}

export const formatSequenceDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const LINK_TITLES: Record<SequenceLinkKind, string> = {
  message: 'Message',
  task: 'Task',
  spawn: 'New session',
  user: 'Your message',
  channel: 'Channel message',
  timer: 'Timer',
  event: 'Notice',
}

const TASK_EVENTS: Record<string, string> = {
  assigned: 'Task assigned',
  completed: 'Task completed',
  cancelled: 'Task cancelled',
  released: 'Task released',
  reassigned: 'Task reassigned',
  updated: 'Task updated',
}

export function sequenceLinkTitle(link: SequenceLink): string {
  if (link.kind === 'task') return (link.taskEvent && TASK_EVENTS[link.taskEvent]) || 'Task update'
  if (link.kind === 'spawn') return link.mode === 'history-inherited' ? 'Forked session' : link.mode === 'user-child-created' ? 'Session created by you' : 'New session'
  if (link.kind === 'event' && link.from.label) return link.from.label
  return LINK_TITLES[link.kind]
}
