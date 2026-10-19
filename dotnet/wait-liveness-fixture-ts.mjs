import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const [mode, root, graph = 'idle'] = process.argv.slice(2)
if (!root || !['seed', 'unseen'].includes(mode)) throw new Error('usage: wait-liveness-fixture-ts.mjs seed|unseen ROOT idle|cycle|missing|changed')
// Set owned paths before any application import, including in direct invocations.
const { isolatedApplicationEnv } = createRequire(import.meta.url)('../scripts/test/test-process-env.cjs')
Object.assign(process.env, isolatedApplicationEnv(root))
process.env.FOXWARM_VECTOR_ENABLED = 'false'
let requests = 0
const peer = http.createServer(async (request, response) => {
  for await (const _ of request) { /* consume the real provider request */ }
  requests++
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end('data: ' + JSON.stringify({ type: 'response.completed', response: {
    id: 'synthetic-liveness', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Synthetic diagnostic received.' }] }],
    usage: { input_tokens: 10, output_tokens: 3 },
  } }) + '\n\n')
})
await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve))
await fs.mkdir(path.join(root, 'state'), { recursive: true })
await fs.writeFile(path.join(root, 'state/models.yaml'), `default: a/wire\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:${peer.address().port}\n    apiKey: synthetic-not-a-key\n    models: [wire]\n`)
await fs.writeFile(path.join(root, 'state/config.yaml'), 'dbWorkers: false\nsessionWorkers: false\nvector:\n  enabled: false\n')
const repository = process.env.FOXWARM_TS_ROOT || path.resolve(import.meta.dirname, '..')
const app = file => import(pathToFileURL(path.join(repository, 'lib', file + '.js')).href)
const sm = await app('sessionManager')
const { armWaitLivenessDiagnostic } = await app('waitLiveness')
const { SessionTurnRunner, LocalSessionTurnHost } = await app('sessionTurnRunner')
const runner = new SessionTurnRunner(new LocalSessionTurnHost())
sm.setSessionTriggerCallback(id => runner.processSessionQueue(id))
await sm.loadSessions()
const id = 'waiter'
const targets = graph === 'cycle' ? ['dep-z', 'dep-a'] : graph === 'missing' ? ['departed']
    : graph === 'changed' ? ['different-dependency'] : ['dependency']
for (const name of [id, ...targets]) await sm.createEmptySession(name)
if (graph === 'cycle') {
  for (const [from, to] of [[targets[0], targets[1]], [targets[1], targets[0]]]) {
    const dependency = await sm.getSession(from)
    await sm.startSessionWaitForSession(dependency, { waitAnySessions: [to] }, () => sm.saveSessionForSessionCritical(dependency))
    await sm.saveSessionCatalogProjectionStrict(from)
  }
}
const owner = await sm.getSession(id)
await sm.appendSessionMessage(owner, { role: 'user', parts: [{ text: 'Synthetic dependency work.' }], __meta: { timestamp: 1000 } })
const declare = () => sm.startSessionWaitForSession(owner, { waitAnySessions: targets, declarationVersion: 1 }, () => sm.saveSessionForSessionCritical(owner))
await declare()
if (graph === 'missing') await sm.deleteSession(targets[0])
await sm.saveSessionCatalogProjectionStrict(id)
if (mode === 'seed') {
  armWaitLivenessDiagnostic(id, owner.meta.wait.id)
  const deadline = Date.now() + 15000
  while (!(requests === 1 && !owner.busy && owner.queue.length === 0 && !owner.meta.wait && owner.history.length === 3)) {
    if (Date.now() > deadline) throw new Error('Source diagnostic did not settle: ' + JSON.stringify({ requests, busy: owner.busy, queue: owner.queue, history: owner.history }))
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(owner.meta.waitLivenessFingerprints.length, 1)
  assert.match(JSON.stringify(owner.history), /wait-sources-quiescent/)
  await declare()
  await sm.saveSessionCatalogProjectionStrict(id)
  // Observe the same graph again through Source, proving this is a deduplicated declaration.
  armWaitLivenessDiagnostic(id, owner.meta.wait.id)
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.equal(requests, 1)
  assert.ok(owner.meta.wait)
}
await sm.saveSessionForSessionCritical(owner)
await sm.saveSessionCatalogProjectionStrict(id)
await runner.shutdown(() => false)
await new Promise(resolve => peer.close(resolve))
console.log('WAIT_LIVENESS_FIXTURE:' + JSON.stringify({ id, targets, requests,
  wait: owner.meta.wait, fingerprints: owner.meta.waitLivenessFingerprints ?? [], history: owner.history }))
process.exit(0)
