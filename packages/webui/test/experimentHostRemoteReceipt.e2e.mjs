// Focused official CLI transfer provenance: direct and nested persisted YAML receipts.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('remote-receipt', { env: { FOXWARM_EXPERIMENT_MONTY_BINARY: process.env.FOXWARM_EXPERIMENT_MONTY_BINARY } })
const plans = new Map(), rounds = new Map(), failures = []
let client, clientOutput = '', requests = 0
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const result = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
const peer = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text), prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/RECEIPT:([\w-]+)/g)].at(-1)?.[1]
    const round = rounds.get(key) || 0; rounds.set(key, round + 1); requests++
    const output = round === 0 ? plans.get(key) : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }]
    const names = new Set((body.tools || []).filter(tool => tool.type === 'function').map(tool => tool.name))
    for (const tool of output.filter(part => part.type === 'function_call')) assert(names.has(tool.name), 'advertised native tool ' + tool.name)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 30, output_tokens: 5 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }))
async function create(name) {
  const reply = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: name })
  assert.equal(reply.status, 200); return reply.body.sessionId
}
async function turn(actor, key, output) {
  plans.set(key, output)
  assert.equal((await fixture.api('POST', route(actor) + '/message', { text: 'RECEIPT:' + key })).status, 202)
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const state = await saved(actor), view = (await fixture.api('GET', route(actor) + '/history')).body.session
    return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'DONE-' + key)) ? state : null
  }, key)
}
try {
  await fixture.start()
  const agents = join(fixture.root, 'cli-agents'), runtime = join(fixture.root, 'cli-runtime')
  await mkdir(join(agents, 'main'), { recursive: true }); await mkdir(runtime)
  const bytes = Buffer.from('title: "Unicode 🦊"\nenabled: true\n')
  await writeFile(join(agents, 'main/config.yaml'), bytes)
  const credentials = (await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: 'two' })).body
  client = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', fixture.origin, '--id', 'two', '--auth-token', credentials.authToken, '--credentials-file', join(runtime, 'credentials.json'), '--no-local-trigger'], { cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_AGENTS_DIR: agents } })
  for (const stream of [client.stdout, client.stderr]) stream.on('data', chunk => { clientOutput = (clientOutput + chunk).slice(-20000) })
  await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.some(node => node.id === 'two' && node.online && node.executable), 'official CLI online', 30000)
  const actor = await create('receipt-owner'), target = await create('receipt-target')
  assert.equal((await fixture.api('POST', route(target) + '/message', { text: '/session unparent' })).status, 200)
  const targetBefore = (await saved(target)).history
  const directState = await turn(actor, 'direct', [call('direct', 'send_file', { filePath: 'config.yaml', node: 'two', sessionId: target })])
  const direct = result(directState, 'direct'); assert(direct && !direct.error, JSON.stringify(direct))
  const nestedState = await turn(actor, 'nested', [call('nested', 'run_script', { code: `return {'receipt': call_tool('builtin:send_file', {'filePath':'config.yaml', 'node':'two', 'sessionId':'${target}'})}` })])
  const nestedResult = result(nestedState, 'nested'); assert(nestedResult && !nestedResult.error, JSON.stringify(nestedResult))
  const nested = nestedResult.result.receipt; assert(nested && !nested.error, JSON.stringify(nested))
  const receipts = []
  for (const value of [direct, nested]) {
    const receipt = value.fileDelivery
    assert.equal(receipt.version, 1); assert.equal(receipt.targetKind, 'session'); assert.equal(receipt.targetId, target)
    assert.equal(receipt.fileName, 'config.yaml'); assert.equal(receipt.mimeType, 'application/yaml'); assert.equal(receipt.sizeBytes, bytes.length)
    assert.equal(receipt.sourceNodeId, 'two'); assert.equal(receipt.downloadNodeId, 'master'); assert.equal(receipt.downloadPath, value.fullPath)
    assert(receipt.downloadPath.startsWith(join(fixture.work, '.temp/file-delivery')))
    assert.deepEqual(await readFile(receipt.downloadPath), bytes)
    // Receipt metadata does not change the existing download-only preview policy.
    const issued = await fixture.api('POST', '/api/download/sign', { path: receipt.downloadPath, preview: '1' }); assert.equal(issued.status, 200)
    const download = await fetch(fixture.origin + '/' + issued.body.url)
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/octet-stream')
    assert(download.headers.get('content-disposition').startsWith('attachment;')); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes)
    receipts.push(receipt)
  }
  assert.notEqual(receipts[0].deliveryId, receipts[1].deliveryId)
  assert.deepEqual((await saved(target)).history, targetBefore)
  const archive = fixture.sql('SELECT seq,message_json FROM archive_messages WHERE session_id = ? ORDER BY seq', [actor])
  const archived = new Map(archive.map(([seq, json]) => [seq, JSON.parse(json)]))
  for (const row of nestedState.history) assert.deepEqual(archived.get(row.__meta.seq), row)
  assert.equal(failures.length, 0)
  console.log(JSON.stringify({ hostStarts: fixture.hostPids.length, officialClients: 1, modelRequests: requests, persistedReceipts: receipts, archiveRows: archive.length, failures: failures.length }))
  await fixture.stop()
} catch (error) { console.error(fixture.output, clientOutput); throw error }
finally {
  if (client && client.exitCode === null && client.signalCode === null) { const exited = once(client, 'exit'); client.kill('SIGTERM'); await exited }
  peer.closeAllConnections(); await new Promise(done => peer.close(done)); await fixture.cleanup()
}
