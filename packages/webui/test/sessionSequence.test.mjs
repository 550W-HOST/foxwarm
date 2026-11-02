import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/sessionSequence.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const {
  buildSequenceGrid,
  buildSequenceRows,
  chooseSequenceBucket,
  liveSequenceEvents,
  mergeSequenceData,
  orderSequenceColumns,
  sequenceColumnItems,
  sequenceWaitMs,
  unloadedSequencePeers,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const T = 1_800_000_000_000
const base = () => ({
  since: T - 3_600_000,
  generatedAt: T + 600_000,
  sessions: [
    { id: 'main/child-b', parentSessionId: 'main/root', startedAt: T + 50_000, maxSeq: 4, firstAt: T + 50_000 },
    { id: 'main/root', firstAt: T, maxSeq: 20 },
    { id: 'main/child-a', parentSessionId: 'main/root', startedAt: T + 10_000, maxSeq: 9, firstAt: T + 10_000 },
    { id: 'other/root', firstAt: T + 5_000, maxSeq: 3 },
  ],
  peers: [{ id: 'external:abc', opaque: true }],
  events: [
    { sessionId: 'main/root', seq: 2, kind: 'llm', start: T, end: T + 4_000 },
    { sessionId: 'main/root', seq: 3, kind: 'tool', name: 'send_to_session', start: T + 4_100, end: T + 4_200, call: 1, callSeq: 2, status: 'ok' },
  ],
  links: [
    { key: 'r|main/root|1|0', kind: 'user', from: { lane: 'user', at: T - 100 }, to: { sessionId: 'main/root', seq: 1, at: T }, sentAt: T - 100, consumedAt: T },
    { key: 'd|main/root|2.1|main/child-a', kind: 'message', from: { lane: 'session', sessionId: 'main/root', seq: 2, call: 1, at: T + 4_100 }, to: { sessionId: 'main/child-a' }, sentAt: T + 4_100, state: 'queued', deliverySeq: '2.1' },
    { key: 'r|other/root|2|0', kind: 'message', from: { lane: 'session', sessionId: 'external:abc', at: T + 5_000 }, to: { sessionId: 'other/root', seq: 2, at: T + 5_500 }, sentAt: T + 5_000, consumedAt: T + 5_500, pairing: 'exact', deliverySeq: '7' },
  ],
  cursors: { 'main/root': 20, 'main/child-a': 9 },
})

test('incremental merge replaces a queued delivery with its read side and keeps the sender anchor', () => {
  const data = base()
  const delta = {
    since: data.since,
    generatedAt: T + 700_000,
    incremental: true,
    sessions: [{ id: 'main/child-a', lastSeq: 12, maxSeq: 12, firstSeq: 10 }],
    peers: [],
    events: [{ sessionId: 'main/child-a', seq: 11, kind: 'llm', start: T + 31_000, end: T + 32_000 }],
    links: [{ key: 'd|main/root|2.1|main/child-a', kind: 'message', pairing: 'exact', deliverySeq: '2.1', from: { lane: 'session', sessionId: 'main/root', seq: 2, call: 1, at: T + 4_000 }, to: { sessionId: 'main/child-a', seq: 10, at: T + 30_000 }, sentAt: T + 4_000, consumedAt: T + 30_000 }],
    cursors: { 'main/child-a': 12 },
  }
  delta.links[0].from = { lane: 'session', sessionId: 'main/root', at: T + 4_000 }
  const merged = mergeSequenceData(data, delta)
  const link = merged.links.find(item => item.key === 'd|main/root|2.1|main/child-a')
  assert.equal(merged.links.length, data.links.length)
  assert.equal(link.consumedAt, T + 30_000)
  assert.equal(link.state, undefined)
  assert.equal(link.from.seq, 2)
  assert.equal(link.from.at, T + 4_100)
  assert.equal(link.to.seq, 10)
  assert.equal(merged.cursors['main/child-a'], 12)
  assert.equal(merged.cursors['main/root'], 20)
  assert.equal(merged.events.length, 3)
  const child = merged.sessions.find(session => session.id === 'main/child-a')
  assert.equal(child.firstAt, T + 10_000)
  assert.equal(child.maxSeq, 12)
  // Repeating the same delta is idempotent.
  assert.deepEqual(mergeSequenceData(merged, delta).events.length, 3)
})

test('unloaded peers trigger a full reload but opaque peers do not', () => {
  const data = base()
  assert.deepEqual(unloadedSequencePeers(data), [])
  data.links.push({ key: 'c|main/new', kind: 'spawn', from: { lane: 'session', sessionId: 'main/root' }, to: { sessionId: 'main/new' }, sentAt: T })
  assert.deepEqual(unloadedSequencePeers(data), ['main/new'])
})

test('running work is drawn until now from runtime state', () => {
  const live = liveSequenceEvents([
    { id: 'a', maxSeq: 5, runtimeState: { state: 'running-tool', busy: true, queueLength: 0, tool: { name: 'exec', startedAt: T } } },
    { id: 'b', runtimeState: { state: 'requesting-model', busy: true, queueLength: 0, since: T + 5 } },
    { id: 'c', runtimeState: { state: 'idle', busy: false, queueLength: 0 } },
  ], T + 1_000)
  assert.deepEqual(live.map(event => [event.sessionId, event.kind, event.end, event.live]), [['a', 'tool', T + 1_000, true], ['b', 'llm', T + 1_000, true]])
})


test('columns follow the parent/child tree and show each Session state', () => {
  const data = base()
  data.sessions[1].runtimeState = { state: 'waiting', busy: false, queueLength: 0 }
  data.sessions[2].runtimeState = { state: 'running-tool', busy: true, queueLength: 0, tool: { name: 'exec', startedAt: T } }
  const columns = orderSequenceColumns(data)
  assert.deepEqual(columns.map(column => column.id), ['main/root', 'main/child-a', 'main/child-b', 'other/root'])
  assert.deepEqual(columns.map(column => column.depth), [0, 1, 1, 0])
  assert.deepEqual(columns.map(column => column.state), ['waiting', 'running', 'idle', 'idle'])
  // No separate input lanes: You, channels and timers appear in the receiving column.
  assert.ok(!columns.some(column => column.id.startsWith('@')))
})

test('column items place input, both halves of a delivery, text phases and tool runs', () => {
  const data = base()
  data.events.push(
    { sessionId: 'main/root', seq: 4, kind: 'llm', start: T + 5_000, end: T + 6_000, calls: 2, preview: 'Checking the build' },
    { sessionId: 'main/root', seq: 5, kind: 'tool', name: 'exec', start: T + 6_100, end: T + 6_200, callSeq: 4, call: 1, status: 'ok' },
    { sessionId: 'main/root', seq: 5, kind: 'tool', name: 'exec', start: T + 6_200, end: T + 6_300, callSeq: 4, call: 2, status: 'error' },
    { sessionId: 'main/root', seq: 6, kind: 'llm', start: T + 7_000, end: T + 8_000, calls: 0, preview: 'All done' },
    { sessionId: 'main/root', seq: 7, kind: 'llm', start: T + 9_000, end: T + 9_500, calls: 1, phase: 'final_answer', preview: 'Marked final' },
  )
  data.events[0].preview = undefined
  data.links.push({ key: 't|1', kind: 'timer', from: { lane: 'timer' }, to: { sessionId: 'main/child-a', seq: 2, at: T + 70_000 }, sentAt: T + 70_000, consumedAt: T + 70_000, preview: 'Daily check' })
  const items = sequenceColumnItems(data, T + 600_000)
  const root = items.get('main/root')
  assert.deepEqual(root.map(item => item.type), ['input', 'card', 'text', 'tools', 'tools', 'text', 'text'])
  assert.equal(root[0].variant, 'user')
  assert.equal(root[1].direction, 'sent')
  // The send_to_session call shown as a card is not repeated as a tool tag.
  assert.ok(!root.some(item => item.type === 'tools' && item.tools.some(tool => tool.name === 'send_to_session')))
  assert.deepEqual(root.filter(item => item.type === 'text').map(item => item.commentary), [true, false, false])
  const child = items.get('main/child-a')
  assert.deepEqual(child.map(item => [item.type, item.direction ?? item.variant]), [['card', 'received'], ['input', 'system']])
  // A queued delivery is shown in the receiver at send time.
  assert.equal(child[0].time, T + 4_100)
  // An opaque sender only appears inside the receiver's column.
  assert.deepEqual(items.get('other/root').map(item => [item.type, item.direction]), [['card', 'received']])
  assert.equal(items.has('external:abc'), false)
})

test('rows bucket by minute, omit idle time, group consecutive tools and coarsen when dense', () => {
  const item = (sessionId, time, type = 'tools', name = 'exec') => type === 'tools'
    ? { type, key: `${sessionId}|${time}`, sessionId, time, tools: [{ sessionId, seq: time, kind: 'tool', name, start: time, end: time, status: 'ok' }] }
    : { type, key: `${sessionId}|${time}`, sessionId, time, text: 'x', commentary: false }
  const minute = Math.floor(T / 60_000) * 60_000
  const items = new Map([
    ['a', [item('a', minute + 1_000), item('a', minute + 2_000, 'tools', 'read'), item('a', minute + 3_000, 'text'), item('a', minute + 4_000), item('a', minute + 3_600_000)]],
    ['b', [item('b', minute + 30_000, 'text')]],
  ])
  const rows = buildSequenceRows(items, 60_000)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].start - rows[0].start, 3_600_000)
  assert.deepEqual(rows[0].cells.a.map(entry => entry.type), ['tools', 'text', 'tools'])
  assert.deepEqual(rows[0].cells.a[0].tools.map(tool => tool.name), ['exec', 'read'])
  assert.equal(rows[0].cells.b.length, 1)
  assert.equal(rows[1].cells.b, undefined)
  const dense = Array.from({ length: 300 }, (_, index) => minute + index * 60_000)
  assert.equal(chooseSequenceBucket(dense.slice(0, 10)), 60_000)
  assert.equal(chooseSequenceBucket(dense, 60), 5 * 60_000)
  assert.ok(chooseSequenceBucket(dense, 2) >= 3 * 3_600_000)
})

