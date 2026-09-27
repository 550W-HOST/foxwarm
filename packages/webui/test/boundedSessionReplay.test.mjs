import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/boundedSessionReplay.ts', import.meta.url), 'utf8')
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
const replay = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)

test('root replay reconstructs 150 rows atomically after a cursor reset', async () => {
  const all = Array.from({ length: 180 }, (_, index) => `root-${index}`)
  let resetOnce = true
  const calls = []
  const result = await replay.replayCursorWindow({ targetCount: 150, pageCap: 100, fetchPage: async (cursor, limit) => {
    calls.push({ cursor, limit })
    const offset = cursor ? Number(cursor) : 0
    if (offset > 0 && resetOnce) { resetOnce = false; return { items: [], nextCursor: null, reset: true } }
    const items = all.slice(offset, offset + limit)
    return { items, nextCursor: offset + items.length < all.length ? String(offset + items.length) : null }
  } })
  assert.deepEqual(result.items, all.slice(0, 150))
  assert.ok(calls.filter(call => call.cursor === null).length >= 2, 'reset restarts from page one')
  assert.ok(calls.every(call => call.limit <= 100))
})

test('branch replay handles 25-child and one-child owned branches in batches of at most 20 parents/pages', async () => {
  const targets = new Map([['wide', 25], ['one', 1], ...Array.from({ length: 19 }, (_, index) => [`small-${index}`, 1])])
  const data = new Map([...targets].map(([id, count]) => [id, Array.from({ length: id === 'wide' ? 31 : count }, (_, index) => `${id}-${index}`)]))
  let resetOnce = true
  const calls = []
  const result = await replay.replayCursorBranches({ targets, pageCap: 20, parentBatchCap: 20, fetchBatch: async (parents, limit) => {
    calls.push({ parents, limit })
    if (parents.some(parent => parent.cursor) && resetOnce) { resetOnce = false; return { reset: true, groups: [] } }
    return { groups: parents.map(parent => { const rows = data.get(parent.parentSessionId); const offset = parent.cursor ? Number(parent.cursor) : 0; const items = rows.slice(offset, offset + limit)
      return { parentSessionId: parent.parentSessionId, items, total: rows.length, nextCursor: offset + items.length < rows.length ? String(offset + items.length) : null } }) }
  } })
  assert.deepEqual(result.get('wide').items, data.get('wide').slice(0, 25))
  assert.deepEqual(result.get('one').items, ['one-0'])
  assert.ok(calls.every(call => call.parents.length <= 20 && call.limit <= 20))
  assert.ok(calls.some(call => call.parents.length === 20), 'expanded parents are batched')
})

test('nested branch replay materializes only explicitly expanded parent windows', async () => {
  const data = new Map([
    ['root', [{ id: 'child' }]],
    ['child', [{ id: 'grandchild' }]],
    ['unrelated', [{ id: 'unrelated-child' }]],
  ])
  const calls = []
  const fetchBatch = async parents => {
    calls.push(parents.map(parent => parent.parentSessionId))
    return { revision: 'r1', groups: parents.map(parent => ({
      parentSessionId: parent.parentSessionId,
      items: data.get(parent.parentSessionId) || [],
      total: (data.get(parent.parentSessionId) || []).length,
      nextCursor: null,
    })) }
  }

  const collapsed = await replay.replayCursorBranches({
    targets: new Map([['root', 5]]), pageCap: 20, parentBatchCap: 20, expectedRevision: 'r1', fetchBatch,
  })
  assert.deepEqual(collapsed.get('root').items.map(row => row.id), ['child'])
  assert.equal(collapsed.has('child'), false)
  assert.deepEqual(calls.flat(), ['root'], 'collapsed descendants and unrelated rows are not requested')

  calls.length = 0
  const expanded = await replay.replayCursorBranches({
    targets: new Map([['root', 5], ['child', 5]]), pageCap: 20, parentBatchCap: 20, expectedRevision: 'r1', fetchBatch,
  })
  assert.deepEqual(expanded.get('child').items.map(row => row.id), ['grandchild'])
  assert.deepEqual(new Set(calls.flat()), new Set(['root', 'child']))
  assert.equal(calls.flat().includes('unrelated'), false)
})

test('newer SSE deltas and tombstones win over older HTTP rows', () => {
  const state = replay.createEpochRows()
  const start = state.epoch
  replay.mergeDeltaRows(state, [{ id: 'live', value: 'delta' }], ['deleted'])
  replay.mergeHttpRows(state, [{ id: 'live', value: 'old-http' }, { id: 'deleted', value: 'old-http' }, { id: 'untouched', value: 'http' }], start)
  assert.equal(state.rows.get('live').value, 'delta')
  assert.equal(state.rows.has('deleted'), false)
  assert.equal(state.rows.get('untouched').value, 'http')
})

