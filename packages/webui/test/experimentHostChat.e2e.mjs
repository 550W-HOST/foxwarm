#!/usr/bin/env node
// One local, bounded, real-browser experiment using the shared Chat component.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import puppeteer from 'puppeteer-core'

const token = 'local-browser-test-api-token'
const providerToken = 'local-browser-test-provider-token'
const dotnet = join(process.env.DOTNET_ROOT || '', 'dotnet')
const dll = process.env.FOXWARM_EXPERIMENT_HOST_DLL || resolve(import.meta.dirname, '../../../dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK.')
const dist = resolve('packages/webui/dist')
const root = await mkdtemp(join(tmpdir(), 'foxwarm-chat-browser-'))
let provider, browser, host
const held = new Set()
let providerRequests = 0
let heldProviderClosed = false
const errors = []

function event(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}
function completed(res, output) {
  event(res, { type: 'response.completed', response: { output } })
  res.end()
}
function call(res, id, name, args) {
  completed(res, [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }])
}
function message(text) {
  return { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }
}
function sleep(ms) { return new Promise(done => setTimeout(done, ms)) }
async function until(check, label, ms = 12000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const result = await check()
    if (result) return result
    await sleep(30)
  }
  throw Error(`Timed out waiting for ${label}`)
}
async function openPort() {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const port = s.address().port
  await new Promise(done => s.close(done))
  return port
}
async function json(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(6000),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function startHost(port, providerPort, dataRoot, toolRoot) {
  const env = {
    ...process.env,
    FOXWARM_EXPERIMENT_DATA_ROOT: dataRoot,
    FOXWARM_EXPERIMENT_TOOL_ROOT: toolRoot,
    FOXWARM_EXPERIMENT_PORT: `${port}`,
    FOXWARM_EXPERIMENT_API_TOKEN: token,
    FOXWARM_EXPERIMENT_PROVIDER_TOKEN: providerToken,
    FOXWARM_EXPERIMENT_RESPONSES_BASE_URI: `http://127.0.0.1:${providerPort}`,
    FOXWARM_EXPERIMENT_REQUEST_MODEL: 'local-browser-model',
    FOXWARM_EXPERIMENT_CONCRETE_MODEL: 'local-browser-model',
    FOXWARM_EXPERIMENT_WEBUI_DIST: dist,
  }
  const child = spawn(dotnet, [dll], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', bytes => { output = (output + bytes).slice(-12000) })
  child.stderr.on('data', bytes => { output = (output + bytes).slice(-12000) })
  await until(async () => {
    if (child.exitCode !== null) throw Error(`Host exited early: ${output}`)
    try { return (await json(port, 'GET', '/health')).status === 200 } catch { return false }
  }, 'host readiness', 15000)
  return { child, get output() { return output } }
}
async function stopHost(port, process) {
  const response = await json(port, 'POST', '/admin/shutdown')
  assert.equal(response.status, 202)
  const status = process.child.exitCode !== null ? process.child.exitCode : (await Promise.race([
    once(process.child, 'exit').then(([code]) => code), sleep(15000).then(() => 'timeout'),
  ]))
  assert.equal(status, 0, `Host failed to stop cleanly: ${process.output}`)
}
async function send(page, text) {
  await page.click('[role="textbox"][aria-label="Message"]')
  await page.type('[role="textbox"][aria-label="Message"]', text)
  await page.click('button[aria-label="Send message"]')
}
async function timeline(page, text) {
  await page.waitForFunction(needle => document.querySelector('[data-chat-timeline="committed"]')?.textContent?.includes(needle),
    { timeout: 12000 }, text)
}
async function browserHistory(page, id) {
  return page.evaluate(async sessionId => {
    const response = await fetch(`/api/sessions/${sessionId}/history?tail=100`)
    if (!response.ok) throw Error(`history HTTP ${response.status}`)
    return response.json()
  }, id)
}

try {
  const dataRoot = join(root, 'data')
  const toolRoot = join(root, 'workspace')
  await mkdir(dataRoot)
  await mkdir(toolRoot)
  provider = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/responses')
      assert.equal(req.headers.authorization, `Bearer ${providerToken}`)
      const chunks = []
      for await (const bytes of req) chunks.push(bytes)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.deepEqual(body.tools.map(item => item.name), ['read', 'write', 'edit', 'apply_patch', 'exec', 'read_exec', 'recall', 'submit_compact_plan'])
      assert.equal(body.tools[6].parameters.properties.target.pattern, '^msg#[1-9][0-9]*$')
      assert.deepEqual(body.tools[7].parameters.required, ['replaceAsBlocks'])
      providerRequests++
      const input = JSON.stringify(body.input)
      const calls = body.input.filter(item => item.type === 'function_call')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' })
      if (input.includes('hold request')) {
        held.add(res)
        res.on('close', () => { held.delete(res); heldProviderClosed = true })
        event(res, { type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', role: 'assistant', content: [] } })
        event(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0,
          delta: 'Waiting to stop' })
        return
      }
      if (!calls.some(item => item.call_id === 'write-one')) {
        call(res, 'write-one', 'write', { filePath: 'note.txt', content: 'héllo' })
      } else if (!calls.some(item => item.call_id === 'read-one')) {
        call(res, 'read-one', 'read', { filePath: 'note.txt' })
      } else {
        event(res, { type: 'response.output_item.added', output_index: 0,
          item: { type: 'message', role: 'assistant', content: [] } })
        event(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0,
          delta: 'The note is' })
        await sleep(400)
        event(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0,
          delta: ' héllo.' })
        completed(res, [message('The note is héllo.')])
      }
    } catch (error) {
      errors.push(String(error))
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const providerPort = provider.address().port
  const port = await openPort()
  host = await startHost(port, providerPort, dataRoot, toolRoot)
  const firstPid = host.child.pid
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
    headless: true, timeout: 15000, args: ['--no-sandbox', '--disable-setuid-sandbox'],
    userDataDir: join(root, 'browser') })
  const page = await browser.newPage()
  page.on('pageerror', error => errors.push(`browser ${String(error)}`))
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.waitForSelector('#experiment-token')
  await page.type('#experiment-token', token)
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'New session'))
  assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_token')), null)
  assert(!((await page.evaluate(() => document.cookie)).includes(token)))
  assert(!(page.url().includes(token)))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'New session')?.click())
  await page.waitForSelector('.foxwarm-chat-root')
  const id = new URL(page.url()).searchParams.get('sessionId')
  assert.match(id, /^s_[0-9a-f]{32}$/)
  assert.equal((await json(port, 'GET', '/api/sessions')).body.sessions.length, 1)
  await send(page, 'Make a note')
  await timeline(page, 'The note is héllo.')
  await page.waitForFunction(() => document.querySelectorAll('[data-tool-header-tone]').length >= 2)
  await until(async () => (await browserHistory(page, id)).messages.length >= 6, 'first tool loop persistence')
  const first = await browserHistory(page, id)
  assert.deepEqual(first.messages.map(row => row.role), ['user', 'model', 'tool', 'model', 'tool', 'model'])
  assert.equal(first.messages[5].__meta.llmRequestId?.length, 32)
  assert.equal(await readFile(join(toolRoot, 'note.txt'), 'utf8'), 'héllo')
  await send(page, 'hold request')
  await timeline(page, 'Waiting to stop')
  await send(page, 'queued while busy')
  await page.waitForSelector('[data-queued-preview="true"]')
  assert.equal((await browserHistory(page, id)).queueLength, 1)
  await page.reload({ waitUntil: 'load' })
  await timeline(page, 'Waiting to stop')
  await page.waitForSelector('[data-queued-preview="true"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Stop'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Stop')?.click())
  await until(() => heldProviderClosed, 'Stop closing the held provider connection')
  await until(async () => (await browserHistory(page, id)).messages.length === 8, 'Stop committing queued input')
  const beforeRestart = await browserHistory(page, id)
  assert.equal(beforeRestart.queueLength, 0)
  await stopHost(port, host)
  host = null
  const second = await startHost(port, providerPort, dataRoot, toolRoot)
  host = second
  assert.notEqual(second.child.pid, firstPid)
  await page.reload({ waitUntil: 'load' })
  await timeline(page, 'The note is héllo.')
  await timeline(page, 'queued while busy')
  const afterRestart = await browserHistory(page, id)
  assert.deepEqual(afterRestart.messages.map(row => row.__meta.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(afterRestart.latestSeq, 8)
  assert.equal(afterRestart.queueLength, 0)
  assert.equal(providerRequests, 4, 'No provider resend after clean restart')
  assert.equal(await readFile(join(toolRoot, 'note.txt'), 'utf8'), 'héllo')
  assert.deepEqual(errors, [])
  await stopHost(port, second)
  host = null
  console.log(JSON.stringify({ result: 'ok', firstPid, secondPid: second.child.pid,
    sessionId: id, providerRequests, committedRows: 8, draftAfterReload: true,
    queuedPreview: true, toolCards: true, stoppedProviderConnection: heldProviderClosed, cookieLogin: true }))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (host?.child.exitCode === null) {
    try { process.kill(-host.child.pid, 'SIGKILL') } catch {}
    await once(host.child, 'exit').catch(() => {})
  }
  for (const res of held) res.end()
  provider?.closeAllConnections()
  if (provider?.listening) await new Promise(done => provider.close(done))
  await rm(root, { recursive: true, force: true })
}