test('the grid and wait times match both halves of a read delivery', () => {
  const data = base()
  data.links[1] = { ...data.links[1], consumedAt: T + 30_000, state: undefined, to: { sessionId: 'main/child-a', seq: 3, at: T + 30_000 } }
  assert.equal(sequenceWaitMs(data.links[1]), 25_900)
  assert.equal(sequenceWaitMs(base().links[1]), undefined)
  const grid = buildSequenceGrid(data, T + 600_000)
  const cards = grid.rows.flatMap(row => Object.values(row.cells).flat()).filter(item => item.type === 'card' && item.link.key === data.links[1].key)
  assert.deepEqual(cards.map(item => [item.sessionId, item.direction, item.seq]), [['main/root', 'sent', 2], ['main/child-a', 'received', 3]])
  assert.equal(grid.bucketMs, 60_000)
})

test('a child creation merges with its initial message or Task into one card on both sides', () => {
  const data = base()
  data.links = [
    { key: 'c|main/child-a', kind: 'spawn', mode: 'new-child', from: { lane: 'session', sessionId: 'main/root', seq: 8, call: 2, at: T + 9_000 }, to: { sessionId: 'main/child-a', seq: 1, at: T + 9_000 }, sentAt: T + 9_000, pairing: 'exact' },
    { key: 'd|main/root|8.2|main/child-a', kind: 'message', deliverySeq: '8.2', from: { lane: 'session', sessionId: 'main/root', seq: 8, call: 2, at: T + 9_100 }, to: { sessionId: 'main/child-a', seq: 2, at: T + 9_500 }, sentAt: T + 9_100, consumedAt: T + 9_500, pairing: 'exact', preview: 'help with the docs' },
    // A creation without a message stays a plain card.
    { key: 'c|main/child-b', kind: 'spawn', mode: 'new-child', from: { lane: 'session', sessionId: 'main/root', seq: 12, call: 1, at: T + 60_000 }, to: { sessionId: 'main/child-b', seq: 1, at: T + 60_000 }, sentAt: T + 60_000, pairing: 'exact' },
  ]
  data.events = [{ sessionId: 'main/root', seq: 9, kind: 'tool', name: 'create_child_session', start: T + 9_000, end: T + 9_200, callSeq: 8, call: 2, status: 'ok' }]
  const items = sequenceColumnItems(data, T + 600_000)
  const sent = items.get('main/root').filter(item => item.type === 'card')
  assert.deepEqual(sent.map(item => [item.link.key, item.created?.key]), [['d|main/root|8.2|main/child-a', 'c|main/child-a'], ['c|main/child-b', undefined]])
  const received = items.get('main/child-a')
  assert.deepEqual(received.map(item => [item.type, item.direction, item.link.key, item.created?.key, item.seq]), [['card', 'received', 'd|main/root|8.2|main/child-a', 'c|main/child-a', 2]])
  assert.ok(!items.get('main/root').some(item => item.type === 'tools'))
})
