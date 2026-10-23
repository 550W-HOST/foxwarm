// Owned .NET host, unchanged fixed official CLI, and wire fault injection at the transport boundary.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('remote-exec', { env: {} })
const plans = new Map(), rounds = new Map(), failures = [], wire = [], clients = [], connections = new Set()
const exists = file => access(file).then(() => true, () => false)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const route = id => '/api/sessions/' + encodeURIComponent(id)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
const done = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'EXEC-DONE-' + key }] }]
const callsFor = id => wire.filter(entry => entry.direction === 'request' && entry.value.type === 'tool_call' && entry.value.sessionId === id)
const eventsFor = id => wire.filter(entry => entry.direction === 'reply' && entry.value.type === 'session_event' && entry.value.sessionId === id)
const execId = result => result.execId || /execId: ([\w-]+)/.exec(result.output)?.[1]
const count = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).length
const peer = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/EXEC:([\w-]+)/g)].at(-1)?.[1] || 'background'
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const step = plans.get(key)?.[round]
    const output = step ? typeof step === 'function' ? await step(body) : step : done(key)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 35, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }))

// The proxy forwards the official protocol unchanged except for the explicit owned ACK/fault cases.
const proxyServer = createServer(), proxy = new WebSocketServer({ server: proxyServer })
proxyServer.listen(0, '127.0.0.1'); await once(proxyServer, 'listening')
const nodeHost = `http://127.0.0.1:${proxyServer.address().port}`
const dropped = new Set(), dropAck = new Set(), heldAck = new Set()
let collisionAgent
proxy.on('connection', (downstream, request) => {
  const upstream = new WebSocket(fixture.origin.replace(/^http/, 'ws') + request.url)
  const node = new URL(request.url, nodeHost).searchParams.get('id')
  const pending = []
  connections.add(downstream); connections.add(upstream)
  upstream.on('open', () => { for (const bytes of pending) upstream.send(bytes.toString()) })
  downstream.on('message', bytes => {
    const value = JSON.parse(bytes); wire.push({ node, direction: 'reply', value })
    if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes.toString())
    else pending.push(bytes)
  })
  let sends = Promise.resolve()
  upstream.on('message', bytes => { sends = sends.then(async () => {
    const value = JSON.parse(bytes); wire.push({ node, direction: 'request', value })
    if (value.type === 'session_event_accepted') {
      const event = wire.find(entry => entry.value.type === 'session_event' && entry.value.requestId === value.requestId)?.value
      if (heldAck.has(event?.sessionId)) return
      if (dropAck.has(event?.sessionId) && !dropped.has(event.sessionId)) { dropped.add(event.sessionId); return }
    }
    if (value.type === 'tool_call' && value.agentName === collisionAgent && value.tool === 'exec') {
      collisionAgent = undefined
      const directory = join(remote, 'agents', value.agentName, '.temp/exec')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'running-exec.json'), JSON.stringify({ execs: [], recentExecIds: [value.backgroundExecId] }))
    }
    if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes.toString())
  }).catch(error => failures.push(error.stack)) })
  for (const [source, target] of [[downstream, upstream], [upstream, downstream]]) {
    source.on('close', () => { connections.delete(source); if (target.readyState === WebSocket.OPEN) target.close() })
    source.on('error', () => {})
  }
})
const remote = join(fixture.root, 'official-cli')
await mkdir(join(remote, 'agents/main'), { recursive: true })
let credentials, client
const nodes = async () => (await fixture.api('GET', '/api/nodes')).body.nodes
const online = id => until(async () => (await nodes()).find(node => node.id === id && node.online && node.executable), 'official Node online ' + id, 30000)
function startClient(credential, approval = false, trigger = false) {
  const args = approval ? [resolve('packages/webui/test/fixtures/officialNodeApproval.mjs')] : [resolve('packages/cli-node/dist/client.js'), '--host', nodeHost, '--id', credential.nodeId, '--auth-token', credential.authToken, '--credentials-file', join(remote, 'credentials.json'), ...(trigger ? ['--local-trigger-port', '0'] : ['--no-local-trigger'])]
  const child = spawn(process.execPath, args, { cwd: remote, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_AGENTS_DIR: join(remote, 'agents'), FOXWARM_NO_CONSOLE_LOG: '0', FOXWARM_OWNED_CLIENT_OPTIONS: JSON.stringify({ host: nodeHost, nodeId: credential.nodeId, authToken: credential.authToken, credentialsFile: join(remote, 'credentials.json') }) } })
  const handle = { child, output: '' }; clients.push(handle)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output += bytes })
  return handle
}
async function stopClient(handle) { if (handle.child.exitCode === null && handle.child.signalCode === null) { const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM'); await exited } }
async function create(name, agent = 'main') {
  const result = await fixture.api('POST', '/api/sessions', { agentId: agent, sessionId: name }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.sessionId
}
async function begin(id, key, steps) {
  plans.set(key, steps); rounds.set(key, 0)
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'EXEC:' + key })).status, 202)
}
async function finish(id, key, timeout = 30000) {
  return until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const state = await saved(id), view = (await fixture.api('GET', route(id) + '/history')).body.session
    return !view.busy && state.history.some(row => row.parts?.some(part => part.text === 'EXEC-DONE-' + key)) ? state : null
  }, 'official exec turn ' + key, timeout)
}
async function turn(id, key, calls) { await begin(id, key, [calls]); return finish(id, key) }
async function select(id, node = 'official-cli') { const result = await turn(id, 'select-' + id.replaceAll('/', '-'), [call('select-' + id, 'node', { action: 'select', nodeId: node })]); assert.equal(result.currentNode, node) }
async function waitBackground(id, key, command, extra = []) {
  await begin(id, key, [[call('exec-' + key, 'exec', { command, timeout: 1 })], async () => {
    const state = await saved(id), result = pair(state, 'exec-' + key), exact = execId(result)
    assert(exact, JSON.stringify(result))
    assert(callsFor(id).some(entry => entry.value.backgroundExecId === exact))
    return [...extra, call('wait-' + key, 'wait', { waitExecIds: [exact], wakeIfNoActivityAfterSeconds: null })]
  }])
  await until(async () => (await saved(id)).meta?.wait?.waitExecIds?.length === 1, 'active remote wait ' + key)
  return callsFor(id).filter(entry => entry.value.tool === 'exec').at(-1).value
}
function assertPairs(state) {
  const calls = state.history.flatMap(row => row.parts || []).filter(part => part.functionCall).map(part => part.functionCall.id)
  const replies = state.history.flatMap(row => row.parts || []).filter(part => part.functionResponse).map(part => part.functionResponse.tool_use_id)
  for (const id of calls) assert.equal(replies.filter(reply => reply === id).length, 1, 'one canonical response for ' + id)
}

