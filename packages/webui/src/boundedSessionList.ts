import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { API_BASE_PATH } from './config'
import type { Session } from './components/SessionListCore'
import { createSessionListRefreshScheduler, type SessionListRefreshScheduler } from './sessionListRefresh'
import type { SessionListOrderMode } from './sessionListPresentation'
import { applyExactMissTombstone, captureExactAliasKeys, chunkBoundedIds, createEpochRows, mergeDeltaRows, mergeHttpRows, pruneEpochRows, replayAtomicWindows, replayCursorBranches, replayCursorWindow, trackHttpRowsRequest } from './boundedSessionReplay'

export interface BoundedChildPage { parentSessionId: string; ids: string[]; total: number; nextCursor: string | null }
interface SidebarPayload { version: 1; sessions: Session[]; nextCursor: string | null; reset?: boolean
  children?: Array<{ parentSessionId: string; sessions: Session[]; total: number; nextCursor: string | null }>
  focus?: Array<{ session: Session | null }>; pathContext?: Array<{ session: Session | null }>; forcedChildren?: Record<string, string[]> }
interface CacheState { rows: Map<string, Session>; rootIds: string[]; rootCursor: string | null; rootTarget: number
  childPages: Map<string, BoundedChildPage>; previewParents: Set<string>; ownedBranches: Map<string, number>
  forcedChildren: Record<string, string[]>; searchIds: string[] | null; descendantBusy: Map<string, number>; invalidationVersion: number }
const emptyState = (rootTarget: number): CacheState => ({ rows: new Map(), rootIds: [], rootCursor: null, rootTarget,
  childPages: new Map(), previewParents: new Set(), ownedBranches: new Map(), forcedChildren: {}, searchIds: null,
  descendantBusy: new Map(), invalidationVersion: 0 })
