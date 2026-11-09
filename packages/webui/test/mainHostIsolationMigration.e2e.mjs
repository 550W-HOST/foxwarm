// Applying the isolation migration on the normal host records the bound Node on Sessions that had none.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture } from './mainHostFixture.mjs'

const fixture = await createHostFixture('isolation-migration')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'] } } }))
const agentRoot = join(fixture.data, 'agents', 'guarded')
await mkdir(join(agentRoot, 'memory'), { recursive: true })
await writeFile(join(fixture.data, 'state/agents.json'), JSON.stringify({ guarded: { isolated: true, isolatedNode: 'retained-bound' } }))
const sessions = join(fixture.data, 'state/sessions')
await mkdir(sessions, { recursive: true })
const rows = {}
for (const [id, placement] of [['guarded-legacy', {}], ['guarded-explicit', { currentNode: 'retained-remote' }]]) {
  const raw = {
    sessionStateVersion: 1, id, agent: 'guarded', busy: false, history: [
      { role: 'user', parts: [{ text: 'Retained input' }], __meta: { seq: 1, timestamp: 100 } },
      { role: 'model', parts: [{ text: 'Retained reply' }], __meta: { seq: 2, timestamp: 200 } },
    ], queue: [], nextMessageSeq: 3, nextBlockId: 1, historyVersion: 0,
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 },
    meta: { messageCount: 2, lastMessageTime: 200 }, cwd: agentRoot,
    model: null, verbose: false, persistentMemorySnapshot: 'Retained snapshot',
    ...placement,
  }
  await writeFile(join(sessions, id + '.json'), JSON.stringify(raw))
  rows[id] = { id, agent: 'guarded', aliases: [], busy: false, queueLength: 0, meta: raw.meta, stats: raw.stats, cwd: raw.cwd, ...placement }
}
await writeFile(join(fixture.data, 'state/sessions.json'), JSON.stringify({ sessions: rows }))
const currentNode = async id => {
  const history = await fixture.api('GET', '/api/sessions/' + id + '/history')
  assert.equal(history.status, 200, JSON.stringify(history.body))
  return history.body.session.currentNode
}
try {
  await fixture.start()
  const report = await fixture.api('GET', '/api/agents/isolation-migration?agent=guarded')
  assert.equal(report.status, 200, JSON.stringify(report.body))
  assert.equal(report.body.agents[0].applicable, true)

  const applied = await fixture.api('POST', '/api/agents/guarded/isolation-migration')
  assert.equal(applied.status, 200, JSON.stringify(applied.body))
  assert.equal(applied.body.applied, true)
  assert.deepEqual(applied.body.materializedSessions, ['guarded-legacy'])
  assert.deepEqual(applied.body.placementReview, [{ sessionId: 'guarded-explicit', currentNode: 'retained-remote' }])
  assert.deepEqual(applied.body.failedSessions, [])
  assert.equal(await currentNode('guarded-legacy'), 'retained-bound')

  // A repeated apply only reruns the backfill, which now has nothing to record.
  const repeated = await fixture.api('POST', '/api/agents/guarded/isolation-migration')
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body))
  assert.equal(repeated.body.applied, false)
  assert.deepEqual(repeated.body.materializedSessions, [])

  await fixture.stop()
  await fixture.start()
  assert.equal(await currentNode('guarded-legacy'), 'retained-bound')
  assert.equal(await currentNode('guarded-explicit'), 'retained-remote')
  await fixture.stop()
  console.log('Normal host isolation migration: bound Node recorded once, explicit placement left for review, persisted across restart.')
} finally {
  await fixture.cleanup()
}
