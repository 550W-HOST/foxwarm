// Real Source/candidate receivers with owned timing barriers, roots and credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { until, sleep } from './experimentHostFixture.mjs'
const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const frames = [], clients = [], connected = new Map(), generations = new Map(), modes = new Map(), protocols = new Map(), sockets = new Set()
const http = createServer(), peer = new WebSocketServer({ server: http })
http.listen(0, '127.0.0.1'); await once(http, 'listening')
const origin = `http://127.0.0.1:${http.address().port}`
let serial = 0
const owner = () => ({ kind: 'external', externalId: 'owned.alpha', contextId: randomUUID() })
const exists = file => access(file).then(() => true, () => false)
peer.on('connection', (socket, request) => {
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
  const id = new URL(request.url, origin).searchParams.get('id')
  socket.on('message', bytes => {
    const value = JSON.parse(bytes); frames.push({ id, socket, value })
    if (value.type === 'node_register') {
      connected.set(id, socket); generations.set(id, (generations.get(id) || 0) + 1)
      socket.send(JSON.stringify({ type: 'registered', nodeId: id, nodeProtocol: { negotiated: protocols.get(id) || 3, master: { min: 1, max: protocols.get(id) || 3 } } }))
    }
    if (value.type === 'external_exec_completed') {
      if (modes.get(id) === 'drop') return
      socket.send(JSON.stringify({ type: 'cli_response', requestId: value.requestId, ok: modes.get(id) !== 'reject', result: { accepted: modes.get(id) !== 'reject' } }))
    }
  })
})
async function launch(name, source = false) {
  const cwd = join(root, name); await mkdir(cwd, { recursive: true })
  const before = generations.get(name) || 0, executable = !source && process.env.FOXWARM_CLI_EXECUTABLE
  const child = spawn(executable || (source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet')), [...(executable ? [] : [resolve(source ? 'packages/cli-node/dist/client.js' : 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', origin, '--id', name, '--auth-token', 'synthetic-' + name, '--credentials-file', join(cwd, 'credentials.json'), '--no-local-trigger'], { cwd, env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents'), fw_agentdir: 'wrong', fw_tmp: 'wrong', FW_AGENTDIR: 'uppercase-kept', EXTERNAL_INHERITED: 'inherited' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const handle = { name, child, cwd, source, output: '' }; clients.push(handle)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { handle.output += data })
  await until(() => (generations.get(name) || 0) > before, 'external CLI registration ' + name)
  handle.socket = connected.get(name); return handle
}
async function stop(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
  const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM')
  let timer
  try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => { handle.child.kill('SIGKILL'); reject(new Error('CLI drain timeout: ' + handle.output)) }, 18000) })]) }
  finally { clearTimeout(timer) }
}
async function request(handle, value) {
  const key = value.type === 'tool_call' ? 'callId' : 'requestId', id = 'owned-' + ++serial
  value[key] = id; handle.socket.send(JSON.stringify(value))
  return until(() => frames.find(row => row.socket === handle.socket && row.value[key] === id)?.value, value.type + ' reply', 65000)
}
const tool = (handle, owned, name, args = {}, extra = {}) => request(handle, { type: 'tool_call', owner: owned, tool: name, args, ...extra })
const query = (handle, owned, execId) => request(handle, { type: 'external_exec_result_request', owner: owned, execId })
const good = reply => { assert.equal(reply.type, 'tool_call_response', JSON.stringify(reply)); return reply.result }
const eventRows = (handle, execId) => frames.filter(row => row.id === handle.name && row.value.type === 'external_exec_completed' && row.value.execId === execId)
const stateRoot = (handle, owned) => join(handle.cwd, 'external-exec', createHash('sha256').update(owned.externalId).digest('hex'), owned.contextId)
const registry = async (handle, owned) => JSON.parse(await readFile(join(stateRoot(handle, owned), 'running.json'), 'utf8'))
async function command(handle, owned, command, args = {}, extra = {}) {
  const id = 'quiet-' + (++serial).toString().split('').map(c => String.fromCharCode(97 + Number(c))).join('')
  const grant = 'synthetic-grant-' + serial
  const reply = await tool(handle, owned, 'exec', { command, timeout: 2, ...args }, { backgroundExecId: id, completionCapability: grant, ...extra })
  return { id, grant, reply, result: reply.result }
}
try {
  for (const source of [true, false]) {
    let handle = await launch(source ? 'source' : 'candidate', source)
    const owned = owner(), base = join(handle.cwd, 'selected'), child = join(base, 'child'); await mkdir(child, { recursive: true })
    const registration = frames.find(row => row.socket === handle.socket && row.value.type === 'node_register').value
    assert.equal(registration.capabilities.features.externalToolOwner, 1)
    for (const invalid of [null, {}, { ...owned, extra: null }, { ...owned, externalId: '../escape' }, { ...owned, contextId: null }]) {
      const reply = await tool(handle, invalid, 'write', { filePath: join(base, 'never'), content: 'no' })
      assert.equal(reply.type, 'tool_call_error'); assert.match(reply.error.message, /owner is unsupported or invalid/)
    }
    for (const field of ['sessionId', 'agentName']) for (const value of [null, '', 'main']) {
      const reply = await tool(handle, owned, 'exec', { command: 'printf no > never' }, { [field]: value })
      assert.equal(reply.execStarted, false); assert.match(reply.error.message, /owner is unsupported or invalid/)
    }
    const missing = await tool(handle, owned, 'exec', { command: 'printf no' })
    assert.equal(missing.execStarted, false); assert.match(missing.error.message, /reserved execution ID/)
    assert.equal((await tool(handle, owned, 'browse_tabs')).type, 'tool_call_error')
    assert.equal(good(await tool(handle, owned, 'get_default_cwd')).output, handle.cwd)
    good(await tool(handle, owned, 'write', { filePath: 'text.txt', content: 'one' }, { sessionCwd: base }))
    good(await tool(handle, owned, 'edit', { filePath: 'text.txt', oldText: 'one', newText: 'two' }, { sessionCwd: base }))
    good(await tool(handle, owned, 'apply_patch', { input: '*** Begin Patch\n*** Update File: text.txt\n@@\n-two\n+three\n*** End Patch' }, { sessionCwd: base }))
    const read = good(await tool(handle, owned, 'read', { filePath: '~/' + relative(homedir(), join(base, 'text.txt')) }, { programmatic: true }))
    assert.match(read.output, /three/); assert.equal(read.content, undefined); assert.equal(read.__foxwarmResolvedToolPaths, undefined)
    for (const variable of ['$fw_tmp/x', '$fw_agentdir/x', '$UNKNOWN/x']) {
      const result = await tool(handle, owned, 'read', { filePath: variable })
      assert.equal(result.type, 'tool_call_error'); assert.match(result.error.message, /Agent path variable/)
      const exec = await command(handle, owner(), 'printf forbidden', { cwd: variable })
      assert.equal(exec.reply.execStarted, false); assert.match(exec.reply.error.message, /Agent path variable/)
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
    await writeFile(join(base, 'pixel'), png)
    const image = good(await tool(handle, owned, 'read', { filePath: join(base, 'pixel') }))
    assert.equal(image.inlineData.mimeType, 'image/png'); assert.equal(image.inlineData.data, png.toString('base64'))
    const foreground = await command(handle, owned, 'printf "%s|%s|%s|%s" "$EXTERNAL_INHERITED" "${fw_agentdir-unset}" "${fw_tmp-unset}" "$FW_AGENTDIR"; cd child', {}, { sessionCwd: base, programmatic: true })
    const result = good(foreground.reply)
    assert.equal(result.cwd, child); assert.equal(result.execId, foreground.id); assert.equal(result.background, false)
    assert.match(result.output, /inherited\|unset\|unset\|uppercase-kept/); assert.equal(result.content, undefined)
    assert.equal((await query(handle, owned, foreground.id)).result.cwd, child)
    assert((await query(handle, { ...owned, contextId: randomUUID() }, foreground.id)).error)
    assert((await query(handle, { ...owned, externalId: 'other' }, foreground.id)).error)
    const recordRoot = stateRoot(handle, owned)
    assert(await exists(join(recordRoot, 'running.json'))); assert(!await exists(join(handle.cwd, 'agents')))
    const collision = await tool(handle, owned, 'exec', { command: 'printf no > never' }, { backgroundExecId: foreground.id, completionCapability: foreground.grant })
    assert.equal(collision.execStarted, false); assert.equal(collision.error.code, 'PERSISTENT_EXEC_ID_COLLISION')
    // The cancellation frame is not a Session Stop controller for an external owner.
    const blocked = command(handle, owned, 'printf once >> once; while [ ! -e release ]; do sleep .03; done; printf done', { timeout: 1 }, { sessionCwd: base })
    await until(() => exists(join(base, 'once')), 'actual external command started')
    const invocation = 'owned-' + serial; handle.socket.send(JSON.stringify({ type: 'tool_call_cancel', callId: invocation }))
    const background = await blocked; assert(good(background.reply).background)
    const notice = frames.findIndex(row => row.socket === handle.socket && row.value.type === 'external_exec_background' && row.value.execId === background.id)
    const response = frames.findIndex(row => row.socket === handle.socket && row.value.type === 'tool_call_response' && row.value.result?.execId === background.id)
    assert(notice >= 0 && notice < response)
    const running = await query(handle, owned, background.id); assert.equal(running.result.state, 'running')
    const persisted = (await registry(handle, owned)).execs.find(entry => entry.id === background.id)
    assert.deepEqual(persisted.externalOwner, owned); assert.equal(persisted.sessionId, undefined); assert.equal(persisted.agentName, undefined)
    assert.equal(persisted.nodeId, handle.name); assert.equal(persisted.completionCapability, background.grant)
    assert(persisted.logPath.startsWith(join(recordRoot, 'logs') + '/'))
    modes.set(handle.name, 'drop'); await writeFile(join(base, 'release'), '')
    await until(() => eventRows(handle, background.id).length, 'external completion with missing ACK')
    const completed = eventRows(handle, background.id)[0].value
    assert.deepEqual(completed.owner, owned); assert.equal(completed.completionCapability, background.grant)
    assert.equal(completed.type, 'external_exec_completed'); assert.equal(completed.sessionId, undefined)
    assert((await registry(handle, owned)).execs.some(entry => entry.id === background.id))
    modes.set(handle.name, 'reject')
    await until(() => eventRows(handle, background.id).length >= 2, 'missing ACK retry', 26000)
    await sleep(100)
    assert((await registry(handle, owned)).execs.some(entry => entry.id === background.id))
    modes.set(handle.name, 'accept')
    await until(async () => !(await registry(handle, owned)).execs.some(entry => entry.id === background.id), 'accepted ACK retires tracking', 12000)
    assert.equal(await readFile(join(base, 'once'), 'utf8'), 'once')
    assert.equal((await query(handle, owned, background.id)).result.state, 'completed')
    // Losing the dispatch socket neither replays an effect nor moves its direct reply to a new socket.
    const reconnectOwner = owner(), reconnectBase = join(handle.cwd, 'reconnect'); await mkdir(reconnectBase)
    const oldSocket = handle.socket, generation = generations.get(handle.name), lostCall = 'lost-call-' + ++serial
    const reconnectId = 'lost-command', reconnectGrant = 'synthetic-reconnect-grant'
    oldSocket.send(JSON.stringify({ type: 'tool_call', callId: lostCall, tool: 'exec', owner: reconnectOwner, backgroundExecId: reconnectId, completionCapability: reconnectGrant, sessionCwd: reconnectBase, args: { command: 'printf once >> effects; while [ ! -e go ]; do sleep .03; done; printf done >> effects', timeout: 1 } }))
    await until(() => exists(join(reconnectBase, 'effects')), 'command starts before socket loss')
    oldSocket.close()
    await until(() => generations.get(handle.name) > generation, 'same authenticated Node reconnects', 12000)
    handle.socket = connected.get(handle.name)
    assert.equal((await query(handle, reconnectOwner, reconnectId)).result.state, 'running')
    assert(!frames.some(row => row.socket === handle.socket && row.value.callId === lostCall), 'old direct response is not sent on successor connection')
    await writeFile(join(reconnectBase, 'go'), '')
    await until(() => eventRows(handle, reconnectId).length, 'original external completion after reconnect', 12000)
    assert.equal(await readFile(join(reconnectBase, 'effects'), 'utf8'), 'oncedone')
    assert.deepEqual(eventRows(handle, reconnectId)[0].value.owner, reconnectOwner)
    assert.equal(eventRows(handle, reconnectId)[0].value.completionCapability, reconnectGrant)
    // Completed cache is insertion-ordered, bounded at twenty, and not a lifetime quota.
    const retained = []
    for (let index = 0; index < 21; index++) { const done = await command(handle, owned, 'printf retained'); good(done.reply); retained.push(done.id) }
    assert((await query(handle, owned, retained[0])).error)
    assert.equal((await query(handle, owned, retained[1])).result.state, 'completed')
    assert.equal((await query(handle, owned, retained.at(-1))).result.state, 'completed')
    // DELETE/release while a command is actually live never kills it or deletes its artifacts early.
    const releasing = owner(), releaseBase = join(handle.cwd, 'release-live'); await mkdir(releaseBase)
    const live = await command(handle, releasing, 'printf started > started; while [ ! -e go ]; do sleep .03; done; printf done > done', { timeout: 1 }, { sessionCwd: releaseBase })
    assert(good(live.reply).background); const releasedRoot = stateRoot(handle, releasing)
    handle.socket.send(JSON.stringify({ type: 'external_exec_release', owner: releasing }))
    assert((await query(handle, releasing, live.id)).error); assert(await exists(releasedRoot))
    const fenced = await command(handle, releasing, 'printf forbidden > forbidden', {}, { sessionCwd: releaseBase })
    assert.equal(fenced.reply.execStarted, false); assert.match(fenced.reply.error.message, /expired/)
    // Source release fences exec authority, not unrelated file-tool effects.
    good(await tool(handle, releasing, 'write', { filePath: join(releaseBase, 'file-after-release'), content: 'allowed' }))
    await writeFile(join(releaseBase, 'go'), '')
    await until(() => exists(join(releaseBase, 'done')), 'released command survives')
    await until(async () => !await exists(releasedRoot), 'settled release cleanup', 12000)
    assert.equal(eventRows(handle, live.id).length, 0)
    const foregroundOwner = owner(), foregroundBase = join(handle.cwd, 'release-foreground'); await mkdir(foregroundBase)
    const foregroundRelease = command(handle, foregroundOwner, 'printf live > live; while [ ! -e go ]; do sleep .03; done; printf settled', { timeout: 30 }, { sessionCwd: foregroundBase })
    await until(() => exists(join(foregroundBase, 'live')), 'foreground command actually running')
    handle.socket.send(JSON.stringify({ type: 'external_exec_release', owner: foregroundOwner }))
    assert((await query(handle, foregroundOwner, 'irrelevant')).error)
    assert(await exists(stateRoot(handle, foregroundOwner)))
    await writeFile(join(foregroundBase, 'go'), '')
    assert.equal(good((await foregroundRelease).reply).background, false)
    await until(async () => !await exists(stateRoot(handle, foregroundOwner)), 'inflight foreground release cleans only after settlement')
    // A retained running directory is not startup authority, nor can query manufacture a manager.
    const restartOwner = owner(), restartBase = join(handle.cwd, 'restart'); await mkdir(restartBase)
    const restart = await command(handle, restartOwner, 'printf once >> effects; while [ ! -e go ]; do sleep .03; done; printf done >> effects', { timeout: 1 }, { sessionCwd: restartBase })
    assert(good(restart.reply).background)
    await stop(handle); handle = await launch(handle.name, source)
    assert((await query(handle, restartOwner, restart.id)).error)
    assert.equal(eventRows(handle, restart.id).length, 0)
    assert((await registry(handle, restartOwner)).execs.some(entry => entry.id === restart.id))
    // The real on-demand exec initializer may load the exact retained namespace; it is not a purge ban.
    good((await command(handle, restartOwner, 'printf new', {}, { sessionCwd: restartBase })).reply)
    assert.equal((await query(handle, restartOwner, restart.id)).result.state, 'running')
    await writeFile(join(restartBase, 'go'), '')
    await until(() => eventRows(handle, restart.id).length, 'on-demand retained completion')
    assert.equal(await readFile(join(restartBase, 'effects'), 'utf8'), 'oncedone')
    // External shutdown drains the manager, not a Session Stop or a thirty-second foreground wait.
    const shutdownOwner = owner(), shutdownBase = join(handle.cwd, 'foreground-shutdown'); await mkdir(shutdownBase)
    const shutdownId = 'shutdown-foreground'
    handle.socket.send(JSON.stringify({ type: 'tool_call', callId: 'shutdown-call', tool: 'exec', owner: shutdownOwner, backgroundExecId: shutdownId, completionCapability: 'synthetic-shutdown-grant', sessionCwd: shutdownBase, args: { command: 'printf once >> effects; while [ ! -e go ]; do sleep .03; done; printf done >> effects', timeout: 30 } }))
    await until(async () => exists(join(shutdownBase, 'effects')).then(async present => present && (await registry(handle, shutdownOwner).catch(() => ({ execs: [] }))).execs.some(entry => entry.id === shutdownId)), 'foreground start is really persisted')
    const stopping = Date.now(); await stop(handle); assert(Date.now() - stopping < 6000, 'shutdown does not wait for external foreground timeout')
    handle = await launch(handle.name, source)
    assert((await query(handle, shutdownOwner, shutdownId)).error, 'foreground retained namespace is not startup authority')
    await writeFile(join(shutdownBase, 'go'), '')
    await until(async () => (await readFile(join(shutdownBase, 'effects'), 'utf8')) === 'oncedone', 'foreground command survives CLI exit without replay')
    assert.equal(eventRows(handle, shutdownId).length, 0)
    good((await command(handle, shutdownOwner, 'printf on-demand', {}, { sessionCwd: shutdownBase })).reply)
    await until(() => eventRows(handle, shutdownId).length, 'actual on-demand initializer reports settled foreground record')
    // Force only persisted age, on an actual Source/candidate-created live record, while stopped.
    const expiredOwner = owner(), expireBase = join(handle.cwd, 'expiry'); await mkdir(expireBase)
    const expired = await command(handle, expiredOwner, 'printf alive > alive; while [ ! -e go ]; do sleep .03; done; printf survived > survived', { timeout: 1 }, { sessionCwd: expireBase })
    good(expired.reply); await stop(handle)
    const file = join(stateRoot(handle, expiredOwner), 'running.json'), data = JSON.parse(await readFile(file, 'utf8'))
    data.execs.find(entry => entry.id === expired.id).startedAt = Date.now() - 24 * 3600000 - 10000
    await writeFile(file, JSON.stringify(data))
    handle = await launch(handle.name, source)
    assert((await query(handle, expiredOwner, expired.id)).error)
    good((await command(handle, expiredOwner, 'printf trigger', {}, { sessionCwd: expireBase })).reply)
    handle.socket.send(JSON.stringify({ type: 'external_exec_release', owner: expiredOwner }))
    await sleep(100); assert(await exists(stateRoot(handle, expiredOwner)))
    await writeFile(join(expireBase, 'go'), '')
    await until(() => exists(join(expireBase, 'survived')), 'expired tracking does not kill')
    await sleep(200); assert(await exists(stateRoot(handle, expiredOwner)), 'uncertain tracking retains artifacts after release')
    assert.equal(eventRows(handle, expired.id).length, 0)
    await stop(handle)
    for (const version of [1, 2]) {
      const name = (source ? 'source' : 'candidate') + '-v' + version; protocols.set(name, version)
      const legacy = await launch(name, source)
      assert.equal((await tool(legacy, owner(), 'write', { filePath: 'never', content: 'no' })).type, 'tool_call_error')
      good(await request(legacy, { type: 'tool_call', tool: 'write', sessionId: 'main/owned', agentName: 'main', args: { filePath: 'ordinary', content: 'legacy-session', createDirs: true } }))
      assert.equal(await readFile(join(legacy.cwd, 'agents/main/ordinary'), 'utf8'), 'legacy-session')
      await stop(legacy)
    }
    console.log(JSON.stringify({ pass: source ? 'Source' : 'candidate', root: handle.cwd, retained: retained.length, contexts: 'disjoint', sourceExternalProgrammatic: 'not requested by receiver' }))
  }
} finally {
  for (const handle of clients) await stop(handle)
  for (const socket of sockets) socket.terminate()
  await new Promise(done => peer.close(done)); await new Promise(done => http.close(done))
}
console.log('PASS actual external receivers: six tools, owner/protocol gates, Source cwd/environment/output, ACK retry, bounded results, live release, on-demand-only recovery and uncertain-expiry artifact retention')
