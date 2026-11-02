import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/sessionSequence.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const {
  buildSequenceTimeScale,
  layoutSequence,
  liveSequenceEvents,
  mergeSequenceData,
  orderSequenceLanes,
  unloadedSequencePeers,
  visibleSequenceItems,
  chooseSequenceZoom,
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
    { sessionId: 'main/root', seq: 3, kind: 'tool', name: 'send_to_session', start: T + 4_100, end: T + 4_200, call: 1 },
  ],
  links: [
    { key: 'r|main/root|1|0', kind: 'user', from: { lane: 'user', at: T - 100 }, to: { sessionId: 'main/root', seq: 1, at: T }, sentAt: T - 100, consumedAt: T },
    { key: 'd|main/root|2.1|main/child-a', kind: 'message', from: { lane: 'session', sessionId: 'main/root', seq: 2, call: 1, at: T + 4_100 }, to: { sessionId: 'main/child-a' }, sentAt: T + 4_100, state: 'queued', deliverySeq: '2.1' },
    { key: 'r|other/root|2|0', kind: 'message', from: { lane: 'session', sessionId: 'external:abc', at: T + 5_000 }, to: { sessionId: 'other/root', seq: 2, at: T + 5_500 }, sentAt: T + 5_000, consumedAt: T + 5_500, pairing: 'exact', deliverySeq: '7' },
  ],
  cursors: { 'main/root': 20, 'main/child-a': 9 },
})

test('lanes put input first, then the parent/child tree by start, then outside peers', () => {
  const lanes = orderSequenceLanes(base())
  assert.deepEqual(lanes.map(lane => lane.id), ['@user', 'main/root', 'main/child-a', 'main/child-b', 'other/root', 'external:abc'])
  assert.deepEqual(lanes.map(lane => lane.depth), [0, 0, 1, 1, 0, 0])
  const external = lanes.at(-1)
  assert.equal(external.kind, 'external')
  assert.equal(external.opaque, true)
  assert.equal(external.label, 'Other session')
  assert.equal(external.sessionId, undefined)
})

test('idle gaps are compressed into breaks while active time keeps its scale', () => {
  const scale = buildSequenceTimeScale([T, T + 60_000, T + 3_600_000, T + 3_660_000], 60)
  assert.equal(scale.breaks.length, 1)
  assert.equal(scale.breaks[0].from, T + 60_000)
  assert.equal(scale.breaks[0].to, T + 3_600_000)
  // 60 px per minute inside active segments.
  assert.equal(scale.y(T + 60_000) - scale.y(T), 60)
  assert.equal(scale.y(T + 3_660_000) - scale.y(T + 3_600_000), 60)
  // The idle hour takes only the break height, and times inside it stay monotonic.
  const gap = scale.y(T + 3_600_000) - scale.y(T + 60_000)
  assert.ok(gap > 0 && gap < 60)
  const inside = scale.y(T + 1_800_000)
  assert.ok(inside > scale.y(T + 60_000) && inside < scale.y(T + 3_600_000))
  assert.ok(scale.height < 300)
  assert.ok(scale.ticks.every((tick, index, all) => index === 0 || tick.y >= all[index - 1].y))
})

test('layout places bars on lanes and draws queue delay from send to read time', () => {
  const data = base()
  data.links[1] = { ...data.links[1], consumedAt: T + 30_000, state: undefined, to: { sessionId: 'main/child-a', seq: 3, at: T + 30_000 } }
  const layout = layoutSequence(data, { pxPerMinute: 60, now: T + 600_000 })
  const lane = id => layout.lanes.find(item => item.id === id)
  const root = lane('main/root')
  const llm = layout.bars.find(bar => bar.event.kind === 'llm')
  const tool = layout.bars.find(bar => bar.event.kind === 'tool')
  assert.ok(llm.x < root.x && tool.x > root.x)
  assert.ok(tool.height >= 3)
  const message = layout.arrows.find(arrow => arrow.link.deliverySeq === '2.1')
  assert.equal(message.x1, root.x)
  assert.equal(message.x2, lane('main/child-a').x)
  assert.equal(message.delayMs, 25_900)
  assert.ok(message.y2 > message.y1)
  // A child created in the window starts its lifeline at creation.
  assert.equal(lane('main/child-b').startY, layout.scale.y(T + 50_000))
  assert.equal(root.startY, 0)
  assert.ok(layout.arrows.some(arrow => arrow.link.kind === 'user' && arrow.x1 === lane('@user').x))
  const visible = visibleSequenceItems(layout, message.y1 + 1, message.y1 + 2)
  assert.ok(visible.arrows.some(arrow => arrow.key === message.key))
  assert.ok(!visible.bars.some(bar => bar.event.kind === 'llm'))
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

test('automatic zoom keeps dense windows within a bounded height', () => {
  const data = base()
  for (let index = 0; index < 600; index++) data.events.push({ sessionId: 'main/root', seq: 100 + index, kind: 'tool', start: T + index * 20_000, end: T + index * 20_000 + 5_000 })
  const zoom = chooseSequenceZoom(data, data.events, 5000)
  assert.ok(layoutSequence(data, { pxPerMinute: zoom, now: T }).height <= 5000 || zoom === 3)
  assert.ok(zoom < 60)
})
