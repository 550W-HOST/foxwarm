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

export type SequenceLaneKind = 'session' | 'external' | 'user' | 'channel' | 'timer' | 'system'

export interface SequenceLane {
  id: string
  kind: SequenceLaneKind
  label: string
  detail?: string
  sessionId?: string
  depth: number
  opaque?: boolean
  busy?: boolean
  /** Older activity in the window was cut by the per-Session row limit. */
  partial?: boolean
}

export const SPECIAL_LANE_LABELS: Record<Exclude<SequenceLaneKind, 'session' | 'external'>, string> = {
  user: 'You',
  channel: 'Channels',
  timer: 'Timers',
  system: 'System',
}

const laneIdForEndpoint = (endpoint: SequenceEndpoint): string | null => {
  if (!endpoint.lane || endpoint.lane === 'session') return endpoint.sessionId ?? null
  return `@${endpoint.lane}`
}

export const sessionLabel = (session: { id: string; displayName?: string }) => session.displayName || session.id.split('/').pop() || session.id

/**
 * Orders lanes: input lanes first, then Sessions in parent/child tree order (siblings by when
 * they started) so creation and delegation arrows stay short, then peers outside the view.
 */
export function orderSequenceLanes(data: SequenceData): SequenceLane[] {
  const sessions = new Map(data.sessions.map(session => [session.id, session]))
  const started = (session: SequenceSession) => session.startedAt ?? session.firstAt ?? session.lastMessageTime ?? Number.MAX_SAFE_INTEGER
  const children = new Map<string, SequenceSession[]>()
  const roots: SequenceSession[] = []
  for (const session of data.sessions) {
    const parent = session.parentSessionId
    if (parent && sessions.has(parent) && parent !== session.id) {
      const list = children.get(parent) || []
      list.push(session)
      children.set(parent, list)
    } else roots.push(session)
  }
  const byStart = (a: SequenceSession, b: SequenceSession) => started(a) - started(b) || a.id.localeCompare(b.id)
  roots.sort(byStart)
  const lanes: SequenceLane[] = []
  const used = new Set<string>()
  for (const link of data.links) {
    const lane = link.from.lane
    if (lane && lane !== 'session') used.add(lane)
  }
  for (const kind of ['user', 'channel', 'timer', 'system'] as const) {
    if (used.has(kind)) lanes.push({ id: `@${kind}`, kind, label: SPECIAL_LANE_LABELS[kind], depth: 0 })
  }
  const visited = new Set<string>()
  const visit = (session: SequenceSession, depth: number) => {
    if (visited.has(session.id)) return
    visited.add(session.id)
    lanes.push({ id: session.id, kind: 'session', label: sessionLabel(session), detail: session.agent, sessionId: session.id, depth, busy: !!(session.runtimeState?.busy ?? session.busy), partial: !!session.truncated })
    for (const child of (children.get(session.id) || []).sort(byStart)) visit(child, depth + 1)
  }
  for (const root of roots) visit(root, 0)
  for (const session of data.sessions) visit(session, 0)
  const peers = new Map(data.peers.map(peer => [peer.id, peer]))
  const external = new Set<string>()
  for (const link of data.links) for (const side of [link.from, link.to]) {
    const id = laneIdForEndpoint(side)
    if (id && !id.startsWith('@') && !sessions.has(id)) external.add(id)
  }
  for (const id of external) {
    const peer = peers.get(id)
    lanes.push({ id, kind: 'external', label: peer?.opaque ? 'Other session' : sessionLabel(peer || { id }), detail: peer?.opaque ? undefined : peer?.agent, sessionId: peer?.opaque ? undefined : id, depth: 0, opaque: !!peer?.opaque })
  }
  return lanes
}

export interface SequenceBreak { y: number; from: number; to: number }
export interface SequenceTick { y: number; time: number; major: boolean }

export interface SequenceTimeScale {
  y: (time: number) => number
  height: number
  breaks: SequenceBreak[]
  ticks: SequenceTick[]
  start: number
  end: number
}

export const SEQUENCE_ZOOM_LEVELS = [3, 6, 15, 30, 60, 120, 300, 600, 1500, 3000] as const
const BREAK_PX = 28
const GAP_PX = 96
const PAD_PX = 24
const TICK_STEPS = [1_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000]

/**
 * Real time downward at `pxPerMinute`; idle stretches longer than about GAP_PX are replaced by a
 * fixed break marker so bursts of activity stay readable.
 */
