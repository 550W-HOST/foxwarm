import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const [mode, root] = process.argv.slice(2)
if (!root || !['seed', 'verify'].includes(mode)) throw new Error('usage: legacy-block-fixture-ts.mjs seed|verify ROOT')
// Establish disposable runtime paths before importing any application module.
const { isolatedApplicationEnv } = createRequire(import.meta.url)('../scripts/test/test-process-env.cjs')
Object.assign(process.env, isolatedApplicationEnv(root))
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '..')
if (mode === 'seed') {
  await fs.mkdir(path.join(root, 'state'), { recursive: true })
  await fs.writeFile(path.join(root, 'state/models.yaml'), 'default: a\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    apiKey: synthetic-not-a-key\n    models: [wire]\n')
  await fs.writeFile(path.join(root, 'state/config.yaml'), 'dbWorkers: false\nvector:\n  enabled: false\n')
}
const load = file => import(pathToFileURL(path.join(repository, 'lib', file)).href)
const sm = await load('sessionManager.js')
const archive = await load('session/archiveStore.js')
const layered = await load('session/layeredContext.js')
const history = await load('session/history.js')
await sm.loadSessions()
const parentId = 'origin'
const childId = 'origin_legacy'
if (mode === 'seed') {
  const parent = (await sm.createEmptySession(parentId)).session
  for (let i = 1; i <= 4; i++) await sm.appendSessionMessage(parent, {
    role: 'user', parts: [{ text: 'Original source message ' + i }], __meta: { timestamp: i * 1000 },
  })
  const blocks = [
    { id: 1, level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 2, rawStartSeq: 1, rawEndSeq: 2 },
    { id: 2, level: 1, sourceKind: 'message', sourceStart: 3, sourceEnd: 4, rawStartSeq: 3, rawEndSeq: 4 },
    { id: 3, level: 2, sourceKind: 'block', sourceStart: 1, sourceEnd: 2, rawStartSeq: 1, rawEndSeq: 4 },
  ].map(block => ({ v: 1, kind: 'block', sessionId: parentId, agent: 'main',
    ...block, summary: 'Synthetic retained summary ' + block.id, createdAt: 5000 + block.id }))
  await archive.writeArchiveBlocks(blocks)
  parent.history = [layered.renderBlockMessage(blocks[2])]
  parent.nextBlockId = 4
  await sm.saveSessionForSessionCritical(parent)
  assert.equal(await sm.forkSession(parentId, 'legacy'), childId)
  const child = await sm.getSession(childId)
  const inherited = (await archive.readEffectiveArchiveBlocks(childId, 3, 3))[0]
  child.history = [layered.renderBlockMessage(inherited)]
  for (let i = 5; i <= 12; i++) await sm.appendSessionMessage(child, {
    role: 'user', parts: [{ text: 'Uncompacted synthetic work ' + i + ' ' + 'x'.repeat(5000) }], __meta: { timestamp: i * 1000 },
  })
  child.meta.wait = { id: 'synthetic-input-wait', startedAt: 20000, waitForInput: true }
  await sm.saveSessionForSessionCritical(child)
  await sm.saveSessionCatalogProjectionStrict(childId)
}
const child = await sm.getSession(childId)
const inheritedMessage = child.history.find(message => message.__meta?.contextBlock?.id === 3)
assert(inheritedMessage)
assert.equal(Object.hasOwn(inheritedMessage.__meta.contextBlock, 'sourceBlockIds'), false)
const blocks = await archive.readEffectiveArchiveBlocks(childId, 1, 3)
assert.deepEqual(blocks.map(block => block.id), [1, 2, 3])
assert.equal(blocks[2].sourceBlockIds, undefined)
assert.equal(blocks[2].sourceSessionId, parentId)
assert.equal(blocks[2].inherited, true)
const excluded = await history.buildLayeredCompactCandidateEntries([inheritedMessage])
assert.equal(excluded.blockPolicies.length, 0)
assert.equal(excluded.candidateEntries.length, 0)
// A sufficiently large current explicit-ID control is eligible; legacy absence is not.
const current = Array.from({ length: 5 }, (_, index) => {
  const message = structuredClone(inheritedMessage)
  Object.assign(message.__meta.contextBlock, { id: 10 + index, sourceBlockIds: [1, 2], rawStartSeq: index * 4 + 1, rawEndSeq: index * 4 + 4 })
  message.parts = [{ text: 'Current generated summary ' + 'x'.repeat(10000) }]
  return message
})
const eligible = await history.buildLayeredCompactCandidateEntries(current)
assert.equal(eligible.blockPolicies[0].totalBlockCount, 5)
assert.equal(eligible.candidateEntries.length, 2)
console.log('LEGACY_BLOCK_FIXTURE:' + JSON.stringify({ childId,
  inheritedMeta: inheritedMessage.__meta.contextBlock, legacyCandidates: excluded.candidateEntries.length,
  currentCandidates: eligible.candidateEntries.length, historyRows: child.history.length }))
process.exit(0)
