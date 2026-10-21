import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/continuousHistory.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { getContinuousContextDemand, getContinuousContextDemandKey, appendContinuousCommits, mergeContinuousHistory, projectContinuousHistory, resolveContinuousContextRanges } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const raw = (seq, text = `Original ${seq}`) => ({ role: 'user', parts: [{ text }], __meta: { seq } })

test('original Archive rows survive active rewrites while new canonical rows append once', () => {
  const loaded = [raw(10), raw(11)]
  const compact = { role: 'model', parts: [{ text: 'Generated summary' }], __meta: { contextBlock: { id: 1 } } }
  const next = appendContinuousCommits(loaded, [compact, raw(11, 'Pruned active payload'), raw(12)])
  assert.deepEqual(next.map(message => message.parts[0].text), ['Original 10', 'Original 11', 'Original 12'])
  assert.equal(appendContinuousCommits(next, []), next, 'clear/delete of active history does not erase Archive')
  assert.deepEqual(appendContinuousCommits(next, [raw(12)]), next)
  assert.deepEqual(mergeContinuousHistory(next, [raw(9), raw(10), compact]).map(message => message.__meta.seq), [9, 10, 11, 12])
})

test('Archive pages exclude synthetic and optimistic context rows', () => {
  const original = raw(1)
  const optimistic = { ...raw(2), __meta: { seq: 2, temporary: true, optimistic: true } }
  const synthetic = { ...raw(3), __meta: { seq: 3, temporary: true } }
  assert.deepEqual(mergeContinuousHistory([], [original, optimistic, synthetic]), [original])
})


test('a newly committed live image remains readable after its active reference is compacted away', () => {
  const liveImage = { role: 'model', parts: [{ inlineDataRef: { blobId: 'synthetic.png', apiPath: '/blobs/synthetic.png' } }], __meta: { seq: 12 } }
  const archive = appendContinuousCommits([raw(11)], [raw(11), liveImage])
  assert.equal(archive[1].parts[0].inlineDataRef.apiPath, '/blobs/synthetic.png?archiveSeq=12')
  assert.equal(liveImage.parts[0].inlineDataRef.apiPath, '/blobs/synthetic.png', 'the model-context array is not rewritten')
  assert.equal(appendContinuousCommits(archive, [])[1], archive[1])
  assert.equal(mergeContinuousHistory(archive, [archive[1]])[1].parts[0].inlineDataRef.apiPath, '/blobs/synthetic.png?archiveSeq=12')
})


test('active snapshots cannot silently bridge an unloaded Archive gap', () => {
  const loaded = [raw(10), raw(11)]
  assert.equal(appendContinuousCommits(loaded, [raw(20), raw(21)]), loaded)
  assert.deepEqual(appendContinuousCommits(loaded, [raw(12), raw(14)]).map(message => message.__meta.seq), [10, 11, 12])
})

const block = (start, end) => ({ role: 'model', parts: [{ text: 'Summary' }], __meta: { contextBlock: { id: start, level: 1, sourceKind: 'message', rawStartSeq: start, rawEndSeq: end } } })

test('active contents and absence own current scope, including oldest and newest deletion', () => {
  const originals = Array.from({ length: 10 }, (_, i) => raw(i + 1))
  const active = [block(1, 3), raw(5, 'Current five'), raw(7), raw(9)]
  const displayed = projectContinuousHistory(originals, active)
  assert.deepEqual(displayed.map(message => message.__meta.seq), [1, 2, 3, 5, 7, 9])
  assert.equal(displayed[3].parts[0].text, 'Current five')
  assert.deepEqual(projectContinuousHistory(mergeContinuousHistory(originals, [raw(4), raw(10)]), active), displayed,
    'fresh Archive pages do not resurrect absent active rows')
  assert.equal(originals[4].parts[0].text, 'Original 5', 'projection never rewrites Archive')
})

test('clear and a new active run do not reveal the previous Archive', () => {
  const originals = [raw(1), raw(2), raw(3)]
  assert.deepEqual(projectContinuousHistory(originals, []), [])
  assert.deepEqual(projectContinuousHistory([...originals, raw(4)], [raw(4)]), [raw(4)])
})

