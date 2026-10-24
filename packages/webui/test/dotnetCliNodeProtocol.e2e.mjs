// Owned real CLI processes: Source-native comparison and connection/authentication consequences.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect as connectTcp } from 'node:net'
import { once } from 'node:events'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm, stat, symlink, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import WebSocket, { WebSocketServer } from 'ws'
import { until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const dll = resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')
const processes = [], servers = [], sockets = new Set(), replies = []
async function server(handler, options = {}) {
  const http = createServer(), ws = new WebSocketServer({ server: http, ...options })
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); servers.push({ http, ws })
  ws.on('connection', (socket, request) => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
    handler(socket, request)
  })
  return { origin: `http://127.0.0.1:${http.address().port}`, http, ws }
}
async function launch(name, host, args = [], source = false, environment = {}) {
  const cwd = join(root, name); await mkdir(cwd, { recursive: true })
  const env = { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents'), FOXWARM_NO_CONSOLE_LOG: '0', ...environment }
  const child = spawn(source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet'), [source ? resolve('packages/cli-node/dist/client.js') : dll, '--host', host, '--no-local-trigger', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const handle = { child, cwd, output: '' }; processes.push(handle)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { handle.output = (handle.output + bytes).slice(-30000) })
  child.on('error', error => { handle.output += error.stack })
  return handle
}
async function stop(handle) {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return
  const exited = once(handle.child, 'exit'); handle.child.kill('SIGTERM')
  await Promise.race([exited, sleep(4000).then(() => { if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGKILL') })]); await exited
}
function registered(socket, extra = { nodeProtocol: { negotiated: 3, master: { min: 1, max: 3 } } }, nodeId = 'wire') {
  socket.send(JSON.stringify({ type: 'registered', nodeId, ...extra }))
}
let serial = 0
async function request(socket, type, body) {
  const id = String(++serial), key = type === 'tool_call' ? 'callId' : 'transferId'
  socket.send(JSON.stringify({ type, [key]: id, ...body }))
  return until(() => { const index = replies.findIndex(reply => reply[key] === id); return index < 0 ? null : replies.splice(index, 1)[0] }, type + ':' + JSON.stringify(body), 15000)
}
const tool = (socket, name, args, extra = {}) => request(socket, 'tool_call', { tool: name, args, sessionId: 'main/fixture', agentName: 'main', ...extra })
function observe(socket) { socket.on('message', bytes => replies.push(JSON.parse(bytes))) }
function normalize(value, cwd) { return JSON.parse(JSON.stringify(value).replaceAll(cwd, '<root>').replaceAll(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<mtime>')) }
async function nativeCorpus(socket, cwd) {
  const agent = join(cwd, 'agents/main'); await mkdir(agent, { recursive: true })
  await writeFile(join(agent, 'mixed.txt'), 'first\r\nsecond\rthird\nlast')
  await writeFile(join(agent, 'large.bin'), Buffer.alloc(1024 * 1024 + 3, 0))
  await writeFile(join(agent, 'image.bin'), Buffer.from('89504e470d0a1a0a010203', 'hex'))
  await writeFile(join(agent, 'forged.png'), 'plain text, not pixels')
  await writeFile(join(agent, 'invalid.txt'), Buffer.from([0x61, 0xff, 0x0a]))
  const rows = []
  const take = async (name, args, extra = {}) => {
    const reply = await tool(socket, name, args, extra); delete reply.callId
    if (reply.error?.code) { assert.equal(typeof reply.error.message, 'string'); rows.push({ type: reply.type, code: reply.error.code }) }
    else rows.push(normalize(reply, cwd)); return reply
  }
  await take('read', { filePath: 'mixed.txt' }, { programmatic: true })
  await take('read', { filePath: 'mixed.txt///' }, { programmatic: true })
  await take('write', { filePath: 'trailing.txt/', content: 'created' })
  assert.equal(await readFile(join(agent, 'trailing.txt'), 'utf8'), 'created')
  await writeFile(join(agent, 'zero.txt'), '')
  await take('read', { filePath: 'zero.txt' }, { programmatic: true })
  if (process.platform === 'linux') {
    execFileSync('mkfifo', [join(agent, 'fifo')])
    await take('read', { filePath: 'fifo' }, { programmatic: true })
    await take('read', { filePath: '.' })
    for (const filePath of ['/dev/null', join(agent, 'fifo')]) {
      const refused = await request(socket, 'file_read_request', { filePath, agentName: 'main', restrictToAgentDir: false })
      assert.equal(refused.type, 'file_transfer_error'); assert.equal(refused.error, 'Not a file: ' + filePath)
      delete refused.transferId; rows.push(normalize(refused, cwd))
    }
  }
  await take('read', { filePath: 'missing.txt' })
  await take('read', { filePath: 'null\0path' })
  await take('read', { filePath: 'mixed.txt/child' })
  await take('write', { filePath: 'parents', content: 'not-a-directory' })
  await take('read', { filePath: 'parents/child' })
  await take('edit', { filePath: 'parents', oldText: 'not-', newText: 'a-' })
  await take('apply_patch', { input: '*** Begin Patch\n*** Delete File: parents\n*** End Patch' })
  await take('read', { filePath: 'mixed.txt', startLine: '2', endLine: '3' }, { programmatic: true })
  await take('read', { filePath: 'mixed.txt', startLine: 4, endLine: 2 }, { programmatic: true })
  await take('read', { filePath: 'large.bin' }, { programmatic: true })
  await take('read', { filePath: 'image.bin' }, { programmatic: true })
  await take('read', { filePath: 'forged.png' })
  await take('read', { filePath: 'invalid.txt' }, { programmatic: true })
  await take('write', { filePath: 'parents/child/file', content: 'blocked' })
  await take('write', { filePath: 'parents/child/file', content: 'first', createDirs: true })
  await take('write', { filePath: 'parents/child/file', content: 'blocked' })
  await take('edit', { filePath: 'parents/child/file', oldText: 'first', newText: "$$-$&-$`-$'-$1" })
  await take('read', { filePath: 'parents/child/file' }, { programmatic: true })
  await take('edit', { filePath: 'mixed.txt', oldText: '', newText: 'never' })
  await take('write', { filePath: 'empty.txt', content: '' })
  await take('edit', { filePath: 'empty.txt', oldText: '', newText: 'empty-became-text' })
  await take('apply_patch', { input: '*** Begin Patch\n*** Add File: added.txt\n+added-without-newline\n*** Update File: mixed.txt\n@@\n-first\n+FIRST\n*** End Patch' })
  await take('apply_patch', { input: '*** Begin Patch\n*** Add File: partial.txt\n+kept\n*** Update File: absent\n-old\n+new\n*** Add File: never\n+never\n*** End Patch' })
  await take('apply_patch', { input: 'not a patch' })
  await take('apply_patch', { input: '*** Begin Patch\n*** Add File: parse-must-not-write\n+never\n*** Update File: empty-update\n*** End Patch' })
  await assert.rejects(readFile(join(agent, 'parse-must-not-write')), { code: 'ENOENT' })
  await take('apply_patch', { input: '*** Begin Patch\n*** Update File: mixed.txt\n context only\n*** End Patch' })
  await writeFile(join(agent, 'anchors.txt'), 'anchor\nfirst\nanchor\nlast')
  await take('apply_patch', { input: '*** Begin Patch\n*** Update File: anchors.txt\n@@ anchor\n-first\n+FIRST\n@@ anchor\n-anchor\n+SECOND\n*** End Patch' })
  await take('read', { filePath: 'anchors.txt' }, { programmatic: true })
  await writeFile(join(agent, 'eof.txt'), 'a\nb')
  await take('apply_patch', { input: '*** Begin Patch\n*** Update File: eof.txt\n@@\n a\n+X\n b\n@@\n-b\n+B\n*** End of File\n*** End Patch' })
  await take('read', { filePath: 'eof.txt' }, { programmatic: true })
  await take('read', { filePath: '$fw_agentdir/added.txt' })
  await take('read', { filePath: '$unsupported/file' })
  await take('write', { filePath: 'no-content', contentRef: 'not-a-cli-input' })
  await take('get_default_cwd', {})
  await take('read', { filePath: 'mixed.txt' }, { sessionCwd: agent, programmatic: true })
  for (const name of ['added.txt', 'partial.txt', 'mixed.txt', 'parents/child/file']) rows.push(await readFile(join(agent, name), 'utf8'))
  await symlink(join(agent, 'mixed.txt'), join(agent, 'link.txt'))
  await take('read', { filePath: 'link.txt/' }, { programmatic: true })
  await take('write', { filePath: 'link.txt', content: 'followed', overwrite: true })
  rows.push(await readFile(join(agent, 'mixed.txt'), 'utf8'))
  for (const entry of ['mixed.txt', 'image.bin', 'forged.png', 'invalid.txt', 'empty.txt', 'added.txt', 'partial.txt', 'large.bin']) await utimes(join(agent, entry), 1, 1)
  await take('read', { filePath: 'parents' })
  const bytes = Buffer.from(Array.from({ length: 1024 * 1024 + 7 }, (_, i) => i % 256))
  const transfer = await request(socket, 'file_write_request', { filePath: 'transfer.bin', agentName: 'main', dataBase64: bytes.toString('base64'), restrictToAgentDir: true })
  delete transfer.transferId; rows.push(normalize(transfer, cwd)); assert.deepEqual(await readFile(join(agent, 'transfer.bin')), bytes)
  const back = await request(socket, 'file_read_request', { filePath: 'transfer.bin', agentName: 'main', restrictToAgentDir: true })
  assert.equal(back.file.dataBase64, bytes.toString('base64')); delete back.transferId; rows.push(normalize(back, cwd))
  const trailing = await request(socket, 'file_read_request', { filePath: 'trailing.txt///', agentName: 'main', restrictToAgentDir: true })
  assert.equal(trailing.file.name, 'trailing.txt'); assert.equal(trailing.file.mimeType, 'text/plain')
  delete trailing.transferId; rows.push(normalize(trailing, cwd))
  const empty = await request(socket, 'file_write_request', { filePath: 'empty-transfer.txt/', agentName: 'main', dataBase64: '', restrictToAgentDir: true })
  assert.equal(empty.result.absolutePath, join(agent, 'empty-transfer.txt')); assert.equal((await stat(join(agent, 'empty-transfer.txt'))).size, 0)
  delete empty.transferId; rows.push(normalize(empty, cwd))
  const refused = await request(socket, 'file_write_request', { filePath: '../outside', agentName: 'main', dataBase64: 'eA', restrictToAgentDir: true })
  delete refused.transferId; rows.push(refused)
  // Transfer overwrite replaces the final symlink rather than following it.
  const receipt = await request(socket, 'file_write_request', { filePath: 'link.txt', agentName: 'main', dataBase64: 'e A-_!?', overwrite: true })
  delete receipt.transferId; rows.push(normalize(receipt, cwd)); assert.equal(await readFile(join(agent, 'mixed.txt'), 'utf8'), 'followed')
  return rows
}
try {
  const connected = new Map(), capabilities = new Map()
  const main = await server((socket, request) => {
    const url = new URL(request.url, 'http://owned'), id = url.searchParams.get('id')
    if (id === 'native') assert.equal(url.pathname, '/deployment/node_ws')
    socket.on('message', bytes => { const frame = JSON.parse(bytes); if (frame.type === 'node_register') { capabilities.set(id, frame.capabilities); connected.set(id, socket); registered(socket, undefined, id) } })
    observe(socket)
  })
  const source = await launch('source', main.origin, ['--id', 'source', '--auth-token', 'source-only'], true)
  await until(() => connected.get('source'), 'Source client register')
  const native = await launch('native', main.origin + '/deployment', ['--id', 'native', '--auth-token', 'native-only', '--credentials-file', join(root, 'native/credentials.json')])
  await until(() => connected.get('native'), 'new CLI register')
  assert.deepEqual(capabilities.get('native').tools.map(tool => tool.name), ['read', 'write', 'edit', 'apply_patch', 'exec', 'get_default_cwd', 'browse_open', 'browse_list', 'browse_get', 'browse_close', 'browse_interact'])
  assert.deepEqual(capabilities.get('native').features, { programmaticToolData: true, execWaitCancellation: true, remoteExecBackgroundRegistration: true, externalToolOwner: 1 }); assert.deepEqual(capabilities.get('native').services, { 'vscode-fs': 1, 'vscode-git': 2, 'vscode-pty': 1 })
  assert.deepEqual(await nativeCorpus(connected.get('native'), native.cwd), await nativeCorpus(connected.get('source'), source.cwd))
  assert.equal((await stat(join(native.cwd, 'credentials.json'))).mode & 0o777, 0o600)
  await stop(source); await stop(native)

  // Explicit credentials override a stale file and are persisted only after registration.
  const queries = [], states = []
  const auth = await server((socket, request) => {
    queries.push(request.url); observe(socket)
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes)
      if (frame.type === 'pair_request') { states.push('pair'); socket.send(JSON.stringify({ type: 'pair_pending', pendingId: 'owned-pending' })); socket.send(JSON.stringify({ type: 'pair_approved', nodeId: 'approved', authToken: 'approved-secret' })) }
      if (frame.type === 'node_register') { states.push('auth'); registered(socket, undefined, new URL(request.url, 'http://owned').searchParams.get('id')) }
    })
  })
  const credentialPath = join(root, 'precedence/credentials.json'); await mkdir(join(root, 'precedence')); await writeFile(credentialPath, JSON.stringify({ nodeId: 'stale', authToken: 'stale-secret' }))
  let client = await launch('precedence', auth.origin, ['--id', 'explicit', '--auth-token', 'explicit-secret', '--credentials-file', credentialPath])
  await until(() => states.length === 1, 'explicit registration'); await until(async () => JSON.parse(await readFile(credentialPath, 'utf8')).nodeId === 'explicit', 'saved explicit credential')
  assert(queries[0].includes('id=explicit&auth=explicit-secret')); assert(!client.output.includes('explicit-secret')); await stop(client)
  client = await launch('precedence', auth.origin, ['--credentials-file', credentialPath]); await until(() => states.length === 2, 'file-only restart'); assert(queries[1].includes('id=explicit&auth=explicit-secret')); await stop(client)
  client = await launch('pairing', auth.origin, ['--id', 'requested', '--token', 'pair-secret', '--credentials-file', join(root, 'pairing/credentials.json')])
  await until(() => states.length === 4, 'pair then authenticated reconnect'); assert(queries[2].includes('token=pair-secret')); assert(queries[3].includes('id=approved&auth=approved-secret')); assert(client.output.includes('/node approve owned-pending')); assert(!client.output.includes('pair-secret')); assert(!client.output.includes('approved-secret')); await stop(client)

  let fallbackConnections = 0
  const fallback = await server((socket, request) => {
    fallbackConnections++
    const url = new URL(request.url, 'http://owned')
    if (url.searchParams.get('auth') === 'expired') { socket.close(1008, 'Invalid node credentials'); return }
    socket.on('message', bytes => {
      const frame = JSON.parse(bytes)
      if (frame.type === 'pair_request') socket.send(JSON.stringify({ type: 'pair_approved', nodeId: 'replacement', authToken: 'replacement-secret' }))
      if (frame.type === 'node_register') registered(socket, undefined, 'replacement')
    })
  })
  client = await launch('fallback', fallback.origin, ['--id', 'old', '--auth-token', 'expired', '--token', 'fallback-pair', '--credentials-file', join(root, 'fallback/credentials.json')])
  await until(async () => fallbackConnections === 3 && await readFile(join(client.cwd, 'credentials.json'), 'utf8').then(text => JSON.parse(text).nodeId === 'replacement', () => false), 'invalid credentials fall back through real reconnect', 12000); await stop(client)

  for (const kind of ['invalid', 'rejected']) {
    let count = 0
    const rejected = await server(socket => { count++; socket.once('message', () => { if (kind === 'invalid') registered(socket, { nodeProtocol: { negotiated: 1, master: { min: 1, max: 3 } } }); else socket.send(JSON.stringify({ type: 'pair_rejected', pendingId: 'rejected' })); socket.close(1008, kind) }) })
    client = await launch(kind, rejected.origin, kind === 'invalid' ? ['--id', 'wire', '--auth-token', 'not-saved', '--credentials-file', join(root, kind, 'credentials.json')] : ['--token', 'rejected-pair'])
    await until(() => count === 1, kind + ' connected'); await sleep(5500); assert.equal(count, 1); assert.match(client.output, kind === 'invalid' ? /protocol_incompatible/ : /pair_rejected/); await stop(client)
  }

  // A disconnected operation may finish its effect, but never responds through a replacement connection.
  if (process.platform === 'linux') {
    let connectionCount = 0, active
    const reconnect = await server(socket => { connectionCount++; active = socket; observe(socket); socket.once('message', () => registered(socket)); })
    client = await launch('ownership', reconnect.origin, ['--id', 'wire', '--auth-token', 'owned'])
    await until(() => connectionCount === 1, 'ownership initial connection')
    const fifo = join(client.cwd, 'pipe'); execFileSync('mkfifo', [fifo]); active.send(JSON.stringify({ type: 'tool_call', callId: 'old-effect', tool: 'write', args: { filePath: fifo, content: 'once', overwrite: true } }))
    await sleep(250); active.terminate(); await until(() => connectionCount === 2, 'replacement connection', 10000)
    assert.equal(await readFile(fifo, 'utf8'), 'once'); await sleep(300); assert(!replies.some(reply => reply.callId === 'old-effect')); await stop(client)
  }

  // Actual ClientWebSocket proxy path: standard environment precedence, credentials and safe logs.
  let proxyCalls = 0
  const target = await server(socket => { socket.once('message', () => registered(socket)) })
  const proxy = createServer(); servers.push({ http: proxy })
  proxy.on('connect', (request, down, head) => {
    if (request.headers['proxy-authorization'] !== 'Basic ' + Buffer.from('proxy-user:proxy-secret').toString('base64')) { down.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="owned"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return }
    proxyCalls++
    const up = connectTcp(new URL(target.origin).port, '127.0.0.1', () => { down.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) up.write(head); down.pipe(up); up.pipe(down) }); sockets.add(up); sockets.add(down)
    for (const socket of [up, down]) { socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)) }
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  client = await launch('proxy', 'http://owned.invalid', ['--id', 'wire', '--auth-token', 'proxy-owned'], false, { http_proxy: `http://proxy-user:proxy-secret@127.0.0.1:${proxy.address().port}`, HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '', no_proxy: '', npm_config_no_proxy: '', npm_config_http_proxy: '', npm_config_proxy: '', all_proxy: '', ALL_PROXY: '' })
  await until(() => client.output.includes('[registered]'), 'proxy-authenticated registration'); assert(proxyCalls > 0); assert(!client.output.includes('proxy-secret')); await stop(client)

  // A stale peer that never PONGs must be replaced, not kept alive indefinitely.
  let heartbeatConnections = 0
  const heartbeat = await server(socket => { heartbeatConnections++; socket.once('message', () => registered(socket)) }, { autoPong: false })
  client = await launch('heartbeat', heartbeat.origin, ['--id', 'wire', '--auth-token', 'heartbeat-owned'])
  await until(() => heartbeatConnections === 2, 'stale heartbeat reconnect', 52000); await stop(client)
  console.log('New CLI: exact Source-native corpus, real auth/persistence/pairing/fallback, incompatible/rejected reconnect suppression, connection ownership, authenticated environment proxy and stale-peer heartbeat passed.')
} catch (error) { console.error(processes.map(process => process.output).join('\n')); throw error }
finally {
  for (const process of processes) await stop(process)
  for (const socket of sockets) socket.terminate?.() ?? socket.destroy?.()
  for (const { http, ws } of servers) { ws?.close(); http.closeAllConnections(); await new Promise(done => http.close(done)) }
  await rm(root, { recursive: true, force: true })
}
