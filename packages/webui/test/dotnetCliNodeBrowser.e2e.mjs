// C# CLI Node browser_* tools through the real owned Node protocol, a real headless Chromium and local pages.
// FOXWARM_CLI_EXECUTABLE selects the native executable instead of the managed CLI.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { WebSocketServer } from 'ws'
import sharp from 'sharp'
import { until } from './mainHostFixture.mjs'
import { browserEnvironment } from '../../browser-host/test/fixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment, isolatedApplicationEnv } = require('../../../scripts/test/test-process-env.cjs')
const { processRoot: root } = initializeTestEnvironment()
const chromium = await browserEnvironment()
assert(chromium.available, 'A Chromium installation is required: ' + chromium.reason)
const nativePath = process.env.FOXWARM_CLI_EXECUTABLE

const servers = [], sockets = new Map(), replies = [], children = [], registrations = new Map()
const site = createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  if (req.url === '/stall') return
  res.end(`<!doctype html><title>${req.url === '/two' ? 'Two' : 'One'}</title><input id="entry" aria-label="Entry"><button id="go" onclick="window.clicked=1">Go</button><a id="link" href="/two">Next</a>`)
})
site.listen(0, '127.0.0.1'); await once(site, 'listening'); servers.push(site)
const origin = `http://127.0.0.1:${site.address().port}`
const http = createServer(), ws = new WebSocketServer({ server: http })
http.listen(0, '127.0.0.1'); await once(http, 'listening'); servers.push(http)
ws.on('connection', (socket, request) => {
  const id = new URL(request.url, 'http://owned').searchParams.get('id')
  socket.on('error', () => {})
  socket.on('message', bytes => {
    const frame = JSON.parse(bytes)
    if (frame.type === 'node_register') {
      registrations.set(id, frame); sockets.set(id, socket)
      socket.send(JSON.stringify({ type: 'registered', nodeId: id, nodeProtocol: { negotiated: 3, master: { min: 1, max: 3 } } }))
    } else replies.push(frame)
  })
})

let serial = 0
const send = (id, frame) => sockets.get(id).send(JSON.stringify(frame))
function start(id, name, args) {
  const callId = String(++serial)
  send(id, { type: 'tool_call', callId, tool: name, args, sessionId: 'main/browser-fixture', agentName: 'main' })
  return callId
}
const reply = (callId, label, timeout = 40000) => until(() => {
  const index = replies.findIndex(row => row.callId === callId)
  return index < 0 ? null : replies.splice(index, 1)[0]
}, label, timeout)
async function tool(id, name, args) {
  const response = await reply(start(id, name, args), name)
  assert.equal(response.type, 'tool_call_response', JSON.stringify(response))
  return response.result
}
async function failure(id, name, args) {
  const response = await reply(start(id, name, args), name)
  assert.equal(response.type, 'tool_call_error', JSON.stringify(response))
  return response.error
}

