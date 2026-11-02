import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import { webUiRealtime } from '../realtime'
import { storeChatViewportState } from '../chatViewportState'
import { SessionMessageNamesContext } from './SessionMessageCard'
import { formatTimelineTimeMarker } from './timelineTime'
import { OTHER_SESSION_PEER, SequenceCell, type SequenceItemActions } from './SessionSequenceItems'
import {
  SEQUENCE_WINDOWS,
  buildSequenceGrid,
  mergeSequenceData,
  sessionLabel,
  unloadedSequencePeers,
  type SequenceColumnState,
  type SequenceData,
  type SequenceWindowId,
} from '../sessionSequence'

async function fetchSequence(body: Record<string, unknown>, signal?: AbortSignal): Promise<SequenceData> {
  const response = await fetch(`${API_BASE_PATH}/session-sequence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Sequence unavailable (${response.status})`)
  return payload as SequenceData
}

/** Opens a Session positioned at one of its messages. */
export function openSessionAtSeq(sessionId: string, seq: number | undefined, open: (sessionId: string) => void) {
  if (seq !== undefined && Number.isSafeInteger(seq) && seq > 0) {
    const anchor = { kind: 'anchor' as const, messageKey: `seq-local-${seq}`, offsetPx: 48 }
    storeChatViewportState(sessionId, anchor, 'continuous')
    storeChatViewportState(sessionId, anchor, 'active')
  }
  open(sessionId)
}

