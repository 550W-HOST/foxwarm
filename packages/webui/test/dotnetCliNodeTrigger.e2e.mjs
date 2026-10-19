// Real Source/managed/native loopback HTTP, persisted shell helper and correlated ACKs.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import { until, sleep } from './experimentHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const http = createServer(), peer = new WebSocketServer({ server: http }), frames = [], clients = [], sockets = new Set()
http.listen(0, '127.0.0.1'); await once(http, 'listening')
const origin = `http://127.0.0.1:${http.address().port}`
peer.on('connection', (socket, request) => {
  const id = new URL(request.url, origin).searchParams.get('id')
  sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket))
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes); frames.push({ id, socket, frame })
    if (frame.type === 'node_register') socket.send(JSON.stringify({ type: 'registered', nodeId: id, nodeProtocol: { negotiated: 3, master: { min: 1, max: 3 } } }))
    if (frame.type === 'session_event' && frame.message !== 'HOLD' && frame.message !== 'TIMEOUT' && frame.message !== 'DISCONNECT')
      socket.send(JSON.stringify({ type: 'cli_response', requestId: frame.requestId, ...(frame.message === 'DENIED' ? { ok: false, error: 'Ordinary trigger denied by real peer' } : { ok: true, result: { queued: true } }) }))
    if (frame.message === 'DISCONNECT') socket.close(1000, 'owned test disconnect')
  })
})
async function launch(name, source, { cwd = join(root, name + " spaces ' 雪"), disabled = false, port = 0, noCredentials = false, expectFailure = false } = {}) {
  await mkdir(cwd, { recursive: true })
  const executable = !source && process.env.FOXWARM_CLI_EXECUTABLE
  const child = spawn(executable || (source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet')), [...(executable ? [] : [resolve(source ? 'packages/cli-node/dist/client.js' : 'dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]), '--host', origin, '--id', name, '--auth-token', 'synthetic-trigger-credential', ...(noCredentials ? [] : ['--credentials-file', join(cwd, 'state', 'credentials.json')]), '--local-trigger-port', String(port), ...(disabled ? ['--no-local-trigger'] : [])], { cwd, env: { ...isolatedApplicationEnv(join(cwd, 'data')), FOXWARM_AGENTS_DIR: join(cwd, 'agents'), ASPNETCORE_URLS: 'http://0.0.0.0:12345', ASPNETCORE_HTTP_PORTS: '12346', ASPNETCORE_Kestrel__Endpoints__Unexpected__Url: 'http://0.0.0.0:12347' }, stdio: ['ignore', 'pipe', 'pipe'] })
  const h = { child, name, cwd, source, output: '' }; clients.push(h)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { h.output += bytes })
  if (expectFailure) { assert.equal((await once(child, 'exit'))[0], 1, h.output); return h }
  await until(() => { assert.equal(child.exitCode, null, h.output); return frames.find(row => row.id === name && row.frame.type === 'node_register') }, 'registered ' + name)
  if (disabled) return h
  h.meta = await until(async () => { assert.equal(child.exitCode, null, h.output); try { const meta = JSON.parse(await readFile(join(cwd, 'state/node_local_trigger.json'), 'utf8')); return meta.nodeId === name && meta.port > 0 ? meta : null } catch { return null } }, 'metadata ' + name)
  h.token = (await readFile(h.meta.tokenFile, 'utf8')).trim()
  assert.equal(h.meta.host, '127.0.0.1'); assert(h.meta.port > 0)
  assert.equal((await stat(h.meta.tokenFile)).mode & 0o777, 0o600)
  assert.equal((await stat(h.meta.scriptFile)).mode & 0o777, 0o700)
  return h
}
async function stop(h) {
  if (h.child.exitCode !== null || h.child.signalCode !== null) return
  const exit = once(h.child, 'exit'); h.child.kill('SIGTERM')
  let timer
  try { assert.deepEqual(await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => { h.child.kill('SIGKILL'); reject(new Error(h.output)) }, 20000) })]), [0, null], h.output) }
  finally { clearTimeout(timer) }
}
function request(h, { path = '/trigger', method = 'POST', body = JSON.stringify({ sessionId: 'session', message: 'normal' }), auth = 'Bearer ' + h.token, headers = {} } = {}) {
  return new Promise((done, reject) => {
    const req = httpRequest({ host: h.meta.host, port: h.meta.port, path, method, agent: false, headers: { ...(auth === null ? {} : { authorization: auth }), ...headers } }, response => {
      const chunks = []; response.on('data', bytes => chunks.push(bytes)); response.on('end', () => done({ status: response.statusCode, text: Buffer.concat(chunks).toString(), contentType: response.headers['content-type'] }))
    }); req.on('error', error => { error.message += " request=" + method + " " + path + " body=" + body; reject(error) }); if (body !== null) req.write(body); req.end()
  })
}
const events = h => frames.filter(row => row.id === h.name && row.frame.type === 'session_event')
async function shell(h, args) {
  const child = spawn('/bin/sh', [h.meta.scriptFile, ...args], { cwd: h.cwd, env: { ...process.env, ...(h.source ? {} : { PATH: '/no-node-python-or-dotnet' }) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { error += bytes })
  const [code] = await once(child, 'exit'); return { code, output, error }
}
async function corpus(h) {
  const errors = []
  for (const [args, status, exact] of [
    [{ path: '/other', method: 'GET', auth: null }, 404, 'Not found'],
    [{ path: '/trigger', method: 'GET', auth: null }, 405, 'Method not allowed'],
    [{ path: '/%74rigger', auth: null }, 404, 'Not found'],
    [{ path: '/a/../%74rigger' }, 404, 'Not found'],
    [{ path: '/%2574rigger' }, 404, 'Not found'],
    [{ path: '/%61/../trigger', method: 'GET', auth: null }, 405, 'Method not allowed'],
    [{ path: '/%ff/../trigger', auth: null, body: 'invalid' }, 401, '{"error":"Unauthorized"}'],
    [{ auth: null, body: 'invalid' }, 401, '{"error":"Unauthorized"}'],
    [{ auth: 'Bearer wrong', headers: { 'x-node-trigger-token': h.token } }, 401, '{"error":"Unauthorized"}'],
    [{ auth: null, headers: { 'x-node-trigger-token': [h.token, 'other'] } }, 401, '{"error":"Unauthorized"}'],
    [{ body: null }, 400, '{"error":"sessionId and message are required"}'],
    [{ body: '{}' }, 400, '{"error":"sessionId and message are required"}'],
    [{ body: '[]' }, 400, '{"error":"sessionId and message are required"}'],
    [{ body: 'true' }, 400, '{"error":"sessionId and message are required"}'],
    [{ body: JSON.stringify({ sessionId: '  ', message: 'text' }) }, 400, '{"error":"sessionId and message are required"}'],
    [{ body: JSON.stringify({ sessionId: 'session', message: '\n \t' }) }, 400, '{"error":"sessionId and message are required"}'],
    [{ body: 'null' }, 500], [{ body: '{bad' }, 500],
  ]) {
    const result = await request(h, args); assert.equal(result.status, status, JSON.stringify(result)); if (exact) assert.equal(result.text, exact); else assert.equal(typeof JSON.parse(result.text).error, 'string'); errors.push(result.status)
  }
  assert.equal(events(h).length, 0)
  for (const path of ['/a/../trigger', '/%61/../trigger', '/%ff/../trigger', '/%2e/trigger', '/a/%2e%2e/trigger', '/%ff/.%2e/trigger']) {
    const before = events(h).length
    assert.equal((await request(h, { path })).status, 200, path)
    assert.equal(events(h).length, before + 1, path)
    assert.equal(events(h).at(-1).frame.message, 'normal')
  }
  assert.equal((await request(h, { body: JSON.stringify({ sessionId: '\ufeffsession\ufeff', message: '\u0085' }) })).status, 200)
  assert.equal(events(h).at(-1).frame.sessionId, 'session'); assert.equal(events(h).at(-1).frame.message, '\u0085')
  assert.equal((await request(h, { body: JSON.stringify({ sessionId: 'session', message: '\ufeff' }) })).status, 400)
  assert.equal((await request(h, { body: '{"sessionId":"wrong","message":0,"sessionId":"session","message":"last wins"}' })).status, 200)
  assert.equal(events(h).at(-1).frame.message, 'last wins'); assert.equal(events(h).at(-1).frame.sessionId, 'session')
  const deep = '{"sessionId":"session","message":"deep","ignored":' + '['.repeat(80) + '0' + ']'.repeat(80) + '}'
  assert.equal((await request(h, { body: deep })).status, 200)
  // Source has no application body-size cap; Kestrel's default 30 MB limit must not leak in.
  const large = 'x'.repeat(31 * 1024 * 1024)
  assert.equal((await request(h, { body: JSON.stringify({ sessionId: 'session', message: large }) })).status, 200)
  assert.equal(events(h).at(-1).frame.message.length, large.length)
  assert.equal((await request(h, { auth: ['Bearer ' + h.token, 'Bearer ignored'] })).status, 200)
  for (const [eventType, mapped, auth] of [['onboot', 'onboot', 'bearer ignored'], ['background', 'background', 'Bearer '], ['unknown', 'trigger', null], ['trigger', 'trigger', 'Bearer ' + h.token]]) {
    const result = await request(h, { path: '/trigger?query=ok', auth, headers: { 'x-node-trigger-token': h.token }, body: JSON.stringify({ sessionId: ' session ', message: "  quoted ' 雪\n\tmessage  ", eventType, eventId: 'forbidden', execId: 'forbidden', completionCapability: 'forbidden', eventTimestamp: 1, arbitrary: true }) })
    assert.equal(result.status, 200, result.text)
    const event = events(h).at(-1).frame; assert.deepEqual(Object.keys(event).sort(), ['type', 'requestId', 'sessionId', 'message', 'eventType'].sort()); assert.equal(event.eventType, mapped); assert.equal(event.sessionId, 'session'); assert.equal(event.message, "  quoted ' 雪\n\tmessage  ")
  }
  const before = events(h).length, helper = await shell(h, ['session', " shell ' 雪\n$HOME `id` ", 'background'])
  assert.equal(helper.code, 0, helper.error); assert.deepEqual(JSON.parse(helper.output), { success: true }); assert.equal(events(h).length, before + 1); assert.equal(events(h).at(-1).frame.message, " shell ' 雪\n$HOME `id` ")
  assert.equal((await shell(h, ['session'])).code, 1)
  const denied = await request(h, { body: JSON.stringify({ sessionId: 'session', message: 'DENIED' }) }); assert.equal(denied.status, 500); assert.equal(JSON.parse(denied.text).error, 'Ordinary trigger denied by real peer')
  assert.equal((await shell(h, ['session', 'DENIED'])).code, 1)
  let settled = false
  const held = request(h, { body: JSON.stringify({ sessionId: 'session', message: 'HOLD' }) }).then(result => { settled = true; return result })
  const row = await until(() => events(h).find(row => row.frame.message === 'HOLD'), 'correlated event')
  await sleep(100); assert.equal(settled, false)
  row.socket.send(JSON.stringify({ type: 'cli_response', requestId: 'not-the-request', ok: true })); await sleep(100); assert.equal(settled, false)
  row.socket.send(JSON.stringify({ type: 'cli_response', requestId: row.frame.requestId, ok: true, result: { queued: true } })); assert.equal((await held).status, 200)
  const started = Date.now(), timeout = await request(h, { body: JSON.stringify({ sessionId: 'session', message: 'TIMEOUT' }) })
  assert.equal(timeout.status, 500); assert.equal(JSON.parse(timeout.text).error, 'cli-node request session_event timed out'); assert(Date.now() - started >= 14500)
  const timed = events(h).find(row => row.frame.message === 'TIMEOUT'); timed.socket.send(JSON.stringify({ type: 'cli_response', requestId: timed.frame.requestId, ok: true }))
  const disconnected = await request(h, { body: JSON.stringify({ sessionId: 'session', message: 'DISCONNECT' }) }); assert.equal(disconnected.status, 500); assert.match(JSON.parse(disconnected.text).error, /connection closed before master acknowledged.*1000: owned test disconnect/)
  const offline = await request(h); assert.equal(offline.status, 500); assert.equal(JSON.parse(offline.text).error, 'Remote node is not connected to master')
  await stop(h); assert(!h.output.includes(h.token), "trigger token must not be logged"); assert(!(await readFile(h.meta.scriptFile, 'utf8')).includes(h.token), "script reads the token, never embeds it"); assert.equal(events(h).filter(row => row.frame.message === 'TIMEOUT').length, 1); assert.equal(events(h).filter(row => row.frame.message === 'DISCONNECT').length, 1)
  await assert.rejects(request(h), /ECONNREFUSED/)
  // Source retains artifacts after close. Restart reads token and writes the selected port/node ID.
  const token = await readFile(h.meta.tokenFile, 'utf8'); await writeFile(h.meta.tokenFile, ' \n' + token.trim() + '\n\t')
  const restarted = await launch(h.name + '-restart', h.source, { cwd: h.cwd, port: '0x' + h.meta.port.toString(16) })
  assert.equal(restarted.token, h.token); assert.equal(restarted.meta.port, h.meta.port); assert.equal(await readFile(h.meta.tokenFile, 'utf8'), ' \n' + token.trim() + '\n\t')
  assert.equal((await shell(restarted, ['session', 'restart'])).code, 0); await stop(restarted)
  console.log(JSON.stringify({ client: h.name, errors, correlatedAck: true, timeoutMs: Date.now() - started, helper: true, persistedRestart: true }))
}
try {
  const source = await launch('trigger-source', true); await corpus(source)
  await corpus(await launch('trigger-candidate', false))
  const readOld = await launch('read-old-source-token', false, { cwd: source.cwd }); assert.equal(readOld.token, source.token); assert.equal((await shell(readOld, ['session', 'read-old-metadata-token'])).code, 0); await stop(readOld)
  for (const source of [true, false]) {
    const h = await launch('disabled-' + source, source, { disabled: true }); await assert.rejects(readFile(join(h.cwd, 'state/node_local_trigger.json')), /ENOENT/); await assert.rejects(readFile(join(h.cwd, 'state/node_local_trigger_token')), /ENOENT/); await stop(h)
    for (const port of [0.5, -1, 65536]) await launch('bad-port-' + source + '-' + port, source, { port, expectFailure: true })
    const fallback = await launch('fallback-port-' + source, source, { port: 'not-a-number' }); await stop(fallback)
    const startup = await launch('startup-' + source, source, { noCredentials: true }); assert.equal(startup.meta.tokenFile, join(startup.cwd, 'state/node_local_trigger_token')); await stop(startup)
  }
  console.log('Loopback route/method/auth/body, exact forwarding, ACK/rejection/disconnect/timeout, helper, restart and disabled listener passed.')
} finally {
  for (const h of clients) await stop(h)
  for (const socket of sockets) socket.terminate()
  await new Promise(done => peer.close(done)); await new Promise(done => http.close(done))
}