async function launch(id, executable) {
  const cwd = join(root, id)
  for (const path of ['home', 'config', 'cache']) await mkdir(join(cwd, path), { recursive: true })
  const command = nativePath || join(process.env.DOTNET_ROOT, 'dotnet')
  const entry = nativePath ? [] : [resolve('dotnet/Foxwarm.CliNode/bin/Debug/net10.0/Foxwarm.CliNode.dll')]
  const child = spawn(command, [...entry, '--host', `http://127.0.0.1:${http.address().port}`, '--no-local-trigger', '--id', id, '--auth-token', id + '-owned', '--credentials-file', join(cwd, 'credentials.json')], {
    cwd,
    env: { ...isolatedApplicationEnv(join(cwd, 'data')), PATH: process.env.PATH, PUPPETEER_EXECUTABLE_PATH: executable, HOME: join(cwd, 'home'), XDG_CONFIG_HOME: join(cwd, 'config'), XDG_CACHE_HOME: join(cwd, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const item = { id, child, output: '' }; children.push(item)
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { item.output += bytes })
  await until(() => sockets.get(id), id + ' registration', 20000)
  return item
}
const advertised = id => registrations.get(id).capabilities.tools.map(row => row.name).filter(name => name.startsWith('browser_'))

try {
  // Without a runnable Chromium the Node advertises no browser tools and refuses a direct call with a reason.
  await launch('absent', join(root, 'no-such-chromium'))
  assert.deepEqual(advertised('absent'), [])
  assert.equal(registrations.get('absent').capabilities.features.toolCallCancellation, true)
  const absent = await failure('absent', 'browser_open', { url: origin + '/' })
  assert.match(absent.message || String(absent), /./)

  const item = await launch('present', chromium.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium')
  assert.deepEqual(advertised('present'), ['browser_tabs', 'browser_open', 'browser_close', 'browser_navigate', 'browser_read', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_type', 'browser_press', 'browser_select', 'browser_scroll', 'browser_wait', 'browser_evaluate'])
  assert.deepEqual((await tool('present', 'browser_tabs', {})).tabs, [])
  const opened = await tool('present', 'browser_open', { url: origin + '/' })
  const tabId = opened.tabId
  assert.equal(opened.title, 'One')
  const snapshot = await tool('present', 'browser_read', { tabId })
  const entry = snapshot.elements.find(row => row.label === 'Entry')
  assert((await tool('present', 'browser_fill', { tabId, ref: entry.ref, text: 'é🙂' })).filled)
  assert.equal((await tool('present', 'browser_evaluate', { tabId, code: 'document.querySelector("#entry").value' })).result, 'é🙂')
  assert((await tool('present', 'browser_click', { tabId, selector: '#go' })).clicked)
  assert.equal((await tool('present', 'browser_evaluate', { tabId, code: 'window.clicked' })).result, 1)
  const shot = await tool('present', 'browser_screenshot', { tabId })
  assert.equal(shot.inlineData.mimeType, 'image/png')
  const meta = await sharp(Buffer.from(shot.inlineData.data, 'base64')).metadata()
  assert(meta.width > 0 && meta.height > 0)
  const followed = await tool('present', 'browser_click', { tabId, selector: '#link' })
  assert.equal(followed.navigated, true); assert.equal(followed.title, 'Two')
  assert.equal((await tool('present', 'browser_navigate', { tabId, history: 'back' })).title, 'One')

  // Cancellation reaches the host: the stalled navigation ends and the tab is not left behind.
  const stalled = start('present', 'browser_open', { url: origin + '/stall' })
  await new Promise(done => setTimeout(done, 600))
  send('present', { type: 'tool_call_cancel', callId: stalled })
  const cancelled = await reply(stalled, 'cancelled open', 15000)
  assert.equal(cancelled.type, 'tool_call_error')
  assert.deepEqual((await tool('present', 'browser_tabs', {})).tabs.map(row => row.tabId), [tabId])

  // The browser survives a reconnect of the same process.
  const original = sockets.get('present'); original.terminate()
  await until(() => sockets.get('present') !== original, 'same-process reconnect', 15000)
  assert.equal((await tool('present', 'browser_tabs', {})).tabs[0].tabId, tabId)
  assert((await tool('present', 'browser_close', { tabId })).closed)

  if (nativePath) assert(!/libcoreclr|libhostfxr/.test(await readFile(`/proc/${item.child.pid}/maps`, 'utf8')), 'native process has no CLR mapping')
  console.log(JSON.stringify({ native: !!nativePath, advertised: advertised('present').length, absentAdvertises: advertised('absent').length, cancel: true, reconnect: true }))
} catch (error) {
  for (const item of children) console.error(item.id, item.output)
  throw error
} finally {
  for (const item of children) {
    if (item.child.exitCode === null && item.child.signalCode === null) {
      const stopped = once(item.child, 'exit'), force = setTimeout(() => item.child.kill('SIGKILL'), 5000); force.unref()
      item.child.kill('SIGTERM'); await stopped; clearTimeout(force)
    }
  }
  for (const socket of ws.clients) socket.terminate()
  await new Promise(done => ws.close(done))
  for (const server of servers) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
}
