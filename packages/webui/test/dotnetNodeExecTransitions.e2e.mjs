// Actual Main and supported CLI processes across exec ownership transitions.
// FOXWARM_TS_ROOT selects the unchanged TypeScript comparison checkout.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import WebSocket, { WebSocketServer } from 'ws'
import { createHostFixture, until } from './mainHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const exists = path => access(path).then(() => true, () => false)
const coreRoot = resolve('.')
const sourceRoot = resolve(process.env.FOXWARM_TS_ROOT || '.')
for (const runtime of ['source', 'dotnet']) for (const clientRuntime of ['source', 'dotnet']) {
  process.chdir(runtime === 'source' ? sourceRoot : coreRoot)
  const env = {}, fixture = await createHostFixture('cli-exec-' + runtime, { runtime, env })
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
      if (down.readyState === WebSocket.OPEN) down.send(bytes.toString())
    }).catch(error => failures.push(error.stack)) })
    for (const [from, to] of [[up, down], [down, up]]) { from.on('error', () => {}); from.on('close', () => { connections.delete(from); if (to.readyState === WebSocket.OPEN) to.close() }) }
  })
  let credential
  async function launch() {
    const source = clientRuntime === 'source'
    const executable = !source && process.env.FOXWARM_CLI_EXECUTABLE
    const child = spawn(executable || (source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet')), [...(executable ? [] : [source ? join(sourceRoot, 'packages/cli-node/dist/client.js') : join(coreRoot, 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', host, ...(credential ? ['--id', credential.nodeId, '--auth-token', credential.authToken] : ['--id', 'exec-cli', '--token', (await readFile(join(fixture.data, 'state/node_token'), 'utf8')).trim()]), '--credentials-file', join(cwd, 'credentials.json'), '--no-local-trigger'], { cwd, env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents') }, stdio: ['ignore', 'pipe', 'pipe'] })
    const handle = { child, output: '' }; clients.push(handle)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output += bytes })
    if (!credential) {
      const pending = await until(async () => (await fixture.api('GET', '/api/nodes/onboarding/pending')).body.items.find(item => item.requestedName === 'exec-cli'), 'ordinary pending CLI')
      assert.equal((await fixture.api('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })).status, 200)
    }
    // Main publishes online before the client finishes saving its credentials.
    await until(async () => (source ? handle.output.includes('Node registered') : handle.output.includes('[registered]')) && (await fixture.api('GET', '/api/nodes')).body.nodes.find(node => node.id === 'exec-cli' && node.online), runtime + ' CLI registered and Node online')
    credential = JSON.parse(await readFile(join(cwd, 'credentials.json'), 'utf8'))
    return handle
  }
  async function create(name, agentId = 'main') { const result = await fixture.api('POST', '/api/sessions', { agentId, sessionId: name }); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.sessionId }
  async function begin(id, key, steps) { plans.set(key, steps); rounds.set(key, 0); assert([200, 202].includes((await fixture.api('POST', route(id) + '/message', { text: 'CLIEXEC:' + key })).status)) }
  async function finish(id, key) { return until(async () => { if (failures.length) throw new Error(failures.join('\n')); const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session; return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'CLI-EXEC-DONE-' + key)) ? state : null }, runtime + ' exec turn ' + key, key === 'lost-foreground' ? 75000 : 45000) }
  async function turn(id, key, steps) { await begin(id, key, steps); return finish(id, key) }
  async function select(id) { await turn(id, 'select-' + id.replaceAll('/', '-'), [[call('select', 'node', { action: 'select', nodeId: 'exec-cli' })]]) }
  function good(state, name) { const value = pair(state, name); assert(value && !value.error, name + ': ' + JSON.stringify(value)); return value }
  const execCalls = id => wire.filter(row => row.direction === 'main' && row.value.type === 'tool_call' && row.value.tool === 'exec' && row.value.sessionId === id).map(row => row.value)
  const events = id => wire.filter(row => row.value.type === 'session_event' && row.value.execId === id).map(row => row.value)
  async function restartCli(handle) {
    const exited = once(handle.child, 'exit'); handle.child.kill('SIGKILL'); await exited
    return launch()
  }
  const acks = request => wire.filter(row => row.direction === 'main' && row.value.type === 'session_event_accepted' && row.value.requestId === request.requestId)
  const receipt = (state, id) => (state.meta.acceptedExternalEventIds || []).filter(item => item === 'remote-exec-completion:' + id).length
  const background = async (id, key) => {
    const state = await turn(id, key, [[call(key, 'exec', { command: `printf start >> ${key}-count; while [ ! -e ${key}-go ]; do sleep .03; done; printf done >> ${key}-count`, timeout: 1 })]])
    good(state, key); return execCalls(id)[0]
  }
  try {
    await fixture.start()
    let cli = await launch()
    const actor = await create('actor')
    // A live command retains its source grant across a real cross-Agent move and client recovery.
    const moved = await create('moving-live'); await select(moved)
    const first = await background(moved, 'moving-live')
    let state = await turn(actor, 'move-live', [[call('move-live', 'call_tool', { toolId: 'builtin:move_session', args: { sessionId: moved, newSessionId: 'moved-live', createAgent: true, newAgentName: 'destination' } })]])
    good(state, 'move-live')
    const target = 'destination/moved-live'
    assert((await saved(target)).aliases.includes(moved))
    cli = await restartCli(cli)
    await writeFile(join(cwd, 'moving-live-go'), '')
    await until(async () => receipt(await saved(target), first.backgroundExecId) === 1 && !(await tracked()).execs.some(entry => entry.id === first.backgroundExecId), 'moved owner durable ACK through successor connection', 30000)
    const finalEvent = events(first.backgroundExecId).at(-1)
    assert.equal(finalEvent.sessionId, moved); assert.equal(finalEvent.completionCapability, first.completionCapability); assert.equal(acks(finalEvent).length, 1)
    assert.equal(await readFile(join(cwd, 'moving-live-count'), 'utf8'), 'startdone'); assert.equal(execCalls(moved).length, 1)
    assert.equal((await fixture.api('GET', route(moved) + '/history')).body.session.id, target)
    // Accepted completion loses its ACK, then its owner moves before the client retries on recovery.
    const duplicate = await create('moving-receipt'); await select(duplicate)
    const second = await background(duplicate, 'moving-receipt'); held.add(second.backgroundExecId)
    await writeFile(join(cwd, 'moving-receipt-go'), '')
    await until(async () => events(second.backgroundExecId).length > 0 && receipt(await saved(duplicate), second.backgroundExecId) === 1, 'completion committed before ACK is released', 30000)
    await until(async () => !(await fixture.api('GET', route(duplicate) + '/history')).body.session.busy, 'completion turn releases owner')
    state = await turn(actor, 'move-receipt', [[call('move-receipt', 'call_tool', { toolId: 'builtin:move_session', args: { sessionId: duplicate, newSessionId: 'moved-receipt', newAgentName: 'destination' } })]])
    good(state, 'move-receipt')
    held.delete(second.backgroundExecId); cli = await restartCli(cli)
    await until(async () => events(second.backgroundExecId).length >= 2 && !(await tracked()).execs.some(entry => entry.id === second.backgroundExecId), 'durable duplicate retried after move and recovery', 30000)
    assert.equal(receipt(await saved('destination/moved-receipt'), second.backgroundExecId), 1)
    assert.equal(await readFile(join(cwd, 'moving-receipt-count'), 'utf8'), 'startdone'); assert.equal(execCalls(duplicate).length, 1)
    assert.equal(events(second.backgroundExecId).at(-1).completionCapability, second.completionCapability)
    assert.equal(acks(events(second.backgroundExecId).at(-1)).length, 1)
    assert.equal(rounds.get('moving-receipt'), 3, 'one initial continuation and one completion continuation, not a second completion wake')
    // Disconnect during foreground observation, before background registration: restore the persisted
    // original record, not the command. Main receives an unknown result, never a replay instruction.
    const foreground = await create('lost-foreground'); await select(foreground)
    await begin(foreground, 'lost-foreground', [[call('lost-foreground', 'exec', { command: 'printf start >> lost-foreground-count; while [ ! -e lost-foreground-go ]; do sleep .03; done; printf done >> lost-foreground-count', timeout: 30 })]])
    const third = await until(() => execCalls(foreground)[0], 'original foreground dispatch')
    await until(async () => (await exists(join(cwd, 'lost-foreground-count'))) && (await tracked()).execs.some(entry => entry.id === third.backgroundExecId && !entry.notifyOnCompletion), 'real persisted foreground record')
    cli = await restartCli(cli)
    await finish(foreground, 'lost-foreground')
    assert(pair(await saved(foreground), 'lost-foreground').error, 'lost reply must not become a successful foreground result')
    await writeFile(join(cwd, 'lost-foreground-go'), '')
    await until(async () => receipt(await saved(foreground), third.backgroundExecId) === 1 && !(await tracked()).execs.some(entry => entry.id === third.backgroundExecId), 'unknown foreground completion accepted with original grant', 30000)
    assert.equal(execCalls(foreground).length, 1); assert.equal(await readFile(join(cwd, 'lost-foreground-count'), 'utf8'), 'startdone')
    assert.equal(events(third.backgroundExecId).at(-1).completionCapability, third.completionCapability)
    console.log(JSON.stringify({ runtime, clientRuntime, liveCrossAgentMove: true, acceptedReceiptMoveAckRetry: true, foregroundGenerationRecovery: true, effectCounts: [1, 1, 1], mainStarts: fixture.hostPids.length, cliStarts: clients.length }))
  } catch (error) { console.error(runtime, clientRuntime, fixture.output, clients.map(client => client.output).join('\n')); throw error }
  finally {
    // Detached test commands must also finish when an assertion fails.
    await Promise.all(['moving-live', 'moving-receipt', 'lost-foreground'].map(key => writeFile(join(cwd, key + '-go'), '').catch(() => {})))
    for (const client of clients) { if (client.child.exitCode === null && client.child.signalCode === null) { const exited = once(client.child, 'exit'); client.child.kill('SIGTERM'); await exited } }
    for (const socket of connections) socket.terminate()
    await new Promise(done => proxy.close(done)); await new Promise(done => proxyHttp.close(done))
    model.closeAllConnections(); await new Promise(done => model.close(done)); await fixture.cleanup()
  }
}