try {
  await fixture.start()
  credentials = (await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: 'official-cli' })).body
  client = startClient(credentials); await online('official-cli')
  const actor = await create('foreground'); await select(actor)
  let state = await turn(actor, 'foreground', [call('foreground', 'exec', { command: 'printf foreground >> foreground-count; pwd' })])
  assert.match(pair(state, 'foreground').output, /foreground|Exit/); assert.equal(await readFile(join(remote, 'foreground-count'), 'utf8'), 'foreground')
  assert.equal(state.cwd, undefined); assert(!await exists(join(fixture.work, 'foreground-count')))
  const project = join(remote, 'project'); await mkdir(project)
  assert.equal((await fixture.api('POST', route(actor) + '/cwd', { cwd: project })).status, 200)
  state = await turn(actor, 'explicit-cwd', [call('cwd', 'call_tool', { toolId: 'node:official-cli/exec', args: { command: 'printf cwd >> cwd-count; cd ..; pwd' } })])
  assert.equal(await readFile(join(project, 'cwd-count'), 'utf8'), 'cwd'); assert.equal(state.cwd, project)
  state = await turn(actor, 'native', [call('native', 'run_script', { code: "return call_tool('node:official-cli/exec', {'command':'printf native >> native-count; pwd'})" })])
  assert.equal(pair(state, 'native').status, 'completed', JSON.stringify(pair(state, 'native')))
  assert.equal(pair(state, 'native').result.status, 'completed'); assert.equal(await readFile(join(project, 'native-count'), 'utf8'), 'native')
  // Temporary explicit targeting must not forward a different Node's cwd.
  const local = await create('temporary'); await fixture.api('POST', route(local) + '/cwd', { cwd: fixture.work })
  state = await turn(local, 'temporary', [call('temporary', 'call_tool', { toolId: 'node:official-cli/exec', args: { command: 'printf temporary >> temporary-count' } })])
  assert.equal(await readFile(join(remote, 'temporary-count'), 'utf8'), 'temporary'); assert.equal(state.currentNode, 'master')
  assert.equal(callsFor(local).at(-1).value.sessionCwd, undefined)
  // Direct adjacent exec has four bounded workers and ordered canonical pairs.
  const start = Date.now()
  state = await turn(actor, 'parallel', Array.from({ length: 6 }, (_, index) => call('parallel-' + index, 'exec', { command: `printf start >> parallel-${index}; sleep 1; printf done >> parallel-${index}`, timeout: 5 })))
  assert(Date.now() - start < 6500, 'direct parallel segment is not serial')
  for (let index = 0; index < 6; index++) assert.equal(await readFile(join(project, 'parallel-' + index), 'utf8'), 'startdone')
  assert.deepEqual(state.history.filter(row => row.role === 'tool').at(-1).parts.map(part => part.functionResponse.tool_use_id), Array.from({ length: 6 }, (_, index) => 'parallel-' + index))
  assertPairs(state)
  // Node switch does not revoke start-time completion or active wait authority.
  const switched = await create('switch'); await select(switched)
  const started = await waitBackground(switched, 'switch', 'printf start\\n >> switch-count; sleep 3; printf done\\n >> switch-count', [call('switch-to-main', 'node', { action: 'select', nodeId: 'master' })])
  state = await finish(switched, 'switch'); assert.equal(state.currentNode, 'master'); assert.equal(state.meta.wait, undefined)
  assert.equal(state.meta.acceptedExternalEventIds.filter(id => id === 'remote-exec-completion:' + started.backgroundExecId).length, 1)
  assert.equal(callsFor(switched).filter(entry => entry.value.tool === 'exec').length, 1)
  // Save failure has no success ACK; the official pending completion retries without a second effect.
  const faulted = await create('save-fault'); await select(faulted)
  const faultRequest = await waitBackground(faulted, 'save-fault', 'printf once >> save-fault-count; sleep 3')
  await mkdir(join(fixture.data, 'state/experiment-faults'), { recursive: true })
  await writeFile(join(fixture.data, 'state/experiment-faults', 'id_' + Buffer.from(faulted).toString('base64url') + '.wait-before-rename'), 'fault')
  state = await finish(faulted, 'save-fault', 45000)
  const faultEvents = eventsFor(faulted); assert(faultEvents.length >= 2)
  assert(wire.some(entry => entry.value.type === 'error' && entry.value.requestId === faultEvents[0].value.requestId))
  assert(!wire.some(entry => entry.value.type === 'session_event_accepted' && entry.value.requestId === faultEvents[0].value.requestId))
  assert.equal(await readFile(join(remote, 'save-fault-count'), 'utf8'), 'once')
  assert.equal(state.meta.acceptedExternalEventIds.filter(id => id === 'remote-exec-completion:' + faultRequest.backgroundExecId).length, 1)
  // Dropped correlated ACK retries the existing completion, never the command or owner wake.
  const duplicate = await create('dropped-ack'); await select(duplicate); dropAck.add(duplicate)
  const duplicateRequest = await waitBackground(duplicate, 'dropped-ack', 'printf once >> dropped-ack-count; sleep 3')
  state = await finish(duplicate, 'dropped-ack', 45000)
  await until(() => eventsFor(duplicate).length >= 2 && wire.some(entry => entry.value.type === 'session_event_accepted' && entry.value.requestId === eventsFor(duplicate).at(-1).value.requestId), 'official dropped ACK retry', 45000)
  assert.equal(state.meta.acceptedExternalEventIds.filter(id => id === 'remote-exec-completion:' + duplicateRequest.backgroundExecId).length, 1)
  assert.equal(await readFile(join(remote, 'dropped-ack-count'), 'utf8'), 'once')
  assertPairs(await saved(duplicate))
  console.log('Official foreground, cwd, temporary routing, native Monty, direct parallel, switch/wait, strict-save retry and dropped ACK qualified.')
  // Actual Node-target authorization blocks all three execution entrances before a wire call.
  await writeFile(join(fixture.work, 'deny-exec.yaml'), 'version: 1\nrules:\n  - id: deny-remote-exec\n    action: deny\n    match:\n      tool: {source: node, name: exec}\n      targetNode: official-cli\n')
  await turn(actor, 'install-exec-policy', [call('exec-policy', 'set_config', { target: 'tool-rules', filePath: 'deny-exec.yaml' })])
  const authorizedCalls = callsFor(actor).length
  state = await turn(actor, 'denied-exec', [call('denied-direct', 'exec', { command: 'printf forbidden > denied-direct' }), call('denied-call', 'call_tool', { toolId: 'node:official-cli/exec', args: { command: 'printf forbidden > denied-call' } }), call('denied-native', 'run_script', { code: "return call_tool('node:official-cli/exec', {'command':'printf forbidden > denied-native'})" })])
  assert.equal(pair(state, 'denied-direct').error.type, 'tool_authorization_denied'); assert.equal(pair(state, 'denied-call').error.type, 'tool_authorization_denied')
  assert.equal(pair(state, 'denied-native').status, 'failed'); assert.equal(callsFor(actor).length, authorizedCalls)
  await writeFile(join(fixture.work, 'restore-exec.yaml'), 'version: 1\n')
  await turn(actor, 'restore-exec-policy', [call('restore-exec-policy', 'set_config', { target: 'tool-rules', filePath: 'restore-exec.yaml' })])
  // Session creation, child and fork retain the source Node without inheriting its filesystem cwd.
  state = await turn(actor, 'create-placement', [call('create-placement', 'call_tool', { toolId: 'builtin:create_session', args: { agentName: 'main', sessionName: 'created-remote' } }), call('child-placement', 'call_tool', { toolId: 'builtin:create_child_session', args: { suffix: 'remote-child' } })])
  assert(!pair(state, 'create-placement').error); assert(!pair(state, 'child-placement').error)
  const child = /Child session created: `([^`]+)`/.exec(pair(state, 'child-placement').output)?.[1]; assert(child)
  const forkResult = await fixture.api('POST', route(actor) + '/fork', { suffix: 'remote-fork' }); assert.equal(forkResult.status, 200)
  for (const id of ['created-remote', child, forkResult.body.newSessionId]) {
    const createdState = await saved(id); assert.equal(createdState.currentNode, 'official-cli'); assert.equal(createdState.cwd, undefined)
    const key = 'placement-' + id.replaceAll('/', '-')
    state = await turn(id, key, [call(key, 'exec', { command: `printf once >> ${key}-count` })])
    assert(!pair(state, key).error); assert.equal(await readFile(join(remote, key + '-count'), 'utf8'), 'once')
  }
  const timerKey = 'remote-timer'; plans.set(timerKey, [[call(timerKey, 'exec', { command: 'printf once >> remote-timer-count' })]])
  state = await turn(actor, 'create-remote-timer', [call('remote-timer-create', 'call_tool', { toolId: 'builtin:create_timer', args: { afterSeconds: 0.2, newSession: true, sessionPrefix: 'remote-timer', message: 'EXEC:remote-timer' } })])
  assert(!pair(state, 'remote-timer-create').error, JSON.stringify(pair(state, 'remote-timer-create')))
  const timerOwner = await until(async () => (await fixture.api('GET', '/api/sessions')).body.sessions.find(row => row.id.startsWith('remote-timer_')), 'timer-created external Session')
  state = await finish(timerOwner.id, timerKey); assert.equal(state.currentNode, 'official-cli'); assert.equal(state.cwd, undefined)
  assert.equal(await readFile(join(remote, 'remote-timer-count'), 'utf8'), 'once')
  // A real official-client pre-start collision: seed its own fresh Agent registry before first initialization.
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'collision' })).status, 201)
  const collided = await create('collision', 'collision'); await select(collided)
  collisionAgent = 'collision'
  state = await turn(collided, 'collision', [call('collision', 'exec', { command: 'printf once >> collision-count' })])
  assert(!pair(state, 'collision').error, JSON.stringify(pair(state, 'collision')))
  const collisionCalls = callsFor(collided).filter(entry => entry.value.tool === 'exec')
  assert.equal(collisionCalls.length, 2); assert.notEqual(collisionCalls[0].value.backgroundExecId, collisionCalls[1].value.backgroundExecId)
  assert(wire.some(entry => entry.value.type === 'tool_call_error' && entry.value.callId === collisionCalls[0].value.callId && entry.value.execStarted === false && entry.value.error.code === 'PERSISTENT_EXEC_ID_COLLISION'))
  assert.equal(await readFile(join(remote, 'collision-count'), 'utf8'), 'once')
  // Stop after real process start retains a truthful actual background result and does not kill it.
  const stopped = await create('stop-started'); await select(stopped)
  await begin(stopped, 'stop-started', [[call('stop-started', 'exec', { command: 'printf start >> stop-started-count; sleep 4; printf done >> stop-started-count', timeout: 30 })]])
  await until(() => exists(join(remote, 'stop-started-count')), 'official process started before Stop')
  const stoppedAt = Date.now(); assert.equal((await fixture.api('POST', route(stopped) + '/stop', {})).status, 200)
  await until(async () => pair(await saved(stopped), 'stop-started'), 'Stop paired actual background result')
  assert(Date.now() - stoppedAt < 3000)
  state = await saved(stopped); assert.match(pair(state, 'stop-started').output, /not killed/)
  assert(wire.some(entry => entry.value.type === 'tool_call_cancel' && entry.value.callId === callsFor(stopped).find(entry => entry.value.tool === 'exec').value.callId))
  await until(async () => (await readFile(join(remote, 'stop-started-count'), 'utf8')) === 'startdone', 'stopped command still completes')
  await finish(stopped, 'stop-started'); assert.equal(callsFor(stopped).filter(entry => entry.value.tool === 'exec').length, 1)
  // Run queued uses the same Stop handshake and retains canonical effect/result pairs.
  const queued = await create('run-queued'); await select(queued)
  await begin(queued, 'run-queued', [[call('run-queued', 'exec', { command: 'printf start >> run-queued-count; sleep 4; printf done >> run-queued-count', timeout: 30 })]])
  await until(() => exists(join(remote, 'run-queued-count')), 'official process started before Run queued')
  assert.equal((await fixture.api('POST', route(queued) + '/message', { text: 'queued ordinary input' })).status, 202)
  assert.equal((await fixture.api('POST', route(queued) + '/message', { text: '/dequeue' })).status, 200)
  await until(async () => pair(await saved(queued), 'run-queued'), 'Run queued pairs actual background result')
  state = await saved(queued); assert.match(pair(state, 'run-queued').output, /not killed/)
  await until(async () => (await readFile(join(remote, 'run-queued-count'), 'utf8')) === 'startdone', 'Run queued command completes')
  assertPairs(await saved(queued))
  // Rename preserves the original signature and aliases; deletion cannot be undone by a late official event.
  const renamed = await create('rename-before'); await select(renamed)
  const renameRequest = await waitBackground(renamed, 'renamed', 'printf once >> rename-count; sleep 5')
  state = await turn(actor, 'rename-target', [call('rename-target', 'call_tool', { toolId: 'builtin:move_session', args: { sessionId: renamed, newSessionId: 'rename-after' } })])
  assert(!pair(state, 'rename-target').error, JSON.stringify(pair(state, 'rename-target')))
  state = await finish('rename-after', 'renamed'); assert(state.aliases.includes(renamed)); assert.equal(state.meta.wait, undefined)
  assert(eventsFor(renamed).some(entry => entry.value.completionCapability === renameRequest.completionCapability))
  assert.equal(await readFile(join(remote, 'rename-count'), 'utf8'), 'once')
  const deleted = await create('delete-running'); await select(deleted)
  const deleteRequest = await waitBackground(deleted, 'delete-running', 'printf once >> delete-count; sleep 4')
  assert.equal((await fixture.api('DELETE', route(deleted))).status, 200)
  await until(() => eventsFor(deleted).length && wire.some(entry => entry.value.type === 'error' && entry.value.requestId === eventsFor(deleted).at(-1).value.requestId), 'late official completion rejected after deletion')
  assert(!await exists(join(fixture.data, 'state/sessions', deleted + '.json')))
  assert.equal((await fixture.api('GET', route(deleted) + '/history')).status, 404)
  assert.equal(await readFile(join(remote, 'delete-count'), 'utf8'), 'once')
  // Durable receipt replay across Main and official-client restart is an ACK of the old event, not new authority.
  const replay = await create('durable-replay'); await select(replay); heldAck.add(replay)
  const replayRequest = await waitBackground(replay, 'durable-replay', 'printf once >> durable-replay-count; sleep 3')
  await finish(replay, 'durable-replay')
  await fixture.stop(); await stopClient(client); heldAck.delete(replay)
  await fixture.start(); client = startClient(credentials); await online('official-cli')
  await until(() => eventsFor(replay).length >= 2 && wire.some(entry => entry.value.type === 'session_event_accepted' && entry.value.requestId === eventsFor(replay).at(-1).value.requestId), 'official persisted pending completion replay', 45000)
  state = await saved(replay); assert.equal(state.meta.acceptedExternalEventIds.filter(id => id === 'remote-exec-completion:' + replayRequest.backgroundExecId).length, 1)
  assert.equal(await readFile(join(remote, 'durable-replay-count'), 'utf8'), 'once')
  assert.equal(callsFor(replay).filter(entry => entry.value.tool === 'exec').length, 1)
  // Restart does not recreate active grant authority for a new, unproven completion or resend the command.
  const unknown = await create('restart-unproven'); await select(unknown)
  const unknownRequest = await waitBackground(unknown, 'restart-unproven', 'printf start >> restart-unproven-count; sleep 7; printf done >> restart-unproven-count')
  await fixture.stop(); await fixture.start(); await online('official-cli')
  await until(() => eventsFor(unknown).length && wire.some(entry => entry.value.type === 'error' && entry.value.requestId === eventsFor(unknown).at(-1).value.requestId), 'new completion after restart rejected', 45000)
  state = await saved(unknown); assert(!state.meta.acceptedExternalEventIds?.includes('remote-exec-completion:' + unknownRequest.backgroundExecId))
  assert.equal(await readFile(join(remote, 'restart-unproven-count'), 'utf8'), 'startdone')
  assert.equal(callsFor(unknown).filter(entry => entry.value.tool === 'exec').length, 1)
  // Node removal settles the foreground wait without claiming process termination or replay.
  const removed = await create('node-removed'); await select(removed)
  await begin(removed, 'node-removed', [[call('node-removed', 'exec', { command: 'printf start >> node-removed-count; sleep 4; printf done >> node-removed-count', timeout: 30 })]])
  await until(() => exists(join(remote, 'node-removed-count')), 'process starts before Node removal')
  assert.equal((await fixture.api('DELETE', '/api/nodes/official-cli')).status, 200)
  state = await finish(removed, 'node-removed'); assert.match(JSON.stringify(pair(state, 'node-removed')), /not retried|may have occurred/)
  await until(async () => (await readFile(join(remote, 'node-removed-count'), 'utf8')) === 'startdone', 'removed Node process completes')
  assert.equal(callsFor(removed).filter(entry => entry.value.tool === 'exec').length, 1)
  await stopClient(client)
  credentials = (await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: 'official-cli' })).body
  client = startClient(credentials); await online('official-cli')
  state = await turn(actor, 'after-reconnect', [call('after-reconnect', 'call_tool', { toolId: 'node:official-cli/exec', args: { command: 'printf once >> reconnect-count' } })])
  assert(!pair(state, 'after-reconnect').error); assert.equal(await readFile(join(project, 'reconnect-count'), 'utf8'), 'once')
  // Stop before process launch uses the unchanged official interactive approval path.
  await stopClient(client); client = startClient(credentials, true); await online('official-cli')
  const approval = await create('stop-before'); await select(approval)
  await begin(approval, 'stop-before', [[call('stop-before', 'exec', { command: 'printf approval-held >> not-started-count', timeout: 30 })]])
  await until(() => client.output.includes('OFFICIAL-APPROVAL-HELD'), 'official interactive approval pending')
  assert.equal((await fixture.api('POST', route(approval) + '/stop', {})).status, 200)
  await until(async () => pair(await saved(approval), 'stop-before'), 'official pre-start Stop result')
  state = await saved(approval); assert.match(JSON.stringify(pair(state, 'stop-before')), /not started|not executed/)
  assert(!await exists(join(remote, 'not-started-count')))
  const approvalCall = callsFor(approval).find(entry => entry.value.tool === 'exec').value
  assert(wire.some(entry => entry.value.type === 'tool_call_error' && entry.value.callId === approvalCall.callId && entry.value.execStarted === false))
  assertPairs(state)
  console.log('Official collision, Stop before/after launch, Run queued, rename/delete, pending replay, restart uncertainty and removal/reconnect qualified.')
  // Genuine official local triggers exercise all ordinary event consumers and their current-Node rule.
  await stopClient(client); client = startClient(credentials, false, true); await online('official-cli')
  const triggerMeta = await until(async () => {
    const path = join(remote, 'node_local_trigger.json'); if (!await exists(path)) return null
    const value = JSON.parse(await readFile(path, 'utf8')); return value.port > 0 ? value : null
  }, 'official local trigger server')
  const triggerToken = (await readFile(triggerMeta.tokenFile, 'utf8')).trim()
  const sendTrigger = async (id, key, type) => {
    const response = await fetch(`http://127.0.0.1:${triggerMeta.port}/trigger`, { method: 'POST', headers: { authorization: 'Bearer ' + triggerToken, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: id, message: 'EXEC:' + key, eventType: type }) })
    return response.status
  }
  for (const type of ['background', 'trigger', 'onboot']) {
    const key = 'ordinary-' + type; plans.set(key, [[call(key, 'exec', { command: 'printf once >> ' + key + '-count' })]])
    assert.equal(await sendTrigger(actor, key, type), 200)
    state = await finish(actor, key); assert.equal(state.currentNode, 'official-cli')
    assert.equal(await readFile(join(project, key + '-count'), 'utf8'), 'once')
    assert(eventsFor(actor).some(entry => entry.value.eventType === type && entry.value.message === 'EXEC:' + key))
  }
  const noPlacement = await create('ordinary-denied')
  assert.equal(await sendTrigger(noPlacement, 'ordinary-denied', 'trigger'), 500)
  assert.equal((await saved(noPlacement)).history.length, 0)
  // Node rename never translates an old grant to a new authenticated Node identity.
  const nodeRenamed = await create('node-rename'); await select(nodeRenamed)
  const oldGrant = await waitBackground(nodeRenamed, 'node-rename', 'printf once >> node-rename-count; sleep 4')
  assert.equal((await fixture.api('POST', '/api/nodes/official-cli/rename', { nodeId: 'renamed-cli' })).status, 200)
  await stopClient(client); client = startClient({ ...credentials, nodeId: 'renamed-cli' }); await online('renamed-cli')
  await until(() => eventsFor(nodeRenamed).some(entry => entry.node === 'renamed-cli') && wire.some(entry => entry.value.type === 'error' && entry.value.requestId === eventsFor(nodeRenamed).filter(entry => entry.node === 'renamed-cli').at(-1).value.requestId), 'old completion rejected on renamed authenticated Node', 30000)
  state = await saved(nodeRenamed); assert.equal(state.currentNode, 'official-cli')
  assert(!state.meta.acceptedExternalEventIds?.includes('remote-exec-completion:' + oldGrant.backgroundExecId))
  assert.equal(await readFile(join(remote, 'node-rename-count'), 'utf8'), 'once')
  const beforeOffline = callsFor(actor).length
  state = await turn(actor, 'offline-status', [call('offline-exec', 'exec', { command: 'printf forbidden > offline-count' }), call('offline-status', 'session', { action: 'status' })])
  assert(pair(state, 'offline-exec').error); assert(!pair(state, 'offline-status').error); assert.equal(callsFor(actor).length, beforeOffline)
  assert(!await exists(join(fixture.work, 'offline-count')))
  // Inspect actual archived pairs as well as live authority, not just transient correlation dictionaries.
  const archive = fixture.sql('SELECT seq,message_json FROM archive_messages WHERE session_id = ? ORDER BY seq', [actor])
  const archived = new Map(archive.map(([seq, json]) => [seq, JSON.parse(json)]))
  for (const row of state.history) assert.deepEqual(archived.get(row.__meta.seq), row, 'Archive mirrors canonical committed message ' + row.__meta.seq)
  assertPairs(state)
  const duplicateArchive = fixture.sql('SELECT message_json FROM archive_messages WHERE session_id = ?', [duplicate]).map(([json]) => JSON.parse(json))
  assert.equal(duplicateArchive.flatMap(row => row.parts || []).filter(part => part.system?.includes('Background Process Finished') && part.system.includes(duplicateRequest.backgroundExecId)).length, 1)
  assert.equal(rounds.get('dropped-ack'), 3, 'one wake/provider follow-up despite ACK retry')
  const proof = { hostStarts: fixture.hostPids.length, officialClientStarts: clients.length, externalExecRequests: wire.filter(entry => entry.direction === 'request' && entry.value.type === 'tool_call' && entry.value.tool === 'exec').length, cancellationHandshakes: wire.filter(entry => entry.value.type === 'tool_call_cancel').length, completionAttempts: wire.filter(entry => entry.value.type === 'session_event' && entry.value.eventId).length, completionAcknowledgements: wire.filter(entry => entry.value.type === 'session_event_accepted').length, archivedActorMessages: archived.size, duplicateCompletionArchiveRows: 1, droppedAckOwnerProviderRounds: rounds.get('dropped-ack'), failures: failures.length }
  await writeFile(join(fixture.root, 'remote-exec-proof.json'), JSON.stringify(proof, null, 2))
  console.log('Official creation/child/fork/timer placement, authorization, ordinary background/trigger/onboot, Node rename, offline observation and Archive evidence qualified.')
  console.log(JSON.stringify(proof))


} catch (error) {
  console.error('Host:', fixture.output)
  console.error('Wire summary:', wire.map(entry => [entry.direction, entry.value.type, entry.value.error]).slice(-15))
  for (const handle of clients) console.error(handle.output.replaceAll(credentials?.authToken || 'unused-token', '[credential]'))
  throw error
} finally {
  for (const handle of clients) await stopClient(handle)
  for (const socket of connections) socket.terminate()
  await new Promise(done => proxy.close(done)); await new Promise(done => proxyServer.close(done))
  await fixture.cleanup(); await new Promise(done => peer.close(done))
}
