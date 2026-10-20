// Public packaged adapter through ordinary C# Main and real, owned loopback SSH.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { sshFixture } from '../../../scripts/test/loopbackSshFixture.cjs'
import { createHostFixture, until } from './experimentHostFixture.mjs'

if (process.platform !== 'linux') throw new Error('The SSH qualification requires Linux, Python 3 and OpenSSH.')
const env = {}, options = { env, normalStartup: true }
const fixture = await createHostFixture('provider-ssh', options)
options.cwd = fixture.root
const sshRoot = await mkdtemp(join(homedir(), '.foxwarm-ssh-test-'))
let connection, model
const failures = [], scripts = new Map(), requests = []
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const result = (state, id) => state.messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse.response
let route
async function turn(key, calls) {
  scripts.set(key, calls)
  assert.equal((await fixture.api('POST', route + '/message', { text: 'SSH-QUALIFY:' + key })).status, 202)
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const state = (await fixture.api('GET', route + '/history')).body
    return !state.session.busy && JSON.stringify(state.messages).includes('SSH-DONE-' + key) && state
  }, key, 60000)
}
try {
  connection = await sshFixture(sshRoot)
  const cwd = join(sshRoot, "target space ü 'quote"), stateDir = join(sshRoot, 'target-state')
  await mkdir(cwd)
  await mkdir(join(cwd, ' sub '))
  const configPath = join(sshRoot, 'provider.json')
  await writeFile(configPath, JSON.stringify({ nodes: [{ id: 'ssh:fixture', label: 'SSH fixture', target: connection.target, sshArgs: connection.sshArgs, cwd, stateDir }] }))
  // Use the bundled resources, outside the source tree and without importing Core.
  const adapter = resolve('dotnet/Foxwarm/bin/Debug/net10.0/skills/node-setup/examples/linux-ssh/provider.py')
  await readFile(adapter); await readFile(join(adapter, '..', 'target.py'))
  env.FOXWARM_BIND_ADDRESS = '127.0.0.1'
  env.FOXWARM_PUBLIC_BASE_URL = fixture.origin
  env.FOXWARM_CONFIG_PATH = join(fixture.data, 'state/config.yaml')
  await writeFile(env.FOXWARM_CONFIG_PATH, JSON.stringify({ bot: { httpPort: fixture.port }, vector: false, llm: { maxOutput: 713 }, nodeProviders: {
    'external-ssh': { type: 'executable', command: 'python3', args: [adapter, '--config', configPath], timeoutSeconds: 5 }
  } }))
  model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw); requests.push(body)
      const text = body.input.filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const key = [...text.matchAll(/SSH-QUALIFY:([\w-]+)/g)].at(-1)?.[1], calls = scripts.get(key)
      assert(calls, key)
      const output = calls.every(item => body.input.some(row => row.type === 'function_call_output' && row.call_id === item.call_id))
        ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SSH-DONE-' + key }] }] : calls
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 25, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { failures.push(error.stack); response.destroy() }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
  await fixture.start()
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'ssh-owner' })
  assert.equal(created.status, 200); route = '/api/sessions/' + encodeURIComponent(created.body.sessionId)
  const node = 'external-ssh/ssh:fixture'
  let state = await turn('discovery', [call('discovery', 'run_script', { code: "return [call_tool('node', {'action':'list'}),call_tool('node', {'action':'inspect','providerId':'external-ssh'})]" })])
  const discovery = result(state, 'discovery')
  assert.equal(discovery.status, 'completed', JSON.stringify(discovery))
  assert.equal(discovery.result[0].nodes.find(row => row.id === node).availability, 'ready')
  assert.deepEqual(discovery.result[0].providers.find(row => row.id === 'external-ssh').lifecycle, [])
  assert.deepEqual(discovery.result[1].provider.lifecycle, [])
  assert(discovery.result[1].provider.dataRetention)
  state = await turn('unsupported', [call('create-unsupported', 'node', { action: 'create', providerId: 'external-ssh' }), call('inspect-unsupported', 'node', { action: 'inspect', nodeId: node }), call('destroy-unsupported', 'node', { action: 'destroy', nodeId: node, confirmation: 'destroy node ' + node })])
  assert(result(state, 'create-unsupported').error); assert(result(state, 'inspect-unsupported').error); assert(result(state, 'destroy-unsupported').error)
  assert.equal((await fixture.api('POST', route + '/node', { nodeId: node })).status, 200)
  const patch = '*** Begin Patch\n*** Update File: sample.txt\n@@\n-β\n+gamma\n*** Add File: added.txt\n+new\n*** End Patch'
  state = await turn('files', [call('files', 'run_script', { code: "call_tool('write', {'filePath':'sample.txt','content':'alpha\\nβ\\n'})\ncall_tool('edit', {'filePath':'sample.txt','oldText':'alpha','newText':'changed'})\ncall_tool('apply_patch', {'input':" + JSON.stringify(patch) + "})\nreturn call_tool('read', {'filePath':'sample.txt'})['content']" })])
  assert.equal(result(state, 'files').result, 'changed\ngamma\n')
  assert.equal(await readFile(join(cwd, 'sample.txt'), 'utf8'), 'changed\ngamma\n')
  assert.equal(await readFile(join(cwd, 'added.txt'), 'utf8'), 'new')
  const bytes = Buffer.alloc(12 * 1024 * 1024 + 7, 0xc3); bytes[0] = 0; bytes[bytes.length - 1] = 255
  const original = join(fixture.work, 'binary.bin'), roundTrip = join(fixture.work, 'roundtrip.bin')
  await writeFile(original, bytes)
  state = await turn('binary', [call('binary', 'run_script', { code: "a=call_tool('copy_between_nodes', {'sourceNode':'master','sourcePath':" + JSON.stringify(original) + ",'targetNode':'" + node + "','targetPath':'transfer.bin'})\nb=call_tool('copy_between_nodes', {'sourceNode':'" + node + "','sourcePath':'transfer.bin','targetNode':'master','targetPath':" + JSON.stringify(roundTrip) + "})\nreturn [a,b]" })])
  assert.equal(result(state, 'binary').status, 'completed', JSON.stringify(result(state, 'binary')))
  assert(result(state, 'binary').result.every(row => !row.error))
  assert.deepEqual(await readFile(roundTrip), bytes)
  assert.deepEqual(await readFile(join(cwd, 'transfer.bin')), bytes)
  state = await turn('cwd', [call('cwd', 'run_script', { code: "return call_tool('exec', {'command':\"cd ' sub '; printf '  héllo\\\\n'; exit 7\",'timeout':15})" })])
  assert.equal(result(state, 'cwd').result.exitCode, 7)
  assert.equal(result(state, 'cwd').result.content, '  héllo\n')
  const authority = async () => JSON.parse(await readFile(join(fixture.data, 'state/sessions', created.body.sessionId + '.json'), 'utf8'))
  assert.equal((await authority()).cwd, join(cwd, ' sub '))
  state = await turn('shell-eof', [call('shell-eof', 'run_script', { code: "return call_tool('exec', {'command':\"cat <<'END_OF_COMMAND'\\nexact trailing newline\\n\",'timeout':15})" })])
  assert(result(state, 'shell-eof').result.content.endsWith('exact trailing newline\n'))
  assert(!result(state, 'shell-eof').result.content.endsWith('exact trailing newline\n\n'))
  state = await turn('large-log', [call('large-log', 'run_script', { code: "return call_tool('exec', {'command':\"head -c 1100000 /dev/zero | tr '\\\\0' x\",'timeout':15})" })])
  const large = result(state, 'large-log').result
  assert.equal(large.truncated, true); assert.equal(large.sizeBytes, 1100000); assert.equal(large.content, undefined)
  assert(large.logPath.startsWith(stateDir)); assert.equal((await readFile(large.logPath)).length, 1100000)
  const effect = join(cwd, 'restart-effect')
  state = await turn('restart', [call('restart', 'run_script', { code: "return call_tool('exec', {'command':" + JSON.stringify('sleep 9; printf x >> ' + quote(effect) + '; printf recovered') + ",'timeout':1})" })])
  const started = result(state, 'restart').result
  assert.equal(started.status, 'running', JSON.stringify(started))
  const registryPath = join(fixture.data, 'state/running-exec.json')
  const tracking = async () => JSON.parse(await readFile(registryPath, 'utf8')).execs
  assert.equal((await tracking()).length, 1)
  const meta = (await tracking())[0]
  assert.equal(meta.backend.providerId, 'external-ssh'); assert.equal(meta.nodeId, node)
  assert(meta.backend.ref.startsWith('process:'))
  const directoryId = meta.backend.ref.slice('process:'.length)
  assert.equal(meta.logPath, join(stateDir, directoryId, 'output.log'))
  const directories = await readdir(stateDir)
  assert(directories.includes(directoryId))
  assert.equal((await fixture.api('POST', route + '/node', { nodeId: 'master' })).status, 200)
  await fixture.stop()
  assert.equal(await readFile(effect, 'utf8').catch(() => ''), '')
  await fixture.start()
  assert.equal((await tracking()).length, 1)
  const recoveredMeta = (await tracking())[0]
  assert.equal(recoveredMeta.backend.ref, meta.backend.ref)
  await until(async () => (await readFile(effect, 'utf8').catch(() => '')) === 'x' && (await tracking()).length === 0, 'same SSH reference completes after Main exit/restart', 20000)
  assert.equal(await readFile(meta.logPath, 'utf8'), 'recovered')
  assert.deepEqual(await readdir(stateDir), directories, 'recovery did not launch a second target execution')
  const history = (await fixture.api('GET', route + '/history')).body
  assert(JSON.stringify(history.messages).includes(started.execId))
  await until(() => requests.some(request => JSON.stringify(request.input).includes('background-process-finished') && JSON.stringify(request.input).includes(started.execId)), 'strict completion reaches the real model owner')
  const knownHosts = connection.sshArgs.find(arg => arg.startsWith('-oUserKnownHostsFile=')).slice('-oUserKnownHostsFile='.length)
  await writeFile(knownHosts, '')
  state = await turn('untrusted', [call('untrusted', 'run_script', { code: "return call_tool('node', {'action':'list'})" }), call('untrusted-exec', 'call_tool', { toolId: 'node:external-ssh/ssh:fixture/exec', args: { command: 'touch must-not-run', timeout: 1 } })])
  const untrusted = result(state, 'untrusted')
  assert.equal(untrusted.status, 'completed', JSON.stringify(untrusted))
  assert.equal(untrusted.result.nodes.find(row => row.id === node).availability, 'offline')
  assert(result(state, 'untrusted-exec').error)
  assert.deepEqual(await readdir(stateDir), directories)
  await assert.rejects(readFile(join(cwd, 'must-not-run')), { code: 'ENOENT' })
  await fixture.stop()
  assert.equal(new Set(fixture.hostPids).size, 2)
  console.log(JSON.stringify({ result: 'Packaged unchanged public Linux SSH adapter: discovery/unsupported lifecycle, canonical files, 12 MiB binary round trip, command/cwd/raw logs, target survival and exact-reference Main restart without replay, strict host-key refusal passed.', mainProcesses: fixture.hostPids.length, modelRequests: requests.length, targetExecutions: directories.length }))
} finally {
  await fixture.cleanup()
  if (model) { model.closeAllConnections(); await new Promise(done => model.close(done)) }
  if (connection) await connection.close()
  await rm(sshRoot, { recursive: true, force: true })
}
