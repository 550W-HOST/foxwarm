#!/usr/bin/env node
// One owned localhost scripted-provider development workflow, including clean restart.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = await mkdtemp(join(tmpdir(), 'foxwarm-devtools-e2e-'))
const dataRoot = join(root, 'data'); const workRoot = join(root, 'work')
const apiToken = 'synthetic-devtools-api-secret'; const providerToken = 'synthetic-provider-secret'
const dll = process.env.FOXWARM_EXPERIMENT_HOST_DLL || resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')
const dotnet = join(process.env.DOTNET_ROOT || '', 'dotnet')
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK')
const seen = []; const errors = []
let foreignExecId
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
const toolOutput = (body, id) => body.input.find(item => item.type === 'function_call_output' && item.call_id === id)?.output || ''
function extractExecId(output) { const id = /execId: ([a-z]+-[a-z]+)/.exec(output)?.[1]; assert(id, `Missing execId in ${String(output).slice(-250)}`); return id }
try {
  await mkdir(dataRoot); await mkdir(workRoot)
  await writeFile(join(workRoot, 'src.txt'), 'old\nduplicate\nduplicate\n', 'utf8')
  await writeFile(join(workRoot, 'empty.txt'), '', 'utf8')
  await writeFile(join(workRoot, 'anchor.txt'), 'header\r\nold\r\n', 'utf8')
  await writeFile(join(root, 'outside.txt'), 'untouched', 'utf8')
  await symlink('../outside.txt', join(workRoot, 'symlink'))
  const requests = []
  provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(req.url, '/responses'); assert.equal(req.headers.authorization, `Bearer ${providerToken}`)
      assert.deepEqual(body.tools.map(tool => tool.name),
        ['read', 'write', 'edit', 'apply_patch', 'exec', 'read_exec', 'recall', 'create_agent', 'create_session', 'create_child_session', 'send_to_session', 'refresh_session_snapshot', 'submit_compact_plan'])
      const payload = JSON.stringify(body.input)
      const latest = body.input.filter(item => item.type === 'message' && item.role === 'user')
        .at(-1)?.content?.map(item => item.text).join(' ') || ''
      const calls = body.input.filter(item => item.type === 'function_call')
      requests.push({ latest, calls: calls.length })
      let output
      if (payload.includes('DEV-FLOW')) {
        const steps = [
          () => call('inspect', 'read', { filePath: 'src.txt' }),
          () => call('edit-once', 'edit', { filePath: 'src.txt', oldText: 'old', newText: 'new' }),
          () => call('edit-duplicate', 'edit', { filePath: 'src.txt', oldText: 'duplicate', newText: 'same' }),
          () => call('edit-empty', 'edit', { filePath: 'empty.txt', oldText: '', newText: 'seed' }),
          () => call('patch-add-update', 'apply_patch', { input: '*** Begin Patch\n*** Add File: nested/sub/new.txt\n+new content\n*** Update File: src.txt\n@@\n-new\n+patched\n duplicate\n duplicate\n*** Update File: anchor.txt\n@@ header\n-old\n+fresh\n*** End Patch' }),
          () => call('patch-unsafe', 'apply_patch', { input: '*** Begin Patch\n*** Add File: denied-first.txt\n+must not appear\n*** Add File: ../outside.txt\n+never\n*** End Patch' }),
          () => call('patch-symlink', 'apply_patch', { input: '*** Begin Patch\n*** Update File: symlink\n@@\n-untouched\n+changed\n*** End Patch' }),
          () => call('patch-partial', 'apply_patch', { input: '*** Begin Patch\n*** Add File: partial.txt\n+already committed\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch' }),
          () => call('nonzero', 'exec', { command: "printf 'start  \\n'; exit 7", timeout: 2 }),
          () => call('env', 'exec', { command: 'if [ -n "$FOXWARM_EXPERIMENT_PROVIDER_TOKEN" ]; then echo SECRET-LEAK; else echo CLEAN-ENV; fi', timeout: 2 }),
          () => call('big', 'exec', { command: "python3 -c \"import sys;sys.stdout.buffer.write(b'A'*16383 + b'\\\\xc3\\\\xa9' + b'B'*1100000)\"", timeout: 3 }),
          () => call('page-both', 'read_exec', { execId: extractExecId(toolOutput(body, 'big')), offset: 16383 }),
          () => call('page-broken', 'read_exec', { execId: extractExecId(toolOutput(body, 'big')), offset: 16384 }),
          () => call('page-middle', 'read_exec', { execId: extractExecId(toolOutput(body, 'big')), offset: 550000 }),
        ]
        if (calls.length < steps.length) output = [steps[calls.length]()]
        else output = [text('DEV-FLOW completed')]
      } else if (payload.includes('DEV-BG')) {
        if (payload.includes('background-process-finished'))
          output = calls.some(item => item.name === 'read_exec') ? [text('DEV-BG completion read')] :
            [call('bg-read', 'read_exec', { execId: extractExecId(toolOutput(body, 'bg')) })]
        else output = calls.some(item => item.call_id === 'bg') ? [text('DEV-BG outstanding')] :
          [call('bg', 'exec', { command: "sleep 4; printf 'BACKGROUND-DONE\\n'", timeout: 1 })]
      } else if (payload.includes('DEV-STOP')) {
        output = calls.length > 0 ? [text('stopped command not killed')] :
          [call('stop-running', 'exec', { command: "sleep 3; printf 'STOP-CHILD-DONE\\n'", timeout: 15 })]
      } else if (payload.includes('DEV-OWNER')) {
        output = calls.length > 0 ? [text('DEV-OWNER checked')] :
          [call('foreign-read', 'read_exec', { execId: foreignExecId })]
      } else output = [text('routine compact regression')]
      seen.push({ input: body.input, output }); sendSse(res, output)
    } catch (error) { errors.push(String(error.stack || error)); if (!res.headersSent) res.writeHead(500); res.end() }
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  const providerPort = provider.address().port; const hostPort = await port()
  async function startHost() {
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
  async function history(id) { const value = await request(hostPort, 'GET', `/api/sessions/${id}/history`); assert.equal(value.status, 200); return value.body.messages }
  async function send(id, content) { assert.equal((await request(hostPort, 'POST', `/api/sessions/${id}/message`, { text: content })).status, 202) }
  host = await startHost(); const firstPid = host.child.pid
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${hostPort}/`, { waitUntil: 'load' }); await page.waitForSelector('#experiment-token')
  await page.type('#experiment-token', apiToken); await page.click('button[type="submit"]')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(item => item.textContent === 'New session'))
  const flow = await create(); await send(flow, 'DEV-FLOW')
  try { await until(async () => (await history(flow)).some(item => item.parts?.some(part => part.text?.includes('DEV-FLOW completed'))), 'dev flow', 3500) }
  catch (error) { console.error('DEV-FLOW diagnostic', JSON.stringify({ rows: (await history(flow)).map(row => ({role:row.role,call:row.parts?.[0]?.functionCall?.name,response:row.parts?.[0]?.functionResponse?.name,output:String(row.parts?.[0]?.functionResponse?.response?.output||'').slice(0,100)})).slice(-6), state: (await request(hostPort, 'GET', `/api/sessions/${flow}/state`)).body, requests:requests.slice(-4), errors, host: host.output })); throw error }
  const rows = await history(flow)
  function responseOf(id) {
    return rows.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
  }
  assert.equal(responseOf('inspect')?.output.includes('old'), true)
  assert.match(JSON.stringify(responseOf('edit-duplicate')), /2 occurrences/)
  assert.equal(await readFile(join(workRoot, 'empty.txt'), 'utf8'), 'seed')
  assert.match(JSON.stringify(responseOf('patch-partial')), /Operations already applied/)
  assert.equal(responseOf('patch-unsafe')?.error?.type, 'invalid_path')
  assert.equal(responseOf('patch-symlink')?.error?.type, 'invalid_path')
  assert.match(responseOf('nonzero')?.output || '', /Exit code: 7/)
  assert.match(responseOf('env')?.output || '', /CLEAN-ENV/)
  assert.doesNotMatch(responseOf('env')?.output || '', /SECRET-LEAK|synthetic-provider-secret/)
  assert.match(responseOf('page-both')?.output || '', /^é/)
  assert.match(responseOf('page-broken')?.output || '', /^\\xA9/)
  assert.match(responseOf('page-middle')?.output || '', /^B/)
  assert.equal(await readFile(join(workRoot, 'src.txt'), 'utf8'), 'patched\nduplicate\nduplicate\n')
  assert.equal(await readFile(join(workRoot, 'nested/sub/new.txt'), 'utf8'), 'new content')
  assert.equal(await readFile(join(workRoot, 'anchor.txt'), 'utf8'), 'header\r\nfresh\r\n')
  assert.equal(await stat(join(workRoot, 'denied-first.txt')).catch(() => null), null)
  assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), 'untouched')
  assert.equal(await readFile(join(workRoot, 'partial.txt'), 'utf8'), 'already committed')
  const bigId = extractExecId(responseOf('big')?.output)
  foreignExecId = bigId
  assert((await stat(join(dataRoot, 'state/exec', flow, bigId, 'output.log'))).size > 1_000_000)
  await page.goto(`http://127.0.0.1:${hostPort}/?sessionId=${flow}`, { waitUntil: 'load' })
  await page.waitForSelector('.foxwarm-chat-root')
  await page.waitForFunction(() => document.body.textContent.includes('DEV-FLOW completed'))

  const otherId = await create(); await send(otherId, 'DEV-OWNER')
  await until(async () => (await history(otherId)).some(row => row.parts?.some(part => part.text?.includes('DEV-OWNER checked'))),
    'foreign exec owner denial')
  const foreignResponse = (await history(otherId)).flatMap(row => row.parts || [])
    .find(part => part.functionResponse?.tool_use_id === 'foreign-read')?.functionResponse?.response
  assert.equal(foreignResponse?.error?.type, 'exec_not_found')

  const stopId = await create(); await send(stopId, 'DEV-STOP')
  await until(async () => { const ids = await readdir(join(dataRoot, 'state/exec', stopId)).catch(() => []); return ids.length === 1 && (await stat(join(dataRoot, 'state/exec', stopId, ids[0], 'tracking.json')).catch(() => null)) }, 'persisted started stop command')
  assert.equal((await request(hostPort, 'POST', `/api/sessions/${stopId}/stop`)).status, 200)
  await until(async () => (await history(stopId)).some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'stop-running')),
    'paired stopped exec tool response')
  const stopRows = await history(stopId)
  assert(stopRows.some(row => row.parts?.some(part => part.functionCall?.id === 'stop-running')))
  assert(stopRows.some(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'stop-running')))

  const bg = await create(); await send(bg, 'DEV-BG')
  await until(async () => (await history(bg)).some(row => row.parts?.some(part => part.text?.includes('DEV-BG outstanding'))), 'background turn completed')
  const bgBefore = await history(bg)
  const bgResult = bgBefore.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'bg')?.functionResponse?.response
  const bgExecId = extractExecId(bgResult?.output)
  assert.equal((await request(hostPort, 'POST', '/admin/shutdown')).status, 202)
  const firstCode = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([code]) => code), sleep(18000).then(() => 'timeout')])
  assert.equal(firstCode, 0, host.output)
  host = await startHost(); assert.notEqual(host.child.pid, firstPid)
  try { await until(async () => (await history(bg)).some(row => row.parts?.some(part => part.text?.includes('DEV-BG completion read'))),
    'same-Session event continuation after restart', 6000) }
  catch (error) { console.error('BG diagnostic', JSON.stringify({ rows: (await history(bg)).map(row => ({role:row.role,part: JSON.stringify(row.parts?.[0]).slice(0,250)})), state: (await request(hostPort, 'GET', `/api/sessions/${bg}/state`)).body, files: await readdir(join(dataRoot, 'state/exec', bg, bgExecId)), provider:requests.slice(-4), errors, host:host.output })); throw error }
  const after = await history(bg)
  assert.equal(after.flatMap(row => row.parts || []).filter(part => part.system?.includes('background-process-finished')).length, 1)
  assert(after.some(row => row.parts?.some(part => part.functionCall?.name === 'read_exec')))
  const readBack = after.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'bg-read')?.functionResponse?.response
  assert.match(readBack?.output || '', /BACKGROUND-DONE/)
  assert.equal(extractExecId(bgResult.output), bgExecId)
  assert.equal((await stat(join(dataRoot, 'state/exec', bg, bgExecId, 'output.log'))).size > 0, true)
  await until(async () => (await stat(join(dataRoot, 'state/exec', stopId,
    (await readdir(join(dataRoot, 'state/exec', stopId)))[0], 'status.json')).catch(() => null)) !== null,
    'stopped child exits naturally', 13000)
  assert.equal(errors.length, 0, errors.join('\n'))
  await stopHost()
  console.log(JSON.stringify({ result: 'ok', firstPid, secondPid: host.child.pid,
    requests: seen.length, tools: 8, execIds: [bigId, bgExecId], completionEvents: 1, originalChat: true }))
} finally {
  try { await browser?.close() } catch {}
  if (host?.child?.exitCode === null) { host.child.kill('SIGTERM'); await Promise.race([once(host.child, 'exit'), sleep(6000)]) }
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)) }
  // All synthetic shell commands end in at most four seconds; no broad process/PID kill.
  await sleep(4100)
  await rm(root, { recursive: true, force: true })
}
