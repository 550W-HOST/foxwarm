// Owned original-Main terminal contract: real Linux PTY, TTY resize/signal, detach/re-attach and Code helper control.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'

const options = { env: {} }, owned = await createHostFixture('terminal-native', options)
options.cwd = owned.root; options.env = { HOME: join(owned.root, 'home'), }
await mkdir(options.env.HOME); await writeFile(join(owned.work, 'helper.txt'), 'one\ntwo\nthree\n')
const open = async (record, control = false) => {
  const url = `ws://127.0.0.1:${owned.port}/api/terminals/stream?terminalId=${encodeURIComponent(record.id)}${control ? '&control=code' : ''}`
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${owned.token}` } })
  const events = []; socket.on('message', bytes => { try { events.push(JSON.parse(bytes.toString())) } catch {} }); await once(socket, 'open')
  await until(() => events.some(item => item.type === 'ready'), 'terminal ready')
  return { socket, events }
}
const output = (events, text) => events.some(item => (item.type === 'ready' || item.type === 'output') && String(item.data ?? item.backlog ?? '').includes(text))
try {
  await owned.start()
  assert.equal((await fetch(owned.origin + '/api/terminals')).status, 401)
  const nodes = await owned.api('GET', '/api/nodes'); assert.equal(nodes.status, 200); assert.equal(nodes.body.nodes[0].services['vscode-pty'], 1)
  const unavailable = await owned.api('POST', '/api/terminals', { nodeId: 'remote-test', cwd: owned.work })
  assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body))
  assert.equal(unavailable.body.code, 'NodeUnavailable')
  assert.deepEqual((await owned.api('GET', '/api/terminals')).body.terminals, [], 'an unavailable remote Node does not create a local PTY')
  const created = await owned.api('POST', '/api/terminals', { nodeId: 'master', cwd: owned.work, cols: 90, rows: 24 }); assert.equal(created.status, 200, JSON.stringify(created.body) + '\n' + owned.output); assert.equal(created.body.success, true); assert.match(created.body.streamPath, /^\/api\/terminals\/stream\?terminalId=/); const record = created.body.terminal; assert.equal(record.nodeId, 'master'); assert.equal(record.cwd, owned.work)
  const lookedUp = await owned.api('GET', `/api/terminals/${encodeURIComponent(record.id)}`); assert.equal(lookedUp.status, 200); assert.equal(lookedUp.body.terminal.pid, record.pid)
  const first = await open(record)
  first.socket.send(JSON.stringify({ type: 'input', data: "printf 'PTY-UTF8-✓\\n'; stty size;\n" })); await until(() => output(first.events, 'PTY-UTF8-✓') && output(first.events, '24 90'), 'UTF8 and initial size', 5000).catch(error => { throw new Error(error.message + ' events=' + JSON.stringify(first.events)); })
  first.socket.send(JSON.stringify({ type: 'resize', cols: 77, rows: 31 })); first.socket.send(JSON.stringify({ type: 'input', data: "stty size;\n" })); await until(() => output(first.events, '31 77'), 'SIGWINCH resize')
  first.socket.send(JSON.stringify({ type: 'input', data: "sleep 30; printf 'CTRL-C-MUST-NOT-EXIST\\n' > ctrl-c-cancelled.txt\n" })); await sleep(300); first.socket.send(JSON.stringify({ type: 'input', data: '\u0003' })); await until(async () => !(await readFile(join(owned.work, 'ctrl-c-cancelled.txt'), 'utf8').catch(() => '')), 'foreground Ctrl-C stopped the command'); first.socket.send(JSON.stringify({ type: 'input', data: "printf 'CTRL-C-SHELL-SURVIVED\\n'\n" })); await until(() => output(first.events, 'CTRL-C-SHELL-SURVIVED'), 'foreground Ctrl-C and shell survival')
  first.socket.close(); await once(first.socket, 'close'); const second = await open(record); assert(output(second.events, 'CTRL-C-SHELL-SURVIVED'))
  second.socket.send(JSON.stringify({ type: 'input', data: "printf 'NATURAL-EXIT\\n'; exit 17\n" })); await until(() => second.events.some(item => item.type === 'exit'), 'natural exit')

  const helperCreated = await owned.api('POST', '/api/terminals', { nodeId: 'master', cwd: owned.work, cols: 80, rows: 24 }); assert.equal(helperCreated.status, 200); const helper = await open(helperCreated.body.terminal, true)
  helper.socket.send(JSON.stringify({ type: 'input', data: `command -v code; code --goto ${join(owned.work, 'helper.txt')}:2:3\n` }))
  const control = await until(() => helper.events.find(item => item.type === 'control'), 'Code control request', 5000).catch(error => { throw new Error(error.message + ' events=' + JSON.stringify(helper.events)) }); assert.equal(control.command, 'open'); assert.equal(control.request.kind, 'openFile'); assert.equal(control.request.startLine, 2)
  helper.socket.send(JSON.stringify({ type: 'control-result', requestId: control.requestId, ok: true, message: 'Opened helper.txt' })); await until(() => output(helper.events, 'Opened helper.txt'), 'Code helper response')
  helper.socket.send(JSON.stringify({ type: 'input', data: 'exit\n' })); await until(() => helper.events.some(item => item.type === 'exit'), 'helper terminal exit')
  await writeFile(join(options.env.HOME, '.bashrc'), 'exit 23\n')
  const quick = await owned.api('POST', '/api/terminals', { nodeId: 'master', cwd: owned.work, cols: 80, rows: 24 }); assert.equal(quick.status, 200)
  await until(async () => (await owned.api('GET', `/api/terminals/${encodeURIComponent(quick.body.terminal.id)}`)).status === 404, 'owned rc immediate exit cleanup')
  assert.equal((await owned.api('DELETE', `/api/terminals/${record.id}`)).status, 200)
  await owned.stop(); console.log(JSON.stringify({ status: 'passed', utf8: true, resize: true, ctrlC: true, detachBacklog: true, naturalExit: true, codeHelper: true, nodePty: true }))
} finally { await owned.cleanup() }
