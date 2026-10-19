// Unchanged CLI NodeClient Session RPCs against an owned real Main and local model.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('cli-sessions', { env: { FOXWARM_BIND_ADDRESS: '127.0.0.1' } })
// Establish owned runtime paths before importing the application client or its logger/configuration.
const require = createRequire(import.meta.url)
const { isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
Object.assign(process.env, isolatedApplicationEnv(fixture.data))
process.env.FOXWARM_AGENTS_DIR = join(fixture.root, 'cli-agents')
await mkdir(process.env.FOXWARM_AGENTS_DIR)
const { NodeClient } = require(resolve('packages/cli-node/dist/client.js'))
const clients = [], requests = [], failures = []
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const bytes of request) raw += bytes
    const body = JSON.parse(raw); requests.push(body)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CLI-MODEL-REPLY' }] }], usage: { input_tokens: 7, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
const route = id => '/api/sessions/' + encodeURIComponent(id)
async function create(name, agent = 'main') {
  const result = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name })
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.sessionId
}
async function connect(id) {
  const credential = (await fixture.api('POST', '/api/nodes/onboarding/create', { nodeId: id })).body
  const client = new NodeClient({ host: fixture.origin, nodeId: id, authToken: credential.authToken, credentialsFile: join(fixture.root, id + '.json'), localTrigger: false })
  clients.push(client); await client.connect()
  await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === id && node.online && node.executable), id + ' registered')
  return client
}
try {
  await fixture.start()
  const client = await connect('cli-one'), other = await connect('cli-two')
  const id = await create('cli-history'), denied = await create('not-assigned')
  assert.equal((await fixture.api('POST', route(id) + '/node', { nodeId: 'cli-one' })).status, 200)
  let sessions = await client.listBoundSessions()
  assert.deepEqual(sessions.map(row => row.id), [id])
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['id', 'displayName', 'messageCount', 'lastMessageTime', 'currentNode', 'cwd', 'busy', 'queueLength'].sort())
  assert.equal((await client.getSessionHistory(id)).totalMessages, 0)
  await assert.rejects(client.getSessionHistory(denied), /cannot read history for.*not assigned/)
  await assert.rejects(client.sendSessionMessage(denied, 'DENIED-CLI-INPUT'), /cannot send messages to.*not assigned/)
  await assert.rejects(other.getSessionHistory(id), /cannot read history for.*not assigned/)
  await assert.rejects(client.getSessionHistory('missing'), /Target session "missing" not found\./)
  // The public NodeClient methods used by Ink produce ordinary wrapped ingress and a real model turn.
  await client.sendSessionMessage(id, 'CLI-INTERACTIVE-INPUT')
  const history = await until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const result = await client.getSessionHistory(id)
    return !result.session.busy && result.messages.some(row => row.text === 'CLI-MODEL-REPLY') ? result : null
  }, 'CLI ingress/model/history')
  assert.equal(history.totalMessages, 2)
  assert.match(history.messages[0].text, /\[SYSTEM\] <foxwarm-message[^>]*type="trigger"/)
  assert.match(history.messages[0].text, /CLI-INTERACTIVE-INPUT/)
  assert.equal(history.messages[1].role, 'model')
  assert.equal(history.messages[1].index, 1)
  assert.equal(typeof history.messages[1].timestamp, 'number')
  assert(requests.some(body => JSON.stringify(body.input).includes('CLI-INTERACTIVE-INPUT')))
  assert(!requests.some(body => JSON.stringify(body.input).includes('DENIED-CLI-INPUT')))
  assert.equal((await client.getSessionHistory(id, 1)).messages.length, 1)
  assert.equal((await client.getSessionHistory(id, -10)).messages.length, 1)
  assert.equal((await client.getSessionHistory(id, 0)).messages.length, 2)
  assert.equal((await client.getSessionHistory(id, 999)).messages.length, 2)
  // Reassignment immediately changes both discovery and access on the same authenticated connections.
  assert.equal((await fixture.api('POST', route(id) + '/node', { nodeId: 'cli-two' })).status, 200)
  assert.deepEqual(await client.listBoundSessions(), [])
  await assert.rejects(client.getSessionHistory(id), /cannot read history for.*not assigned/)
  await assert.rejects(client.sendSessionMessage(id, 'REASSIGNED-DENIED'), /cannot send messages to.*not assigned/)
  assert((await other.listBoundSessions()).some(row => row.id === id))
  assert.equal((await other.getSessionHistory(id)).totalMessages, 2)
  // Bound isolated Agent scope is independent of an ordinary Session's selection.
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'cli-bound', isolatedNode: 'cli-one' })).status, 201)
  const bound = await create('bound-history', 'cli-bound')
  assert((await client.listBoundSessions()).some(row => row.id === bound))
  assert.equal((await client.getSessionHistory(bound)).session.currentNode, 'cli-one')
  await assert.rejects(other.getSessionHistory(bound), /cannot read history for.*not assigned/)
  await fixture.stop(); await fixture.start()
  await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.filter(node => node.online).length === 3, 'clients reconnected after owned Main restart')
  assert.equal((await other.getSessionHistory(id)).totalMessages, 2)
  assert((await client.listBoundSessions()).some(row => row.id === bound))
  console.log('Unchanged CLI NodeClient list/history/send, normal ingress/model reply, denied/reassigned/bound scope and cold Main restart passed.')
} finally {
  for (const client of clients) await client.disconnect()
  model.closeAllConnections(); await new Promise(done => model.close(done)); await fixture.cleanup()
}
