// Owned host and unchanged official CLI: an old list reply must not detach a newer live PTY.
// Run from the repository root with the .NET host and official CLI already built.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('pty-list', { env: { FOXWARM_BIND_ADDRESS: '127.0.0.1' } })
const runtime = join(fixture.root, 'cli'), home = join(fixture.root, 'home')
await mkdir(runtime); await mkdir(home)
const proxyServer = createServer(), proxy = new WebSocketServer({ server: proxyServer })
proxyServer.listen(0, '127.0.0.1'); await once(proxyServer, 'listening')
const sockets = new Set(), browsers = [], wire = []
let holdNextList = false, held = null, cli, cliOutput = ''
proxy.on('connection', (down, request) => {
  const up = new WebSocket(fixture.origin.replace(/^http/, 'ws') + request.url), queued = [], requests = new Map()
  sockets.add(up); sockets.add(down)
  up.on('open', () => { for (const bytes of queued) up.send(bytes) })
  down.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); wire.push(message)
    const original = requests.get(message.requestId)
    if (holdNextList && message.type === 'node_service_response' && original?.service === 'vscode-pty' && original.operation === 'list') {
      // Hold the genuine response, unchanged, while normal authenticated create/attach proceeds.
      holdNextList = false; held = { up, bytes: bytes.toString(), message }; return
    }
    if (up.readyState === WebSocket.OPEN) up.send(bytes.toString()); else queued.push(bytes.toString())
  })
  up.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); wire.push(message)
    if (message.requestId) requests.set(message.requestId, message)
    if (down.readyState === WebSocket.OPEN) down.send(bytes.toString())
  })
  for (const [a, b] of [[up, down], [down, up]]) {
    a.on('close', () => { if (b.readyState === WebSocket.OPEN) b.close() })
    a.on('error', () => {})
  }
})
async function attach(id) {
  const socket = new WebSocket(fixture.origin.replace(/^http/, 'ws') + '/api/terminals/stream?terminalId=' + encodeURIComponent(id), {
    headers: { authorization: 'Bearer ' + fixture.token },
  })
  browsers.push(socket)
  const state = { socket, messages: [], closed: false }
  socket.on('message', bytes => state.messages.push(JSON.parse(bytes.toString())))
  socket.on('close', () => { state.closed = true })
  socket.on('error', () => {})
  await until(() => state.messages.find(item => item.type === 'ready'), 'terminal attached')
  return state
}
const output = client => client.messages.filter(row => row.type === 'output').map(row => row.data).join('')
const ptyRequests = operation => wire.filter(row => row.type === 'node_service_request' && row.service === 'vscode-pty' && row.operation === operation)
try {
  await fixture.start()
  const credential = await fixture.api('POST', '/api/nodes/onboarding/create', { fallbackUrl: fixture.origin, nodeId: 'list-cli' })
  assert.equal(credential.status, 200)
  const executable = process.env.FOXWARM_CLI_EXECUTABLE
  cli = spawn(executable || process.execPath, [...(executable ? [] : [resolve('packages/cli-node/dist/client.js')]), '--host', `http://127.0.0.1:${proxyServer.address().port}`, '--id', 'list-cli', '--auth-token', credential.body.authToken, '--credentials-file', join(runtime, 'credentials.json'), '--no-local-trigger'], {
    cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: home, FOXWARM_AGENTS_DIR: join(runtime, 'agents') },
  })
  for (const stream of [cli.stdout, cli.stderr]) stream.on('data', bytes => { cliOutput = (cliOutput + bytes).slice(-20000) })
  await until(async () => (await fixture.api('GET', '/api/nodes')).body.nodes.find(row => row.id === 'list-cli' && row.online && row.services?.['vscode-pty'] === 1), 'CLI online')

  holdNextList = true
  const listing = fixture.api('GET', '/api/terminals')
  listing.catch(() => {})
  await until(() => held, 'genuine empty list response captured')
  assert.deepEqual(held.message.result.terminals, [])
  const created = await fixture.api('POST', '/api/terminals', { nodeId: 'list-cli', cwd: runtime })
  assert.equal(created.status, 200)
  const terminal = created.body.terminal
  assert(terminal.pid > 0)
  const client = await attach(terminal.id)
  assert.equal(client.messages.find(row => row.type === 'ready').terminal.pid, terminal.pid)
  // The marker includes the evaluated shell PID, not just the command's terminal echo.
  client.socket.send(JSON.stringify({ type: 'input', data: "printf 'BEFORE-LIST-PID=%s\\n' \"$$\"\n" }))
  await until(() => output(client).includes('BEFORE-LIST-PID=' + terminal.pid), 'real output before old list release')

  held.up.send(held.bytes); held = null
  const list = await listing
  assert.equal(list.status, 200)
  // Returning the older observation is fine; it is not authority to delete the new attachment.
  assert.deepEqual(list.body.terminals, [])
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify({ type: 'input', data: "printf 'AFTER-LIST-PID=%s\\n' \"$$\"\n" }))
  }
  await until(() => output(client).includes('AFTER-LIST-PID=' + terminal.pid) || client.closed || client.messages.some(row => row.type === 'error'), 'same attachment after old list release')
  assert.deepEqual(client.messages.filter(row => row.type === 'error' || row.type === 'exit'), [])
  assert.equal(client.closed, false)
  assert.equal(client.socket.readyState, WebSocket.OPEN)
  assert(output(client).includes('AFTER-LIST-PID=' + terminal.pid))
  assert.equal(client.messages.filter(row => row.type === 'ready').length, 1)
  assert.equal(ptyRequests('attach').length, 1)
  assert.equal(wire.filter(row => row.type === 'node_service_command' && row.operation === 'detach').length, 0)
  const lookup = await fixture.api('GET', '/api/terminals/' + encodeURIComponent(terminal.id))
  assert.equal(lookup.status, 200)
  assert.equal(lookup.body.terminal.pid, terminal.pid)
  process.kill(terminal.pid, 0)

  assert.equal((await fixture.api('DELETE', '/api/terminals/' + encodeURIComponent(terminal.id))).status, 200)
  await until(() => {
    try { process.kill(terminal.pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
  }, 'explicit close killed real PTY')
  assert.equal(ptyRequests('close').length, 1)
  console.log(JSON.stringify({ result: 'passed', cli: process.env.FOXWARM_CLI_EXECUTABLE ? 'configured-native-capable' : 'source', genuineEmptyList: true, staleListReturnedEmpty: true, terminalId: terminal.id, realPid: terminal.pid, sameBrowserStream: true, samePidOutputBeforeAndAfter: true, falseErrors: 0, nodeAttachRequests: 1, detachBeforeClose: 0, explicitCloseKills: true }))
  await fixture.stop()
} catch (error) {
  console.error(cliOutput); console.error(fixture.output); throw error
} finally {
  for (const socket of browsers) socket.terminate()
  for (const socket of sockets) socket.terminate()
  if (cli && cli.exitCode === null && cli.signalCode === null) {
    const exited = once(cli, 'exit'); cli.kill('SIGTERM'); await exited
  }
  proxy.close(); await new Promise(done => proxyServer.close(done)); await fixture.cleanup()
}