test('separate CTX ranges preserve older history without filling current gaps; retained rows override', () => {
  const originals = Array.from({ length: 12 }, (_, i) => raw(i + 1))
  const active = [block(1, 3), raw(2, 'Retained active two'), block(6, 9), raw(12)]
  const displayed = projectContinuousHistory(originals, active)
  assert.deepEqual(displayed.map(message => message.__meta.seq), [1, 2, 3, 6, 7, 8, 9, 12])
  assert.equal(displayed[1].parts[0].text, 'Retained active two')
  assert.deepEqual(projectContinuousHistory(originals.slice(0, 3), active).map(message => message.__meta.seq), [1, 2, 3],
    'an older loaded window does not pull in a disconnected active tail')
})

test('higher CTX membership follows explicit children rather than a raw envelope', async () => {
  const higher = (id, start, end) => ({ ...block(start, end), __meta: { contextBlock: { id, sourceKind: 'block', level: 2, rawStartSeq: start, rawEndSeq: end } } })
  const root = higher(20, 1, 12)
  const records = new Map([[20, [block(1, 3), higher(21, 6, 12)]], [21, [block(6, 7), block(10, 12)]]])
  const requested = []
  const ranges = await resolveContinuousContextRanges([root], Array.from({ length: 12 }, (_, i) => i + 1), async id => { requested.push(id); return records.get(id) })
  assert.deepEqual(requested, [20, 21], 'message-backed blocks never fetch their raw expansion')
  const originals = Array.from({ length: 12 }, (_, i) => raw(i + 1))
  assert.deepEqual(projectContinuousHistory(originals, [root], new Map([[20, ranges]])).map(message => message.__meta.seq), [1, 2, 3, 6, 7, 10, 11, 12])
  assert.deepEqual(projectContinuousHistory(originals, [root]), [], 'unresolved higher-level envelopes cannot fill gaps')
})

test('removing an independent preserved row leaves only its surviving CTX representation', () => {
  const originals = [raw(1), raw(2), raw(3), raw(4), raw(5)]
  const summary = block(1, 4)
  const retained = { ...raw(3, 'Active retained version'), __meta: { seq: 3, preservedFromBlockId: 1 } }
  assert.equal(projectContinuousHistory(originals, [summary, retained, raw(5)])[2].parts[0].text, 'Active retained version')
  assert.equal(projectContinuousHistory(originals, [summary])[2].parts[0].text, 'Original 3')
  assert.deepEqual(projectContinuousHistory(originals, [raw(5)]), [raw(5)], 'removing the CTX removes its older representation')
})


test('membership demand excludes unloaded originals and rows already owned by active history', () => {
  const root = { ...block(1, 600), __meta: { contextBlock: { id: 20, sourceKind: 'block', level: 2, rawStartSeq: 1, rawEndSeq: 600 } } }
  const recent = Array.from({ length: 100 }, (_, index) => raw(index + 501))
  assert.deepEqual(getContinuousContextDemand([root, ...recent], recent), [])
  const demand = getContinuousContextDemand([root, ...recent], [raw(301), raw(302), ...recent, raw(601)])
  assert.deepEqual(demand.map(item => item.sequences), [[301, 302]])
  assert.equal(getContinuousContextDemandKey(demand), '20:301,302')
})

test('candidate sequences prune unrelated non-leaf branches without proving membership in gaps', async () => {
  const higher = (id, start, end) => ({ ...block(start, end), __meta: { contextBlock: { id, sourceKind: 'block', level: 2, rawStartSeq: start, rawEndSeq: end } } })
  const root = higher(20, 1, 12)
  const children = new Map([[20, [higher(21, 1, 3), higher(22, 6, 12)]], [22, [block(6, 7), block(10, 12)]]])
  const requested = []
  const ranges = await resolveContinuousContextRanges([root], [8], async id => { requested.push(id); return children.get(id) })
  assert.deepEqual(requested, [20, 22], 'the unrelated non-leaf branch is not traversed')
  assert.deepEqual(ranges, [], 'the relevant branch envelope is not a membership proof for seq 8')
})
