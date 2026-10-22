// Ordinary unchanged Source and C# Main/model callers with actual CLI-owned persistent commands.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import WebSocket, { WebSocketServer } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const exists = path => access(path).then(() => true, () => false)
for (const runtime of ['source', 'dotnet']) {
  const env = {}, fixture = await createHostFixture('cli-exec-' + runtime, { runtime, normalStartup: true, env })
  Object.assign(env, isolatedApplicationEnv(fixture.data), { FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '' })
  const cwd = join(fixture.root, 'cli'), registry = join(cwd, 'agents/main/.temp/exec/running-exec.json')
  await mkdir(join(cwd, 'agents/main'), { recursive: true })
  const plans = new Map(), rounds = new Map(), failures = [], clients = [], wire = [], connections = new Set(), held = new Set()
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
  const tracked = () => readFile(registry, 'utf8').then(JSON.parse)
  const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
  const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CLI-EXEC-DONE-' + key }] }]
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes
      const body = JSON.parse(raw), prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const key = [...prompt.matchAll(/CLIEXEC:([\w-]+)/g)].at(-1)?.[1]
      const round = rounds.get(key) || 0; rounds.set(key, round + 1)
      const step = plans.get(key)?.[round], output = typeof step === 'function' ? await step(body) : step || final(key)
      for (const tool of output.filter(part => part.type === 'function_call')) assert(body.tools.some(def => def.type === 'function' && def.name === tool.name), 'advertised tool ' + tool.name)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: cli-exec-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, effort: { allowed: ['none'], default: 'none' }, models: ['wire'] } } }))
  const proxyHttp = createServer(), proxy = new WebSocketServer({ server: proxyHttp })
  proxyHttp.listen(0, '127.0.0.1'); await once(proxyHttp, 'listening')
  const host = `http://127.0.0.1:${proxyHttp.address().port}`
  let injectCollision = false
  proxy.on('connection', (down, request) => {
    const up = new WebSocket(fixture.origin.replace(/^http/, 'ws') + request.url), pending = []
    connections.add(up); connections.add(down)
    up.on('open', () => { for (const bytes of pending) up.send(bytes.toString()) })
    down.on('message', bytes => { const value = JSON.parse(bytes); wire.push({ direction: 'cli', value }); if (up.readyState === WebSocket.OPEN) up.send(bytes.toString()); else pending.push(bytes) })
    let sending = Promise.resolve()
    up.on('message', bytes => { sending = sending.then(async () => {
      const value = JSON.parse(bytes); wire.push({ direction: 'main', value })
      if (value.type === 'session_event_accepted') {
        const event = wire.find(row => row.value.type === 'session_event' && row.value.requestId === value.requestId)?.value
        if (held.has(event?.execId)) return
      }
      if (injectCollision && value.type === 'tool_call' && value.tool === 'exec' && value.agentName === 'collision') {
        injectCollision = false
        const path = join(cwd, 'agents/collision/.temp/exec'); await mkdir(path, { recursive: true })
        await writeFile(join(path, 'running-exec.json'), JSON.stringify({ execs: [], recentExecIds: [value.backgroundExecId] }))
      }
      if (down.readyState === WebSocket.OPEN) down.send(bytes.toString())
    }).catch(error => failures.push(error.stack)) })
    for (const [from, to] of [[up, down], [down, up]]) { from.on('error', () => {}); from.on('close', () => { connections.delete(from); if (to.readyState === WebSocket.OPEN) to.close() }) }
  })
  let credential
  async function launch(source = false) {
    const executable = !source && process.env.FOXWARM_CLI_EXECUTABLE
    const child = spawn(executable || (source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet')), [...(executable ? [] : [resolve(source ? 'packages/cli-node/dist/client.js' : 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', host, ...(credential ? ['--id', credential.nodeId, '--auth-token', credential.authToken] : ['--id', 'exec-cli', '--token', (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim()]), '--credentials-file', join(cwd, 'credentials.json'), '--no-local-trigger'], { cwd, env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents') }, stdio: ['ignore', 'pipe', 'pipe'] })
    const handle = { child, output: '' }; clients.push(handle)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output += bytes })
    if (!credential) {
      const pending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(item => item.requestedName === 'exec-cli'), 'ordinary pending CLI')
      assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })).status, 200)
    }
    await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'exec-cli' && node.online), runtime + ' Node online')
    credential = JSON.parse(await readFile(join(cwd, 'credentials.json'), 'utf8'))
    return handle
  }
  async function stop(handle) {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
    const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM')
    let timer
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { handle.child.kill('SIGKILL'); reject(new Error('CLI drain timeout')) }, 6000) })]) }
    finally { clearTimeout(timer) }
    await until(async () => !(await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'exec-cli')?.online, 'Node offline')
  }
  async function create(name, agentId = 'main') { const result = await fixture.api('POST', '/api/sessions', { agentId, sessionId: name }); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.sessionId }
  async function begin(id, key, steps) { plans.set(key, steps); rounds.set(key, 0); assert([200, 202].includes((await fixture.api('POST', route(id) + '/message', { text: 'CLIEXEC:' + key })).status)) }
  async function finish(id, key) { return until(async () => { if (failures.length) throw new Error(failures.join('\n')); const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session; return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'CLI-EXEC-DONE-' + key)) ? state : null }, runtime + ' exec turn ' + key, 45000) }
  async function turn(id, key, steps) { await begin(id, key, steps); return finish(id, key) }
  async function select(id) { await turn(id, 'select-' + id.replaceAll('/', '-'), [[call('select', 'node', { action: 'select', nodeId: 'exec-cli' })]]) }
  function good(state, name) { const value = pair(state, name); assert(value && !value.error, name + ': ' + JSON.stringify(value)); return value }
  const execCalls = id => wire.filter(row => row.direction === 'main' && row.value.type === 'tool_call' && row.value.tool === 'exec' && row.value.sessionId === id).map(row => row.value)
  const events = id => wire.filter(row => row.value.type === 'session_event' && row.value.execId === id).map(row => row.value)
  try {
    await fixture.start()
    let cli = await launch(true)
    const old = await create('source-pending'); await select(old)
    // The proxy holds only the ACK. Main genuinely admits the event and keeps its durable receipt.
    await begin(old, 'source-pending', [[call('source-pending', 'exec', { command: 'printf once >> source-pending-count; sleep 1.5', timeout: 1 })]])
    const first = await until(() => execCalls(old)[0], 'Main reserves first Source job'); held.add(first.backgroundExecId)
    await finish(old, 'source-pending'); await until(() => events(first.backgroundExecId).length, 'Source pending completion')
    const running = await create('source-running'); await select(running)
    const runningState = await turn(running, 'source-running', [[call('source-running', 'exec', { command: 'printf start >> source-running-count; sleep 5; printf done >> source-running-count', timeout: 1 })]])
    good(runningState, 'source-running'); const second = execCalls(running)[0]
    const originals = (await tracked()).execs; assert.equal(originals.length, 2)
    await stop(cli); held.delete(first.backgroundExecId); cli = await launch()
    await until(async () => (await tracked()).execs.length === 0, 'real Main ACKs Source-created recovered jobs', 22000)
    for (const request of [first, second]) {
      assert(events(request.backgroundExecId).some(event => event.eventId === 'remote-exec-completion:' + request.backgroundExecId && event.completionCapability === request.completionCapability))
      assert.equal(execCalls(request.sessionId).length, 1)
      const state = await saved(request.sessionId)
      assert.equal(state.meta.acceptedExternalEventIds.filter(id => id === 'remote-exec-completion:' + request.backgroundExecId).length, 1)
    }
    assert.equal(await readFile(join(cwd, 'source-pending-count'), 'utf8'), 'once'); assert.equal(await readFile(join(cwd, 'source-running-count'), 'utf8'), 'startdone')
    const actor = await create('new-cli'); await select(actor)
    const project = join(cwd, 'project'); await mkdir(project)
    assert.equal((await fixture.api('POST', route(actor) + '/cwd', { cwd: project })).status, 200)
    let state = await turn(actor, 'foreground', [[call('foreground', 'exec', { command: 'printf once >> foreground-count; cd ..; pwd' })]])
    assert.match(good(state, 'foreground').output, /Exit code: 0/); assert.equal(await readFile(join(project, 'foreground-count'), 'utf8'), 'once')
    assert.equal(state.cwd, project) // Existing Session protocol does not publish finished cwd as external-owner metadata.
    state = await turn(actor, 'programmatic', [[call('programmatic', 'run_script', { code: "return call_tool('exec', {'command':'printf raw-capture'})" })]])
    assert.equal(good(state, 'programmatic').result.content, 'raw-capture'); assert.equal(good(state, 'programmatic').result.status, 'completed')
    const local = await create('temporary-target'); await fixture.api('POST', route(local) + '/cwd', { cwd: fixture.work })
    state = await turn(local, 'temporary-target', [[call('temporary', 'call_tool', { toolId: 'node:exec-cli/exec', args: { command: 'printf once >> temporary-count' } })]])
    good(state, 'temporary'); assert.equal(state.currentNode, 'master'); assert.equal(await readFile(join(cwd, 'temporary-count'), 'utf8'), 'once'); assert.equal(execCalls(local)[0].sessionCwd, undefined)
    const stopped = await create('stopped'); await select(stopped)
    await begin(stopped, 'stopped', [[call('stopped', 'exec', { command: 'printf start > stopped-count; sleep 3; printf done >> stopped-count', timeout: 30 })]])
    await until(() => exists(join(cwd, 'stopped-count')), 'new CLI starts before real Stop')
    assert.equal((await fixture.api('POST', route(stopped) + (runtime === 'source' ? '/message' : '/stop'), runtime === 'source' ? { text: '/stop' } : {})).status, 200)
    await until(async () => pair(await saved(stopped), 'stopped'), 'Stop saves actual background tool result')
    state = await saved(stopped); assert.match(good(state, 'stopped').output, /not killed/)
    const stoppedRequest = execCalls(stopped)[0]
    assert(wire.some(row => row.value.type === 'tool_call_cancel' && row.value.callId === stoppedRequest.callId))
    await until(async () => (await saved(stopped)).meta.acceptedExternalEventIds?.includes('remote-exec-completion:' + stoppedRequest.backgroundExecId), 'Stop completion admitted')
    assert.equal(await readFile(join(cwd, 'stopped-count'), 'utf8'), 'startdone')
    // Fresh Agent collision reaches Main's actual exact-ID retry path before any command effect.
    assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'collision' })).status, 201)
    const collision = await create('collision', 'collision'); await select(collision); injectCollision = true
    state = await turn(collision, 'collision', [[call('collision', 'exec', { command: 'printf once >> collision-count' })]])
    good(state, 'collision'); assert.equal(execCalls(collision).length, 2)
    assert.notEqual(execCalls(collision)[0].backgroundExecId, execCalls(collision)[1].backgroundExecId)
    assert(wire.some(row => row.value.type === 'tool_call_error' && row.value.execStarted === false && row.value.error.code === 'PERSISTENT_EXEC_ID_COLLISION'))
    assert.equal(await readFile(join(cwd, 'collision-count'), 'utf8'), 'once')
    // Real wait uses Main's reserved identity; only accepted completion wakes it.
    const waited = await create('waited'); await select(waited)
    state = await turn(waited, 'waited', [[call('waited-exec', 'exec', { command: 'printf once > waited-count; sleep 2', timeout: 1 })], async () => {
      const request = execCalls(waited)[0]
      return [call('waited-wait', 'wait', { waitExecIds: [request.backgroundExecId], wakeIfNoActivityAfterSeconds: null })]
    }])
    assert.equal(state.meta.wait, undefined); assert.equal(execCalls(waited).length, 1)
    assert.equal(state.meta.acceptedExternalEventIds.filter(id => id === 'remote-exec-completion:' + execCalls(waited)[0].backgroundExecId).length, 1)
    // Restart both peers only after durable acceptance, with CLI tracking deliberately unACKed.
    const replay = await create('replay'); await select(replay)
    await begin(replay, 'replay', [[call('replay', 'exec', { command: 'printf once > replay-count; sleep 1.5', timeout: 1 })]])
    const replayCall = await until(() => execCalls(replay)[0], 'Main replay reservation'); held.add(replayCall.backgroundExecId)
    await finish(replay, 'replay'); await until(() => events(replayCall.backgroundExecId).length, 'durable event before restart')
    await stop(cli); await fixture.stop(); held.delete(replayCall.backgroundExecId)
    await fixture.start(); cli = await launch()
    await until(async () => !(await tracked()).execs.some(entry => entry.id === replayCall.backgroundExecId), 'retained durable receipt ACK after Main/CLI restart')
    assert.equal(await readFile(join(cwd, 'replay-count'), 'utf8'), 'once')
    assert.equal((await saved(replay)).meta.acceptedExternalEventIds.filter(id => id === 'remote-exec-completion:' + replayCall.backgroundExecId).length, 1)
    console.log(JSON.stringify({ runtime, actualSourceJobsRecoveredByNewCli: originals.length, exactMainReservationsAndAck: true, stopWaitAndCwd: true, nativeToolScript: true, hostStarts: fixture.hostPids.length, cliStarts: clients.length, modelRequests: [...rounds.values()].reduce((a, b) => a + b, 0) }))
  } catch (error) { console.error(runtime, fixture.output, clients.map(client => client.output).join('\n')); throw error }
  finally {
    for (const client of clients) { if (client.child.exitCode === null && client.child.signalCode === null) { const exited = once(client.child, 'exit'); client.child.kill('SIGTERM'); await exited } }
    for (const socket of connections) socket.terminate()
    await new Promise(done => proxy.close(done)); await new Promise(done => proxyHttp.close(done))
    model.closeAllConnections(); await new Promise(done => model.close(done)); await fixture.cleanup()
  }
}
