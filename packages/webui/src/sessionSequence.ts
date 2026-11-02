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
  /** Time of the Session's first own Archive row. */
  createdAt?: number
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
  /** The other half of this delivery is in an older page that is not loaded yet. */
  pending?: 'older'
  taskId?: string
  taskEvent?: string
  mode?: string
}

/** Newest-first paging position; returned as `next` and sent back as `before`. */
export interface SequenceCursor { at: number; sessionId?: string; seq?: number }

export interface SequenceData {
  generatedAt: number
  sessions: SequenceSession[]
  peers: SequencePeer[]
  events: SequenceEvent[]
  links: SequenceLink[]
  cursors: Record<string, number>
  tasks?: Record<string, { title?: string; status?: string }>
  mode?: 'page' | 'incremental'
  /** Page only: the time range it covers; `to` is absent for the newest page. */
  range?: { from?: number | null; to?: number | null }
  next?: SequenceCursor | null
  hasMore?: boolean
}

export const SEQUENCE_BUCKET_MS = 60_000

export const sequenceEventKey = (event: SequenceEvent) => `${event.sessionId}|${event.seq}|${event.kind}|${event.call ?? 0}`

const extreme = (pick: (...values: number[]) => number, a: number | undefined, b: number | undefined) =>
  a === undefined ? b : b === undefined ? a : pick(a, b)

/**
 * Merges an older page or a live update. Links are keyed, so the two halves of a delivery
 * (sender and receiver, possibly from different pages) become one link: a delivery first seen
 * as queued is replaced once its read half is known, and sender-side anchors survive when only
 * the receiver's half arrives.
 */
