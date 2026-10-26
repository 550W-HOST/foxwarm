// Normal Main, official MCP clients/peer, real durable Session ingress, and unchanged CLI Node.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const options = { normalStartup: true, env: {} }
const host = await createHostFixture('inbound-mcp', options)
const prefix = '/external/main'
options.publicRoot = host.origin + prefix + '/'
const alphaToken = 'synthetic-external-alpha', betaToken = 'synthetic-external-beta'
const children = [], clients = [], streams = [], modelRequests = [], errors = [], sockets = []
const ruleInstalls = new Map()
let ruleSerial = 0
const exists = file => access(file).then(() => true, () => false)
const app = (identities = {}, webui = true) => ({ url: host.origin + prefix, bot: { httpPort: host.port, enableWebUI: webui }, access: { identities } })
const identities = { alpha: { token: alphaToken, surfaces: { mcp: {}, webui: { sessions: ['target'] } } }, beta: { token: betaToken, surfaces: { mcp: {} } } }
let current = app()
const model = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text); modelRequests.push(body)
    const marker = [...JSON.stringify(body.input).matchAll(/INSTALL-RULES-(\d+)/g)].at(-1)?.[1]
    const install = marker && ruleInstalls.get(marker)
    const already = install && body.input.some(item => item.type === 'function_call' && item.call_id === 'rules-' + marker)
    const output = install && !already ? [{ type: 'function_call', call_id: 'rules-' + marker, name: 'set_config', arguments: JSON.stringify({ target: 'tool-rules', filePath: install }) }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DURABLY-RECEIVED' }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 20, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.destroy() }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify(current))
await writeFile(join(host.data, 'state/tool-authorization.yaml'), 'version: 1\nrules:\n  - id: external\n    action: allow\n    match: {externalId: [alpha, beta]}\n')
const peerRoot = join(host.root, 'peer'); await mkdir(peerRoot)
const peer = spawn(process.execPath, [resolve('dotnet/Foxwarm.Tests/Mcp/Fixtures/outbound-peer.mjs'), 'http', peerRoot], { stdio: ['ignore', 'pipe', 'pipe'] })
children.push(peer)
let peerOutput = ''; peer.stdout.on('data', data => { peerOutput += data }); peer.stderr.on('data', data => errors.push(String(data)))
await until(() => peerOutput.includes('\n'), 'independent official outbound peer')
const peerUrl = JSON.parse(peerOutput.trim().split('\n')[0]).url
await writeFile(join(host.data, 'state/mcp.json'), JSON.stringify({ servers: { peer: { url: peerUrl + '/mcp', transport: 'streamable-http', token: 'synthetic-known-outbound-credential', env: { ORDINARY: 'ordinary-environment-value' }, headers: { 'X-Ordinary': 'ordinary-header-value' } } } }))
const events = async () => (await fetch(peerUrl + '/events')).json()
async function api(token, method, path, body) {
  const response = await fetch(host.origin + prefix + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const admin = (method, path, body) => api(host.token, method, path, body)
async function install(next) {
  const result = await admin('POST', '/api/setup/config', { yaml: JSON.stringify(next) })
  assert.equal(result.status, 200, JSON.stringify(result))
  assert(result.body.applied.includes('access.surfaces.mcp')); assert(!result.body.notApplied.includes('access.surfaces.mcp'))
  current = next
}
async function installRules(yaml) {
  const key = String(++ruleSerial), path = join(host.work, 'rules-' + key + '.yaml')
  await writeFile(path, yaml); ruleInstalls.set(key, path)
  assert.equal((await admin('POST', '/api/sessions/target/message', { text: 'INSTALL-RULES-' + key })).status, 202)
  await until(async () => (await readFile(join(host.data, 'state/tool-authorization.yaml'), 'utf8')) === yaml, 'real internal set_config installs rules')
  await until(async () => !(await admin('GET', '/api/sessions/target/history')).body.session.busy, 'policy installation turn settled')
}
async function connect(token = alphaToken) {
  const transport = new StreamableHTTPClientTransport(new URL(host.origin + prefix + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + token } } })
  const client = new Client({ name: 'official-inbound-qualification', version: '1' })
  client.onerror = () => {} // Disconnected GET and explicitly deleted contexts are expected here.
  await client.connect(transport)
  const owner = { client, transport, token }; clients.push(owner); return owner
}
const call = (owner, name, args = {}) => owner.client.callTool({ name, arguments: args })
const concrete = (owner, toolId, args = {}) => call(owner, 'foxwarm_call', { toolId, args })
const value = result => { assert(!result.isError, JSON.stringify(result)); return result.structuredContent ?? JSON.parse(result.content[0].text) }
const rawText = result => result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n')
async function deleteOwner(owner) { await owner.transport.terminateSession() }
async function get(owner, waitForRelease = false) {
  const controller = new AbortController()
  const open = async () => {
    const response = await fetch(host.origin + prefix + '/mcp', { headers: { authorization: 'Bearer ' + owner.token, accept: 'text/event-stream', 'mcp-session-id': owner.transport.sessionId, 'mcp-protocol-version': '2025-11-25' }, signal: controller.signal })
    if (!waitForRelease || response.status === 200) return response
    const body = await response.text()
    assert.equal(response.status, 409, body)
    assert.deepEqual(JSON.parse(body), { error: 'MCP SSE stream already open.' }, body)
    return false
  }
  const response = waitForRelease ? await until(open, 'previous physical MCP GET releases its attachment') : await open()
  const state = { controller, response, ended: false }
  state.reading = (async () => { try { for await (const _ of response.body) {} } catch {} finally { state.ended = true } })()
  streams.push(state); return state
}
async function command(owner, command, timeout = 15) { return concrete(owner, 'node:official-external/exec', { command, timeout }) }
try {
  await host.start()
  assert.equal((await admin('POST', '/api/sessions', { agentId: 'main', sessionId: 'target' })).status, 200)
  assert.equal((await api(alphaToken, 'POST', '/mcp', {})).status, 401, 'empty-map endpoint starts without accepting a credential')
  await install(app(identities))
  const alpha = await connect(), beta = await connect(betaToken), sameIdentityOtherContext = await connect()
  assert.equal((await alpha.client.listTools()).tools.length, 5)
  assert.equal(alpha.client.getServerCapabilities().experimental['foxwarm/session-notifications'].version, 1)
  const discovery = value(await call(alpha, 'foxwarm_discover', { limit: 50 }))
  assert(discovery.tools.some(tool => tool.toolId === 'builtin:node_pair_approve'))
  assert(discovery.tools.some(tool => tool.toolId === 'mcp:peer/probe'))
  assert(!discovery.tools.some(tool => tool.toolId.includes('unsafe_descriptor')), 'known-credential descriptor is omitted whole')
  const first = value(await concrete(alpha, 'mcp:peer/probe', { tag: 'first' })).id
  assert.equal(value(await concrete(alpha, 'mcp:peer/probe', { tag: 'again' })).id, first)
  assert.notEqual(value(await concrete(beta, 'mcp:peer/probe')).id, first)
  assert.notEqual(value(await concrete(sameIdentityOtherContext, 'mcp:peer/probe')).id, first)
  for (const kind of ['duplicate', 'image', 'error', 'meta', 'audio', 'resource', 'opaque']) {
    const result = await concrete(alpha, 'mcp:peer/result', { kind })
    if (kind === 'duplicate') { assert.equal(result.content.length, 1); assert(result.structuredContent) }
    if (kind === 'image') { assert.equal(result.content[1].type, 'image'); assert(result.content[1]._meta.imageNote) }
    if (kind === 'error') assert.equal(result.isError, true)
    if (kind === 'meta') assert.equal(result._meta.retained, true)
    if (kind === 'opaque') assert.equal(result.customTag.retained, true)
  }
  for (const [index, rawResult] of [{ content: 'invalid-content', isError: 'not-a-boolean' }, { content: [null] }].entries()) {
    const tag = 'malformed-effect-' + index
    const result = await concrete(alpha, 'mcp:peer/result', { rawResult, tag })
    assert.equal(result.isError, true); assert.match(rawText(result), /outcome may be unknown/); assert.match(rawText(result), /do not retry automatically/)
    assert.equal((await events()).filter(event => event.kind === 'effect' && event.tag === tag).length, 1)
  }
  assert.equal((await alpha.client.listTools()).tools.length, 5, 'malformed downstream output does not retire the initialized context')
  const validProtocol = await concrete(alpha, 'mcp:peer/result', { rawResult: { content: [{ type: 'text', text: 'business extension', isError: 'business' }, { type: 'image', data: 'AA', mimeType: 'image/png' }, { type: 'resource_link', uri: 'ordinary-resource', name: 'resource', size: 'business' }], customTag: { retained: true } }, tag: 'valid-protocol-effect' })
  assert.equal(validProtocol.content[1].data, 'AA'); assert.equal(validProtocol.customTag.retained, true)
  assert.equal((await events()).filter(event => event.kind === 'effect' && event.tag === 'valid-protocol-effect').length, 1)
  const secret = await concrete(alpha, 'mcp:peer/result', { kind: 'credential', tag: 'secret-effect' })
  assert(secret.isError); assert.match(rawText(secret), /withheld/); assert(!JSON.stringify(secret).includes('synthetic-known-outbound-credential'))
  assert.equal((await events()).filter(event => event.kind === 'effect' && event.tag === 'secret-effect').length, 1)
  const ordinary = await concrete(alpha, 'mcp:peer/result', { kind: 'ordinary', value: 'ordinary-environment-value' })
  assert(rawText(ordinary).includes('/ordinary/path')); assert(rawText(ordinary).includes('ordinary-environment-value'))
  assert.equal((await api(alphaToken, 'GET', '/api/setup/status')).status, 403, 'MCP/WebUI surface does not grant admin')
  assert.equal((await api(alphaToken, 'GET', '/api/auth/session')).body.role, 'webui')
  const listed = value(await call(alpha, 'foxwarm_session', { action: 'list', count: 1 })); assert.equal(listed.count, 1)
  const emptyRead = value(await call(alpha, 'foxwarm_session', { action: 'read', sessionId: 'target', count: 10 })); assert.equal(emptyRead.count, 0); assert.equal(emptyRead.total, 0)
  const sent = value(await call(alpha, 'foxwarm_session', { action: 'send', sessionId: 'target', message: 'EXTERNAL-INPUT-ONCE', allowReply: false })); assert.equal(sent.accepted, true)
  const saved = await until(async () => {
    const state = JSON.parse(await readFile(join(host.data, 'state/sessions/target.json'), 'utf8'))
    return state.history.some(row => row.parts?.some(part => part.text === 'DURABLY-RECEIVED')) && state
  }, 'actual accepted input persisted and normal turn answered')
  const external = saved.history.find(row => row.parts?.some(part => part.text === 'EXTERNAL-INPUT-ONCE'))
  assert(external.parts.some(part => part.system?.includes('kind="external-input"'))); assert(!external.sourceSessionId); assert(!external.source)
  assert(modelRequests.some(request => JSON.stringify(request.input).includes('EXTERNAL-INPUT-ONCE')))
  const read = value(await call(alpha, 'foxwarm_session', { action: 'read', sessionId: 'target', start: -2, count: 2, previewLength: 1000 }))
  assert.match(read.preview, /EXTERNAL-INPUT-ONCE/); assert(!read.messages); assert(!read.queue); assert(!read.persistentMemorySnapshot)
  for (const args of [{ allowReply: true }, { reply: true }, { allowReply: false, reply: true }])
    assert((await call(alpha, 'foxwarm_session', { action: 'send', sessionId: 'target', message: 'MUST-NOT-QUEUE', ...args })).isError)

  // Real existing pairing handshake: no credential is exported by the external wrapper.
  for (const [nodeId, version, feature] of [['v2-external', 2, 1], ['missing-external-feature', 3, undefined]]) {
    const credential = (await admin('POST', '/api/nodes/onboarding/create', { fallbackUrl: host.origin + prefix, nodeId })).body
    const ws = new WebSocket(host.origin.replace('http:', 'ws:') + prefix + '/node_ws?id=' + encodeURIComponent(nodeId) + '&auth=' + encodeURIComponent(credential.authToken))
    sockets.push(ws); const frames = []; ws.on('message', bytes => frames.push(JSON.parse(bytes)))
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'node_register', nodeType: 'cli', nodeProtocol: { min: version, max: version }, capabilities: { tools: [{ name: 'read', parameters: { type: 'object' } }], features: feature === undefined ? {} : { externalToolOwner: feature } } }))
    await until(() => frames.some(frame => frame.type === 'registered'), 'authenticated incompatible external-owner capability gate')
    assert((await concrete(alpha, 'node:' + nodeId + '/read', { filePath: 'must-not-dispatch' })).isError)
    assert(!frames.some(frame => frame.type === 'tool_call'), 'v3 and externalToolOwner must both negotiate before dispatch')
    ws.close(); await once(ws, 'close')
  }
  const remote = join(host.root, 'official-cli'); await mkdir(remote)
  const credentialPath = join(remote, 'credentials.json')
  const pairing = (await readFile(join(host.data, 'state/node_token'), 'utf8')).trim()
  const cli = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', host.origin + prefix, '--id', 'official-external', '--token', pairing, '--credentials-file', credentialPath, '--no-local-trigger'], { cwd: remote, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_AGENTS_DIR: join(remote, 'agents') } })
  children.push(cli); let cliOutput = ''; cli.stdout.on('data', data => { cliOutput += data }); cli.stderr.on('data', data => { cliOutput += data })
  const pending = await until(async () => value(await concrete(alpha, 'builtin:node_pair_list')).requests.find(item => item.requestedName === 'official-external'), 'actual pending official CLI')
  const approved = value(await concrete(alpha, 'builtin:node_pair_approve', { pendingId: pending.id }))
  assert.equal(approved.nodeId, 'official-external'); assert(!JSON.stringify(approved).includes('authToken')); assert(!JSON.stringify(approved).includes(pairing))
  await until(async () => value(await call(alpha, 'foxwarm_node', { action: 'list' })).nodes.includes('official-external'), 'authenticated v3 external-owner CLI capabilities')
  await installRules('version: 1\nrules:\n  - id: list\n    action: allow\n    match:\n      externalId: alpha\n      tool: {source: builtin, name: node}\n  - id: read-only\n    action: allow\n    match:\n      externalId: alpha\n      tool: {source: node, name: read}\n')
  assert.deepEqual(value(await call(alpha, 'foxwarm_discover', { sources: ['node'] })).tools.map(tool => tool.name), ['read'])
  assert.deepEqual(value(await call(alpha, 'foxwarm_node', { action: 'list' })).nodes, ['official-external'], 'only permitted IDs, no hidden capability descriptors')
  assert((await concrete(alpha, 'node:official-external/exec', { command: 'printf forbidden > forbidden-exec' })).isError)
  assert(!await exists(join(remote, 'forbidden-exec'))); assert(!await exists(join(host.work, 'forbidden-exec')))
  await installRules('version: 1\nrules:\n  - id: external\n    action: allow\n    match: {externalId: [alpha, beta]}\n')
  const selected = value(await call(alpha, 'foxwarm_node', { action: 'select', nodeId: 'official-external' })); assert.equal(selected.cwd, remote)
  value(await concrete(alpha, 'node:official-external/write', { filePath: 'owned.txt', content: 'one' }))
  value(await concrete(alpha, 'node:official-external/edit', { filePath: 'owned.txt', oldText: 'one', newText: 'two' }))
  value(await concrete(alpha, 'node:official-external/apply_patch', { input: '*** Begin Patch\n*** Update File: owned.txt\n@@\n-two\n+three\n*** End Patch' }))
  assert.match(JSON.stringify(await concrete(alpha, 'node:official-external/read', { filePath: 'owned.txt' })), /three/)
  assert.equal(await readFile(join(remote, 'owned.txt'), 'utf8'), 'three'); assert(!await exists(join(host.work, 'owned.txt')))
  const partialPatch = await concrete(alpha, 'node:official-external/apply_patch', { input: '*** Begin Patch\n*** Add File: partial-effect.txt\n+first committed\n*** Update File: missing-after-first.txt\n@@\n-old\n+new\n*** End Patch' })
  assert(partialPatch.isError); assert.match(rawText(partialPatch), /effects may have occurred/)
  assert.equal(await readFile(join(remote, 'partial-effect.txt'), 'utf8'), 'first committed')
  assert(!await exists(join(host.work, 'partial-effect.txt')))
  const foreground = value(await command(alpha, 'mkdir -p next; cd next; printf foreground'))
  assert.equal(foreground.background, false); assert.match(foreground.output, /foreground/)
  assert.equal(value(await call(alpha, 'foxwarm_node', { action: 'status' })).cwd, join(remote, 'next'))
  const running = value(await command(alpha, 'printf partial; sleep 2; printf complete', 1)); assert.equal(running.background, true)
  assert((await call(beta, 'foxwarm_exec_result', { execId: running.execId })).isError)
  const partial = value(await call(alpha, 'foxwarm_exec_result', { execId: running.execId })); assert.match(partial.output, /partial/)
  const completed = await until(async () => { const result = value(await call(alpha, 'foxwarm_exec_result', { execId: running.execId })); return result.state === 'completed' && result }, 'signed actual CLI completion')
  assert.match(completed.output, /complete/)
  const allowRules = '  - id: external\n    action: allow\n    match: {externalId: [alpha, beta]}\n'
  await installRules('version: 1\nrules:\n  - id: deny-original-exec\n    action: deny\n    match:\n      externalId: alpha\n      tool: {source: node, name: exec}\n      targetNode: official-external\n      args: {command: "printf partial; sleep 2; printf complete"}\n' + allowRules)
  assert((await call(alpha, 'foxwarm_exec_result', { execId: running.execId })).isError, 'actual stored result rechecks original exec arguments under current policy')
  await installRules('version: 1\nrules:\n' + allowRules)
  assert.equal(value(await call(alpha, 'foxwarm_exec_result', { execId: running.execId })).state, 'completed')
  assert(value(await call(alpha, 'foxwarm_exec_result')).executions.some(item => item.execId === running.execId))
  const otherRemote = join(host.root, 'other-cli'); await mkdir(otherRemote)
  const otherCredential = (await admin('POST', '/api/nodes/onboarding/create', { fallbackUrl: host.origin + prefix, nodeId: 'other-external' })).body
  const otherCli = spawn(process.execPath, [resolve('packages/cli-node/dist/client.js'), '--host', host.origin + prefix, '--id', 'other-external', '--auth-token', otherCredential.authToken, '--credentials-file', join(otherRemote, 'credentials.json'), '--no-local-trigger'], { cwd: otherRemote, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_AGENTS_DIR: join(otherRemote, 'agents') } })
  children.push(otherCli); otherCli.stdout.on('data', () => {}); otherCli.stderr.on('data', () => {})
  await until(async () => value(await call(alpha, 'foxwarm_node', { action: 'list' })).nodes.includes('other-external'), 'second actual CLI owner')
  const lateCwd = value(await command(alpha, 'sleep 2; cd ..; printf late-cwd', 1))
  assert(lateCwd.background)
  assert.equal(value(await call(alpha, 'foxwarm_node', { action: 'select', nodeId: 'other-external' })).cwd, otherRemote)
  await until(async () => value(await call(alpha, 'foxwarm_exec_result', { execId: lateCwd.execId })).state === 'completed', 'old Node completion after new selection')
  assert.equal(value(await call(alpha, 'foxwarm_node', { action: 'status' })).cwd, otherRemote, 'old generation cannot overwrite successor cwd')
  value(await call(alpha, 'foxwarm_node', { action: 'select', nodeId: 'official-external' }))
  value(await command(alpha, 'cd next; printf restore-selected-cwd'))
  const survives = value(await command(alpha, 'sleep 2; printf survived > survive-context', 1)); assert(survives.background)
  const alphaContextId = alpha.transport.sessionId
  const releasedRoot = join(remote, 'external-exec', createHash('sha256').update('alpha').digest('hex'), alphaContextId)
  assert(await exists(releasedRoot), 'real CLI external namespace exists before release')
  await deleteOwner(alpha)
  await until(() => exists(join(remote, 'next/survive-context')), 'started command survives inbound DELETE')
  assert.equal((await events()).filter(event => event.kind === 'delete' && event.id === first).length, 1, 'DELETE awaits selected downstream binding cleanup')
  const fresh = await connect(); assert((await call(fresh, 'foxwarm_exec_result', { execId: survives.execId })).isError, 'new context cannot reconstruct artifacts')
  await until(async () => !await exists(releasedRoot), 'real released CLI context artifacts are retired after surviving process exits')

  // Same initialized context accepts new physical GETs, with no replay header or initialize.
  // Local close/abort can finish before remote attachment release; observe only its existing admission conflict.
  // Official JS already owns its automatic GET. Close it, then use independently authenticated physical requests.
  const raw = await connect()
  await raw.transport.close()
  for (let index = 0; index < 3; index++) {
    const stream = await get(raw, true); assert.equal(stream.response.status, 200)
    const duplicate = await get(raw); assert.equal(duplicate.response.status, 409)
    stream.controller.abort(); await stream.reading
  }
  assert.equal((await api(betaToken, 'DELETE', '/mcp')).status, 400)
  await install(app({ ...identities, alpha: { ...identities.alpha, surfaces: { mcp: {}, webui: { sessions: ['main/*'] } } } }))
  assert.equal((await beta.client.listTools()).tools.length, 5)
  await install(app({ beta: identities.beta }))
  assert.equal((await api(alphaToken, 'POST', '/mcp', {})).status, 401)
  assert.equal((await beta.client.listTools()).tools.length, 5, 'unaffected sibling remains initialized')
  await install(app())
  assert.equal((await api(betaToken, 'POST', '/mcp', {})).status, 401, 'last identity removal is hot without restart')
  assert.equal((await admin('GET', '/api/auth/session')).body.role, 'admin')
  await host.stop()
  // Headless activation uses the same listener/Node/bootstrap and does not construct a WebUI channel.
  await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify(app(identities, false)))
  await host.start()
  const headless = await connect(); assert.equal((await headless.client.listTools()).tools.length, 5)
  assert(value(await call(headless, 'foxwarm_session', { action: 'list' })).sessions.some(item => item.id === 'target'))
  assert.equal((await admin('GET', '/api/auth/session')).status, 404)
  assert.equal((await fetch(host.origin + prefix + '/node/run.sh')).status, 200)
  await deleteOwner(headless)
  await host.stop()
  assert.deepEqual(errors, [])
  console.log('PASS normal Main: official JS SDK, all five wrappers, independent peer/raw results/known-secret fence, live activation/revocation, actual durable local Session, real paired v3 CLI files/exec/signed completion/release, no post-effect replay, headless restart')
} finally {
  for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  for (const stream of streams) { stream.controller.abort(); await stream.reading.catch(() => {}) }
  for (const owner of clients) await owner.client.close().catch(() => {})
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit').catch(() => {}); child.kill('SIGTERM'); await exited }
  await new Promise(done => model.close(done))
  await host.cleanup()
}
