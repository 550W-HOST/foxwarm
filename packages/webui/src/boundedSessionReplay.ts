export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
  reset?: boolean
  revision?: string
}

export class BoundedReplayRevisionMismatch extends Error {
  constructor() { super('Bounded replay revision changed before the complete window was reconstructed.') }
}

export async function replayAtomicWindows<R extends { revision?: string }, B>(options: {
  loadRoots: () => Promise<R>
  loadBranches: (roots: R) => Promise<B>
  maxRestarts?: number
}): Promise<{ roots: R; branches: B }> {
  const maxRestarts = Math.max(0, Math.min(options.maxRestarts ?? 3, 10))
  for (let attempt = 0; ; attempt++) {
    try { const roots = await options.loadRoots(); return { roots, branches: await options.loadBranches(roots) } }
    catch (error) { if (!(error instanceof BoundedReplayRevisionMismatch) || attempt >= maxRestarts) throw error }
  }
}

export function chunkBoundedIds<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

export function mergeForcedPresentationPath(rootIds: readonly string[], childIds: ReadonlyMap<string, readonly string[]>, path: readonly string[]) {
  const roots = [...rootIds]; const children = new Map([...childIds].map(([parent, ids]) => [parent, [...ids]]))
  if (path.length && !roots.includes(path[0])) roots.push(path[0])
  for (let index = 0; index + 1 < path.length; index++) children.set(path[index], [...new Set([...(children.get(path[index]) || []), path[index + 1]])])
  return { rootIds: roots, childIds: children }
}

export function filterPresentationPathForAgent<T extends { agent?: string }>(path: readonly string[], rows: ReadonlyMap<string, T>, focusedId: string, selectedAgent: string | null): string[] {
  if (!selectedAgent) return [...path]
  if (rows.get(focusedId)?.agent !== selectedAgent) return []
  let start = path.length - 1
  while (start > 0 && rows.get(path[start - 1])?.agent === selectedAgent) start -= 1
  return path.slice(start)
}

export async function replayCursorWindow<T>(options: {
  targetCount: number
  pageCap: number
  fetchPage: (cursor: string | null, limit: number) => Promise<CursorPage<T>>
  maxRestarts?: number
}): Promise<{ items: T[]; nextCursor: string | null; pages: CursorPage<T>[]; revision?: string }> {
  const target = Math.max(0, Math.floor(options.targetCount))
  if (!target) return { items: [], nextCursor: null, pages: [], revision: undefined }
  const cap = Math.max(1, Math.floor(options.pageCap))
  const maxRestarts = options.maxRestarts ?? 3
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    const items: T[] = []
    const pages: CursorPage<T>[] = []
    let cursor: string | null = null
    let revision: string | undefined
    let restart = false
    while (items.length < target) {
      const page = await options.fetchPage(cursor, Math.min(cap, target - items.length))
      if (page.reset && cursor !== null) { restart = true; break }
      if (revision !== undefined && page.revision !== revision) { restart = true; break }
      revision ??= page.revision
      pages.push(page)
      items.push(...page.items)
      cursor = page.nextCursor
      if (!cursor || page.items.length === 0) return { items: items.slice(0, target), nextCursor: cursor, pages, revision }
    }
    if (!restart) return { items: items.slice(0, target), nextCursor: cursor, pages, revision }
  }
  throw new Error('Bounded cursor window kept resetting during replay.')
}

export interface BranchReplayRequest {
  parentSessionId: string
  cursor?: string
}

export interface BranchReplayGroup<T> {
  parentSessionId: string
  items: T[]
  nextCursor: string | null
  total?: number
}

export async function replayCursorBranches<T>(options: {
  targets: Map<string, number>
  pageCap: number
  parentBatchCap: number
  fetchBatch: (parents: BranchReplayRequest[], limit: number) => Promise<{ reset?: boolean; revision?: string; groups: BranchReplayGroup<T>[] }>
  maxRestarts?: number
  expectedRevision?: string
}): Promise<Map<string, { items: T[]; nextCursor: string | null; total: number }>> {
  const pageCap = Math.max(1, Math.floor(options.pageCap))
  const batchCap = Math.max(1, Math.floor(options.parentBatchCap))
  const maxRestarts = options.maxRestarts ?? 3
  for (let attempt = 0; attempt <= maxRestarts; attempt++) {
    const states = new Map([...options.targets].map(([id, target]) => [id, {
      target: Math.max(0, Math.floor(target)), items: [] as T[], cursor: null as string | null, total: 0, done: target <= 0,
    }]))
    let restart = false
    let revision = options.expectedRevision
    while ([...states.values()].some(state => !state.done)) {
      const pending = [...states.entries()].filter(([, state]) => !state.done)
      for (let offset = 0; offset < pending.length; offset += batchCap) {
        const batch = pending.slice(offset, offset + batchCap)
        const limit = Math.min(pageCap, Math.max(...batch.map(([, state]) => state.target - state.items.length)))
        const response = await options.fetchBatch(batch.map(([parentSessionId, state]) => ({
          parentSessionId, ...(state.cursor ? { cursor: state.cursor } : {}),
        })), limit)
        if (response.revision !== undefined && revision !== undefined && response.revision !== revision) {
          throw new BoundedReplayRevisionMismatch()
        }
        revision ??= response.revision
        if (response.reset && batch.some(([, state]) => state.cursor !== null)) { restart = true; break }
        const groups = new Map(response.groups.map(group => [group.parentSessionId, group]))
        for (const [parentSessionId, state] of batch) {
          const group = groups.get(parentSessionId)
          if (!group) { state.done = true; continue }
          state.items.push(...group.items)
          state.cursor = group.nextCursor
          state.total = Number(group.total ?? state.total)
          state.done = state.items.length >= state.target || !state.cursor || group.items.length === 0
        }
      }
      if (restart) break
    }
    if (!restart) return new Map([...states].map(([id, state]) => [id, {
      items: state.items.slice(0, state.target), nextCursor: state.cursor, total: Math.max(state.total, state.items.length),
    }]))
  }
  throw new Error('Bounded branch windows kept resetting during replay.')
}