export default function SessionSequenceView({ currentSession, onSelectSession }: { currentSession?: string; onSelectSession: (sessionId: string) => void }) {
  const [windowId, setWindowId] = useState<SequenceWindowId>('1h')
  const [focusId, setFocusId] = useState<string | null>(currentSession || null)
  const [data, setData] = useState<SequenceData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [highlightKey, setHighlightKey] = useState<string | null>(null)
  const [viewWidth, setViewWidth] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const dataRef = useRef<SequenceData | null>(null); dataRef.current = data
  const requestRef = useRef(0)
  const followRef = useRef(true)

  useEffect(() => { setFocusId(currentSession || null) }, [currentSession])

  const since = useCallback(() => Date.now() - SEQUENCE_WINDOWS.find(item => item.id === windowId)!.ms, [windowId])

  const reload = useCallback(async () => {
    const request = ++requestRef.current
    setLoading(true)
    try {
      const next = await fetchSequence({ since: since(), ...(focusId ? { focusSessionId: focusId } : {}) })
      if (request !== requestRef.current) return
      setData(next); setError('')
    } catch (failure) {
      if (request === requestRef.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [focusId, since])

  const refreshIncremental = useCallback(async () => {
    const current = dataRef.current
    if (!current || !current.sessions.length) return
    const request = requestRef.current
    try {
      const delta = await fetchSequence({ since: current.since, sessionIds: current.sessions.map(session => session.id), after: current.cursors })
      if (request !== requestRef.current || dataRef.current !== current) return
      const merged = mergeSequenceData(current, delta)
      setData(merged)
      // A peer that is not on screen yet (for example a new child) needs a full selection.
      if (unloadedSequencePeers(merged).length > unloadedSequencePeers(current).length) void reload()
    } catch { /* The next change or reload retries. */ }
  }, [reload])

  useEffect(() => { void reload() }, [reload])

  // Live updates: Session list deltas carry runtime state and message times for loaded columns.
  const laneIds = useMemo(() => data?.sessions.map(session => session.id) || [], [data?.sessions])
  useEffect(() => {
    let timer: number | null = null
    const schedule = () => { if (timer === null) timer = window.setTimeout(() => { timer = null; void refreshIncremental() }, 1200) }
    const unsubscribe = webUiRealtime.subscribeSessionList(laneIds, {
      onOpen: () => schedule(),
      onMessage: message => {
        if (message.type === 'session-list-delta') {
          const rows = (message.sessions || []) as Array<{ id: string; busy?: boolean; runtimeState?: unknown; lastMessageTime?: number; displayName?: string }>
          if (rows.length) setData(previous => previous ? { ...previous, sessions: previous.sessions.map(session => { const row = rows.find(item => item.id === session.id); return row ? { ...session, busy: row.busy, runtimeState: row.runtimeState as never, lastMessageTime: row.lastMessageTime ?? session.lastMessageTime, displayName: row.displayName ?? session.displayName } : session }) } : previous)
          schedule()
        }
        if (message.type === 'session-list-invalidated') schedule()
      },
    })
    return () => { if (timer !== null) window.clearTimeout(timer); unsubscribe() }
  }, [laneIds.join('\0'), refreshIncremental])

  // Without a focus, Sessions that become active elsewhere join on a slow full refresh.
  useEffect(() => {
    if (focusId) return
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void reload() }, 60_000)
    return () => window.clearInterval(timer)
  }, [focusId, reload])

  const busy = !!data?.sessions.some(session => session.runtimeState?.busy ?? session.busy)
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  const grid = useMemo(() => data ? buildSequenceGrid(data, now) : null, [data, now])
  const names = useMemo(() => {
    const result: Record<string, string> = { [OTHER_SESSION_PEER]: 'Other session' }
    for (const peer of data?.peers || []) if (!peer.opaque) result[peer.id] = sessionLabel(peer)
    for (const session of data?.sessions || []) result[session.id] = sessionLabel(session)
    return result
  }, [data?.sessions, data?.peers])
  const open = useCallback((sessionId: string, seq?: number) => openSessionAtSeq(sessionId, seq, onSelectSession), [onSelectSession])
  const actions = useMemo<SequenceItemActions>(() => ({ highlightKey, onHighlight: setHighlightKey, onOpen: open }), [highlightKey, open])

  // Follow the newest activity while the view is scrolled to the bottom.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (element && followRef.current) element.scrollTop = element.scrollHeight
  }, [grid?.rows.length, data?.generatedAt])

  // Time separators stay centered in the visible part of a horizontally scrolled grid.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => setViewWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const onScroll = () => {
    const element = scrollRef.current
    if (element) followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32
  }

  const focusLabel = focusId ? names[focusId] || focusId.split('/').pop() : null
  const pill = (active: boolean) => `rounded-md px-2.5 py-1 font-medium ${active ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`
  const columns = grid?.columns || []
  const template = `repeat(${columns.length}, ${COLUMN_WIDTH}px)`

  return (
    <div className="flex min-w-0 flex-col gap-3" data-session-sequence>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div>
          <h2 className="text-sm font-semibold text-fw-text-strong">Session sequence</h2>
          <p className="mt-0.5 text-xs text-fw-text-muted">What each session did, side by side, and the messages between them.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="inline-flex rounded-lg border border-fw-border bg-fw-surface p-0.5" role="group" aria-label="Time window">
            {SEQUENCE_WINDOWS.map(item => <button key={item.id} type="button" aria-pressed={windowId === item.id} onClick={() => setWindowId(item.id)} className={pill(windowId === item.id)}>{item.label}</button>)}
          </div>
          <div className="inline-flex rounded-lg border border-fw-border bg-fw-surface p-0.5" role="group" aria-label="Sessions shown">
            <button type="button" aria-pressed={!focusId} onClick={() => setFocusId(null)} className={pill(!focusId)}>All active</button>
            <button type="button" aria-pressed={!!focusId} disabled={!focusId && !currentSession} onClick={() => setFocusId(focusId || currentSession || null)} title={focusId ? `Sessions connected to ${focusLabel}` : 'Sessions connected to the current session'} className={`max-w-[220px] truncate disabled:opacity-40 ${pill(!!focusId)}`}>{focusId ? `Connected to ${focusLabel}` : 'Connected'}</button>
          </div>
          <button type="button" aria-label="Refresh" onClick={() => void reload()} className="rounded-lg border border-fw-border bg-fw-surface p-1.5 text-fw-text-muted hover:bg-fw-hover"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </div>
      {error ? <div className="rounded-xl border border-fw-danger-border bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger">{error}</div> : null}
      {data?.truncatedSessions ? <div className="px-1 text-xs text-fw-text-muted">Showing the most recently active sessions. Choose a shorter window or a connected view to see fewer.</div> : null}
      <div ref={scrollRef} onScroll={onScroll} className="relative h-[calc(100vh-260px)] min-h-[420px] overflow-auto rounded-xl border border-fw-border bg-fw-surface" data-sequence-scroll>
        {grid && columns.length ? (
          <SessionMessageNamesContext.Provider value={names}>
            <div className="grid w-max gap-x-3 px-3 pb-4" style={{ gridTemplateColumns: template }} data-sequence-grid data-bucket-minutes={grid.bucketMs / 60_000}>
              {columns.map(column => (
                <button key={column.id} type="button" onClick={() => open(column.id)} title={column.partial ? `${column.id} · Earlier activity in this window is not shown` : column.id}
                  className="sticky top-0 z-10 flex min-w-0 flex-col items-start border-b border-fw-border-muted bg-fw-surface/95 px-1 pb-2 pt-3 text-left backdrop-blur hover:bg-fw-hover"
                  style={{ paddingLeft: 4 + Math.min(column.depth, 4) * 8 }} data-sequence-column={column.id} data-state={column.state}>
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    <StateDot state={column.state} />
                    <span className="min-w-0 truncate text-[13px] font-semibold text-fw-text-strong">{column.label}</span>
                  </span>
                  <span className="mt-0.5 w-full truncate pl-3 text-[11px] text-fw-text-subtle">{[STATE_LABELS[column.state], column.agent, column.partial ? 'recent only' : null].filter(Boolean).join(' · ')}</span>
                </button>
              ))}
              {grid.rows.map(row => {
                const marker = formatTimelineTimeMarker({ timestamp: row.start }, now)
                return [
                  <div key={`t${row.start}`} style={{ gridColumn: '1 / -1', width: viewWidth ? Math.min(viewWidth - 24, columns.length * (COLUMN_WIDTH + 12) - 12) : undefined }} className="sticky left-0 my-2 text-center text-[11px] text-fw-text-subtle" data-timeline-time-separator data-sequence-row={row.start}>
                    <time dateTime={new Date(row.start).toISOString()} title={marker.title} className="tabular-nums">{marker.text}</time>
                  </div>,
                  ...columns.map(column => (
                    <div key={`${row.start}|${column.id}`} className="min-w-0 border-l border-fw-border-muted/60 pl-2" data-sequence-cell={column.id}>
                      {row.cells[column.id] ? <SequenceCell items={row.cells[column.id]} data={data!} now={now} actions={actions} /> : null}
                    </div>
                  )),
                ]
              })}
            </div>
          </SessionMessageNamesContext.Provider>
        ) : <div className="flex h-full items-center justify-center p-6 text-sm text-fw-text-muted">{loading ? 'Loading…' : 'No session activity in this window.'}</div>}
      </div>
    </div>
  )
}

const COLUMN_WIDTH = 300

const STATE_LABELS: Record<SequenceColumnState, string> = { running: 'Running', waiting: 'Waiting', idle: 'Idle' }

function StateDot({ state }: { state: SequenceColumnState }) {
  const tone = state === 'running' ? 'bg-fw-success animate-pulse' : state === 'waiting' ? 'bg-fw-warning' : 'bg-fw-border-strong'
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${tone}`} />
}
