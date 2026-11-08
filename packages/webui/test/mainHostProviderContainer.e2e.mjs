// Opt-in qualification: packaged container adapter through ordinary C# Main and a real Docker or Podman engine.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const engine = process.env.FOXWARM_TEST_CONTAINER_ENGINE, image = process.env.FOXWARM_TEST_CONTAINER_IMAGE
if (!engine || !image) throw new Error('Set FOXWARM_TEST_CONTAINER_ENGINE (docker or podman) and FOXWARM_TEST_CONTAINER_IMAGE (a local image built from the example Containerfile).')
const providerId = 'container-e2e-' + process.pid
const run = (...args) => execFileSync(engine, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const owned = () => run('ps', '-a', '-q', '--no-trunc', '--filter', `label=net.foxwarm.provider=${providerId}`).split(/\s+/).filter(Boolean)
const inContainer = (local, ...command) => run('exec', owned().find(id => run('inspect', '--format', '{{index .Config.Labels "net.foxwarm.node"}}', id).trim() === local), ...command)
const options = { env: {} }
const fixture = await createHostFixture('provider-container', options)
options.cwd = fixture.root
let model, route
const failures = [], scripts = new Map(), requests = []
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
// Structured exec results come from native ToolScript, as in the SSH qualification.
const exec = (id, command, timeout) => call(id, 'run_script', { code: 'return call_tool(' + "'exec'" + ', ' + JSON.stringify({ command, timeout }) + ')' })
const result = (state, id) => state.messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse.response
async function turn(key, calls, timeout = 60000) {
  scripts.set(key, calls)
  assert.equal((await fixture.api('POST', route + '/message', { text: 'CONTAINER-QUALIFY:' + key })).status, 202)
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const state = (await fixture.api('GET', route + '/history')).body
    return !state.session.busy && JSON.stringify(state.messages).includes('CONTAINER-DONE-' + key) && state
  }, key, timeout)
}
try {
  assert.deepEqual(owned(), [], 'no leftover containers for this Provider ID')
  const configPath = join(fixture.root, 'profiles.json')
  await writeFile(configPath, JSON.stringify({ engine: [engine], maxNodes: 3, profiles: { e2e: { image, description: 'Qualification profile.', pids: 256 } } }))
  // Use the packaged resources, outside the source tree and without importing Core.
  const adapter = resolve('dotnet/Foxwarm/bin/Debug/net10.0/skills/node-setup/examples/container/provider.py')
  await readFile(adapter); await readFile(join(adapter, '..', '..', 'linux-ssh', 'target.py'))
  await writeFile(join(fixture.data, 'state/config.yaml'), JSON.stringify({ url: fixture.origin, bot: { httpPort: fixture.port }, vector: false, llm: { maxOutput: 713 }, nodeProviders: {
    [providerId]: { type: 'executable', command: 'python3', args: [adapter, '--config', configPath], timeoutSeconds: 60 }
  } }))
  model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw); requests.push(body)
      const text = body.input.filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const key = [...text.matchAll(/CONTAINER-QUALIFY:([\w-]+)/g)].at(-1)?.[1], calls = scripts.get(key)
      assert(calls, key)
      const output = calls.every(item => body.input.some(row => row.type === 'function_call_output' && row.call_id === item.call_id))
        ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CONTAINER-DONE-' + key }] }] : calls
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 25, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { failures.push(error.stack); response.destroy() }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
  await fixture.start()
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'container-owner' })
  assert.equal(created.status, 200); route = '/api/sessions/' + encodeURIComponent(created.body.sessionId)
  const node = providerId + '/w1'

  let state = await turn('discover', [call('discover', 'node', { action: 'inspect', providerId })])
  const provider = result(state, 'discover').provider
  assert.deepEqual(provider.lifecycle, ['create', 'ensure', 'inspect', 'destroy'])
  assert.deepEqual(provider.createParameters.properties.profile.enum, ['e2e'])

  state = await turn('create', [
    call('reject', 'node', { action: 'create', providerId, nodeId: providerId + '/rejected', parameters: { profile: 'e2e', image: 'other' } }),
    call('create', 'node', { action: 'create', providerId, nodeId: node, parameters: { profile: 'e2e' } }),
  ], 120000)
  assert(result(state, 'reject').error)
  assert.equal(result(state, 'create').node.id, node, JSON.stringify(result(state, 'create')))
  assert.equal(result(state, 'create').node.availability, 'ready')
  assert.equal(owned().length, 1)
  const settings = JSON.parse(run('inspect', owned()[0]))[0]
  assert.equal(settings.HostConfig.NetworkMode, 'none')
  assert.equal(settings.Config.Labels['net.foxwarm.profile'], 'e2e')

  assert.equal((await fixture.api('POST', route + '/node', { nodeId: node })).status, 200)
  const patch = '*** Begin Patch\n*** Update File: sample.txt\n@@\n-β\n+gamma\n*** End Patch'
  state = await turn('files', [call('files', 'run_script', { code: "call_tool('write', {'filePath':'sample.txt','content':'alpha\\nβ\\n'})\ncall_tool('edit', {'filePath':'sample.txt','oldText':'alpha','newText':'changed'})\ncall_tool('edit', {'apply_patch':" + JSON.stringify(patch) + "})\nreturn call_tool('read', {'filePath':'sample.txt'})['content']" })])
  assert.equal(result(state, 'files').result, 'changed\ngamma\n')
  assert.equal(inContainer('w1', 'cat', '/workspace/sample.txt'), 'changed\ngamma\n')

  const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 0xc3); bytes[0] = 0; bytes[bytes.length - 1] = 255
  const original = join(fixture.work, 'binary.bin'), roundTrip = join(fixture.work, 'roundtrip.bin')
  await writeFile(original, bytes)
  state = await turn('binary', [call('binary', 'run_script', { code: "a=call_tool('copy_between_nodes', {'sourceNode':'master','sourcePath':" + JSON.stringify(original) + ",'targetNode':'" + node + "','targetPath':'transfer.bin'})\nb=call_tool('copy_between_nodes', {'sourceNode':'" + node + "','sourcePath':'transfer.bin','targetNode':'master','targetPath':" + JSON.stringify(roundTrip) + "})\nreturn [a,b]" })], 120000)
  assert.equal(result(state, 'binary').status, 'completed', JSON.stringify(result(state, 'binary')))
  assert.deepEqual(await readFile(roundTrip), bytes)

  state = await turn('commands', [
    exec('exit', "mkdir -p ' sub ' && cd ' sub ' && printf '  héllo\\n'; exit 7", 15),
    exec('offline', "python3 -c \"import socket; socket.create_connection(('192.0.2.1', 80), 2)\"", 15),
    exec('caps', 'grep CapEff /proc/self/status', 15),
  ])
  assert.equal(result(state, 'exit').result.exitCode, 7, JSON.stringify(result(state, 'exit')))
  assert.equal(result(state, 'exit').result.content, '  héllo\n')
  assert.notEqual(result(state, 'offline').result.exitCode, 0, 'no network inside the container')
  assert.match(result(state, 'caps').result.content, /CapEff:\s+0+\s*$/)

  state = await turn('restart', [exec('restart', 'sleep 8; printf x >> /workspace/restart-effect; printf recovered', 1)])
  const started = result(state, 'restart').result
  assert.equal(started.status, 'running', JSON.stringify(started))
  const registryPath = join(fixture.data, 'state/running-exec.json')
  const tracking = async () => JSON.parse(await readFile(registryPath, 'utf8')).execs
  const meta = (await tracking())[0]
  assert.equal(meta.backend.providerId, providerId); assert.equal(meta.nodeId, node)
  assert.equal((await fixture.api('POST', route + '/node', { nodeId: 'master' })).status, 200)
  await fixture.stop()
  await fixture.start()
  await until(async () => inContainer('w1', 'sh', '-c', 'cat /workspace/restart-effect 2>/dev/null || true') === 'x' && (await tracking()).length === 0, 'same reference completes after Main restart', 30000)
  assert.equal(inContainer('w1', 'cat', meta.logPath), 'recovered')
  await until(() => requests.some(request => JSON.stringify(request.input).includes('background-process-finished') && JSON.stringify(request.input).includes(started.execId)), 'completion reaches the model owner')

  assert.equal((await fixture.api('POST', route + '/node', { nodeId: node })).status, 200)
  state = await turn('stopped', [exec('long', 'sleep 120', 1)])
  assert.equal(result(state, 'long').result.status, 'running')
  run('stop', '-t', '1', owned()[0])
  state = await turn('ensure', [call('ensure', 'node', { action: 'ensure', providerId, nodeId: node, parameters: { profile: 'e2e' } })], 120000)
  assert.equal(result(state, 'ensure').node.availability, 'ready', JSON.stringify(result(state, 'ensure')))
  await until(async () => (await tracking()).length === 0, 'command ended by a container stop is reported lost, not successful', 60000)

  assert.equal((await fixture.api('POST', route + '/node', { nodeId: 'master' })).status, 200)
  state = await turn('destroy', [call('destroy', 'node', { action: 'destroy', nodeId: node, confirmation: 'destroy node ' + node })], 120000)
  assert.equal(result(state, 'destroy').nodeId, node, JSON.stringify(result(state, 'destroy')))
  assert.deepEqual(owned(), [])
  state = await turn('gone', [call('gone', 'run_script', { code: "return call_tool('node', {'action':'list'})" })])
  assert(!result(state, 'gone').result.nodes.some(row => row.id === node))
  await fixture.stop()
  console.log(JSON.stringify({ result: `Packaged container adapter with ${engine}: profile-only create, hardening, canonical files, binary round trip, commands without network or capabilities, exact-reference Main restart, stop/ensure loss reporting and destroy passed.`, modelRequests: requests.length }))
} finally {
  await fixture.cleanup()
  if (model) { model.closeAllConnections(); await new Promise(done => model.close(done)) }
  for (const id of owned()) run('rm', '-f', '-v', id)
}