test('state-only SSE deltas preserve an exact bounded child count until topology refetch', () => {
  const existing = new Map([['child', { id: 'child', childTotal: 1, runtime: 'idle' }]])
  const rows = replay.preserveKnownChildTotals(existing, [{ id: 'child', runtime: 'busy' }, { id: 'new', runtime: 'idle' }])
  assert.deepEqual(rows, [{ id: 'child', childTotal: 1, runtime: 'busy' }, { id: 'new', runtime: 'idle' }])
  assert.deepEqual(replay.preserveKnownChildTotals(existing, [{ id: 'child', childTotal: 0, runtime: 'busy' }]),
    [{ id: 'child', childTotal: 0, runtime: 'busy' }], 'an explicit topology count is never replaced by the cache')

  const state = replay.createEpochRows()
  replay.mergeDeltaRows(state, [{ id: 'child', childTotal: 1, runtime: 'idle' }])
  const refreshStart = replay.beginHttpRowsRequest(state)
  replay.mergeDeltaRows(state, replay.preserveKnownChildTotals(state.rows, [{ id: 'child', runtime: 'busy' }]))
  replay.mergeHttpRows(state, [{ id: 'child', childTotal: 0, runtime: 'stale-http' }], refreshStart)
  assert.deepEqual(state.rows.get('child'), { id: 'child', childTotal: 0, runtime: 'busy' },
    'topology refetch updates only the count when a newer state delta owns the rest of the row')
  replay.endHttpRowsRequest(state, refreshStart)
})

test('state-only SSE deltas preserve bounded sequence message counts while fresh rows may fall back', () => {
  const existing = new Map([['session', { id: 'session', messageCount: 2, sequenceMessageCount: 17 }]])
  assert.deepEqual(replay.preserveKnownSequenceMessageCounts(existing, [{ id: 'session', messageCount: 3 }]), [
    { id: 'session', messageCount: 3, sequenceMessageCount: 17 },
  ])
  assert.deepEqual(replay.preserveKnownSequenceMessageCounts(existing, [{ id: 'session', messageCount: 3, sequenceMessageCount: 18 }]), [
    { id: 'session', messageCount: 3, sequenceMessageCount: 18 },
  ])
  assert.deepEqual(replay.preserveKnownSequenceMessageCounts(existing, [{ id: 'fresh', messageCount: 4 }]), [
    { id: 'fresh', messageCount: 4 },
  ])

  const state = replay.createEpochRows()
  replay.mergeDeltaRows(state, [{ id: 'session', messageCount: 2, sequenceMessageCount: 17 }])
  const refreshStart = replay.beginHttpRowsRequest(state)
  replay.mergeDeltaRows(state, replay.preserveKnownSequenceMessageCounts(state.rows, [{ id: 'session', messageCount: 3 }]))
  replay.mergeHttpRows(state, [{ id: 'session', messageCount: 2, sequenceMessageCount: 18 }], refreshStart)
  assert.deepEqual(state.rows.get('session'), { id: 'session', messageCount: 3, sequenceMessageCount: 18 },
    'bounded HTTP refetch updates only the sequence count when a newer state delta owns the rest of the row')
  replay.endHttpRowsRequest(state, refreshStart)
})

test('exact by-id miss tombstone prevents an older root or search response from resurrecting the row', () => {
  const state = replay.createEpochRows(); const rootSearchStart = state.epoch
  replay.mergeDeltaRows(state, [], ['gone'])
  replay.mergeHttpRows(state, [{ id: 'gone', title: 'older root/search row' }], rootSearchStart)
  assert.equal(state.rows.has('gone'), false)
})

test('all accepted exact/watch IDs are chunked without truncation', () => {
  const ids = Array.from({ length: 205 }, (_, index) => `id-${index}`)
  const chunks = replay.chunkBoundedIds(ids, 100)
  assert.deepEqual(chunks.map(chunk => chunk.length), [100, 100, 5])
  assert.deepEqual(chunks.flat(), ids)
})

test('window or agent ownership pruning removes historical rows and epochs', () => {
  const state = replay.createEpochRows()
  replay.mergeDeltaRows(state, [
    { id: 'agent-a-root' }, { id: 'agent-a-child' }, { id: 'agent-b-root' }, { id: 'idle-watch' },
  ])
  replay.pruneEpochRows(state, new Set(['agent-b-root', 'idle-watch']))
  assert.deepEqual([...state.rows.keys()], ['agent-b-root', 'idle-watch'])
  assert.deepEqual([...state.epochs.keys()], ['agent-b-root', 'idle-watch'])
})