export function buildSequenceTimeScale(times: number[], pxPerMinute: number): SequenceTimeScale {
  const points = [...new Set(times.filter(Number.isFinite))].sort((a, b) => a - b)
  const scale = pxPerMinute / 60_000
  const maxGap = Math.max(30_000, GAP_PX / scale)
  type Segment = { t0: number; t1: number; y0: number }
  const segments: Segment[] = []
  const breaks: SequenceBreak[] = []
  let y = PAD_PX
  for (const time of points) {
    const last = segments.at(-1)
    if (!last) { segments.push({ t0: time, t1: time, y0: y }); continue }
    if (time - last.t1 > maxGap) {
      const end = last.y0 + (last.t1 - last.t0) * scale
      breaks.push({ y: end + BREAK_PX / 2, from: last.t1, to: time })
      segments.push({ t0: time, t1: time, y0: end + BREAK_PX })
    } else last.t1 = time
  }
  const last = segments.at(-1)
  const height = last ? last.y0 + (last.t1 - last.t0) * scale + PAD_PX : PAD_PX * 2
  const map = (time: number) => {
    if (!segments.length) return PAD_PX
    if (time <= segments[0].t0) return segments[0].y0
    let low = 0
    let high = segments.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (segments[middle].t0 <= time) low = middle
      else high = middle - 1
    }
    const segment = segments[low]
    if (time <= segment.t1) return segment.y0 + (time - segment.t0) * scale
    const segmentEnd = segment.y0 + (segment.t1 - segment.t0) * scale
    const next = segments[low + 1]
    if (!next) return segmentEnd
    // Inside a compressed gap: place proportionally within the break marker.
    return segmentEnd + (next.y0 - segmentEnd) * ((time - segment.t1) / (next.t0 - segment.t1))
  }
  const step = TICK_STEPS.find(candidate => candidate * scale >= 64) ?? TICK_STEPS.at(-1)!
  const ticks: SequenceTick[] = []
  for (const segment of segments) {
    ticks.push({ y: segment.y0, time: segment.t0, major: true })
    for (let time = Math.ceil(segment.t0 / step) * step; time <= segment.t1; time += step) {
      const tickY = segment.y0 + (time - segment.t0) * scale
      if (tickY - ticks.at(-1)!.y >= 40) ticks.push({ y: tickY, time, major: false })
    }
  }
  return { y: map, height, breaks, ticks, start: points[0] ?? 0, end: points.at(-1) ?? 0 }
}

export interface SequenceBar { key: string; laneId: string; x: number; y: number; height: number; event: SequenceEvent }

export interface SequenceArrow {
  key: string
  link: SequenceLink
  x1: number
  y1: number
  x2: number
  y2: number
  /** Time the delivery waited between send and consumption. */
  delayMs: number
}

export interface SequenceLayout {
  lanes: Array<SequenceLane & { x: number; startY: number }>
  bars: SequenceBar[]
  arrows: SequenceArrow[]
  scale: SequenceTimeScale
  width: number
  height: number
}

export const SEQUENCE_AXIS_WIDTH = 72
export const SEQUENCE_LANE_WIDTH = 132

const linkTimes = (link: SequenceLink) => [link.from.at ?? link.sentAt, link.sentAt, link.consumedAt ?? link.sentAt]

/** Picks the largest zoom whose compressed height stays within `maxHeight`. */
export function chooseSequenceZoom(data: SequenceData, events: SequenceEvent[], maxHeight = 5000): number {
  const times = sequenceTimes(data, events)
  for (const level of [...SEQUENCE_ZOOM_LEVELS].reverse()) {
    if (buildSequenceTimeScale(times, level).height <= maxHeight) return level
  }
  return SEQUENCE_ZOOM_LEVELS[0]
}

function sequenceTimes(data: SequenceData, events: SequenceEvent[]): number[] {
  const times: number[] = []
  for (const event of events) times.push(event.start, event.end)
  for (const link of data.links) times.push(...linkTimes(link))
  for (const session of data.sessions) if (session.startedAt) times.push(session.startedAt)
  return times
}

export function layoutSequence(data: SequenceData, options: { pxPerMinute: number; now: number }): SequenceLayout {
  const events = [...data.events, ...liveSequenceEvents(data.sessions, options.now)]
  const scale = buildSequenceTimeScale(sequenceTimes(data, events), options.pxPerMinute)
  const ordered = orderSequenceLanes(data)
  const sessions = new Map(data.sessions.map(session => [session.id, session]))
  const lanes = ordered.map((lane, index) => {
    const session = lane.sessionId ? sessions.get(lane.sessionId) : undefined
    // A Session created inside the window starts its lifeline at creation.
    return { ...lane, x: SEQUENCE_AXIS_WIDTH + index * SEQUENCE_LANE_WIDTH + SEQUENCE_LANE_WIDTH / 2, startY: session?.startedAt !== undefined ? scale.y(session.startedAt) : 0 }
  })
  const laneX = new Map(lanes.map(lane => [lane.id, lane.x]))
  const bars: SequenceBar[] = []
  for (const event of events) {
    const x = laneX.get(event.sessionId)
    if (x === undefined) continue
    const top = scale.y(event.start)
    bars.push({ key: `${sequenceEventKey(event)}${event.live ? '|live' : ''}`, laneId: event.sessionId, x: event.kind === 'llm' ? x - 7 : x + 1, y: top, height: Math.max(3, scale.y(event.end) - top), event })
  }
  const arrows: SequenceArrow[] = []
  for (const link of data.links) {
    const fromId = laneIdForEndpoint(link.from)
    const toId = laneIdForEndpoint(link.to)
    const x1 = fromId ? laneX.get(fromId) : undefined
    const x2 = toId ? laneX.get(toId) : undefined
    if (x1 === undefined || x2 === undefined || fromId === toId) continue
    const sent = link.from.at ?? link.sentAt
    const arrived = link.consumedAt ?? link.sentAt
    arrows.push({ key: link.key, link, x1, y1: scale.y(sent), x2, y2: scale.y(arrived), delayMs: Math.max(0, arrived - sent) })
  }
  return { lanes, bars, arrows, scale, width: SEQUENCE_AXIS_WIDTH + lanes.length * SEQUENCE_LANE_WIDTH + 24, height: scale.height }
}

/** Elements overlapping the visible band, so long histories render only what is on screen. */
export function visibleSequenceItems(layout: SequenceLayout, top: number, bottom: number) {
  return {
    bars: layout.bars.filter(bar => bar.y <= bottom && bar.y + bar.height >= top),
    arrows: layout.arrows.filter(arrow => Math.min(arrow.y1, arrow.y2) <= bottom && Math.max(arrow.y1, arrow.y2) >= top),
  }
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
