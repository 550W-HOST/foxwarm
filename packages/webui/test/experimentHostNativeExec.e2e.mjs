// Owned native Main commands survive Stop and actual process restart, using original log paths.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const env = {}, options = { env, normalStartup: true }
const fixture = await createHostFixture('native-exec', options)
options.cwd = fixture.root
Object.assign(env, { FOXWARM_BIND_ADDRESS: '127.0.0.1', FOXWARM_PUBLIC_BASE_URL: fixture.origin, FOXWARM_CONFIG_PATH: join(fixture.data, 'state/config.yaml'), FOXWARM_NATIVE_OWNED_VALUE: 'inherited ordinary value' })
await writeFile(env.FOXWARM_CONFIG_PATH, JSON.stringify({ bot: { httpPort: fixture.port }, vector: false, llm: { maxOutput: 713 } }))
for (const root of [join(fixture.data, 'state/logs'), join(fixture.work, '.temp/exec')])
  for (let day = 17; day <= 20; day++) {
    const date = join(root, '2026-10-' + day); await mkdir(date, { recursive: true }); await writeFile(join(date, 'retained.log'), 'owned historical output')
  }
let phase = 'parallel', restartId, restartLog
const failures = [], requests = []
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const result = body.input.find(row => row.type === 'function_call_output' && row.call_id === phase + '-command')
    let output
    if (!result) {
      output = phase === 'parallel'
        ? [call('parallel-command', 'exec', { command: 'sleep .2; printf "$FOXWARM_NATIVE_OWNED_VALUE"; printf x > parallel-one' }), call('parallel-two', 'exec', { command: 'printf x > parallel-two' })]
        : [call(phase + '-command', 'exec', { command: phase === 'stop' ? 'sleep 2; printf x >> stop-effect' : 'sleep 8; printf x >> restart-effect; printf "  native finished\\n"', timeout: phase === 'stop' ? 15 : 1 })]
    } else if (phase === 'restart') {
      const text = typeof result.output === 'string' ? result.output : result.output.map(part => part.text).join('\n')
      restartId = /execId: ([a-z]+-[a-z]+)/.exec(text)?.[1]
      restartLog = /Log file: ([^\n]+)/.exec(text)?.[1]
      assert(restartId && restartLog, text)
      const event = body.input.some(row => JSON.stringify(row).includes('background-process-finished') && JSON.stringify(row).includes(restartId))
      output = !event ? [call('await-native', 'wait', { waitExecIds: [restartId] })]
        : body.input.some(row => row.type === 'function_call_output' && row.call_id === 'original-log')
          ? [message('NATIVE-RESTART-COMPLETED')]
          : [call('original-log', 'read', { filePath: restartLog })]
    } else output = [message('NATIVE-' + phase.toUpperCase() + '-COMPLETED')]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 25, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
const registry = async () => JSON.parse(await readFile(join(fixture.data, 'state/running-exec.json'), 'utf8').catch(() => '{"execs":[]}'))
let route
const history = async () => (await fixture.api('GET', route + '/history')).body
const finished = async marker => !(await history()).session.busy && JSON.stringify((await history()).messages).includes(marker)
try {
  await fixture.start()
  for (const root of [join(fixture.data, 'state/logs'), join(fixture.work, '.temp/exec')])
    await until(async () => (await readFile(join(root, 'archives/2026-10-17.tar.gz')).catch(() => Buffer.alloc(0))).length > 0, 'normal startup archive pass')
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'native-exec' })
  assert.equal(created.status, 200); route = '/api/sessions/' + encodeURIComponent(created.body.sessionId)
  await fixture.api('POST', route + '/message', { text: 'Run parallel commands.' })
  await until(() => finished('NATIVE-PARALLEL-COMPLETED'), 'ordinary adjacent native commands')
  assert.equal(await readFile(join(fixture.work, 'parallel-one'), 'utf8'), 'x'); assert.equal(await readFile(join(fixture.work, 'parallel-two'), 'utf8'), 'x')
  assert(JSON.stringify((await history()).messages).includes('inherited ordinary value'))
  phase = 'stop'
  await fixture.api('POST', route + '/message', { text: 'Run Stop command.' })
  await until(async () => (await registry()).execs.some(entry => entry.command.includes('stop-effect')), 'native launch committed')
  assert.equal((await fixture.api('POST', route + '/stop')).status, 200)
  await until(async () => !(await history()).session.busy, 'native foreground Stop settles')
  await until(async () => (await readFile(join(fixture.work, 'stop-effect'), 'utf8').catch(() => '')) === 'x', 'native command survives Stop')
  await until(async () => (await registry()).execs.length === 0, 'strict native completion removes only tracking')
  phase = 'restart'
  await fixture.api('POST', route + '/message', { text: 'Run native restart command.' })
  await until(async () => restartId && !(await history()).session.busy && (await registry()).execs.length === 1, 'native background and persisted wait')
  const before = (await registry()).execs[0]
  assert.equal(before.id, restartId); assert.equal(before.logPath, restartLog); assert.equal(before.nodeId, 'master')
  assert(before.logPath.startsWith(join(fixture.work, '.temp/exec/')))
  await fixture.stop()
  assert.equal(await readFile(join(fixture.work, 'restart-effect'), 'utf8').catch(() => ''), '')
  process.kill(before.pid, 0) // The shell, not its exited Main, owns its lifetime and descriptors.
  await fixture.start()
  await until(() => finished('NATIVE-RESTART-COMPLETED'), 'native restart completion and actual original-path read')
  assert.equal(await readFile(join(fixture.work, 'restart-effect'), 'utf8'), 'x')
  assert.equal(await readFile(restartLog, 'utf8'), '  native finished\n')
  assert.equal(JSON.parse(await readFile(before.statusPath, 'utf8')).exitCode, 0)
  assert.equal((await registry()).execs.length, 0)
  assert((await registry()).recentExecIds.includes(restartId))
  assert(!(await readdir(join(fixture.data, 'state'))).includes('exec'))
  const resumed = (await history()).messages.flatMap(row => row.parts || [])
  assert.equal(resumed.filter(part => part.system?.includes('background-process-finished') && part.system.includes(restartId)).length, 1)
  assert(resumed.some(part => part.functionResponse?.tool_use_id === 'original-log' && part.functionResponse.response.output.includes('native finished')))
  await fixture.stop(); assert.deepEqual(failures, []); assert.equal(new Set(fixture.hostPids).size, 2)
  console.log(JSON.stringify({ result: 'Native adjacent commands, inherited environment, Stop, detached lifetime, actual Main restart, exact completion, original-path read and startup log rotation passed.', mainProcesses: fixture.hostPids.length, modelRequests: requests.length }))
} finally {
  await fixture.cleanup(); model.closeAllConnections(); await new Promise(done => model.close(done))
}