test('21-parent replay restarts atomically on mutation between first-page batches', async () => {
  const targets = new Map(Array.from({ length: 21 }, (_, index) => [`parent-${index}`, 1]))
  let rootLoads = 0; let batch = 0
  const result = await replay.replayAtomicWindows({ loadRoots: async () => ({ revision: ++rootLoads === 1 ? 'r1' : 'r2' }),
    loadBranches: roots => replay.replayCursorBranches({ targets, pageCap: 20, parentBatchCap: 20, expectedRevision: roots.revision,
      fetchBatch: async parents => { batch += 1; const mutatedBetweenFirstPageBatches = rootLoads === 1 && batch === 2
        return { revision: mutatedBetweenFirstPageBatches ? 'r2' : roots.revision, groups: parents.map(parent => ({
          parentSessionId: parent.parentSessionId, items: [`${parent.parentSessionId}-child`], total: 1, nextCursor: null,
        })) } } }) })
  assert.equal(rootLoads, 2, 'mutation restarts roots as well as the 21-parent branch batches')
  assert.equal(result.branches.size, 21)
})

test('root-to-branch revision mismatch aborts the combined replay', async () => {
  const roots = await replay.replayCursorWindow({ targetCount: 1, pageCap: 100,
    fetchPage: async () => ({ revision: 'root-r1', items: ['root'], nextCursor: null }) })
  assert.equal(roots.revision, 'root-r1')
  await assert.rejects(() => replay.replayCursorBranches({ targets: new Map([['root', 1]]), pageCap: 20, parentBatchCap: 20,
    expectedRevision: roots.revision, fetchBatch: async () => ({ revision: 'branch-r2', groups: [] }) }), /revision changed/)
})

test('root-to-branch mutation restarts the entire atomic operation before publish', async () => {
  let rootLoads = 0; let branchLoads = 0
  const result = await replay.replayAtomicWindows({
    loadRoots: async () => ({ revision: ++rootLoads === 1 ? 'r1' : 'r2', items: ['root'] }),
    loadBranches: async roots => { branchLoads += 1; if (roots.revision === 'r1') throw new replay.BoundedReplayRevisionMismatch(); return { revision: 'r2', items: ['child'] } },
  })
  assert.equal(rootLoads, 2); assert.equal(branchLoads, 2)
  assert.equal(result.roots.revision, 'r2'); assert.equal(result.branches.revision, 'r2')
})

test('atomic root-to-branch replay rejects after revision retry exhaustion', async () => {
  let rootLoads = 0
  await assert.rejects(() => replay.replayAtomicWindows({
    maxRestarts: 2,
    loadRoots: async () => ({ revision: `r${++rootLoads}` }),
    loadBranches: async () => { throw new replay.BoundedReplayRevisionMismatch() },
  }), replay.BoundedReplayRevisionMismatch)
  assert.equal(rootLoads, 3, 'the initial attempt plus two bounded restarts run before the error becomes user-visible')
})

test('off-page Architecture focus path becomes a bounded forced render chain', () => {
  const path = Array.from({ length: 105 }, (_, index) => `focus-${index}`)
  const merged = replay.mergeForcedPresentationPath(['ordinary-root'], new Map([['ordinary-root', ['ordinary-child']]]), path)
  assert.deepEqual(merged.rootIds, ['ordinary-root', 'focus-0'])
  for (let index = 0; index + 1 < path.length; index++) assert.ok(merged.childIds.get(path[index]).includes(path[index + 1]))
  assert.deepEqual(merged.childIds.get('ordinary-root'), ['ordinary-child'], 'the agent forest remains intact')
})

test('selected-agent Architecture ignores focus owned by another agent', () => {
  const rows = new Map([['a', { agent: 'agent-a' }], ['b', { agent: 'agent-b' }]])
  assert.deepEqual(replay.filterPresentationPathForAgent(['a', 'b'], rows, 'b', 'agent-a'), [])
})

test('selected-agent Architecture keeps only the contiguous same-agent focus suffix', () => {
  const rows = new Map([['a1', { agent: 'agent-a' }], ['b', { agent: 'agent-b' }], ['a2', { agent: 'agent-a' }]])
  const filtered = replay.filterPresentationPathForAgent(['a1', 'b', 'a2'], rows, 'a2', 'agent-a')
  assert.deepEqual(filtered, ['a2'])
  const merged = replay.mergeForcedPresentationPath(['a1', 'a2'], new Map(), filtered)
  assert.deepEqual(merged.rootIds, ['a1', 'a2']); assert.equal(merged.childIds.has('b'), false); assert.equal(merged.childIds.has('a2'), false)
  assert.deepEqual(replay.filterPresentationPathForAgent(['a1', 'b', 'a2'], rows, 'a2', null), ['a1', 'b', 'a2'], 'unfiltered mode preserves the canonical path')
})

