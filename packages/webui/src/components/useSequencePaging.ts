import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE_PATH } from '../config'
import { webUiRealtime } from '../realtime'
import { mergeSequenceData, trimSequenceData, type SequenceCursor, type SequenceData } from '../sessionSequence'

export const SEQUENCE_PAGE_LIMIT = 400
// Rows are committed slightly after their timestamps; live requests overlap by this much.
const LIVE_SLACK_MS = 10_000
// After returning to the newest activity, older pages beyond this many are dropped.
const MAX_PAGES = 8
const KEEP_PAGES = 3

export async function fetchSequence(body: Record<string, unknown>, signal?: AbortSignal): Promise<SequenceData> {
  const response = await fetch(`${API_BASE_PATH}/session-sequence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || `Timeline unavailable (${response.status})`)
  return payload as SequenceData
}

// The route accepts this many cursors. Sessions left out are read again from `since`, and the
// merge drops the duplicates.
const MAX_CURSORS = 1000
const liveCursors = (data: SequenceData): Record<string, number> => {
  const entries = Object.entries(data.cursors)
  if (entries.length <= MAX_CURSORS) return data.cursors
  const recent = new Map(data.sessions.map(session => [session.id, session.lastMessageTime ?? 0]))
  return Object.fromEntries(entries.sort((a, b) => (recent.get(b[0]) ?? 0) - (recent.get(a[0]) ?? 0)).slice(0, MAX_CURSORS))
}

interface PageMark { from: number | null; next: SequenceCursor | null }

export interface SequencePaging {
  pages: PageMark[]
  next: SequenceCursor | null
  hasMore: boolean
  /** Start of the oldest loaded page; older rows are not shown until their page loads. */
  loadedFrom: number | null
}

const EMPTY: SequencePaging = { pages: [], next: null, hasMore: false, loadedFrom: null }

/** Newest-first pages of the timeline, older pages on demand and live appends at the end. */
export function useSequencePaging() {
  const [data, setData] = useState<SequenceData | null>(null)
  const [paging, setPaging] = useState<SequencePaging>(EMPTY)
  const [loading, setLoading] = useState<'newest' | 'older' | null>(null)
  const [error, setError] = useState('')
  const dataRef = useRef(data); dataRef.current = data
  const pagingRef = useRef(paging); pagingRef.current = paging
  const generationRef = useRef(0)
  const olderRef = useRef(false)
  const liveRef = useRef(false)
  const sinceRef = useRef(0)

  const loadNewest = useCallback(async () => {
    const generation = ++generationRef.current
    olderRef.current = false
    setLoading('newest')
    try {
      const page = await fetchSequence({ limit: SEQUENCE_PAGE_LIMIT })
      if (generation !== generationRef.current) return
      sinceRef.current = page.generatedAt - LIVE_SLACK_MS
      const from = page.range?.from ?? null
      setData(page)
      setPaging({ pages: [{ from, next: page.next ?? null }], next: page.next ?? null, hasMore: !!page.hasMore, loadedFrom: from })
      setError('')
    } catch (failure) {
      if (generation === generationRef.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (generation === generationRef.current) setLoading(null)
    }
  }, [])

  const loadOlder = useCallback(async () => {
    const current = pagingRef.current
    if (olderRef.current || !current.hasMore || !current.next) return
    const generation = generationRef.current
    olderRef.current = true
    setLoading('older')
    try {
      const page = await fetchSequence({ before: current.next, limit: SEQUENCE_PAGE_LIMIT })
      if (generation !== generationRef.current) return
      setData(previous => previous ? mergeSequenceData(previous, page) : page)
      setPaging(previous => ({
        pages: [...previous.pages, { from: page.range?.from ?? null, next: page.next ?? null }],
        next: page.next ?? null,
        hasMore: !!page.hasMore,
        loadedFrom: page.range?.from ?? previous.loadedFrom,
      }))
      setError('')
    } catch (failure) {
      if (generation === generationRef.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      if (generation === generationRef.current) { olderRef.current = false; setLoading(null) }
    }
  }, [])

  const refreshLive = useCallback(async () => {
    const current = dataRef.current
    if (!current || liveRef.current) return
    const generation = generationRef.current
    liveRef.current = true
    try {
      const delta = await fetchSequence({ since: sinceRef.current, after: liveCursors(current) })
      if (generation !== generationRef.current) return
      sinceRef.current = Math.max(sinceRef.current, delta.generatedAt - LIVE_SLACK_MS)
      setData(previous => previous ? mergeSequenceData(previous, delta) : delta)
    } catch { /* The next change retries. */ } finally { liveRef.current = false }
  }, [])

  /** Drops distant older pages; called while the newest activity is in view. */
  const trimOlder = useCallback(() => {
    const current = pagingRef.current
    if (current.pages.length <= MAX_PAGES) return
    const keep = current.pages[KEEP_PAGES - 1]
    // Only a minute-boundary page end can be reloaded with a plain time cursor.
    if (keep.from == null || !keep.next || keep.next.sessionId !== undefined) return
    const cutoff = keep.from
    setData(previous => previous ? trimSequenceData(previous, cutoff) : previous)
    setPaging({ pages: current.pages.slice(0, KEEP_PAGES), next: keep.next, hasMore: true, loadedFrom: cutoff })
  }, [])

  useEffect(() => { void loadNewest() }, [loadNewest])

  const updateRuntime = useCallback((rows: Array<{ id: string; busy?: boolean; runtimeState?: unknown; lastMessageTime?: number; displayName?: string }>) => {
    if (!rows.length) return
    const byId = new Map(rows.map(row => [row.id, row]))
    setData(previous => previous ? { ...previous, sessions: previous.sessions.map(session => {
      const row = byId.get(session.id)
      return row ? { ...session, busy: row.busy, runtimeState: row.runtimeState as never, lastMessageTime: row.lastMessageTime ?? session.lastMessageTime, displayName: row.displayName ?? session.displayName } : session
    }) } : previous)
  }, [])

  // Live: list deltas for loaded Sessions carry runtime state; any change requests new rows,
  // and a slow visible refresh picks up Sessions that become active without a delta here.
  const laneKey = useMemo(() => data?.sessions.map(session => session.id).join('\0') || '', [data?.sessions])
  useEffect(() => {
    let timer: number | null = null
    const schedule = () => { if (timer === null) timer = window.setTimeout(() => { timer = null; void refreshLive() }, 1200) }
    const unsubscribe = webUiRealtime.subscribeSessionList(laneKey ? laneKey.split('\0') : [], {
      onOpen: () => schedule(),
      onMessage: message => {
        if (message.type === 'session-list-delta') { updateRuntime((message.sessions || []) as never); schedule() }
        if (message.type === 'session-list-invalidated' || message.type === 'sessions-updated') schedule()
      },
    })
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') schedule() }, 30_000)
    return () => { if (timer !== null) window.clearTimeout(timer); window.clearInterval(interval); unsubscribe() }
  }, [laneKey, refreshLive, updateRuntime])

  return { data, paging, loading, error, loadNewest, loadOlder, trimOlder }
}
