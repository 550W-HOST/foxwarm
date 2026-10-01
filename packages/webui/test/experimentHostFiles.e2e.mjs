#!/usr/bin/env node
import { writeModelFixture } from './experimentModelFixture.mjs'
// Concentrated original-Chat file workflow with real filesystem effects and clean restart.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = await mkdtemp(join(tmpdir(), 'foxwarm-files-e2e-'))
const dataRoot = join(root, 'data'); const workRoot = join(root, 'work')
const apiToken = 'synthetic-devtools-api-secret'; const providerToken = 'synthetic-provider-secret'
const dll = process.env.FOXWARM_EXPERIMENT_HOST_DLL || resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')
const dotnet = join(process.env.DOTNET_ROOT || '', 'dotnet')
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK')
const seen = []; const errors = []
const tasks = new Map(); let taskCounter = 0
let provider, host, browser
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(fn, label, ms = 22000) {
  const end = Date.now() + ms
  while (Date.now() < end) { const result = await fn(); if (result) return result; await sleep(40) }
  throw new Error(`Timed out waiting for ${label}; ${JSON.stringify(errors)}`)
}
async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const chosen = server.address().port; await new Promise(done => server.close(done)); return chosen
}
async function request(portNumber, method, path, value) {
  const response = await fetch(`http://127.0.0.1:${portNumber}${path}`, {
    method, headers: { Authorization: `Bearer ${apiToken}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
function sendSse(response, output) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 200, output_tokens: 20 } } })}\n\n`)
}
const text = body => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: body }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
try {
  await mkdir(dataRoot); await mkdir(workRoot)
  provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); seen.push({ toolCount: body.tools.length })
      const latest = body.input.filter(item => item.type === 'message' && item.role === 'user').at(-1)?.content?.map(item => item.text).join(' ') || ''
      const id = /FILE-TASK-(\d+)/.exec(latest)?.[1]; assert(id, latest.slice(0, 200))
      const task = tasks.get(id); assert(task)
      const existing = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'file-' + id)
      sendSse(res, existing ? [text('FILE-DONE-' + id)] : [call('file-' + id, task.name, task.args)])
    } catch (error) { errors.push(String(error.stack || error)); if (!res.headersSent) res.writeHead(500); res.end() }
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const providerPort = provider.address().port; const hostPort = await port()
  async function startHost() {
  await writeModelFixture(dataRoot, { default: 'scripted-wire', providers: { 'scripted-wire': { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: providerToken, models: ['scripted-wire'] } } })
    const child = spawn(dotnet, [dll], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, FOXWARM_EXPERIMENT_DATA_ROOT: dataRoot, FOXWARM_EXPERIMENT_TOOL_ROOT: workRoot,
      FOXWARM_EXPERIMENT_PORT: String(hostPort), FOXWARM_EXPERIMENT_API_TOKEN: apiToken,
      FOXWARM_EXPERIMENT_PROVIDER_TOKEN: providerToken, FOXWARM_EXPERIMENT_RESPONSES_BASE_URI: `http://127.0.0.1:${providerPort}`,
      FOXWARM_EXPERIMENT_REQUEST_MODEL: 'scripted-wire', FOXWARM_EXPERIMENT_CONCRETE_MODEL: 'scripted-wire',
      FOXWARM_EXPERIMENT_WEBUI_DIST: resolve('packages/webui/dist'),
    } })
    let output = ''; child.stdout.on('data', value => { output = (output + value).slice(-12000) })
    child.stderr.on('data', value => { output = (output + value).slice(-12000) })
    try { await until(async () => {
      if (child.exitCode !== null) throw new Error(`Host exited ${child.exitCode}: ${output}`)
      try { return (await request(hostPort, 'GET', '/health')).status === 200 } catch { return false }
    }, 'host ready', 9000) } catch (error) { console.error('START diagnostic', JSON.stringify({pid: child.pid, exit: child.exitCode, output, root, authority: await Promise.all((await readdir(join(dataRoot, 'state/sessions')).catch(() => [])).map(async name => {const json = JSON.parse(await readFile(join(dataRoot, 'state/sessions', name), 'utf8')); return {name,busy:json.busy,stopping:json.stopping,queue:json.queue.length,history:json.history.length} }))})); throw error }
    return { child, get output() { return output } }
  }
  async function stopHost() {
    assert.equal((await request(hostPort, 'POST', '/admin/shutdown')).status, 202)
    const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([code]) => code), sleep(18000).then(() => 'timeout')])
    assert.equal(code, 0, `Host stop failed: ${host.output}`)
  }
  async function create() {
    const response = await request(hostPort, 'POST', '/api/sessions', {}); assert.equal(response.status, 200); return response.body.sessionId
  }
  async function history(id) { const value = await request(hostPort, 'GET', `/api/sessions/${encodeURIComponent(id)}/history`); assert.equal(value.status, 200); return value.body.messages }
  async function send(id, content) { assert.equal((await request(hostPort, 'POST', `/api/sessions/${encodeURIComponent(id)}/message`, { text: content })).status, 202) }
  host = await startHost(); const firstPid = host.child.pid
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${hostPort}/`, { waitUntil: 'load' }); await page.waitForSelector('#dotnet-token')
  await page.type('#dotnet-token', apiToken); await page.click('button[type="submit"]')
  await page.waitForSelector('button[aria-label="New session"]')
  const flow = await create()
  async function invoke(name, args, id = flow) {
    const key = String(++taskCounter); tasks.set(key, { name, args }); await send(id, 'FILE-TASK-' + key)
    await until(async () => (await history(id)).some(row => row.parts?.some(part => part.text === 'FILE-DONE-' + key)), name + ':' + key, 25000)
    await until(async () => !(await request(hostPort, 'GET', `/api/sessions/${encodeURIComponent(id)}/state`)).body.session.busy, 'idle:' + key)
    const response = (await history(id)).flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'file-' + key)?.functionResponse.response
    assert(response, key); return response
  }
  const prepared = await invoke('exec', { command: `python3 - <<'PY'