test('cached exact alias miss survives pruning until older root and search responses settle', () => {
  const state = replay.createEpochRows(); replay.mergeDeltaRows(state, [{ id: 'canonical', aliases: ['alias'], title: 'cached' }])
  const rootStart = replay.beginHttpRowsRequest(state); const searchStart = replay.beginHttpRowsRequest(state); const exactStart = replay.beginHttpRowsRequest(state)
  const known = replay.captureExactAliasKeys(state, ['alias']); replay.applyExactMissTombstone(state, 'alias', known.get('alias'), exactStart); replay.pruneEpochRows(state, new Set())
  replay.endHttpRowsRequest(state, exactStart)
  assert.equal(state.tombstones.has('alias'), true); assert.equal(state.tombstones.has('canonical'), true)
  replay.mergeHttpRows(state, [{ id: 'canonical', aliases: ['alias'], title: 'older root' }], rootStart); assert.equal(state.rows.has('canonical'), false)
  replay.endHttpRowsRequest(state, rootStart)
  replay.mergeHttpRows(state, [{ id: 'canonical', aliases: ['alias'], title: 'older search' }], searchStart); assert.equal(state.rows.has('canonical'), false)
  replay.endHttpRowsRequest(state, searchStart)
  assert.equal(state.tombstones.size, 0, 'obsolete tombstones prune only after every older request settles')
})

test('uncached raw alias tombstone blocks older canonical root/search rows carrying that alias', () => {
  const state = replay.createEpochRows(); const rootStart = replay.beginHttpRowsRequest(state); const searchStart = replay.beginHttpRowsRequest(state); const exactStart = replay.beginHttpRowsRequest(state)
  const known = replay.captureExactAliasKeys(state, ['uncached-alias']); replay.applyExactMissTombstone(state, 'uncached-alias', known.get('uncached-alias'), exactStart); replay.pruneEpochRows(state, new Set()); replay.endHttpRowsRequest(state, exactStart)
  replay.mergeHttpRows(state, [{ id: 'canonical', aliases: ['uncached-alias'] }], rootStart); replay.endHttpRowsRequest(state, rootStart)
  replay.mergeHttpRows(state, [{ id: 'canonical', aliases: ['uncached-alias'] }], searchStart); assert.equal(state.rows.has('canonical'), false)
  replay.endHttpRowsRequest(state, searchStart); assert.equal(state.tombstones.size, 0)
})

test('exact A miss preserves newer canonical S after SSE removes alias A', () => {
  const state = replay.createEpochRows(); replay.mergeDeltaRows(state, [{ id: 'S', aliases: ['A'] }])
  const rootStart = replay.beginHttpRowsRequest(state); const exactStart = replay.beginHttpRowsRequest(state); const known = replay.captureExactAliasKeys(state, ['A'])
  replay.mergeDeltaRows(state, [{ id: 'S', aliases: [] }]); replay.applyExactMissTombstone(state, 'A', known.get('A'), exactStart); replay.pruneEpochRows(state, new Set(['S']))
  assert.deepEqual(state.rows.get('S')?.aliases, []); assert.equal(state.tombstones.has('S'), false); assert.equal(state.tombstones.has('A'), true)
  replay.endHttpRowsRequest(state, exactStart); replay.mergeHttpRows(state, [{ id: 'S', aliases: ['A'], source: 'older root' }], rootStart)
  assert.deepEqual(state.rows.get('S')?.aliases, [], 'older alias-bearing root row cannot replace newer canonical S')
  replay.endHttpRowsRequest(state, rootStart)
})

test('exact A miss preserves newer canonical S and its replacement alias B', () => {
  const state = replay.createEpochRows(); replay.mergeDeltaRows(state, [{ id: 'S', aliases: ['A', 'old'] }])
  const searchStart = replay.beginHttpRowsRequest(state); const exactStart = replay.beginHttpRowsRequest(state); const known = replay.captureExactAliasKeys(state, ['A'])
  replay.mergeDeltaRows(state, [{ id: 'S', aliases: ['B'] }]); replay.applyExactMissTombstone(state, 'A', known.get('A'), exactStart); replay.pruneEpochRows(state, new Set(['S', 'B']))
  assert.deepEqual(state.rows.get('S')?.aliases, ['B']); assert.equal(state.tombstones.has('S'), false); assert.equal(state.tombstones.has('B'), false)
  assert.equal(state.tombstones.has('A'), true); assert.equal(state.tombstones.has('old'), true)
  replay.endHttpRowsRequest(state, exactStart); replay.mergeHttpRows(state, [{ id: 'S', aliases: ['A'], source: 'older search' }], searchStart)
  assert.deepEqual(state.rows.get('S')?.aliases, ['B']); replay.endHttpRowsRequest(state, searchStart)
})
