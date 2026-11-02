import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, RefreshCw } from 'lucide-react'
import { CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX, storeChatViewportState, updateChatBottomFollow, type ChatBottomFollowState } from '../chatViewportState'
import { SessionMessageNamesContext } from './SessionMessageCard'
import { formatTimelineTimeMarker } from './timelineTime'
import { OTHER_SESSION_PEER, SequenceCell, type SequenceItemActions } from './SessionSequenceItems'
import { useSequencePaging } from './useSequencePaging'
import {
  SEQUENCE_COLUMN_STRIDE,
  buildSequenceRows,
  connectedSequenceSessions,
  estimateSequenceRow,
  loadedSequenceRows,
  nextSequenceColumns,
  orderSequenceColumns,
  sequenceColumnItems,
  sequenceRowOffsets,
  sequenceRowSessions,
  sequenceRowWindow,
  sequenceScrollLeftShift,
  sessionLabel,
  stepSequenceWidths,
  type SequenceColumn,
  type SequenceColumnState,
  type SequenceData,
  type SequenceRow,
} from '../sessionSequence'

/** Opens a Session positioned at one of its messages. */
export function openSessionAtSeq(sessionId: string, seq: number | undefined, open: (sessionId: string) => void) {
  if (seq !== undefined && Number.isSafeInteger(seq) && seq > 0) {
    const anchor = { kind: 'anchor' as const, messageKey: `seq-local-${seq}`, offsetPx: 48 }
    storeChatViewportState(sessionId, anchor, 'continuous')
    storeChatViewportState(sessionId, anchor, 'active')
  }
  open(sessionId)
}

const COLUMN_CONTENT_WIDTH = SEQUENCE_COLUMN_STRIDE - 12
const WIDTH_ANIMATION_MS = 180
// Automatic older-page loading pauses after this many pages that add nothing to show.
const EMPTY_PAGE_LIMIT = 5

const STATE_LABELS: Record<SequenceColumnState, string> = { running: 'Running', waiting: 'Waiting', idle: 'Idle' }

