// Model-request projection and direct exec effects through an unchanged official CLI.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('remote-exec-schemas')
const plans = new Map(), rounds = new Map(), failures = [], schemaEvidence = []
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const done = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SCHEMA-DONE-' + key }] }]
const peer = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/SCHEMA:([\w-]+)/g)].at(-1)?.[1]
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const names = new Set((body.tools || []).filter(tool => tool.type === 'function').map(tool => tool.name))
    const execAdvertised = names.has('exec'), remoteDefaultCwdAdvertised = names.has('get_default_cwd')
    schemaEvidence.push({ key, round, execAdvertised, remoteDefaultCwdAdvertised })
    if (['foreground', 'parallel'].includes(key)) {
      assert(execAdvertised, 'selected official CLI must advertise exec before direct calls')
      assert(remoteDefaultCwdAdvertised, 'request must use selected CLI capabilities')
    }
    if (key === 'hidden') {
      assert(!execAdvertised, 'current remote deny policy must hide exec')
      assert(remoteDefaultCwdAdvertised, 'policy must not hide unrelated CLI tools')
    }
    const output = round === 0 ? plans.get(key) ?? done(key) : done(key)
    // Never manufacture an undeclared direct tool call in this qualification.
    for (const tool of output.filter(part => part.type === 'function_call'))
      assert(names.has(tool.name), 'provider response requires advertised function ' + tool.name)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 35, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }))
const remote = join(fixture.root, 'official-cli')
await mkdir(join(remote, 'agents/main'), { recursive: true })
let client, clientOutput = '', actor
const saved = () => readFile(join(fixture.data, 'state/sessions', actor + '.json'), 'utf8').then(JSON.parse)
const route = () => '/api/sessions/' + encodeURIComponent(actor)
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
async function turn(key, calls = []) {
  plans.set(key, calls.length ? calls : done(key))
  assert.equal((await fixture.api('POST', route() + '/message', { text: 'SCHEMA:' + key })).status, 202)
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const state = await saved(), view = (await fixture.api('GET', route() + '/history')).body.session
    return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'SCHEMA-DONE-' + key)) ? state : null
  }, 'schema-qualified turn ' + key)
}
try {
  await fixture.start()
  const credentials = (await fixture.api('POST', '/api/nodes/onboarding/create', { nodeId: 'official-cli' })).body
  client = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', fixture.origin, '--id', credentials.nodeId, '--auth-token', credentials.authToken, '--credentials-file', join(remote, 'credentials.json'), '--no-local-trigger'], {
    cwd: remote, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_AGENTS_DIR: join(remote, 'agents') },
  })
  for (const stream of [client.stdout, client.stderr]) stream.on('data', bytes => { clientOutput += bytes })
  await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'official-cli' && node.online && node.executable), 'official CLI registration', 30000)
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'schema-owner' })
  assert.equal(created.status, 200); actor = created.body.sessionId
  let state = await turn('select', [call('select', 'node', { action: 'select', nodeId: 'official-cli' })])
  assert.equal(state.currentNode, 'official-cli')
  state = await turn('foreground', [call('foreground', 'exec', { command: 'printf once >> foreground-count; pwd' })])
  assert(!pair(state, 'foreground').error, JSON.stringify(pair(state, 'foreground')))
  assert.match(pair(state, 'foreground').output, new RegExp(remote))
  assert.equal(await readFile(join(remote, 'foreground-count'), 'utf8'), 'once')
  assert.equal(await access(join(fixture.work, 'foreground-count')).then(() => true, () => false), false)
  const parallelIds = Array.from({ length: 6 }, (_, index) => 'parallel-' + index)
  const started = Date.now()
  state = await turn('parallel', parallelIds.map(id => call(id, 'exec', { command: `printf start >> ${id}; sleep 1; printf done >> ${id}`, timeout: 5 })))
  const parallelMilliseconds = Date.now() - started
  assert(parallelMilliseconds < 4500, 'six adjacent one-second exec calls must not run serially')
  for (const id of parallelIds) {
    assert(!pair(state, id).error, JSON.stringify(pair(state, id)))
    assert.equal(await readFile(join(remote, id), 'utf8'), 'startdone')
  }
  assert.deepEqual(state.history.filter(row => row.role === 'tool').at(-1).parts.map(part => part.functionResponse.tool_use_id), parallelIds)
  await writeFile(join(fixture.work, 'deny-exec.yaml'), 'version: 1\nrules:\n- id: remote-exec\n  action: deny\n  match:\n    tool: {source: node, name: exec}\n    targetNode: official-cli\n')
  state = await turn('policy', [call('policy', 'call_tool', { toolId: 'builtin:set_config', args: { target: 'tool-rules', filePath: 'deny-exec.yaml' } })])
  assert(!pair(state, 'policy').error, JSON.stringify(pair(state, 'policy')))
  state = await turn('hidden')
  const calls = state.history.flatMap(row => row.parts || []).filter(part => part.functionCall).map(part => part.functionCall.id)
  const replies = state.history.flatMap(row => row.parts || []).filter(part => part.functionResponse).map(part => part.functionResponse.tool_use_id)
  for (const id of calls) assert.equal(replies.filter(reply => reply === id).length, 1, 'one canonical response for ' + id)
  assert(schemaEvidence.some(row => row.key === 'foreground' && row.round === 0 && row.execAdvertised))
  assert(schemaEvidence.some(row => row.key === 'parallel' && row.round === 0 && row.execAdvertised))
  assert(schemaEvidence.some(row => row.key === 'hidden' && !row.execAdvertised))
  assert.equal(failures.length, 0)
  await fixture.stop()
  console.log(JSON.stringify({ hostStarts: fixture.hostPids.length, officialClientStarts: 1, directExecEffects: 7, canonicalToolPairs: replies.length, parallelMilliseconds, schemaEvidence, failures: failures.length }))
} catch (error) { console.error(fixture.output, clientOutput); throw error }
finally {
  if (client && client.exitCode === null && client.signalCode === null) { const exited = once(client, 'exit'); client.kill('SIGTERM'); await exited }
  peer.closeAllConnections(); await new Promise(done => peer.close(done))
  await fixture.cleanup()
}
