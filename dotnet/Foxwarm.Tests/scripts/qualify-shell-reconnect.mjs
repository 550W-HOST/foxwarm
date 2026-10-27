import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createHostFixture, until, sleep } from '../../../packages/webui/test/mainHostFixture.mjs'

// Own every host, credential, client and fault. No installed runtime is consulted.
// An optional executable argument selects portable HTTP-only qualification.
const portable = process.argv[2]
const fixture = await createHostFixture(portable ? 'shell-reconnect-portable-pwsh' : 'shell-reconnect')
let blockPolls = false, prepareFailures = 2, registerFailures = 0, dropRegistrations = 1
let holdRegistration = false, held, release
const registrations = [], polls = [], children = [], sockets = [], activePolls = new Set()
const proxy = createServer(async (request, response) => {
  try {
    const register = request.url.endsWith('/register'), prepare = request.method === 'HEAD'
    if ((prepare && prepareFailures-- > 0) || (register && !prepare && registerFailures-- > 0) || (blockPolls && request.url.endsWith('/poll'))) {
      response.writeHead(503); response.end(); return
    }
    if (register && !prepare && holdRegistration) {
      held = true
      await new Promise(done => { release = done })
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const headers = { ...request.headers }; delete headers.host; delete headers['content-length']
    if (request.url.endsWith('/poll')) activePolls.add(response)
    const result = await fetch(fixture.origin + request.url, { method: request.method, headers, ...(['HEAD', 'GET'].includes(request.method) ? {} : { body: Buffer.concat(chunks) }) })
    const body = Buffer.from(await result.arrayBuffer())
    activePolls.delete(response)
    if (register && !prepare) {
      registrations.push({ connection: request.headers['x-foxwarm-connection'], predecessor: request.headers['x-foxwarm-predecessor'], status: result.status })
      if (result.status === 204 && dropRegistrations-- > 0) { response.destroy(); return }
    }
    if (request.url.endsWith('/poll')) polls.push({ connection: request.headers['x-foxwarm-connection'], status: result.status, reason: result.headers.get('x-foxwarm-shell-reason') })
    response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(body)
  } catch { if (!response.headersSent) response.writeHead(503); response.end() }
})
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
const host = 'http://127.0.0.1:' + proxy.address().port
const online = id => fixture.api('GET', '/api/nodes').then(result => result.body.nodes.find(node => node.id === id)?.online)
const connected = id => until(() => online(id), 'official Shell online: ' + id)
const exited = handle => until(() => handle.child.exitCode !== null || handle.child.signalCode !== null, 'official client exit', 40000)
async function credential(id) {
  const result = await fixture.api('POST', '/api/nodes/onboarding/create', { baseUrl: fixture.origin, nodeId: id })
  assert.equal(result.status, 200); return result.body
}
function launch(value, script) {
  const child = spawn(portable || '/bin/sh', portable ? ['-NoProfile', '-NonInteractive', '-File', script] : [script, '--host=' + host, '--node-id=' + value.nodeId], { cwd: fixture.work, detached: true, env: { ...process.env, NODE_AUTH_TOKEN: value.authToken, SHELL_TEST_HOST: host, SHELL_TEST_NODE: value.nodeId }, stdio: ['ignore', 'pipe', 'pipe'] })
  const handle = { child, output: '' }; children.push(handle)
  child.stdout.on('data', data => { handle.output += data }); child.stderr.on('data', data => { handle.output += data })
  return handle
}
async function websocket(value) {
  const ws = new WebSocket(fixture.origin.replace('http', 'ws') + '/node_ws?id=' + value.nodeId + '&auth=' + value.authToken); sockets.push(ws)
  await once(ws, 'open'); const reply = once(ws, 'message')
  ws.send(JSON.stringify({ type: 'node_register', nodeType: 'qualification-ws', nodeProtocol: { min: 1, max: 3 }, capabilities: { tools: [{ name: 'exec' }] } }))
  assert.equal(JSON.parse(String((await reply)[0])).type, 'registered'); return ws
}
try {
  await fixture.start()
  const value = await credential('recover')
  const script = join(fixture.root, portable ? 'portable-protocol.ps1' : 'official-shell.sh')
  if (portable) {
    const source = await (await fetch(fixture.origin + '/node/run-shell.ps1')).text()
    const embedded = /Add-Type -TypeDefinition @'\n([\s\S]*?)\n'@/.exec(source)[1]
    // Only adapt the unavailable Framework ACL overload for compilation on portable .NET.
    // No job executes here, so this does not qualify Windows ACL/process/cwd behavior.
    const portableSource = embedded.replace('Directory.CreateDirectory(directory, security);', 'Directory.CreateDirectory(directory);')
    await writeFile(script, `$ErrorActionPreference = 'Stop'\nAdd-Type -CompilerOptions '/nowarn:SYSLIB0014' -TypeDefinition @'\n${portableSource}\n'@\n$client = New-Object Foxwarm.ShellHttpClient($env:SHELL_TEST_HOST, $env:SHELL_TEST_NODE, $env:NODE_AUTH_TOKEN, 'C:\\portable [cwd]', 'unused-engine')\n$client.Run()\n`)
  } else await writeFile(script, await (await fetch(fixture.origin + '/node/run-shell.sh')).text())
  const shell = launch(value, script)
  await connected(value.nodeId)
  await until(() => registrations.length >= 2, 'lost initial registration response retried')
  assert.equal(registrations[0].connection, registrations[1].connection)
  assert.equal(registrations[0].predecessor, registrations[1].predecessor)
  // A short interrupted poll retries without publishing a replacement.
  const before = registrations.length
  await until(() => activePolls.size > 0, 'an actual outstanding client poll')
  blockPolls = true; for (const response of activePolls) response.destroy()
  await sleep(7000); blockPolls = false
  await until(() => shell.output.includes('polling resumed'), 'ordinary polling resumes', 60000)
  assert.equal(registrations.length, before); assert(await online(value.nodeId))
  // Restart actual Main processes, preserving only normal persisted data.
  registerFailures = 2; dropRegistrations = 1
  await fixture.stop(); await fixture.start()
  await connected(value.nodeId)
  await until(() => registrations.length >= before + 2, 'lost reconnect response retried')
  assert.equal(shell.child.exitCode, null)
  assert(registrations.filter(row => row.status === 204).every(row => row.connection === registrations[0].connection))
  // The actual 90-second online boundary, including the normal ten-second collector.
  blockPolls = true
  const expiryStart = Date.now(); await sleep(96000)
  assert.equal(await online(value.nodeId), false)
  blockPolls = false; registerFailures = 1
  await connected(value.nodeId)
  assert.equal(shell.child.exitCode, null)
  assert(polls.some(row => row.reason === 'connection-unavailable'))
  // Hold the old client's recovery POST, publish a real successor, then let it race.
  holdRegistration = true; held = false
  await fixture.stop(); await fixture.start()
  await until(() => held, 'old client deciding to republish')
  const ws = await websocket(value)
  holdRegistration = false; release()
  await exited(shell)
  assert(shell.output.includes('connection replaced'))
  const pong = once(ws, 'message'); ws.send(JSON.stringify({ type: 'ping' }))
  assert.equal(JSON.parse(String((await pong)[0])).type, 'pong')
  assert(await online(value.nodeId))
  const revokedValue = await credential('revoked'), revoked = launch(revokedValue, script)
  await connected(revokedValue.nodeId)
  assert.equal((await fixture.api('DELETE', '/api/nodes/' + revokedValue.nodeId)).status, 200)
  await exited(revoked); assert(revoked.output.includes('credentials rejected or revoked'))
  const stoppedValue = await credential('stopped'), stopped = launch(stoppedValue, script)
  await connected(stoppedValue.nodeId)
  stopped.child.kill('SIGTERM'); await exited(stopped)
  const attempts = registrations.length; await sleep(2500); assert.equal(registrations.length, attempts)
  assert(children.every(handle => !handle.output.includes(value.authToken) && !handle.output.includes(revokedValue.authToken) && !handle.output.includes(stoppedValue.authToken)))
  assert(registrations.length < 20, 'registration retries are bounded by fixed delay, not a busy loop')
  console.log(JSON.stringify({ result: 'passed', client: portable ? 'portable PowerShell embedded HTTP control only; no Windows jobs' : '/bin/sh', actualExpiryMilliseconds: Date.now() - expiryStart, hostStarts: fixture.hostPids.length, registrationRequests: registrations.length, pollReasons: [...new Set(polls.map(row => row.reason).filter(Boolean))], lostInitialAndReconnectResponses: true, heldSuccessorRace: true, clientOutput: shell.output }))
  await fixture.stop()
} catch (error) {
  console.error(JSON.stringify({ registrations, polls, clients: children.map(handle => ({ output: handle.output, exit: handle.child.exitCode })) }))
  throw error
} finally {
  release?.()
  for (const socket of sockets) socket.terminate()
  for (const handle of children) { try { process.kill(-handle.child.pid, 'SIGKILL') } catch {} }
  proxy.closeAllConnections(); await new Promise(done => proxy.close(done)); await fixture.cleanup()
}