function StateDot({ state }: { state: SequenceColumnState }) {
  const tone = state === 'running' ? 'bg-fw-success animate-pulse' : state === 'waiting' ? 'bg-fw-warning' : 'bg-fw-border-strong'
  return <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${tone}`} />
}

/** A column slot whose width animates; content keeps its full width and is clipped meanwhile. */
function Slot({ width, children, className, ...rest }: { width: number; children?: React.ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={`shrink-0 ${width < SEQUENCE_COLUMN_STRIDE ? 'overflow-hidden' : ''}`} style={{ width }} {...rest}>
      <div className={className} style={{ width: COLUMN_CONTENT_WIDTH }}>{children}</div>
    </div>
  )
}

interface RowProps {
  row: SequenceRow
  columns: string[]
  widths: Record<string, number>
  data: SequenceData
  now: number
  actions: SequenceItemActions
  separatorWidth: number
  observer: ResizeObserver | null
}

const SequenceRowView = memo(function SequenceRowView({ row, columns, widths, data, now, actions, separatorWidth, observer }: RowProps) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !observer) return
    observer.observe(element)
    return () => observer.unobserve(element)
  }, [observer])
  const marker = formatTimelineTimeMarker({ timestamp: row.start }, now)
  return (
    <div ref={ref} data-sequence-row-start={row.start}>
      <div style={{ width: separatorWidth }} className="sticky left-0 py-2 text-center text-[11px] text-fw-text-subtle" data-timeline-time-separator data-sequence-row={row.start}>
        <time dateTime={new Date(row.start).toISOString()} title={marker.title} className="tabular-nums">{marker.text}</time>
      </div>
      <div className="flex">
        {columns.map(id => (
          <Slot key={id} width={widths[id] ?? 0} className="min-w-0 border-l border-fw-border-muted/60 pl-2" data-sequence-cell={id}>
            {row.cells[id] ? <SequenceCell items={row.cells[id]} data={data} now={now} actions={actions} /> : null}
          </Slot>
        ))}
      </div>
    </div>
  )
})

function ColumnHeader({ column, width, pinned, onOpen }: { column: SequenceColumn; width: number; pinned: boolean; onOpen: (id: string) => void }) {
  return (
    <Slot width={width} data-sequence-column={column.id} data-state={column.state} data-pinned={pinned ? '' : undefined}>
      <button type="button" onClick={() => onOpen(column.id)} title={column.id}
        className="flex w-full min-w-0 flex-col items-start px-1 pb-2 pt-3 text-left hover:bg-fw-hover"
        style={{ paddingLeft: 4 + Math.min(column.depth, 4) * 8 }}>
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <StateDot state={column.state} />
          <span className="min-w-0 truncate text-[13px] font-semibold text-fw-text-strong">{column.label}</span>
        </span>
        <span className="mt-0.5 w-full truncate pl-3 text-[11px] text-fw-text-subtle">{[pinned ? 'This session' : null, STATE_LABELS[column.state], column.agent].filter(Boolean).join(' · ')}</span>
      </button>
    </Slot>
  )
}

export default function SessionSequenceView({ currentSession, onSelectSession }: { currentSession?: string; onSelectSession: (sessionId: string) => void }) {
  const pinned = currentSession || null
  const { data, paging, loading, error, loadNewest, loadOlder, trimOlder } = useSequencePaging()
  const [connectedOnly, setConnectedOnly] = useState(!!pinned)
  useEffect(() => { setConnectedOnly(!!pinned) }, [pinned])
  const [now, setNow] = useState(Date.now())
  const [highlightKey, setHighlightKey] = useState<string | null>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0, width: 0 })
  const [following, setFollowing] = useState(true)
  const [heightsVersion, setHeightsVersion] = useState(0)
  const [observer, setObserver] = useState<ResizeObserver | null>(null)
  const renderCountRef = useRef(0)
  renderCountRef.current++
  const [autoOlder, setAutoOlder] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const heightsRef = useRef(new Map<number, number>())
  const followRef = useRef<ChatBottomFollowState>({ following: true, pendingUserLeave: false })
  const intentRef = useRef<'none' | 'leave' | 'toward-bottom'>('none')
  const pointerRef = useRef(false)
  const anchorRef = useRef<{ start: number; offset: number } | null>(null)
  const frameRef = useRef(0)
  // Scroll position set from row offsets while the anchor row is not rendered yet.
  const placedRef = useRef<number | null>(null)

  const setFollow = useCallback((next: ChatBottomFollowState) => {
    followRef.current = next
    setFollowing(next.following)
    if (next.following) anchorRef.current = null
  }, [])

  // Running work is drawn up to now.
  const busy = !!data?.sessions.some(session => session.runtimeState?.busy ?? session.busy)
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [busy])

  const connected = useMemo(() => pinned && connectedOnly && data ? connectedSequenceSessions(data, pinned) : null, [pinned, connectedOnly, data])
  const columnsById = useMemo(() => {
    const result = new Map<string, SequenceColumn>()
    for (const column of data ? orderSequenceColumns(data) : []) result.set(column.id, column)
    if (pinned && !result.has(pinned)) result.set(pinned, { id: pinned, label: pinned.split('/').pop() || pinned, depth: 0, state: 'idle' })
    return result
  }, [data, pinned])
  // Tree order, pinned Session first; `order` is limited to what the filter shows.
  const fullOrder = useMemo(() => {
    const ids = [...columnsById.keys()].filter(id => id !== pinned)
    return pinned ? [pinned, ...ids] : ids
  }, [columnsById, pinned])
  const order = useMemo(() => connected ? fullOrder.filter(id => connected.has(id)) : fullOrder, [fullOrder, connected])
  const rows = useMemo(() => {
    if (!data) return []
    const all = sequenceColumnItems(data, now)
    const items = connected ? new Map([...all].filter(([id]) => connected.has(id))) : all
    return loadedSequenceRows(buildSequenceRows(items), paging.loadedFrom)
  }, [data, now, connected, paging.loadedFrom])
  const offsets = useMemo(() => sequenceRowOffsets(rows, row => heightsRef.current.get(row.start) ?? estimateSequenceRow(row)), [rows, heightsVersion])

  // Row heights are measured once rendered; estimates fill in for rows never rendered.
  useEffect(() => {
    const instance = new ResizeObserver(entries => {
      let changed = false
      for (const entry of entries) {
        const element = entry.target as HTMLElement
        const start = Number(element.getAttribute('data-sequence-row-start'))
        if (heightsRef.current.get(start) !== element.offsetHeight) { heightsRef.current.set(start, element.offsetHeight); changed = true }
      }
      if (changed) setHeightsVersion(version => version + 1)
    })
    setObserver(instance)
    return () => instance.disconnect()
  }, [])

  // Columns: join with items within one viewport of the visible rows, leave only with none
  // within two, so columns do not flicker at the edge. The pinned Session never leaves.
  const [shown, setShown] = useState<string[]>([])
  useEffect(() => {
    const { top, height } = viewport
    const near = sequenceRowSessions(rows, ...sequenceRowWindow(offsets, top, height, height))
    const far = sequenceRowSessions(rows, ...sequenceRowWindow(offsets, top, height, 2 * height))
    setShown(current => {
      const next = nextSequenceColumns({ order, current: current.filter(id => order.includes(id)), near, far, pinned })
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next
    })
  }, [rows, offsets, viewport, order, pinned])

  // Column widths animate toward the shown set. The first layout after a load is immediate.
  const [widths, setWidths] = useState<Record<string, number>>({})
  const widthsRef = useRef(widths); widthsRef.current = widths
  const instantRef = useRef(true)
  useEffect(() => {
    if (instantRef.current || document.visibilityState !== 'visible') {
      const next = Object.fromEntries(shown.map(id => [id, SEQUENCE_COLUMN_STRIDE]))
      widthsRef.current = next
      setWidths(next)
      return
    }
    let frame = 0
    let last = performance.now()
    const tick = (time: number) => {
      const next = stepSequenceWidths(widthsRef.current, shown, (time - last) * SEQUENCE_COLUMN_STRIDE / WIDTH_ANIMATION_MS)
      last = time
      if (next === widthsRef.current) return
      widthsRef.current = next
      setWidths(next)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [shown])
  useEffect(() => {
    if (!paging.pages[0]) return
    const timer = window.setTimeout(() => { instantRef.current = false }, 400)
    return () => window.clearTimeout(timer)
  }, [paging.pages[0]])
  const rendered = useMemo(() => fullOrder.filter(id => (widths[id] ?? 0) > 0), [fullOrder, widths])

  // Already-visible columns keep their horizontal position when others come and go.
  const previousWidthsRef = useRef(widths)
  useLayoutEffect(() => {
    const element = scrollRef.current
    const before = previousWidthsRef.current
    previousWidthsRef.current = widths
    if (!element || before === widths) return
    const shift = sequenceScrollLeftShift(fullOrder, before, widths, element.scrollLeft)
    if (shift) element.scrollLeft += shift
  }, [widths, fullOrder])

  // The timeline fills the rest of the page (or split pane) instead of scrolling with it.
  const [fitHeight, setFitHeight] = useState<number | null>(null)
  useEffect(() => {
    const element = scrollRef.current
    const page = element?.closest<HTMLElement>('[data-system-section]')
    if (!element || !page) return
    const fit = () => {
      const top = element.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop
      setFitHeight(Math.max(420, Math.floor(page.clientHeight - top - 24)))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(page)
    return () => observer.disconnect()
  }, [])

  const measure = useCallback(() => {
    const element = scrollRef.current
    const list = rowsRef.current
    if (!element || !list) return
    const top = element.scrollTop - list.offsetTop
    setViewport(previous => previous.top === top && previous.height === element.clientHeight && previous.width === element.clientWidth ? previous : { top, height: element.clientHeight, width: element.clientWidth })
  }, [])

  // The visual anchor: the first row reaching into view and its offset from the top edge.
  const captureAnchor = useCallback(() => {
    const element = scrollRef.current
    if (!element || followRef.current.following) return
    const view = element.getBoundingClientRect()
    for (const row of element.querySelectorAll<HTMLElement>('[data-sequence-row-start]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom > view.top && rect.top < view.bottom) { anchorRef.current = { start: Number(row.getAttribute('data-sequence-row-start')), offset: rect.top - view.top }; return }
    }
    // Rows for a new scroll position are not rendered yet; nothing to keep in place.
    anchorRef.current = null
  }, [])

  // After every render: follow the bottom, or keep the anchor row where the user left it, so
  // prepended pages, measured heights and column changes do not move what is being read.
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    if (followRef.current.following) {
      if (element.scrollTop !== element.scrollHeight - element.clientHeight) element.scrollTop = element.scrollHeight
    } else if (anchorRef.current) {
      const { start, offset } = anchorRef.current
      const row = element.querySelector<HTMLElement>(`[data-sequence-row-start="${start}"]`)
      if (row) {
        placedRef.current = null
        const delta = row.getBoundingClientRect().top - element.getBoundingClientRect().top - offset
        if (Math.abs(delta) >= 1) element.scrollTop += delta
      } else if (rowsRef.current) {
        // Rows were inserted above and the window has not moved there yet: place it by offsets,
        // and the next render corrects any estimate from the rendered row.
        const index = rows.findIndex(item => item.start === start)
        if (index >= 0) {
          element.scrollTop = rowsRef.current.offsetTop + offsets[index] - offset
          placedRef.current = element.scrollTop
        }
      }
    }
    if (placedRef.current === null) captureAnchor()
    // Measured on the next frame, so a render never synchronously triggers another.
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(measure)
  })
  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  const onScroll = () => {
    const element = scrollRef.current
    if (!element) return
    if (placedRef.current !== null) {
      // Our own placement, not the user's; keep the anchor until its row renders.
      if (Math.abs(placedRef.current - element.scrollTop) < 1) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = requestAnimationFrame(measure)
        return
      }
      placedRef.current = null
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    let intent = intentRef.current
    if (pointerRef.current && distance > CHAT_BOTTOM_FOLLOW_REJOIN_THRESHOLD_PX) intent = 'leave'
    intentRef.current = 'none'
    const next = updateChatBottomFollow({ ...followRef.current, distanceFromBottom: distance, userIntent: intent })
    if (next.following !== followRef.current.following || next.pendingUserLeave !== followRef.current.pendingUserLeave) setFollow(next)
    captureAnchor()
    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(measure)
  }

  // Wheel, touch, keys and scrollbar drags express the user's intent, as in Chat.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const wheel = (event: WheelEvent) => { if (event.deltaY) intentRef.current = event.deltaY < 0 ? 'leave' : 'toward-bottom' }
    const key = (event: KeyboardEvent) => {
      if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) intentRef.current = 'leave'
      if (['PageDown', 'ArrowDown', 'End'].includes(event.key)) intentRef.current = 'toward-bottom'
    }
    const touch = () => { intentRef.current = 'leave' }
    const down = () => { pointerRef.current = true }
    const up = () => { pointerRef.current = false }
    element.addEventListener('wheel', wheel, { passive: true })
    element.addEventListener('keydown', key)
    element.addEventListener('touchmove', touch, { passive: true })
    element.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    const resize = new ResizeObserver(() => measure())
    resize.observe(element)
    return () => {
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('keydown', key)
      element.removeEventListener('touchmove', touch)
      element.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
      resize.disconnect()
    }
  }, [measure])

  // Older pages load as the top comes near; pages that add nothing visible (for example with
  // the Connected filter) stop automatic loading after a few, leaving a button.
  const emptyPagesRef = useRef(0)
  const rowCountRef = useRef<number | null>(null)
  useEffect(() => {
    if (loading === 'older') { rowCountRef.current ??= rows.length; return }
    if (rowCountRef.current === null) return
    emptyPagesRef.current = rows.length > rowCountRef.current ? 0 : emptyPagesRef.current + 1
    rowCountRef.current = null
    if (emptyPagesRef.current >= EMPTY_PAGE_LIMIT) setAutoOlder(false)
  }, [loading, rows.length])
  useEffect(() => {
    if (!autoOlder || loading || !paging.hasMore || !viewport.height) return
    if (viewport.top < viewport.height) void loadOlder()
  }, [autoOlder, loading, paging.hasMore, viewport, loadOlder])
  const loadEarlier = () => { emptyPagesRef.current = 0; setAutoOlder(true); void loadOlder() }
  useEffect(() => { emptyPagesRef.current = 0; setAutoOlder(true) }, [connectedOnly])
  // Far older pages are dropped again once the newest activity is back in view.
  useEffect(() => { if (following) trimOlder() }, [following, paging.pages.length, trimOlder])

  const reload = () => {
    instantRef.current = true
    heightsRef.current.clear()
    setFollow({ following: true, pendingUserLeave: false })
    emptyPagesRef.current = 0
    setAutoOlder(true)
    void loadNewest()
  }
  const jumpToNewest = () => {
    setFollow({ following: true, pendingUserLeave: false })
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }

  const names = useMemo(() => {
    const result: Record<string, string> = { [OTHER_SESSION_PEER]: 'Other session' }
    for (const peer of data?.peers || []) if (!peer.opaque) result[peer.id] = sessionLabel(peer)
    for (const session of data?.sessions || []) result[session.id] = sessionLabel(session)
    return result
  }, [data?.sessions, data?.peers])
  const open = useCallback((sessionId: string, seq?: number) => openSessionAtSeq(sessionId, seq, onSelectSession), [onSelectSession])
  const actions = useMemo<SequenceItemActions>(() => ({ highlightKey, onHighlight: setHighlightKey, onOpen: open }), [highlightKey, open])

  const [start, end] = sequenceRowWindow(offsets, viewport.top, viewport.height || 800, viewport.height || 800)
  const totalWidth = rendered.reduce((sum, id) => sum + (widths[id] ?? 0), 0)
  const separatorWidth = Math.max(0, Math.min((viewport.width || 0) - 24, totalWidth - 12))
  const pinnedLabel = pinned ? names[pinned] || pinned.split('/').pop() : null
  const pill = (active: boolean) => `rounded-md px-2.5 py-1 font-medium ${active ? 'bg-fw-text-strong text-fw-surface' : 'text-fw-text-muted hover:bg-fw-hover'}`
  const status = loading === 'older' ? 'Loading earlier activity…'
    : !paging.hasMore ? (rows.length ? 'Start of history' : null)
    : !autoOlder ? null : ' '

  return (
    <div className="flex min-w-0 flex-col gap-3" data-session-sequence>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-xs text-fw-text-muted">What each session did, side by side, and the messages between them.</p>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {pinned ? (
            <div className="inline-flex rounded-lg border border-fw-border bg-fw-surface p-0.5" role="group" aria-label="Sessions shown">
              <button type="button" aria-pressed={!connectedOnly} onClick={() => setConnectedOnly(false)} className={pill(!connectedOnly)}>All</button>
              <button type="button" aria-pressed={connectedOnly} onClick={() => setConnectedOnly(true)} title={`${pinnedLabel} and the sessions it exchanged messages, sessions or Tasks with`} className={`max-w-[220px] truncate ${pill(connectedOnly)}`}>Connected to {pinnedLabel}</button>
            </div>
          ) : null}
          <button type="button" aria-label="Reload" onClick={reload} className="rounded-lg border border-fw-border bg-fw-surface p-1.5 text-fw-text-muted hover:bg-fw-hover"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
        </div>
      </div>
      {error ? <div className="rounded-xl border border-fw-danger-border bg-fw-danger-surface px-3 py-2 text-xs text-fw-danger">{error}</div> : null}
      <div className="relative">
        <div ref={scrollRef} onScroll={onScroll} tabIndex={0} style={{ overflowAnchor: 'none', height: fitHeight ?? 'calc(100vh - 260px)' }}
          className="min-h-[420px] overflow-auto rounded-xl border border-fw-border bg-fw-surface outline-none"
          data-sequence-scroll data-following={following ? '' : undefined} data-has-more={paging.hasMore ? '' : undefined} data-loaded-from={paging.loadedFrom ?? undefined} data-renders={renderCountRef.current}>
          {data && (rows.length || rendered.length) ? (
            <SessionMessageNamesContext.Provider value={names}>
              <div className="relative px-3 pb-4" style={{ width: totalWidth + 24, minWidth: '100%' }} data-sequence-grid>
                <div className="sticky top-0 z-10 flex border-b border-fw-border-muted bg-fw-surface/95 backdrop-blur">
                  {rendered.map(id => <ColumnHeader key={id} column={columnsById.get(id)!} width={widths[id] ?? 0} pinned={id === pinned} onOpen={open} />)}
                </div>
                <div style={{ width: separatorWidth }} className="sticky left-0 flex h-8 items-center justify-center text-[11px] text-fw-text-subtle" data-sequence-status>
                  {status ?? (paging.hasMore ? <button type="button" onClick={loadEarlier} className="rounded-md px-2 py-0.5 text-fw-text-muted hover:bg-fw-hover">Load earlier activity</button> : null)}
                </div>
                <div ref={rowsRef} style={{ paddingTop: offsets[start] ?? 0, paddingBottom: (offsets.at(-1) ?? 0) - (offsets[end] ?? 0) }}>
                  {rows.slice(start, end).map(row => (
                    <SequenceRowView key={row.start} row={row} columns={rendered} widths={widths} data={data} now={now} actions={actions} separatorWidth={separatorWidth} observer={observer} />
                  ))}
                </div>
              </div>
            </SessionMessageNamesContext.Provider>
          ) : <div className="flex h-full items-center justify-center p-6 text-sm text-fw-text-muted">{loading ? 'Loading…' : 'No session activity yet.'}</div>}
        </div>
        {!following && data ? (
          <button type="button" onClick={jumpToNewest} className="absolute bottom-4 right-6 inline-flex items-center gap-1 rounded-full border border-fw-border bg-fw-surface px-3 py-1.5 text-xs text-fw-text shadow-md hover:bg-fw-hover" data-sequence-jump-newest>
            <ArrowDown className="h-3.5 w-3.5" />Newest
          </button>
        ) : null}
      </div>
    </div>
  )
}