from pathlib import Path
p=Path('.')
(p/'large.txt').write_bytes((b'A'*4999+'é'.encode()+b'\\n')+(b'row-middle\\r\\n'*100000)+b'LAST-TAIL')
(p/'giant.txt').write_bytes(b'G'*1100000+b'\\r\\nend')
(p/'mixed.txt').write_bytes(b'one\\r\\ntwo\\rthree\\nlast')
(p/'boundary.txt').write_bytes(b'X'*65535+b'\\r\\n'+b'after\\r'+b'Q'*1050000)
(p/'empty.txt').write_bytes(b'')
(p/'blanks.txt').write_bytes(b'\\r\\n\\n')
(p/'invalid.txt').write_bytes(b'a\\xffb')
(p/'binary.dat').write_bytes(b'\\x00'*1100000)
(p/'dirs').mkdir()
for i in range(55): (p/'dirs'/('item%02d'%i)).write_text(str(i))
(p/'dirs'/'z-subdir').mkdir()
(p/'existing.txt').write_text('ORIGINAL')
(p/'parent-file').write_text('BLOCKER')
(p/'readlink').symlink_to('existing.txt')
import os
os.mkfifo('fifo')
PY`, timeout: 5 })
  assert(!prepared.error, JSON.stringify(prepared))
  const output = async (path, extra = {}) => { const result = await invoke('read', { filePath: path, ...extra }); assert(!result.error, JSON.stringify(result)); return result.output }
  const large = await output('large.txt'); assert(large.length < 13000); assert(large.includes('middle omitted') && large.includes('\\xc3') && large.includes('LAST-TAIL'))
  const range = await output('large.txt', { startLine: 2, endLine: 3 }); assert(range.startsWith('row-middle\r\nrow-middle\r\n---\n')); assert(range.includes('Selected lines 2-3.') && !range.includes(' of '))
  const boundary = await output('boundary.txt', { startLine: 2, endLine: 2 }); assert(boundary.startsWith('after\r---\n'))
  const giant = await output('giant.txt', { startLine: 1, endLine: 1 }); assert(giant.length < 13000 && giant.includes('selected file range middle omitted'))
  const mixed = await output('mixed.txt'); assert(mixed.startsWith('one\r\ntwo\rthree\nlast\n---\n') && mixed.includes('File has 4 lines.') && mixed.includes('no trailing newline'))
  const partial = await output('mixed.txt', { startLine: 2, endLine: 3 }); assert(partial.startsWith('two\rthree\n---\n') && partial.includes('Selected lines 2-3 of 4.'))
  const end = await output('mixed.txt', { startLine: 4, endLine: 0 }); assert(end.startsWith('last\n---\n') && end.includes('no trailing newline'))
  assert((await output('mixed.txt', { startLine: -2, endLine: 1 })).startsWith('one\r\n---'))
  assert((await output('mixed.txt', { endLine: -2 })).includes('no content'))
  assert((await output('mixed.txt', { startLine: 9 })).includes('File has 4 lines.'))
  assert((await output('empty.txt')).includes('File has 0 lines.')); assert((await output('blanks.txt')).includes('only empty lines'))
  assert((await output('invalid.txt')).startsWith('a�b')); assert((await output('binary.dat')).includes('appears binary'))
  const dir = await output('dirs'); assert(dir.includes('Showing items 1-50 of 56.') && !dir.includes('item50'))
  const next = await output('dirs', { startLine: 51 }); assert(next.includes('Showing items 51-56 of 56.') && next.includes('z-subdir/'))
  assert((await output('dirs', { startLine: 0, endLine: -1 })).includes('no items'))
  assert((await invoke('read', { filePath: 'readlink' })).error); assert((await invoke('read', { filePath: 'fifo' })).error)
  assert((await output(join(workRoot, 'mixed.txt'))).includes('File has 4 lines.'))
  function ref(result) { const id = /contentRef: "(write_[a-f0-9]+)"/.exec(result.error?.message || '')?.[1]; assert(id, JSON.stringify(result)); return id }
  const existingRef = ref(await invoke('write', { filePath: 'existing.txt', content: 'REPLACEMENT' }))
  assert.equal(await readFile(join(workRoot, 'existing.txt'), 'utf8'), 'ORIGINAL')
  const peer = await create(); assert((await invoke('write', { filePath: 'peer.txt', contentRef: existingRef, overwrite: true }, peer)).error)
  const agentCreated = await request(hostPort, 'POST', '/api/agents', { agentId: 'other' }); assert.equal(agentCreated.status, 201)
  const agentSession = await request(hostPort, 'POST', '/api/sessions', { agentId: 'other', sessionId: 'reader' }); assert.equal(agentSession.status, 200)
  assert((await invoke('write', { filePath: 'agent-peer.txt', contentRef: existingRef, overwrite: true }, agentSession.body.sessionId)).error)
  assert((await invoke('write', { filePath: '../escape.txt', contentRef: existingRef, overwrite: true })).error)
  assert((await invoke('write', { filePath: 'retry/deep.txt', contentRef: existingRef, overwrite: true })).error.message.includes(existingRef))
  assert((await invoke('write', { filePath: 'retry/deep.txt', contentRef: existingRef, content: 'both', overwrite: true })).error)
  assert(!(await invoke('write', { filePath: 'retry/deep.txt', contentRef: existingRef, overwrite: true, createDirs: true })).error)
  assert.equal(await readFile(join(workRoot, 'retry/deep.txt'), 'utf8'), 'REPLACEMENT')
  assert((await invoke('write', { filePath: 'consumed.txt', contentRef: existingRef, overwrite: true })).error)
  const missingRef = ref(await invoke('write', { filePath: 'missing/file.txt', content: 'CACHED-MISSING' }))
  assert(!(await invoke('write', { filePath: 'new.txt', contentRef: missingRef, overwrite: true })).error)
  assert.equal(await readFile(join(workRoot, 'new.txt'), 'utf8'), 'CACHED-MISSING')
  const parentError = await invoke('write', { filePath: 'parent-file/child.txt', content: 'NO' }); assert(parentError.error.message.includes('not a directory') && !parentError.error.message.includes('contentRef'))
  const hugeOwner = await create()
  const huge = 'W'.repeat(2 * 1024 * 1024 + 1)
  assert(!(await invoke('write', { filePath: 'huge.txt', content: huge }, hugeOwner)).error); assert.equal((await stat(join(workRoot, 'huge.txt'))).size, huge.length)
  const uncached = await invoke('write', { filePath: 'huge.txt', content: huge }, hugeOwner); assert(uncached.error.message.includes('too large to cache') && !uncached.error.message.includes('write_'))
  const oldest = ref(await invoke('write', { filePath: 'existing.txt', content: 'OLDEST' }))
  for (let i = 0; i < 32; i++) ref(await invoke('write', { filePath: 'existing.txt', content: 'EVICT-' + i }))
  assert((await invoke('write', { filePath: 'evicted.txt', contentRef: oldest, overwrite: true })).error)
  const budgetOwner = await create()
  const budgetRef = ref(await invoke('write', { filePath: 'existing.txt', content: 'B'.repeat(2 * 1024 * 1024) }, budgetOwner))
  for (let i = 0; i < 4; i++) ref(await invoke('write', { filePath: 'existing.txt', content: 'C'.repeat(2 * 1024 * 1024) }, await create()))
  assert((await invoke('write', { filePath: 'budget-evicted.txt', contentRef: budgetRef, overwrite: true }, budgetOwner)).error)
  const restartRef = ref(await invoke('write', { filePath: 'existing.txt', content: 'RESTART' }))
  await page.evaluate(id => { window.history.replaceState(null, '', '/?session=' + encodeURIComponent(id)); location.reload() }, flow)
  await page.waitForFunction(() => typeof window.foxwarmTest?.switchToSession === 'function')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), flow)
  await page.waitForFunction(() => document.body.textContent.includes('FILE-DONE-'))
  const original = await readFile(join(workRoot, 'mixed.txt'))
  await stopHost(); host = null; host = await startHost(); const secondPid = host.child.pid; assert.notEqual(firstPid, secondPid)
  assert((await invoke('write', { filePath: 'restart.txt', contentRef: restartRef, overwrite: true })).error)
  assert.deepEqual(await readFile(join(workRoot, 'mixed.txt')), original)
  assert.equal(await readFile(join(workRoot, 'retry/deep.txt'), 'utf8'), 'REPLACEMENT')
  assert.deepEqual(errors, []); await stopHost(); host = null
  console.log(JSON.stringify({ result: 'ok', requests: seen.length, tasks: taskCounter, firstPid, secondPid, exactPhysicalLines: true, boundedLargeFiles: true, directoryPagination: true, cachedRetry: true, scopedRefs: true, consumedEvictedRestart: true, oversizeUncached: true, originalChat: true }))
} finally {
  if (browser) await browser.close().catch(() => {})
  if (host?.child.exitCode === null) { try { process.kill(-host.child.pid, 'SIGKILL') } catch {} await once(host.child, 'exit').catch(() => {}) }
  if (provider) await new Promise(done => provider.close(done)); await rm(root, { recursive: true, force: true })
}
