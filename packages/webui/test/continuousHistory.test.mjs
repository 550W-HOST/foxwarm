import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/continuousHistory.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { appendContinuousCommits, mergeContinuousHistory } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
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
