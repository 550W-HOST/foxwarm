#!/usr/bin/env node
// Exercise native features from an extracted release, never a source build output.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { createHostFixture, until } from '../../packages/webui/test/mainHostFixture.mjs'

assert.equal(process.platform, 'darwin', 'macOS package qualification must run on macOS')
assert.equal(process.arch, 'arm64', 'macOS package qualification requires native arm64 Node.js')
const payload = resolve(process.argv[2] || '')
assert(process.argv[2], 'Usage: qualify-macos-package.mjs EXTRACTED_PACKAGE')
const release = JSON.parse(await readFile(join(payload, 'release.json'), 'utf8'))
assert.equal(release.rid, 'osx-arm64')
const options = { corePath: join(payload, 'Foxwarm.dll'), env: { SHELL: '/bin/bash' } }
const fixture = await createHostFixture('macos-package', options)
options.cwd = fixture.root
options.env.HOME = join(fixture.root, 'home')
await mkdir(options.env.HOME)
await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  httpPort: ${fixture.port}\nvector:\n  enabled: false\n`)
const failures = [], sockets = []
let requests = 0
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const bytes of request) raw += bytes
    const body = JSON.parse(raw)
    requests++
    const reply = body.input.find(row => row.type === 'function_call_output' && row.call_id === 'native-monty')
    const output = reply
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'MACOS-NATIVE-COMPLETED' }] }]
      : [{ type: 'function_call', call_id: 'native-monty', name: 'run_script', arguments: JSON.stringify({
        code: "call_tool('write', {'filePath': 'native-monty.txt', 'content': 'packaged Monty 🦊'})\nreturn {'answer': 6 * 7}\n",
      }) }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 20, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500).end('Qualification peer failed') }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: {
  local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] },
} }))
try {
  await fixture.start()
  assert.equal((await fetch(fixture.origin + '/login.html')).status, 200)
  assert.match(await readFile(join(fixture.data, 'state/logs/foxwarm.log'), 'utf8'), /Main HTTP listening:/)

  const created = await fixture.api('POST', '/api/terminals', { nodeId: 'master', cwd: fixture.work, cols: 80, rows: 24 })
  assert.equal(created.status, 200, JSON.stringify(created.body) + '\n' + fixture.output)
  const terminal = created.body.terminal
  assert(terminal.pid > 0)
  const socket = new WebSocket(`ws://127.0.0.1:${fixture.port}/api/terminals/stream?terminalId=${encodeURIComponent(terminal.id)}`, {
    headers: { authorization: `Bearer ${fixture.token}` },
  })
  sockets.push(socket)
  let ready = false, output = ''
  socket.on('message', bytes => {
    const event = JSON.parse(bytes.toString())
    if (event.type === 'ready') { ready = true; output += event.backlog || '' }
    if (event.type === 'output') output += event.data || ''
  })
  await once(socket, 'open'); await until(() => ready, 'packaged terminal ready')
  socket.send(JSON.stringify({ type: 'resize', cols: 95, rows: 39 }))
  // Split the marker in the printf command so echoed input cannot satisfy it.
  socket.send(JSON.stringify({ type: 'input', data: "stty -echo; printf 'MACOS_%s_🦊\\n' PTY; stty size\n" }))
  await until(() => output.includes('MACOS_PTY_🦊') && output.includes('39 95'), 'packaged PTY input, Unicode output and resize')
  socket.send(JSON.stringify({ type: 'input', data: "printf 'BLOCKED_%s\\n' READ; sleep 120\n" }))
  await until(() => output.includes('BLOCKED_READ'), 'PTY waiting with a blocked native read')
  assert.equal((await fixture.api('DELETE', '/api/terminals/' + encodeURIComponent(terminal.id))).status, 200)
  await until(() => {
    try { process.kill(terminal.pid, 0); return false } catch (error) { if (error.code !== 'ESRCH') throw error; return true }
  }, 'PTY cancellation kills and reaps the owned shell')
  assert.equal((await fixture.api('GET', '/api/terminals/' + encodeURIComponent(terminal.id))).status, 404)

  const session = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'native-package' })
  assert.equal(session.status, 200)
  const route = '/api/sessions/' + encodeURIComponent(session.body.sessionId)
  assert.equal((await fixture.api('POST', route + '/message', { text: 'Run the packaged native ToolScript worker.' })).status, 202)
  const history = await until(async () => {
    assert.deepEqual(failures, [])
    const reply = await fixture.api('GET', route + '/history')
    return !reply.body.session.busy && JSON.stringify(reply.body.messages).includes('MACOS-NATIVE-COMPLETED') ? reply.body : null
  }, 'packaged native Monty host call')
  const result = history.messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'native-monty')?.functionResponse.response
  assert.equal(result?.status, 'completed', JSON.stringify(result))
  assert.equal(result.result.answer, 42)
  assert.equal(await readFile(join(fixture.work, 'native-monty.txt'), 'utf8'), 'packaged Monty 🦊')
  assert.equal(requests, 2)
  await fixture.stop()
  console.log(JSON.stringify({ target: release.target, packagedNativeToolScript: true, fileLogging: true,
    ptyInputOutput: true, ptyResize: true, ptyCancelAndReap: true }))
} catch (error) {
  console.error(fixture.output)
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await fixture.cleanup()
  peer.closeAllConnections(); await new Promise(done => peer.close(done))
}