export function mergeSequenceData(base: SequenceData, delta: SequenceData): SequenceData {
  const sessions = new Map(base.sessions.map(session => [session.id, session]))
  for (const session of delta.sessions) {
    const previous = sessions.get(session.id)
    const older = !!previous && session.firstSeq !== undefined && previous.firstSeq !== undefined && session.firstSeq < previous.firstSeq
    // Row bounds widen; current runtime fields come from whichever response is newer.
    const merged = older ? { ...session, ...previous } : { ...previous, ...session }
    sessions.set(session.id, {
      ...merged,
      firstSeq: extreme(Math.min, previous?.firstSeq, session.firstSeq),
      firstAt: extreme(Math.min, previous?.firstAt, session.firstAt),
      lastSeq: extreme(Math.max, previous?.lastSeq, session.lastSeq),
      maxSeq: extreme(Math.max, previous?.maxSeq, session.maxSeq),
      startedAt: previous?.startedAt ?? session.startedAt,
      startKind: previous?.startKind ?? session.startKind,
    })
  }
  const peers = new Map(base.peers.map(peer => [peer.id, peer]))
  for (const peer of delta.peers) peers.set(peer.id, { ...peers.get(peer.id), ...peer })
  const events = new Map(base.events.map(event => [sequenceEventKey(event), event]))
  for (const event of delta.events) events.set(sequenceEventKey(event), event)
  const links = new Map(base.links.map(link => [link.key, link]))
  // A send half knows the exact sending call and time; a read half knows when it was read.
  const sendHalf = (link: SequenceLink) => link.consumedAt === undefined && (link.from.lane ?? 'session') === 'session'
  for (const link of delta.links) {
    const previous = links.get(link.key)
    if (!previous) { links.set(link.key, link); continue }
    let from = link.from
    let sentAt = link.sentAt
    if (previous.from.seq !== undefined && link.from.seq === undefined) {
      from = { ...link.from, seq: previous.from.seq, call: previous.from.call, sub: previous.from.sub, at: previous.from.at }
      sentAt = previous.sentAt
    } else if (sendHalf(previous) && !sendHalf(link)) {
      from = { ...link.from, ...previous.from }
      sentAt = previous.sentAt
    }
    const consumed = link.consumedAt ?? previous.consumedAt
    // The read half's endpoint wins; a send half only knows the receiver's ID.
    const to = previous.to.seq !== undefined && link.to.seq === undefined ? { ...link.to, ...previous.to } : { ...previous.to, ...link.to }
    if (!(previous.to.outside && link.to.outside)) delete to.outside
    const merged: SequenceLink = { ...previous, ...link, from, to, sentAt, consumedAt: consumed, state: consumed !== undefined ? undefined : link.state ?? previous.state, preview: link.preview || previous.preview }
    if (!(previous.pending && link.pending)) delete merged.pending
    links.set(link.key, merged)
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
  }
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
  const started = (session: SequenceSession) => session.createdAt ?? session.startedAt ?? session.firstAt ?? session.lastMessageTime ?? Number.MAX_SAFE_INTEGER
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
    columns.push({ id: session.id, label: sessionLabel(session), agent: session.agent, depth, state: sequenceColumnState(session) })
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

const localOffset = (time: number) => -new Date(time).getTimezoneOffset() * 60_000
const bucketStart = (time: number, size: number) => Math.floor((time + localOffset(time)) / size) * size - localOffset(time)

export interface SequenceRow {
  start: number
  end: number
  cells: Record<string, SequenceItem[]>
}

/**
 * Time-bucket rows across all columns. Empty buckets are omitted, so idle time disappears;
 * consecutive tool runs within a cell collapse into one counted group.
 */
export function buildSequenceRows(items: Map<string, SequenceItem[]>, bucketMs = SEQUENCE_BUCKET_MS): SequenceRow[] {
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

/** The pinned Session and every Session it exchanged deliveries, creation or Tasks with. */
export function connectedSequenceSessions(data: SequenceData, pinned: string): Set<string> {
  const connected = new Set([pinned])
  for (const link of data.links) {
    if (link.kind !== 'message' && link.kind !== 'task' && link.kind !== 'spawn') continue
    const from = link.from.sessionId
    const to = link.to.sessionId
    if (from === pinned && to) connected.add(to)
    if (to === pinned && from) connected.add(from)
  }
  return connected
}

/** Sessions with items in rows `start`..`end` (exclusive). */
export function sequenceRowSessions(rows: SequenceRow[], start: number, end: number): Set<string> {
  const result = new Set<string>()
  for (let index = Math.max(0, start); index < Math.min(rows.length, end); index++) {
    for (const id of Object.keys(rows[index].cells)) result.add(id)
  }
  return result
}

/**
 * Next column set. A Session joins when it has items near the viewport (`near`) and leaves only
 * when it has none in the wider band (`far`), so columns do not flicker at the edge. Columns
 * keep tree order; the pinned Session is always first.
 */
export function nextSequenceColumns({ order, current, near, far, pinned }: { order: string[]; current: string[]; near: Set<string>; far: Set<string>; pinned?: string | null }): string[] {
  const keep = new Set(current.filter(id => far.has(id) || near.has(id)))
  for (const id of near) keep.add(id)
  const result = order.filter(id => keep.has(id) && id !== pinned)
  return pinned ? [pinned, ...result] : result
}

/** Cumulative row offsets: `offsets[i]` is the top of row i, the last entry the total height. */
export function sequenceRowOffsets(rows: SequenceRow[], height: (row: SequenceRow) => number): number[] {
  const offsets = [0]
  for (const row of rows) offsets.push(offsets[offsets.length - 1] + height(row))
  return offsets
}

/** Index of the row containing `y` (clamped). */
export function sequenceRowAt(offsets: number[], y: number): number {
  let low = 0
  let high = offsets.length - 2
  if (high < 0) return 0
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (offsets[middle] <= y) low = middle
    else high = middle - 1
  }
  return low
}

/** Rows to render for a viewport, with `margin` pixels above and below. */
export function sequenceRowWindow(offsets: number[], top: number, viewport: number, margin: number): [number, number] {
  const count = offsets.length - 1
  if (count <= 0) return [0, 0]
  return [sequenceRowAt(offsets, top - margin), Math.min(count, sequenceRowAt(offsets, top + viewport + margin) + 1)]
}

/** Estimated height of a row before it is measured. */
export function estimateSequenceRow(row: SequenceRow): number {
  let tallest = 0
  for (const items of Object.values(row.cells)) tallest = Math.max(tallest, items.length)
  return 36 + tallest * 64
}

/**
 * Drops loaded activity older than `before` (a bucket boundary), keeping links whose newer half
 * is still loaded. Used to bound memory after scrolling far back and returning to the newest.
 */
export function trimSequenceData(data: SequenceData, before: number): SequenceData {
  const keepEvent = (event: SequenceEvent) => event.end >= before || event.start >= before
  const linkTime = (link: SequenceLink) => Math.max(link.consumedAt ?? 0, link.to.at ?? 0, link.from.at ?? 0, link.sentAt)
  return { ...data, events: data.events.filter(keepEvent), links: data.links.filter(link => linkTime(link) >= before) }
}

/** Rendered width of a full column, including the gap to the next one. */
export const SEQUENCE_COLUMN_STRIDE = 312

/**
 * One animation step for column widths: entering columns grow, leaving columns shrink and are
 * dropped at zero. Returns the same object when every width has reached its target.
 */
export function stepSequenceWidths(widths: Record<string, number>, shown: string[], stepPx: number, full = SEQUENCE_COLUMN_STRIDE): Record<string, number> {
  const target = new Set(shown)
  let changed = false
  const next: Record<string, number> = {}
  for (const id of new Set([...Object.keys(widths), ...shown])) {
    const current = widths[id] ?? 0
    const goal = target.has(id) ? full : 0
    const value = current < goal ? Math.min(goal, current + stepPx) : Math.max(goal, current - stepPx)
    if (value !== current || !(id in widths)) changed = true
    if (value > 0 || target.has(id)) next[id] = value
    else changed = true
  }
  return changed ? next : widths
}

/**
 * Horizontal scroll change that keeps already-visible columns in place when columns are
 * inserted, removed or resized: the first column whose right edge was in view, and which is
 * still present, stays at the same screen position.
 */
export function sequenceScrollLeftShift(order: string[], before: Record<string, number>, after: Record<string, number>, scrollLeft: number): number {
  let leftBefore = 0
  let leftAfter = 0
  for (const id of order) {
    const was = before[id] ?? 0
    const now = after[id] ?? 0
    if (was > 0 && now > 0 && leftBefore + was > scrollLeft) return leftAfter - leftBefore
    leftBefore += was
    leftAfter += now
  }
  return 0
}

/** Rows that lie inside the loaded range; an older half-loaded bucket waits for its page. */
export const loadedSequenceRows = (rows: SequenceRow[], loadedFrom: number | null | undefined) =>
  loadedFrom == null ? rows : rows.filter(row => row.end > loadedFrom)
