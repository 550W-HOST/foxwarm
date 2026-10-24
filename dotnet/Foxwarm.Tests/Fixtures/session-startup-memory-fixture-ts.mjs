import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const [mode, root] = process.argv.slice(2)
if (!root || !['seed', 'inspect'].includes(mode)) throw new Error('usage: session-startup-memory-fixture-ts.mjs seed|inspect OWNED_ROOT')
const { isolatedApplicationEnv } = createRequire(import.meta.url)('../../../scripts/test/test-process-env.cjs')
Object.assign(process.env, isolatedApplicationEnv(root))
process.env.FOXWARM_VECTOR_ENABLED = 'false'
await fs.mkdir(path.join(root, 'state'), { recursive: true })
if (mode === 'seed') {
  await fs.writeFile(path.join(root, 'state/config.yaml'), 'dbWorkers: false\nsessionWorkers: false\nvector:\n  enabled: false\n')
  await fs.writeFile(path.join(root, 'state/models.yaml'), 'default: a/wire\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    apiKey: synthetic-not-a-key\n    models: [wire]\n')
}
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '../../..')
const app = file => import(pathToFileURL(path.join(repository, 'lib', file + '.js')).href)
const sm = await app('sessionManager')
const { isSessionCatalogStub } = await app('sessionRuntimeState')
await sm.loadSessions()
const triggered = []
sm.setSessionTriggerCallback(id => { triggered.push(id) })
const coldIds = [
  ...Array.from({ length: 338 }, (_, n) => 'legacy-' + n),
  ...Array.from({ length: 90 }, (_, n) => 'reason-' + n),
  ...Array.from({ length: 5 }, (_, n) => 'input-' + n),
  ...Array.from({ length: 3 }, (_, n) => 'any-' + n),
  ...Array.from({ length: 2 }, (_, n) => 'all-' + n),
]
if (mode === 'seed') {
  for (const id of [...coldIds, 'busy', 'queued']) {
    const { session } = await sm.createEmptySession(id)
    await sm.appendSessionMessage(session, { role: 'user', parts: [{ text: 'Synthetic retained history for ' + id }], __meta: { timestamp: 1000 } })
    if (id === 'busy') {
      session.busy = true
      session.busyStartedAt = 1000
    } else if (id === 'queued') {
      session.queue.push({ type: 'user', parts: [{ text: 'Synthetic pending work.' }] })
    } else {
      const options = id.startsWith('reason-') ? { reason: 'Synthetic legacy wait' }
        : id.startsWith('input-') ? { waitForInput: true, declarationVersion: 1 }
        : id.startsWith('any-') ? { waitAnySessions: ['input-0'], declarationVersion: 1 }
        : id.startsWith('all-') ? { waitAllSessions: ['input-0', 'input-1'], declarationVersion: 1 }
        : {}
      await sm.startSessionWaitForSession(session, options, () => sm.saveSessionForSessionCritical(session))
    }
    await sm.saveSessionForSessionCritical(session)
    await sm.saveSessionCatalogProjectionStrict(id)
  }
} else {
  const { initializeWaitLivenessDiagnostics } = await app('waitLiveness')
  const { initializeTimers, shutdownTimers } = await app('timers')
  const { initializeExecManager, getDefaultExecRuntime } = await app('execManager')
  initializeWaitLivenessDiagnostics()
  await initializeExecManager()
  await initializeTimers()
  await sm.resumeBusySessions()
  await new Promise(resolve => setTimeout(resolve, 700))
  const { sessionCatalogStore } = await app('session/catalogStore')
  assert.equal(sessionCatalogStore.list().length, 440)
  for (const id of coldIds) assert.ok(isSessionCatalogStub(sm.getSessionCatalog(id)), id)
  assert.deepEqual([...sm.getAllSessions().values()].filter(session => !isSessionCatalogStub(session)).map(session => session.id).sort(), ['busy', 'queued'])
  await shutdownTimers()
  await getDefaultExecRuntime().shutdown()
}
console.log('SESSION_STARTUP_FIXTURE:' + JSON.stringify({ coldIds, catalogCount: sm.getAllSessions().size,
  hydrated: [...sm.getAllSessions().values()].filter(session => !isSessionCatalogStub(session)).map(session => session.id).sort(), triggered: triggered.sort() }))
process.exit(0)
