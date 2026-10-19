import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const [mode, root] = process.argv.slice(2)
if (!root || !['seed', 'inspect', 'matching', 'input'].includes(mode)) throw new Error('usage: legacy-wait-fixture-ts.mjs seed|inspect|matching|input ROOT')
// Establish disposable runtime paths before importing application modules.
const { isolatedApplicationEnv } = createRequire(import.meta.url)('../scripts/test/test-process-env.cjs')
Object.assign(process.env, isolatedApplicationEnv(root))
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '..')
if (mode === 'seed') {
  await fs.mkdir(path.join(root, 'state'), { recursive: true })
  await fs.writeFile(path.join(root, 'state/models.yaml'), 'default: a\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    apiKey: synthetic-not-a-key\n    models: [wire]\n')
  await fs.writeFile(path.join(root, 'state/config.yaml'), 'dbWorkers: false\nvector:\n  enabled: false\n')
}
const sm = await import(pathToFileURL(path.join(repository, 'lib/sessionManager.js')).href)
await sm.loadSessions()
const id = 'legacy-waiter', target = 'reporter'
if (mode === 'seed') {
  for (const name of [id, target]) await sm.createEmptySession(name)
  const session = await sm.getSession(id)
  await sm.appendSessionMessage(session, {
    role: 'user', parts: [{ text: 'Synthetic work awaiting a report.' }], __meta: { timestamp: 1000 },
  })
  await sm.startSessionWaitForSession(session, {
    reason: 'Await the original report', waitAllSessions: [target],
  }, () => sm.saveSessionForSessionCritical(session))
  await sm.saveSessionCatalogProjectionStrict(id)
}
const session = await sm.getSession(id)
const wait = structuredClone(session.meta.wait ?? null)
const item = mode === 'matching'
  ? { type: 'intersession', sourceSessionId: target, parts: [{ text: 'Original synthetic report 🦊' }], syntheticReceipt: 'original-report' }
  : { type: 'user', parts: [{ text: 'Ordinary synthetic input' }] }
const transition = ['matching', 'input'].includes(mode) ? sm.applyQueuedItemToWaitState(session, item) : null
if (mode === 'seed') {
  assert.deepEqual(wait.waitAll, { sessions: [target], satisfiedSessions: [], deferredQueue: [] })
  assert.equal(Object.hasOwn(wait, 'declarationVersion'), false)
  assert.equal(session.busy, false)
  assert.equal(session.queue.length, 0)
}
console.log('LEGACY_WAIT_FIXTURE:' + JSON.stringify({ id, target, wait, item, transition,
  currentWait: session.meta.wait ?? null, queue: session.queue }))
process.exit(0)
