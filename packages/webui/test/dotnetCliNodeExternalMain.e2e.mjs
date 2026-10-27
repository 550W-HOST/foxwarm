// Existing inbound MCP and authenticated Node entrypoints in ordinary Source and .NET Main.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import WebSocket, { WebSocketServer } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHostFixture, until } from './mainHostFixture.mjs'
const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()
const exists = file => access(file).then(() => true, () => false)
const value = result => { assert(!result.isError, JSON.stringify(result)); return result.structuredContent ?? JSON.parse(result.content[0].text) }
for (const runtime of ['source', 'dotnet']) {
  const env = {}, host = await createHostFixture('cli-external-' + runtime, { runtime, env })
  Object.assign(env, isolatedApplicationEnv(host.data), { FOXWARM_SYNC_FILE_LOG: '', FOXWARM_NO_CONSOLE_LOG: '' })
  const prefix = runtime === 'source' ? '' : '/external/main'
  const tokens = { alpha: 'synthetic-alpha', beta: 'synthetic-beta' }
  const identities = Object.fromEntries(Object.entries(tokens).map(([id, token]) => [id, { token, surfaces: { mcp: {} } }]))
  await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify({ url: host.origin + prefix, bot: { httpPort: host.port, enableWebUI: true, enableTrigger: false }, vector: false, vectorMaintenance: false, sessionWorkers: false, dbWorkers: false, channels: {}, access: { identities } }))
  await writeFile(host.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:9', models: ['wire'] } } }))
  await writeFile(join(host.data, 'state/tool-authorization.yaml'), 'version: 1\nrules:\n  - id: external\n    action: allow\n    match: {externalId: [alpha, beta]}\n')
  const cwd = join(host.root, 'cli'); await mkdir(cwd)
  const clients = [], wire = [], sockets = new Set(), children = []
  const proxyHttp = createServer(), proxy = new WebSocketServer({ server: proxyHttp })
  proxyHttp.listen(0, '127.0.0.1'); await once(proxyHttp, 'listening')
  let tamperNext = false
  proxy.on('connection', (down, request) => {
    const up = new WebSocket(host.origin.replace(/^http/, 'ws') + request.url), pending = []
    sockets.add(up); sockets.add(down)
    up.on('open', () => { for (const bytes of pending) up.send(bytes) })
    down.on('message', bytes => {
      const value = JSON.parse(bytes); wire.push({ direction: 'cli', value })
      if (up.readyState === WebSocket.OPEN) up.send(bytes.toString()); else pending.push(bytes.toString())
    })
    up.on('message', bytes => {
      const frame = JSON.parse(bytes); wire.push({ direction: 'main', value: frame })
      const forwarded = structuredClone(frame)
      if (tamperNext && frame.type === 'tool_call' && frame.tool === 'exec') { tamperNext = false; forwarded.completionCapability = 'synthetic-tampered-grant' }
      if (down.readyState === WebSocket.OPEN) down.send(JSON.stringify(forwarded))
    })
    for (const [from, to] of [[up, down], [down, up]]) { from.on('error', () => {}); from.on('close', () => { sockets.delete(from); if (to.readyState === WebSocket.OPEN) to.close() }) }
  })
  async function admin(method, path, body) {
    const response = await fetch(host.origin + prefix + path, { method, headers: { authorization: 'Bearer ' + host.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = { status: response.status, body: await response.json().catch(() => ({})) }
    assert.equal(result.status, 200, JSON.stringify(result)); return result.body
  }
  async function connect(identity = 'alpha') {
    const transport = new StreamableHTTPClientTransport(new URL(host.origin + prefix + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + tokens[identity] } } })
    const client = new Client({ name: 'cli-external-qualification', version: '1' }); client.onerror = () => {}
    await client.connect(transport); const owner = { client, transport }; clients.push(owner); return owner
  }
  const call = (owner, name, args = {}) => owner.client.callTool({ name, arguments: args })
  const concrete = (owner, name, args = {}) => call(owner, 'foxwarm_call', { toolId: 'node:external-cli/' + name, args })
  const command = (owner, command, timeout = 15) => concrete(owner, 'exec', { command, timeout })
  const online = () => until(async () => (await admin('GET', '/api/nodes')).nodes.find(node => node.id === 'external-cli' && node.online), 'actual CLI online')
  const execCall = id => wire.find(row => row.direction === 'main' && row.value.type === 'tool_call' && row.value.backgroundExecId === id)?.value
  const contextRoot = contextId => join(cwd, 'external-exec', createHash('sha256').update('alpha').digest('hex'), contextId)
  try {
    await host.start()
    const pairing = (await readFile(join(host.data, 'state/node_token'), 'utf8')).trim()
    const executable = process.env.FOXWARM_CLI_EXECUTABLE
    const child = spawn(executable || join(process.env.DOTNET_ROOT, 'dotnet'), [...(executable ? [] : [resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', `http://127.0.0.1:${proxyHttp.address().port}` + prefix, '--id', 'external-cli', '--token', pairing, '--credentials-file', join(cwd, 'credentials.json'), '--no-local-trigger'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents') } })
    children.push(child); let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
    const pending = await until(async () => (await admin('GET', '/api/nodes/onboarding/pending')).items.find(item => item.requestedName === 'external-cli'), 'real pending CLI')
    await admin('POST', '/api/nodes/onboarding/approve', { pendingId: pending.id })
    await online()
    const credential = await until(async () => readFile(join(cwd, 'credentials.json'), 'utf8').then(JSON.parse).catch(() => null), 'paired credential persistence')
    const alpha = await connect(), beta = await connect('beta')
    assert.equal(value(await call(alpha, 'foxwarm_node', { action: 'select', nodeId: 'external-cli' })).cwd, cwd)
    value(await concrete(alpha, 'write', { filePath: 'owned.txt', content: 'one' }))
    value(await concrete(alpha, 'edit', { filePath: 'owned.txt', oldText: 'one', newText: 'two' }))
    value(await concrete(alpha, 'apply_patch', { input: '*** Begin Patch\n*** Update File: owned.txt\n@@\n-two\n+three\n*** End Patch' }))
    assert.match(JSON.stringify(await concrete(alpha, 'read', { filePath: 'owned.txt' })), /three/)
    assert.equal(await readFile(join(cwd, 'owned.txt'), 'utf8'), 'three'); assert(!await exists(join(host.work, 'owned.txt')))
    const first = value(await command(alpha, 'mkdir next; cd next; printf foreground'))
    assert.equal(first.background, false); assert.equal(first.cwd, join(cwd, 'next'))
    assert.equal(value(await call(alpha, 'foxwarm_node', { action: 'status' })).cwd, join(cwd, 'next'))
    const firstWire = execCall(first.execId)
    assert.equal(firstWire.owner.externalId, 'alpha'); assert.equal(firstWire.owner.contextId, alpha.transport.sessionId)
    assert.equal(firstWire.sessionId, undefined); assert.equal(firstWire.agentName, undefined)
    assert.match(firstWire.backgroundExecId, /^[a-z]+-[a-z]+$/); assert(firstWire.completionCapability)
    const running = value(await command(alpha, 'printf once >> effects; while [ ! -e go ]; do sleep .03; done; printf done >> effects', 1))
    assert(running.background)
    assert.equal(execCall(running.execId).sessionCwd, join(cwd, 'next'))
    assert((await call(beta, 'foxwarm_exec_result', { execId: running.execId })).isError)
    assert.equal(value(await call(alpha, 'foxwarm_exec_result', { execId: running.execId })).state, 'running')
    assert(wire.some(row => row.direction === 'main' && row.value.type === 'external_exec_result_request' && row.value.execId === running.execId), 'actual Main query caller was exercised')
    const next = join(cwd, 'next'); await writeFile(join(next, 'go'), '')
    const event = await until(() => wire.find(row => row.value.type === 'external_exec_completed' && row.value.execId === running.execId)?.value, 'actual signed completion')
    const ack = await until(() => wire.find(row => row.direction === 'main' && row.value.requestId === event.requestId)?.value, 'actual Main ACK')
    assert.equal(ack.ok, true); assert.equal(event.completionCapability, execCall(running.execId).completionCapability)
    assert.equal(value(await call(alpha, 'foxwarm_exec_result', { execId: running.execId })).state, 'completed')
    assert.equal(await readFile(join(next, 'effects'), 'utf8'), 'oncedone')
    // Main, not Node, rejects a wrong signed capability on the real completion/ACK path.
    const badOwner = await connect(); tamperNext = true
    const bad = value(await command(badOwner, 'sleep 1.3; printf real-effect', 1)); assert(bad.background)
    const badEvent = await until(() => wire.find(row => row.value.type === 'external_exec_completed' && row.value.execId === bad.execId)?.value, 'tampered completion reaches real Main')
    assert.equal((await until(() => wire.find(row => row.direction === 'main' && row.value.requestId === badEvent.requestId)?.value, 'real rejected ACK')).ok, false)
    assert.equal(badEvent.completionCapability, 'synthetic-tampered-grant')
    assert((JSON.parse(await readFile(join(contextRoot(badOwner.transport.sessionId), 'running.json'), 'utf8'))).execs.some(entry => entry.id === bad.execId))
    const badContext = badOwner.transport.sessionId
    await badOwner.transport.terminateSession()
    await until(async () => !await exists(contextRoot(badContext)), 'released rejected-ACK namespace settles', 12000)
    const retained = []
    for (let index = 0; index < 21; index++) retained.push(value(await command(alpha, 'printf retained-' + index)).execId)
    assert((await call(alpha, 'foxwarm_exec_result', { execId: retained[0] })).isError)
    assert.equal(value(await call(alpha, 'foxwarm_exec_result', { execId: retained.at(-1) })).state, 'completed')
    const release = value(await command(alpha, 'printf started > release-start; while [ ! -e release-go ]; do sleep .03; done; printf survived > survived', 1)); assert(release.background)
    const oldId = alpha.transport.sessionId, releasedRoot = contextRoot(oldId)
    assert(await exists(releasedRoot)); await alpha.transport.terminateSession()
    await until(() => wire.some(row => row.direction === 'main' && row.value.type === 'external_exec_release' && row.value.owner.contextId === oldId), 'actual Main release caller')
    assert(await exists(releasedRoot), 'release cannot delete live artifacts')
    await writeFile(join(next, 'release-go'), '')
    await until(() => exists(join(next, 'survived')), 'command survives real inbound DELETE')
    await until(async () => !await exists(releasedRoot), 'real release cleans only known settled namespace', 12000)
    const fresh = await connect(); assert((await call(fresh, 'foxwarm_exec_result', { execId: release.execId })).isError)
    const keep = value(await command(fresh, 'printf before-restart'))
    await host.stop(); await host.start(); await online()
    const restarted = await connect(); assert((await call(restarted, 'foxwarm_exec_result', { execId: keep.execId })).isError, 'Main restart does not restore context result authority')
    assert(!await exists(join(cwd, 'agents')), 'no external effect invented an Agent')
    assert(!host.output.includes(credential.authToken)); assert(!output.includes(credential.authToken))
    console.log(JSON.stringify({ pass: runtime, mainStarts: 2, cliStarts: 1, actualSignedAck: true, actualRejectedCapability: true, contextCwdQueryRelease: true, retainedExecutions: retained.length }))
  } finally {
    for (const owner of clients) await owner.client.close().catch(() => {})
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM'); await exited }
    for (const socket of sockets) socket.terminate()
    await new Promise(done => proxy.close(done)); await new Promise(done => proxyHttp.close(done))
    await host.cleanup()
  }
}
console.log('PASS ordinary Source/.NET Main inbound MCP driving actual external CLI files, reservation, cwd, query, signed/rejected ACK, retention, live release and restart authority')
