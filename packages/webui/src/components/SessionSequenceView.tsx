import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Minus, Plus, RefreshCw } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import { webUiRealtime } from '../realtime'
import { storeChatViewportState } from '../chatViewportState'
import { SEQUENCE_LINK_COLORS, SequenceCanvas, SequenceDetails, type SequenceSelection } from './SessionSequenceCanvas'
import {
  SEQUENCE_LANE_WIDTH,
  SEQUENCE_WINDOWS,
  SEQUENCE_ZOOM_LEVELS,
  chooseSequenceZoom,
  layoutSequence,
  liveSequenceEvents,
  mergeSequenceData,
  unloadedSequencePeers,
  visibleSequenceItems,
  type SequenceData,
  type SequenceLayout,
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
  const [zoom, setZoom] = useState<number | null>(null)
  const [selection, setSelection] = useState<SequenceSelection>(null)
  const [now, setNow] = useState(Date.now())
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
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

  useEffect(() => { setZoom(null); setSelection(null); void reload() }, [reload])

  // Live updates: Session list deltas carry runtime state and message times for loaded lanes.
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

  const effectiveZoom = useMemo(() => zoom ?? (data ? chooseSequenceZoom(data, [...data.events, ...liveSequenceEvents(data.sessions, data.generatedAt)]) : 60), [zoom, data])
  const layout = useMemo<SequenceLayout | null>(() => data ? layoutSequence(data, { pxPerMinute: effectiveZoom, now }) : null, [data, effectiveZoom, now])

  // Follow the newest activity while the view is scrolled to the bottom.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || !layout) return
    if (followRef.current) element.scrollTop = element.scrollHeight
    setViewport({ top: element.scrollTop, height: element.clientHeight })
  }, [layout?.height])

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32
    setViewport({ top: element.scrollTop, height: element.clientHeight })
  }

  const zoomBy = (direction: 1 | -1) => {
    const levels = [...SEQUENCE_ZOOM_LEVELS]
    const index = levels.findIndex(level => level >= effectiveZoom)
    const next = levels[Math.max(0, Math.min(levels.length - 1, (index < 0 ? levels.length - 1 : index) + direction))]
    setZoom(next)
  }

  const visible = layout ? visibleSequenceItems(layout, viewport.top - 400, viewport.top + viewport.height + 400) : { bars: [], arrows: [] }
  const laneLabels = useMemo(() => new Map(layout?.lanes.map(lane => [lane.id, lane.label]) || []), [layout?.lanes])
  const focusLabel = focusId ? (data?.sessions.find(session => session.id === focusId)?.displayName || focusId.split('/').pop()) : null

  return (
    <div className="flex min-w-0 flex-col gap-3" data-session-sequence>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div>
          <h2 className="text-sm font-semibold text-fw-text-strong">Session sequence</h2>
          <p className="mt-0.5 text-xs text-fw-text-muted">Model requests, tool runs, and messages between sessions over time.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="inline-flex rounded-lg border border-fw-border bg-fw-surface p-0.5" role="group" aria-label="Time window">
            {SEQUENCE_WINDOWS.map(item => <button key={item.id} type="button" aria-pressed={windowId === item.id} onClick={() => setWindowId(item.id)} className={`rounded-md px-2.5 py-1 font-medium ${windowId === item.id ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`}>{item.label}</button>)}
          </div>
          <div className="inline-flex rounded-lg border border-fw-border bg-fw-surface p-0.5" role="group" aria-label="Sessions shown">
            <button type="button" aria-pressed={!focusId} onClick={() => setFocusId(null)} className={`rounded-md px-2.5 py-1 font-medium ${!focusId ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`}>All active</button>
            <button type="button" aria-pressed={!!focusId} disabled={!focusId && !currentSession} onClick={() => setFocusId(focusId || currentSession || null)} title={focusId ? `Sessions connected to ${focusLabel}` : 'Sessions connected to the current session'} className={`max-w-[220px] truncate rounded-md px-2.5 py-1 font-medium disabled:opacity-40 ${focusId ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`}>{focusId ? `Connected to ${focusLabel}` : 'Connected'}</button>
          </div>
          <div className="inline-flex items-center rounded-lg border border-fw-border bg-fw-surface p-0.5">
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(-1)} className="rounded-md p-1 text-fw-text-muted hover:bg-fw-hover"><Minus className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Fit to view" title="Fit to view" onClick={() => setZoom(null)} className="min-w-[56px] rounded-md px-1.5 py-1 tabular-nums text-fw-text-muted hover:bg-fw-hover">{effectiveZoom >= 60 ? `${effectiveZoom / 60} px/s` : `${effectiveZoom} px/min`}</button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1)} className="rounded-md p-1 text-fw-text-muted hover:bg-fw-hover"><Plus className="h-3.5 w-3.5" /></button>
          </div>
          <button type="button" aria-label="Refresh" onClick={() => void reload()} className="rounded-lg border border-fw-border bg-fw-surface p-1.5 text-fw-text-muted hover:bg-fw-hover"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </div>
      <SequenceLegend />
      {error ? <div className="rounded-xl border border-fw-danger-border bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger">{error}</div> : null}
      {data?.truncatedSessions ? <div className="px-1 text-xs text-fw-text-muted">Showing the most recently active sessions. Choose a shorter window or a connected view to see fewer.</div> : null}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div ref={scrollRef} onScroll={onScroll} className="relative h-[calc(100vh-300px)] min-h-[420px] overflow-auto rounded-xl border border-fw-border bg-fw-surface" data-sequence-scroll>
          {layout && layout.lanes.length ? <>
            <div className="sticky top-0 z-10 h-12 border-b border-fw-border-muted bg-fw-surface/95 backdrop-blur" style={{ width: layout.width }}>
              {layout.lanes.map(lane => (
                <button key={lane.id} type="button" disabled={!lane.sessionId} onClick={() => lane.sessionId && openSessionAtSeq(lane.sessionId, undefined, onSelectSession)} title={lane.sessionId || lane.label}
                  className="absolute top-1.5 flex h-9 flex-col items-center justify-center truncate rounded-md px-1 text-center hover:bg-fw-hover disabled:hover:bg-transparent"
                  style={{ left: lane.x - SEQUENCE_LANE_WIDTH / 2 + 4, width: SEQUENCE_LANE_WIDTH - 8 }} data-sequence-lane={lane.id}>
                  <span className={`max-w-full truncate text-xs font-semibold ${lane.kind === 'session' ? 'text-fw-text-strong' : 'text-fw-text-muted'}`}>{lane.busy ? <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-fw-success align-middle" /> : null}{lane.label}</span>
                  {lane.detail ? <span className="max-w-full truncate text-[10px] text-fw-text-subtle">{lane.detail}</span> : null}
                </button>
              ))}
            </div>
            <SequenceCanvas layout={layout} bars={visible.bars} arrows={visible.arrows} selection={selection} onSelect={setSelection} />
          </> : <div className="flex h-full items-center justify-center p-6 text-sm text-fw-text-muted">{loading ? 'Loading…' : 'No session activity in this window.'}</div>}
        </div>
        <SequenceDetails selection={selection} data={data} laneLabels={laneLabels} onClose={() => setSelection(null)} onOpen={(sessionId, seq) => openSessionAtSeq(sessionId, seq, onSelectSession)} onFocus={sessionId => setFocusId(sessionId)} />
      </div>
    </div>
  )
}

function SequenceLegend() {
  const item = (label: string, swatch: JSX.Element) => <span className="inline-flex items-center gap-1.5">{swatch}{label}</span>
  const line = (color: string, dash?: string) => <svg width="22" height="8" aria-hidden><line x1="1" y1="4" x2="21" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash} /></svg>
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-fw-text-muted">
      {item('Model request', <span className="h-3 w-1.5 rounded-sm bg-fw-accent/60" />)}
      {item('Tool run', <span className="h-3 w-1.5 rounded-sm bg-fw-tool" />)}
      {item('Message', line(SEQUENCE_LINK_COLORS.message))}
      {item('Task', line(SEQUENCE_LINK_COLORS.task))}
      {item('New session', line(SEQUENCE_LINK_COLORS.spawn))}
      {item('Matched by time', line('var(--foxwarm-color-text-muted)', '4 3'))}
      {item('Not read yet', <svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="4" fill="none" stroke="var(--foxwarm-color-text-muted)" strokeWidth="1.5" /></svg>)}
    </div>
  )
}
