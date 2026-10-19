// Ordinary Main/model lifecycle callers; no provisioning UI or native credential fallback.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const env = {}, options = { env, normalStartup: true }
const fixture = await createHostFixture('provider-lifecycle', options)
options.cwd = fixture.root
const target = join(fixture.root, 'target')
await mkdir(target)
const unicodeTarget = join(fixture.root, 'unicode')
await mkdir(unicodeTarget)
const unicodeSchema = '\u2028'.repeat(3000) + '\u2029😀\u0085\u200b'
const unicodeBytes = Buffer.byteLength(JSON.stringify(unicodeSchema))
assert(unicodeBytes < 16 * 1024)
await writeFile(join(unicodeTarget, 'description.json'), JSON.stringify({ label: 'Unicode schema', description: 'Plain JSON schema data.', lifecycle: [], createParameters: unicodeSchema }))
env.FOXWARM_BIND_ADDRESS = '127.0.0.1'
env.FOXWARM_PUBLIC_BASE_URL = fixture.origin
env.FOXWARM_CONFIG_PATH = join(fixture.data, 'state/config.yaml')
await writeFile(env.FOXWARM_CONFIG_PATH, JSON.stringify({ bot: { httpPort: fixture.port }, vector: false, llm: { maxOutput: 713 }, nodeProviders: {
  external: { type: 'executable', command: 'python3', args: [resolve('dotnet/Foxwarm.Tests/Tools/Fixtures/node-provider.py'), target, 'lifecycle'], timeoutSeconds: 3 },
  unicode: { type: 'executable', command: 'python3', args: [resolve('dotnet/Foxwarm.Tests/Tools/Fixtures/node-provider.py'), unicodeTarget], timeoutSeconds: 3 }
} }))
const failures = [], requests = [], scripts = new Map()
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const text = body.input.filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...text.matchAll(/LIFECYCLE:([\w-]+)/g)].at(-1)?.[1], calls = scripts.get(key)
    assert(calls, key)
    const definition = body.tools.find(tool => tool.name === 'node')
    assert(definition.parameters.properties.action.enum.includes('create'))
    const output = calls.every(item => body.input.some(row => row.type === 'function_call_output' && row.call_id === item.call_id))
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }] : calls
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 25, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
let route
async function turn(key, calls) {
  scripts.set(key, calls)
  assert.equal((await fixture.api('POST', route + '/message', { text: 'LIFECYCLE:' + key })).status, 202)
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const state = (await fixture.api('GET', route + '/history')).body
    return !state.session.busy && JSON.stringify(state.messages).includes('DONE-' + key) && state
  }, key)
}
const result = (state, id) => state.messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse.response
try {
  await fixture.start()
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'provider-lifecycle' })
  assert.equal(created.status, 200); route = '/api/sessions/' + encodeURIComponent(created.body.sessionId)
  let state = await turn('discover', [call('discover', 'run_script', { code: "x=call_tool('node', {'action':'list'})\ny=call_tool('builtin:node', {'action':'inspect','providerId':'external'})\nreturn [x,y]" })])
  const discovery = result(state, 'discover')
  assert.equal(discovery.status, 'completed', JSON.stringify(discovery))
  assert.equal(discovery.result[0].currentNode, 'master')
  assert.equal(discovery.result[0].providers.find(p => p.id === 'external').createParameters, undefined)
  assert.equal(discovery.result[1].provider.createParameters.type, 'object')
  assert(discovery.result[0].providers.some(provider => provider.id === 'unicode'))
  state = await turn('unicode', [call('unicode', 'node', { action: 'inspect', providerId: 'unicode' })])
  assert.equal(result(state, 'unicode').provider.createParameters, unicodeSchema)
  const properties = entries => Object.fromEntries(Array.from({ length: entries }, (_, index) => ['k' + index, 0]))
  state = await turn('reject-plain', [
    call('reject-array', 'node', { action: 'create', providerId: 'external', nodeId: 'external/rejected-array', parameters: { items: Array(2049).fill(0) } }),
    call('reject-object', 'node', { action: 'create', providerId: 'external', nodeId: 'external/rejected-object', parameters: properties(2049) }),
    call('reject-number', 'node', { action: 'create', providerId: 'external', nodeId: 'external/rejected-number', parametersJson: '{"huge":1e400}' })
  ])
  for (const id of ['reject-array', 'reject-object', 'reject-number']) assert(result(state, id).error, id)
  await assert.rejects(readFile(join(target, 'effects.jsonl')), { code: 'ENOENT' })
  state = await turn('plain-controls', [
    call('control-array', 'node', { action: 'create', providerId: 'external', nodeId: 'external/array', parameters: { items: Array(2048).fill(0) } }),
    call('control-object', 'node', { action: 'create', providerId: 'external', nodeId: 'external/object', parameters: properties(2048) }),
    call('control-number', 'node', { action: 'create', providerId: 'external', nodeId: 'external/finite', parametersJson: '{"large":1e308,"tiny":5e-324,"negativeZero":-0}' })
  ])
  for (const id of ['control-array', 'control-object', 'control-number']) assert.equal(result(state, id).error, undefined, id)
  const controlEffects = (await readFile(join(target, 'effects.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(controlEffects.map(effect => effect.nodeId).sort(), ['array', 'finite', 'object'])
  state = await turn('create', [call('create', 'node', { action: 'create', providerId: 'external', nodeId: 'external/new', parametersJson: '{"label":"Created by model"}' })])
  assert.equal(result(state, 'create').node.id, 'external/new')
  const authority = JSON.parse(await readFile(join(fixture.data, 'state/sessions', created.body.sessionId + '.json'), 'utf8'))
  assert.equal(authority.currentNode ?? 'master', 'master')
  state = await turn('select-exec', [call('select', 'node', { action: 'select', nodeId: 'external/new' }), call('command', 'exec', { command: 'printf actual > model-effect', timeout: 15 })])
  assert.equal(result(state, 'command').error, undefined)
  assert.equal(await readFile(join(target, 'fs/root/model-effect'), 'utf8'), 'actual')
  state = await turn('destroy', [call('destroy', 'node', { action: 'destroy', nodeId: 'external/new', confirmation: 'destroy node external/new' })])
  assert.equal(result(state, 'destroy').nodeId, 'external/new')
  assert.equal(await readFile(join(target, 'fs/root/model-effect'), 'utf8'), 'actual')
  const human = await fixture.api('POST', route + '/message', { text: '/node inspect master' })
  assert.equal(human.status, 200)
  assert.equal((await fixture.api('GET', '/api/nodes/master')).status, 200)
  const calls = (await readFile(join(target, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const effects = calls.filter(row => ['create', 'destroy'].includes(row.operation))
  assert.deepEqual(effects.map(row => row.operation), ['create', 'create', 'create', 'create', 'destroy'])
  assert(effects.slice(-2).every(row => row.request.nodeId === 'new'))
  assert(effects.every(row => row.request.sourceSessionId === created.body.sessionId && row.request.context.agent === 'main'))
  await fixture.stop()
  console.log(JSON.stringify({ result: 'Ordinary Main/model structured discovery, lifecycle, selection/exec, retention, human command admission and distinct HTTP detail passed.', mainProcesses: fixture.hostPids.length, modelRequests: requests.length, unicodeSchemaBytes: unicodeBytes, rejectedEffects: 0, controlEffects: controlEffects.length }))
} finally {
  await fixture.cleanup(); model.closeAllConnections(); await new Promise(done => model.close(done))
}