const dedupe = (ids: Iterable<string>) => [...new Set(ids)]
function responseError(response: Response): Promise<Error> { return response.json().catch(() => ({})).then(body => new Error(body?.error || `Request failed (${response.status})`)) }
async function fetchJson(path: string, init?: RequestInit): Promise<any> { const response = await fetch(`${API_BASE_PATH}${path}`, init); if (!response.ok) throw await responseError(response); return response.json() }
function currentWatchIds(): string[] { try { const value = JSON.parse(localStorage.getItem('foxwarm_session_idle_notifications_v1') || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [] } catch { return [] } }
function structuralIds(state: Pick<CacheState, 'rootIds'|'childPages'|'forcedChildren'>): string[] {
  const ids = [...state.rootIds]
  for (const page of state.childPages.values()) ids.push(page.parentSessionId, ...page.ids)
  for (const [parent, children] of Object.entries(state.forcedChildren)) ids.push(parent, ...children)
  return dedupe(ids)
}
function ownedKeepIds(state: CacheState, exactIds: readonly string[]): Set<string> {
  return new Set([...structuralIds(state), ...exactIds, ...(state.searchIds || [])])
}
function clearBranchOwnership(current: CacheState): CacheState {
  return { ...current, childPages: new Map(), previewParents: new Set(), ownedBranches: new Map(), forcedChildren: {}, descendantBusy: new Map() }
}

export interface BoundedSessionListController { sessions: Session[]; knownSessions: Session[]; mode: SessionListOrderMode; query: string
  hasMoreRoots: boolean; childPages: Map<string, BoundedChildPage>; descendantBusy: Map<string, number>; invalidationVersion: number
  setMode: (mode: SessionListOrderMode) => void; setQuery: (query: string) => void; loadMoreRoots: () => Promise<void>
  loadMoreChildren: (id: string) => Promise<void>; expandBranch: (id: string) => Promise<void>; collapseBranch: (id: string) => void
  refresh: () => Promise<void>; invalidate: () => void; globalSummary: { total: number; busy: number } | null }

export function useBoundedSessionList(options: { focusIds: string[]; exactIds?: string[]; rootLimit?: number; childLimit?: number; connectStream?: boolean; includeGlobalSummary?: boolean; includeIdleWatches?: boolean }): BoundedSessionListController {
  const rootLimit = options.rootLimit || 50; const childLimit = options.childLimit || 5
  const [mode, setModeState] = useState<SessionListOrderMode>('default'); const [query, setQueryState] = useState('')
  const [watchIds, setWatchIds] = useState<string[]>(currentWatchIds); const [state, setState] = useState(() => emptyState(rootLimit))
  const [globalSummary, setGlobalSummary] = useState<{ total: number; busy: number } | null>(null)
  const stateRef = useRef(state); stateRef.current = state; const queryRef = useRef(query); queryRef.current = query
  const rowStoreRef = useRef(createEpochRows<Session>()); const windowGenerationRef = useRef(0); const exactGenerationRef = useRef(0)
  const searchGenerationRef = useRef(0); const badgeGenerationRef = useRef(0); const summaryGenerationRef = useRef(0)
  const schedulerRef = useRef<SessionListRefreshScheduler | null>(null)
  const invalidationIdentityRef = useRef<string | null>(null)
  const focusIds = useMemo(() => dedupe(options.focusIds.filter(Boolean)).slice(0, 8), [options.focusIds.join('\0')])
  const exactIds = useMemo(() => dedupe([...focusIds, ...(options.exactIds || []), ...(options.includeIdleWatches === false ? [] : watchIds)].filter(Boolean)), [focusIds.join('\0'), (options.exactIds || []).join('\0'), watchIds.join('\0'), options.includeIdleWatches])
  const exactIdsRef = useRef(exactIds); exactIdsRef.current = exactIds

  useEffect(() => { const update = () => setWatchIds(currentWatchIds()); window.addEventListener('foxwarm-idle-watch-changed', update); window.addEventListener('storage', update)
    return () => { window.removeEventListener('foxwarm-idle-watch-changed', update); window.removeEventListener('storage', update) } }, [])

  const publish = useCallback((next: CacheState, httpRows: Session[], startEpoch: number) => {
    mergeHttpRows(rowStoreRef.current, httpRows, startEpoch); pruneEpochRows(rowStoreRef.current, ownedKeepIds(next, exactIdsRef.current)); next.rows = new Map(rowStoreRef.current.rows); stateRef.current = next; setState(next)
  }, [])

  const collectRoots = useCallback(async (target: number) => {
    const result = await replayCursorWindow<Session>({ targetCount: target, pageCap: 100, fetchPage: async (cursor, limit) => {
      const params = new URLSearchParams({ mode, limit: String(limit), childLimit: String(childLimit) }); if (cursor) params.set('cursor', cursor)
      for (const id of focusIds) params.append('focusSessionId', id)
      const payload = await fetchJson(`/session-list/sidebar?${params}`) as SidebarPayload
      return { ...payload, items: payload.sessions, nextCursor: payload.nextCursor }
    } })
    const pages = result.pages as Array<SidebarPayload & { items: Session[] }>; const rows: Session[] = [...result.items]
    const childPages = new Map<string, BoundedChildPage>(); const previewParents = new Set<string>(); let forcedChildren: Record<string, string[]> = {}
    for (const page of pages) { for (const group of page.children || []) { previewParents.add(group.parentSessionId); childPages.set(group.parentSessionId, { parentSessionId: group.parentSessionId, ids: group.sessions.map(row => row.id), total: group.total, nextCursor: group.nextCursor }); rows.push(...group.sessions) }
      rows.push(...(page.focus || []).flatMap(item => item.session ? [item.session] : []), ...(page.pathContext || []).flatMap(item => item.session ? [item.session] : [])); forcedChildren = { ...forcedChildren, ...(page.forcedChildren || {}) } }
    return { rootIds: result.items.map(row => row.id), rootCursor: result.nextCursor, childPages, previewParents, forcedChildren, rows, revision: result.revision }
  }, [mode, childLimit, focusIds.join('\0')])

  const collectBranches = useCallback(async (targets: Map<string, number>, expectedRevision?: string) => replayCursorBranches<Session>({ targets, pageCap: 20, parentBatchCap: 20, expectedRevision,
    fetchBatch: async (parents, limit) => { const payload = await fetchJson('/session-list/children', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, limit, parents }) })
      return { reset: payload.reset, revision: payload.revision, groups: (payload.children || []).map((group: any) => ({ parentSessionId: group.parentSessionId, items: group.sessions, nextCursor: group.nextCursor, total: group.total })) } } }), [mode])

  const replayOwnedWindows = useCallback(async (rootTarget: number, branchTargets: Map<string, number>) => trackHttpRowsRequest(rowStoreRef.current, async startEpoch => {
    const generation = ++windowGenerationRef.current
    const { roots, branches } = await replayAtomicWindows({ loadRoots: () => collectRoots(rootTarget),
      loadBranches: roots => branchTargets.size ? collectBranches(branchTargets, roots.revision) : Promise.resolve(new Map<string, { items: Session[]; nextCursor: string | null; total: number }>()) })
    if (generation !== windowGenerationRef.current) return
    const current = stateRef.current; const next: CacheState = { ...current, rootIds: roots.rootIds, rootCursor: roots.rootCursor, rootTarget,
      childPages: new Map(roots.childPages), previewParents: new Set(roots.previewParents), ownedBranches: new Map(branchTargets), forcedChildren: roots.forcedChildren,
      descendantBusy: new Map(current.descendantBusy), rows: new Map() }
    const rows = [...roots.rows]
    for (const [parent, replay] of branches) { next.childPages.set(parent, { parentSessionId: parent, ids: replay.items.map(row => row.id), total: replay.total, nextCursor: replay.nextCursor }); rows.push(...replay.items) }
    // Keep only expanded branches still connected to a current root/focus path.
    const reachable = new Set(roots.rootIds); for (const [parent, children] of Object.entries(roots.forcedChildren)) { reachable.add(parent); children.forEach(id => reachable.add(id)) }
    let changed = true; while (changed) { changed = false; for (const [parent] of next.ownedBranches) if (reachable.has(parent)) for (const id of next.childPages.get(parent)?.ids || []) if (!reachable.has(id)) { reachable.add(id); changed = true } }
    for (const parent of [...next.ownedBranches.keys()]) if (!reachable.has(parent)) { next.ownedBranches.delete(parent); if (!next.previewParents.has(parent)) next.childPages.delete(parent) }
    publish(next, rows, startEpoch); void loadBadges(structuralIds(next))
  }), [collectRoots, collectBranches, publish])

  const loadBadges = useCallback(async (ids: string[]) => {
    const requested = dedupe(ids); const generation = ++badgeGenerationRef.current; const counts = new Map<string, number>()
    for (const batch of chunkBoundedIds(requested, 100)) { const payload = await fetchJson('/session-list/descendant-activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch }) }); for (const item of payload.results || []) counts.set(item.sessionId, Number(item.busy || 0)) }
    if (generation !== badgeGenerationRef.current) return; const next = { ...stateRef.current, descendantBusy: counts }; stateRef.current = next; setState(next)
  }, [])

  const loadExact = useCallback(async () => trackHttpRowsRequest(rowStoreRef.current, async startEpoch => { const generation = ++exactGenerationRef.current; const rows: Session[] = []; const missing: string[] = []
    const known = captureExactAliasKeys(rowStoreRef.current, exactIds)
    for (const batch of chunkBoundedIds(exactIds, 100)) { const payload = await fetchJson('/session-list/by-id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch, includePaths: false }) }); for (const item of payload.results || []) item.session ? rows.push(item.session) : missing.push(item.requestedId) }
    if (generation !== exactGenerationRef.current) return; mergeHttpRows(rowStoreRef.current, rows, startEpoch)
    for (const requested of missing) applyExactMissTombstone(rowStoreRef.current, requested, known.get(requested), startEpoch)
    const next = { ...stateRef.current, rows: new Map() }; pruneEpochRows(rowStoreRef.current, ownedKeepIds(next, exactIds)); next.rows = new Map(rowStoreRef.current.rows); stateRef.current = next; setState(next)
  }), [exactIds.join('\0')])

  const loadSearch = useCallback(async (value: string) => trackHttpRowsRequest(rowStoreRef.current, async startEpoch => { const generation = ++searchGenerationRef.current
    const payload = await fetchJson(`/session-list/search?${new URLSearchParams({ q: value, limit: '100' })}`); if (generation !== searchGenerationRef.current) return
    const next = { ...stateRef.current, searchIds: (payload.sessions || []).map((row: Session) => row.id), rows: new Map() }; publish(next, payload.sessions || [], startEpoch)
  }), [publish])
  const loadSummary = useCallback(async () => { if (!options.includeGlobalSummary) return; const generation = ++summaryGenerationRef.current; const payload = await fetchJson('/session-list/architecture?limit=1&childLimit=1'); if (generation === summaryGenerationRef.current) setGlobalSummary({ total: Number(payload.summary?.total || 0), busy: Number(payload.summary?.busy || 0) }) }, [options.includeGlobalSummary])

  const refresh = useCallback(async () => { const current = stateRef.current; await replayOwnedWindows(current.rootTarget, new Map(current.ownedBranches)); await loadExact(); await loadSummary(); if (queryRef.current.trim()) await loadSearch(queryRef.current.trim()) }, [replayOwnedWindows, loadExact, loadSummary, loadSearch])
  const invalidate = useCallback(() => { const next = { ...stateRef.current, invalidationVersion: stateRef.current.invalidationVersion + 1 }; stateRef.current = next; setState(next); schedulerRef.current?.requestRefresh() }, [])
  useEffect(() => { const scheduler = createSessionListRefreshScheduler(refresh); schedulerRef.current = scheduler; return () => { scheduler.dispose(); if (schedulerRef.current === scheduler) schedulerRef.current = null } }, [refresh])
  useEffect(() => { void replayOwnedWindows(stateRef.current.rootTarget, new Map()).then(loadSummary).catch(error => console.error('Failed bounded Session bootstrap', error)) }, [replayOwnedWindows, loadSummary])
  useEffect(() => { void loadExact().catch(error => console.error('Failed bounded Session exact context', error)) }, [loadExact])

  const setMode = useCallback((nextMode: SessionListOrderMode) => { if (nextMode === mode) return; setModeState(nextMode); const next = clearBranchOwnership({ ...stateRef.current, rootTarget: rootLimit }); stateRef.current = next; setState(next) }, [mode, rootLimit])
  const setQuery = useCallback((nextQuery: string) => {
    const cleared = !!queryRef.current.trim() && !nextQuery.trim()
    if (nextQuery !== queryRef.current) { const next = clearBranchOwnership(stateRef.current); stateRef.current = next; setState(next) }
    setQueryState(nextQuery)
    if (cleared) void replayOwnedWindows(stateRef.current.rootTarget, new Map()).catch(error => console.error('Failed bounded Session search reset', error))
  }, [replayOwnedWindows])
  useEffect(() => { const value = query.trim(); ++searchGenerationRef.current; if (!value) { const next = { ...stateRef.current, searchIds: null, rows: new Map() }; pruneEpochRows(rowStoreRef.current, ownedKeepIds(next, exactIds)); next.rows = new Map(rowStoreRef.current.rows); stateRef.current = next; setState(next); return }
    const timer = window.setTimeout(() => { void loadSearch(value).catch(error => console.error('Failed bounded Session search', error)) }, 150); return () => window.clearTimeout(timer) }, [query, loadSearch, exactIds.join('\0')])

  const expandBranch = useCallback(async (id: string) => { const current = stateRef.current; const targets = new Map(current.ownedBranches); targets.set(id, Math.max(childLimit, current.childPages.get(id)?.ids.length || 0)); await replayOwnedWindows(current.rootTarget, targets) }, [childLimit, replayOwnedWindows])
  const collapseBranch = useCallback((id: string) => { const current = stateRef.current; const remove = new Set([id]); let changed = true; while (changed) { changed = false; for (const [parent, page] of current.childPages) if (remove.has(parent)) for (const child of page.ids) if (!remove.has(child)) { remove.add(child); changed = true } }
    const targets = new Map(current.ownedBranches); for (const branch of remove) targets.delete(branch)
    void replayOwnedWindows(current.rootTarget, targets).catch(error => console.error('Failed bounded Session collapse replay', error)) }, [replayOwnedWindows])
  const loadMoreRoots = useCallback(async () => { const current = stateRef.current; await replayOwnedWindows(current.rootTarget + 50, new Map(current.ownedBranches)) }, [replayOwnedWindows])
  const loadMoreChildren = useCallback(async (id: string) => { const current = stateRef.current; const targets = new Map(current.ownedBranches); targets.set(id, (targets.get(id) || current.childPages.get(id)?.ids.length || 0) + 10); await replayOwnedWindows(current.rootTarget, targets) }, [replayOwnedWindows])

  const subscriptionIds = useMemo(() => dedupe([...exactIds, ...(state.searchIds || []), ...structuralIds(state)]), [exactIds.join('\0'), (state.searchIds || []).join('\0'), structuralIds(state).join('\0')])
  useEffect(() => {
    if (options.connectStream === false) return
    let disposed = false; let legacyPending = false; let legacyTimer: number | null = null
    const controllers = (subscriptionIds.length ? chunkBoundedIds(subscriptionIds, 100) : [[]]).map(batch => ({ batch, source: null as EventSource | null, timer: null as number | null, delay: 1000 }))
    const handleInvalidation = (data: any) => {
      const identity = data.eventId !== undefined ? `${data.eventId}:${data.presentationRevision ?? ''}` : null
      if (identity) { if (invalidationIdentityRef.current === identity) return; invalidationIdentityRef.current = identity }
      else { if (legacyPending) return; legacyPending = true; legacyTimer = window.setTimeout(() => { legacyPending = false }, 50) }
      invalidate()
    }
    const connect = (controller: typeof controllers[number]) => {
      if (disposed) return
      controller.source?.close(); if (controller.timer !== null) { window.clearTimeout(controller.timer); controller.timer = null }
      const params = new URLSearchParams(); controller.batch.forEach(id => params.append('sessionId', id)); const queryString = params.toString()
      const source = new EventSource(`${API_BASE_PATH}/sessions/stream${queryString ? `?${queryString}` : ''}`); controller.source = source
      source.onopen = () => { controller.delay = 1000 }
      source.onmessage = event => { try { const data = JSON.parse(event.data); if (data.type === 'session-list-delta') { mergeDeltaRows(rowStoreRef.current, data.sessions || [], data.deletedIds || []); const next = { ...stateRef.current, rows: new Map(rowStoreRef.current.rows) }; stateRef.current = next; setState(next) } if (data.type === 'sessions-updated' || data.type === 'session-list-invalidated') handleInvalidation(data) } catch {} }
      source.onerror = () => { source.close(); if (disposed) return; controller.timer = window.setTimeout(() => { invalidate(); connect(controller); controller.delay = Math.min(controller.delay * 2, 30000) }, controller.delay) }
    }
    controllers.forEach(connect)
    return () => { disposed = true; controllers.forEach(controller => { controller.source?.close(); if (controller.timer !== null) window.clearTimeout(controller.timer) }); if (legacyTimer !== null) window.clearTimeout(legacyTimer) }
  }, [subscriptionIds.join('\0'), options.connectStream, invalidate])

  const visibleIds = state.searchIds || structuralIds(state)
  return { sessions: visibleIds.map(id => state.rows.get(id)).filter((row): row is Session => !!row), knownSessions: [...state.rows.values()], mode, query,
    hasMoreRoots: !query.trim() && !!state.rootCursor, childPages: query.trim() ? new Map() : state.childPages, descendantBusy: state.descendantBusy,
    invalidationVersion: state.invalidationVersion, setMode, setQuery, loadMoreRoots, loadMoreChildren, expandBranch, collapseBranch, refresh, invalidate, globalSummary }
}