export interface EpochRows<T extends { id: string; aliases?: string[] }> {
  rows: Map<string, T>
  epochs: Map<string, number>
  tombstones: Map<string, number>
  activeRequestStarts: Map<number, number>
  desiredKeep: Set<string>
  epoch: number
}

export function createEpochRows<T extends { id: string; aliases?: string[] }>(): EpochRows<T> {
  return { rows: new Map(), epochs: new Map(), tombstones: new Map(), activeRequestStarts: new Map(), desiredKeep: new Set(), epoch: 0 }
}

export function beginHttpRowsRequest<T extends { id: string; aliases?: string[] }>(state: EpochRows<T>): number {
  const start = state.epoch; state.activeRequestStarts.set(start, (state.activeRequestStarts.get(start) || 0) + 1); return start
}

export function endHttpRowsRequest<T extends { id: string; aliases?: string[] }>(state: EpochRows<T>, start: number): void {
  const count = state.activeRequestStarts.get(start) || 0
  if (count <= 1) state.activeRequestStarts.delete(start); else state.activeRequestStarts.set(start, count - 1)
  pruneEpochRows(state, state.desiredKeep)
}

export async function trackHttpRowsRequest<T extends { id: string; aliases?: string[] }, R>(state: EpochRows<T>, request: (startEpoch: number) => Promise<R>): Promise<R> {
  const start = beginHttpRowsRequest(state); try { return await request(start) } finally { endHttpRowsRequest(state, start) }
}

export function tombstoneRows<T extends { id: string; aliases?: string[] }>(state: EpochRows<T>, ids: readonly string[]): void {
  for (const id of ids) { const epoch = ++state.epoch; state.rows.delete(id); state.epochs.set(id, epoch); state.tombstones.set(id, epoch) }
}

export function captureExactAliasKeys<T extends { id: string; aliases?: string[] }>(state: EpochRows<T>, requestedIds: readonly string[]): Map<string, Set<string>> {
  return new Map(requestedIds.map(requested => { const keys = new Set([requested]); for (const [id, row] of state.rows) if (id === requested || row.aliases?.includes(requested)) { keys.add(id); for (const alias of row.aliases || []) keys.add(alias) } return [requested, keys] }))
}

export function applyExactMissTombstone<T extends { id: string; aliases?: string[] }>(state: EpochRows<T>, requested: string, knownKeys: ReadonlySet<string> | undefined, startEpoch: number): void {
  const keys = new Set(knownKeys || [requested]); keys.add(requested)
  const currentMatches = [...state.rows].filter(([id, row]) => id === requested || row.aliases?.includes(requested))
  for (const [id, row] of currentMatches) { keys.add(id); for (const alias of row.aliases || []) keys.add(alias) }
  const preserve = new Set<string>()
  for (const key of keys) { const row = state.rows.get(key); if (row && (state.epochs.get(row.id) || 0) > startEpoch) { preserve.add(row.id); for (const alias of row.aliases || []) preserve.add(alias) } }
  for (const [id, row] of currentMatches) if ((state.epochs.get(id) || 0) > startEpoch) { preserve.add(id); for (const alias of row.aliases || []) preserve.add(alias) }
  tombstoneRows(state, [...keys].filter(key => !preserve.has(key)))
}

export function mergeHttpRows<T extends { id: string; aliases?: string[] }>(state: EpochRows<T>, rows: readonly T[], startEpoch: number): void {
  for (const row of rows) {
    if ([row.id, ...(row.aliases || [])].some(id => (state.tombstones.get(id) || 0) > startEpoch)) continue
    if ((state.epochs.get(row.id) || 0) <= startEpoch) { state.rows.set(row.id, row); state.tombstones.delete(row.id) }
  }
}

export function mergeDeltaRows<T extends { id: string; aliases?: string[] }>(state: EpochRows<T>, rows: readonly T[], deletedIds: readonly string[] = []): void {
  for (const row of rows) {
    state.epoch++
    state.epochs.set(row.id, state.epoch)
    state.rows.set(row.id, row)
    state.tombstones.delete(row.id); for (const alias of row.aliases || []) state.tombstones.delete(alias)
  }
  for (const id of deletedIds) {
    state.epoch++
    state.epochs.set(id, state.epoch)
    state.rows.delete(id)
    state.tombstones.set(id, state.epoch)
  }
}

export function pruneEpochRows<T extends { id: string; aliases?: string[] }>(state: EpochRows<T>, keepIds: ReadonlySet<string>): void {
  state.desiredKeep = new Set(keepIds)
  for (const id of state.rows.keys()) if (!keepIds.has(id)) state.rows.delete(id)
  for (const [id, epoch] of state.epochs) if (!keepIds.has(id) && ![...state.activeRequestStarts.keys()].some(start => start < epoch)) { state.epochs.delete(id); state.tombstones.delete(id) }
}
