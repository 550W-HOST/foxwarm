#!/usr/bin/env node
// Exercise native features from an extracted release, never a source build output:
// file logging, PTY input/output/resize/cancellation and the packaged ToolScript worker.
// --vector additionally indexes and searches history through the packaged Vector child.
// Usage: qualify-package.mjs EXTRACTED_PACKAGE [--vector]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { createHostFixture, until } from '../../packages/webui/test/mainHostFixture.mjs'

const [packageArgument, ...flags] = process.argv.slice(2)
assert(packageArgument && flags.every(flag => flag === '--vector'), 'Usage: qualify-package.mjs EXTRACTED_PACKAGE [--vector]')
const vector = flags.includes('--vector')
const payload = resolve(packageArgument)
const release = JSON.parse(await readFile(join(payload, 'release.json'), 'utf8'))
const hostRid = { 'linux-x64': 'linux-x64', 'darwin-arm64': 'osx-arm64' }[`${process.platform}-${process.arch}`]
assert.equal(release.rid, hostRid, `A ${release.rid} package must be qualified natively on ${release.rid}`)
// Native packages run their NativeAOT executable; managed ones run Foxwarm.dll with dotnet.
const options = release.native
  ? { coreExecutable: join(payload, 'Foxwarm'), env: { SHELL: '/bin/bash' } }
  : { corePath: join(payload, 'Foxwarm.dll'), env: { SHELL: '/bin/bash' } }
if (release.native) assert(!existsSync(join(payload, 'Foxwarm.dll')), 'A native package must not contain Foxwarm.dll')
const fixture = await createHostFixture('package', options)
options.cwd = fixture.root
options.env.HOME = join(fixture.root, 'home')
await mkdir(options.env.HOME)
const failures = [], sockets = []
let requests = 0, embeddings = 0
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const bytes of request) raw += bytes
    const body = JSON.parse(raw)
    if (request.url === '/v1/embeddings') {
      embeddings++
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: Array(1024).fill(0.01) })) }))
      return
    }
    requests++
    const reply = body.input.find(row => row.type === 'function_call_output' && row.call_id === 'native-monty')
    const output = reply
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PACKAGE-NATIVE-COMPLETED' }] }]
      : [{ type: 'function_call', call_id: 'native-monty', name: 'run_script', arguments: JSON.stringify({
        code: "call_tool('write', {'filePath': 'native-monty.txt', 'content': 'packaged Monty 🦊'})\nreturn {'answer': 6 * 7}\n",
      }) }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 20, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500).end('Qualification peer failed') }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const provider = `http://127.0.0.1:${peer.address().port}`
await writeFile(join(fixture.data, 'state/config.yaml'), vector
  ? JSON.stringify({ bot: { httpPort: fixture.port, httpHost: '127.0.0.1' }, vector: { baseUrl: provider + '/v1' }, dbWorkers: true, vectorMaintenance: false })
  : `bot:\n  httpPort: ${fixture.port}\n  httpHost: 127.0.0.1\nvector:\n  enabled: false\n`)
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: {
  local: { providerType: 'openai-responses', baseUrl: provider, models: ['wire'] },
} }))
// Linux only: whether a process has mapped a library, from /proc.
const maps = async pid => process.platform === 'linux' ? readFile(`/proc/${pid}/maps`, 'utf8') : ''
try {
  await fixture.start()
  const mainPid = fixture.hostPids.at(-1)
  if (release.native) assert(!/libcoreclr/.test(await maps(mainPid)), 'Native Main must not load CoreCLR')
  assert.match(fixture.output, new RegExp(`Main HTTP listening: http://127\\.0\\.0\\.1:${fixture.port}\\b`), 'Main must listen only on its configured address')
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
  socket.send(JSON.stringify({ type: 'input', data: "stty -echo; printf 'PACKAGE_%s_🦊\\n' PTY; stty size\n" }))
  await until(() => output.includes('PACKAGE_PTY_🦊') && output.includes('39 95'), 'packaged PTY input, Unicode output and resize')
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
    return !reply.body.session.busy && JSON.stringify(reply.body.messages).includes('PACKAGE-NATIVE-COMPLETED') ? reply.body : null
  }, 'packaged native Monty host call')
  const result = history.messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'native-monty')?.functionResponse.response
  assert.equal(result?.status, 'completed', JSON.stringify(result))
  assert.equal(result.result.answer, 42)
  assert.equal(await readFile(join(fixture.work, 'native-monty.txt'), 'utf8'), 'packaged Monty 🦊')
  assert.equal(requests, 2)

  const summary = { target: release.target, native: release.native === true, loopbackListener: true, packagedNativeToolScript: true, fileLogging: true,
    ptyInputOutput: true, ptyResize: true, ptyCancelAndReap: true }
  if (vector) {
    // The Vector owner is a child of the same executable; Main itself never loads LanceDB.
    // A message of 8000 or more tokens makes indexing start immediately rather than after minutes.
    assert.equal((await fixture.api('POST', route + '/message', { text: 'packaged-index-marker ' + 'v'.repeat(40000) })).status, 202)
    await until(async () => !(await fixture.api('GET', route + '/history')).body.session.busy, 'large exchange committed')
    await until(() => fixture.sql('SELECT raw_last_indexed_seq FROM archive_checkpoints WHERE session_id=?', [session.body.sessionId])[0]?.[0] >= 1,
      'committed messages indexed by the Vector child', 60000)
    await until(async () => {
      const found = await fixture.api('GET', '/api/history/search?query=packaged&sessionId=' + encodeURIComponent(session.body.sessionId))
      assert(found.status === 200 || found.body.code === 'VECTOR_UNAVAILABLE', JSON.stringify(found))
      return found.status === 200 && found.body.results.length > 0
    }, 'indexed history search results', 60000)
    assert(embeddings > 0, 'The Vector child must request embeddings')
    const children = execFileSync('ps', ['-ww', '-o', 'pid=,ppid=,args=', '-A'], { encoding: 'utf8' }).split('\n')
      .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(match => match && Number(match[2]) === mainPid && match[3].includes('--foxwarm-vector-child'))
    assert.equal(children.length, 1, 'Main must run exactly one Vector child')
    const childArgs = children[0][3]
    if (release.native) {
      assert(childArgs.startsWith(join(payload, 'Foxwarm') + ' --foxwarm-vector-child'), 'The Vector child must be the packaged executable: ' + childArgs)
      assert(!/libcoreclr/.test(await maps(children[0][1])), 'The native Vector child must not load CoreCLR')
    }
    if (process.platform === 'linux') {
      assert(/lancedb_ffi/.test(await maps(children[0][1])), 'The Vector child must own LanceDB')
      assert(!/lancedb_ffi/.test(await maps(mainPid)), 'Main must not load LanceDB')
    }
    Object.assign(summary, { vectorChild: true, vectorIndexAndSearch: true })
  }
  await fixture.stop()
  console.log(JSON.stringify(summary))
} catch (error) {
  console.error(fixture.output)
  throw error
} finally {
  for (const socket of sockets) socket.terminate()
  await fixture.cleanup()
  peer.closeAllConnections(); await new Promise(done => peer.close(done))
}
