// Disposable ordinary Main, model, tools, control, and independent target-process lifetime.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const env = {}, options = { env, normalStartup: true }
const fixture = await createHostFixture('provider-exec', options)
options.cwd = fixture.root
const target = join(fixture.root, 'target')
await mkdir(target)
env.FOXWARM_BIND_ADDRESS = '127.0.0.1'
env.FOXWARM_PUBLIC_BASE_URL = fixture.origin
env.FOXWARM_CONFIG_PATH = join(fixture.data, 'state/config.yaml')
const provider = { type: 'executable', command: 'python3', args: [resolve('dotnet/Foxwarm.Tests/Tools/Fixtures/node-provider.py'), target], timeoutSeconds: 3 }
const configure = async enabled => writeFile(env.FOXWARM_CONFIG_PATH, JSON.stringify({ bot: { httpPort: fixture.port }, vector: false, llm: { maxOutput: 713 }, nodeProviders: enabled ? { external: provider } : {} }))
await configure(true)
let phase = 'stop', restartId
const failures = [], requests = []
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const callId = phase + '-command'
    const result = body.input.find(row => row.type === 'function_call_output' && row.call_id === callId)
    let output
    if (!result) {
      const command = phase === 'stop' ? 'sleep 2; printf x >> stop-effect' : 'sleep 10; printf x >> restart-effect'
      output = [{ type: 'function_call', call_id: callId, name: 'exec', arguments: JSON.stringify({ command, timeout: phase === 'stop' ? 15 : 1 }) }]
    } else if (phase === 'restart') {
      const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
      restartId = /execId: ([a-z]+-[a-z]+)/.exec(text)?.[1]
      assert(restartId, text)
      const event = body.input.some(row => JSON.stringify(row).includes('background-process-finished') && JSON.stringify(row).includes(restartId))
      output = event
        ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESTART-COMPLETED' }] }]
        : [{ type: 'function_call', call_id: 'await-command', name: 'wait', arguments: JSON.stringify({ waitExecIds: [restartId] }) }]
    } else output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'STOP-COMPLETED' }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 25, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
const calls = async () => (await readFile(join(target, 'calls.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
const starts = async () => (await calls()).filter(row => row.operation === 'exec-start')
const tracking = async () => {
  const base = join(fixture.data, 'state/exec')
  return (await readdir(base, { recursive: true }).catch(() => [])).filter(path => path.endsWith('tracking.json'))
}
try {
  await fixture.start()
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'provider-exec' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const route = '/api/sessions/' + encodeURIComponent(created.body.sessionId)
  assert.equal((await fixture.api('POST', route + '/node', { nodeId: 'external/target' })).status, 200)
  assert.equal((await fixture.api('POST', route + '/message', { text: 'Run stop-job.' })).status, 202)
  await until(async () => (await starts()).length === 1, 'target command submitted')
  assert.equal((await fixture.api('POST', route + '/stop')).status, 200)
  await until(async () => !(await fixture.api('GET', route + '/history')).body.session.busy, 'foreground Stop settlement')
  await until(async () => (await readFile(join(target, 'fs/root/stop-effect'), 'utf8').catch(() => '')) === 'x', 'command survives foreground Stop')
  await until(async () => JSON.stringify((await fixture.api('GET', route + '/history')).body.messages).includes('STOP-COMPLETED'), 'strict completion resumes real model owner')
  assert.equal((await starts()).length, 1)
  phase = 'restart'
  assert.equal((await fixture.api('POST', route + '/message', { text: 'Run restart-job.' })).status, 202)
  await until(async () => {
    const history = (await fixture.api('GET', route + '/history')).body
    return restartId && !history.session.busy && (await tracking()).length === 1
  }, 'background command and persisted wait')
  // The Session now selects Main, but the admitted job retains its exact original provider and Node.
  assert.equal((await fixture.api('POST', route + '/node', { nodeId: 'master' })).status, 200)
  const metaPath = join(fixture.data, 'state/exec', (await tracking())[0].replace('tracking.json', 'meta.json'))
  const meta = JSON.parse(await readFile(metaPath, 'utf8'))
  assert.equal(meta.ProviderId, 'external'); assert.equal(meta.NodeId, 'external/target')
  assert.equal(meta.Cwd, 'opaque://root'); assert.equal(typeof meta.Reference, 'string')
  assert.equal(meta.LogPath, 'opaque://logs/' + meta.Reference + '.log')
  assert.equal(meta.Pid, 0) // Target PID is never Main process authority.
  const sourceRegistry = join(fixture.data, 'state/running-exec.json')
  const unrelated = JSON.stringify({ execs: [], recentExecIds: ['retained-source-record'] })
  await writeFile(sourceRegistry, unrelated)
  await fixture.stop()
  assert.equal(await readFile(join(target, 'fs/root/restart-effect'), 'utf8').catch(() => ''), '')
  await configure(false)
  await fixture.start()
  await sleep(600)
  assert.equal((await tracking()).length, 1, 'missing configuration must not discard a running reference')
  assert.equal((await starts()).length, 2)
  await fixture.stop()
  await configure(true)
  await writeFile(join(target, 'list-unavailable'), '')
  const before = (await calls()).length
  await fixture.start()
  await until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const history = (await fixture.api('GET', route + '/history')).body
    return !history.session.busy && JSON.stringify(history.messages).includes('RESTART-COMPLETED')
  }, 'exact backend restart poll, completion, persisted wait, and model continuation')
  assert.equal(await readFile(join(target, 'fs/root/restart-effect'), 'utf8'), 'x')
  assert.equal((await starts()).length, 2, 'recovery never starts again')
  assert.equal((await tracking()).length, 0)
  const recovered = (await calls()).slice(before)
  assert(recovered.some(call => call.operation === 'exec-poll' && call.request.ref === meta.Reference))
  assert(!recovered.some(call => call.operation === 'list'), 'admitted job observations do not rediscover directories')
  assert.equal(await readFile(sourceRegistry, 'utf8'), unrelated)
  assert(!(await readdir(join(fixture.data, 'state/exec'), { recursive: true })).some(path => path.endsWith('output.log')))
  await fixture.stop()
  assert.equal(new Set(fixture.hostPids).size, 3)
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ result: 'Provider exec Stop, target lifetime, strict wait/completion, missing configuration, exact-backend restart without replay, raw tracking, and model continuation passed.', mainProcesses: fixture.hostPids.length, modelRequests: requests.length, starts: (await starts()).length }))
} finally {
  await fixture.cleanup(); model.closeAllConnections(); await new Promise(done => model.close(done))
}
