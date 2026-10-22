#!/usr/bin/env node
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'
// Concentrated original-App -> scripted Responses -> real official-SDK MCP workflow.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

const root = await mkdtemp(join(tmpdir(), 'foxwarm-unified-mcp-'))
const data = join(root, 'data'); const work = join(root, 'work'); const peerRoot = join(root, 'peer')
const peerFile = resolve(import.meta.dirname, 'experimentHostMcp.peer.mjs')
const token = 'synthetic-mcp-api-token'; const providerToken = 'synthetic-mcp-provider-token'
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK')
const dotnet = join(process.env.DOTNET_ROOT, 'dotnet')
const sleep = ms => new Promise(done => setTimeout(done, ms))
const exists = file => access(file).then(() => true, () => false)
const text = value => ({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: value }] })
const fn = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const invoke = (id, target, args = {}) => fn(id, 'call_tool', typeof target === 'string' ? { toolId: target, args } : { ...target, args })
const requests = []; const failures = []; const scripts = new Map(); const pids = []; let serial = 0
let provider, browser, page, host, httpPeer, port, httpPort, current
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await sleep(25) }
  throw new Error(`Timeout: ${label}; ${JSON.stringify({ failures, host: host?.output, requests: requests.slice(-3).map(item => item.task) })}`)
}
async function request(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const route = id => `/api/sessions/${encodeURIComponent(id)}`
async function history(id = current) { return (await request('GET', route(id) + '/history')).body.messages }
async function state(id = current) { return (await request('POST', '/api/session-list/by-id', { ids: [id] })).body.results[0].session }
async function idle(id = current) { return until(async () => !(await state(id)).busy, id + ' idle') }
async function pair(id, owner = current) {
  return until(async () => (await history(owner)).flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response, id + ' paired')
}
async function create(name) { const result = await request('POST', '/api/sessions', { agentId: 'team', sessionId: name }); assert.equal(result.status, 200); return result.body.sessionId }
async function task(calls, { owner = current, final = true, browserSend = false } = {}) {
  const key = 'task-' + (++serial); scripts.set(key, { calls, final, owner }); const message = 'MCP-TASK ' + key
  if (browserSend) {
    await page.evaluate(id => { location.hash = '#session/' + encodeURIComponent(id) }, owner)
    const chat = `[data-workbench-content-tab=${JSON.stringify('chat:' + owner)}] .foxwarm-chat-root[data-chat-connection-state="connected"]`
    await page.waitForSelector(chat, { visible: true })
    const editor = chat + ' [role="textbox"][aria-label="Message"]'
    await page.click(editor); await page.type(editor, message)
    await page.click(chat + ' button[aria-label="Send message"]')
  } else assert.equal((await request('POST', route(owner) + '/message', { text: message })).status, 202)
  if (final) {
    await until(async () => (await history(owner)).some(row => row.parts?.some(part => part.text === 'DONE-' + key)), key + ' final')
    await idle(owner)
  }
  return key
}
async function perform(target, args, id, owner = current) { await task([invoke(id, target, args)], { owner }); return pair(id, owner) }
async function lines(file) { return (await readFile(join(peerRoot, file), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
async function startHost() {
  await mkdir(join(data, 'state'), { recursive: true })
  await writeFile(join(data, 'state', 'token'), token, { mode: 0o600 })
  await writeModelFixture(data, { default: 'local', providers: { 'local': { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${provider.address().port}`, apiKey: providerToken, models: ['wire'] } } })
  const child = spawn(dotnet, [resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...testEnvironment.isolatedApplicationEnv(data),
    FOXWARM_EXPERIMENT_DATA_ROOT: data, FOXWARM_EXPERIMENT_TOOL_ROOT: work, FOXWARM_EXPERIMENT_API_TOKEN: token,
    FOXWARM_EXPERIMENT_RESPONSES_BASE_URI: `http://127.0.0.1:${provider.address().port}`, FOXWARM_EXPERIMENT_PROVIDER_TOKEN: providerToken,
    FOXWARM_EXPERIMENT_REQUEST_MODEL: 'wire', FOXWARM_EXPERIMENT_CONCRETE_MODEL: 'local/wire', FOXWARM_EXPERIMENT_WEBUI_DIST: resolve('packages/webui/dist'),
    MCP_HOST_ONLY_SENTINEL: 'synthetic-host-only-credential' } })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-20000) })
  host = { child, get output() { return output } }; pids.push(child.pid)
  await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return (await request('GET', '/health')).status === 200 } catch { return false } }, 'host ready')
}
async function stopHost() {
  assert.equal((await request('POST', '/admin/shutdown')).status, 202)
  const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([status]) => status), sleep(15000).then(() => 'timeout')])
  assert.equal(code, 0, host.output)
}
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
try {
  await mkdir(data); await mkdir(work); await mkdir(peerRoot)
  provider = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(req.headers.authorization, `Bearer ${providerToken}`)
      assert(body.tools.some(tool => tool.name === 'compact_session')); assert(body.tools.some(tool => tool.name === 'call_tool')); assert(body.tools.some(tool => tool.name === 'search_tools'))
      assert(!body.tools.some(tool => tool.name === 'mcp_config' || tool.name === 'list_mcp_servers' || tool.name === 'echo_effect'))
      for (const tool of body.tools) {
        const fields = tool.parameters.properties
        if (tool.name === 'submit_compact_plan') assert.equal(fields.__cancelTool, undefined)
        else { assert.deepEqual(fields.__cancelTool.enum, [true]); assert.equal(Object.keys(fields).at(-1), '__cancelAllToolsThisTurn') }
      }
      for (const call of body.input.filter(item => item.type === 'function_call')) assert(body.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id), call.call_id + ' historical provider pairing')
      const inputs = body.input.filter(item => item.type === 'message' && item.role === 'user').flatMap(item => item.content || []).map(part => part.text || '')
      const key = inputs.findLast(value => value.includes('MCP-TASK '))?.match(/MCP-TASK (task-\d+)/)?.[1]; assert(key, 'Owned current task')
      const script = scripts.get(key); assert(script, key)
      const already = script.calls.every(call => body.input.some(item => item.type === 'function_call' && item.call_id === call.call_id))
      if (already) for (const call of script.calls) assert(body.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id), call.call_id + ' provider paired result')
      requests.push({ task: key, body, final: already })
      const output = already ? [text('DONE-' + key)] : script.calls
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`)
    } catch (error) { failures.push(String(error.stack || error)); if (!res.headersSent) res.writeHead(500); res.end() }
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  httpPeer = spawn(process.execPath, [peerFile, 'http', peerRoot, 'http-label'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = ''; httpPeer.stdout.on('data', bytes => { ready += bytes }); httpPeer.stderr.on('data', bytes => failures.push('HTTP peer: ' + bytes))
  await until(() => ready.includes('\n'), 'real HTTP peer'); httpPort = JSON.parse(ready.trim().split('\n')[0]).port
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); port = reserve.address().port; await new Promise(done => reserve.close(done))
  await mkdir(join(data, 'state'), { recursive: true })
  await writeFile(join(data, 'state/config.yaml'), `bot: {httpPort: ${port}}\n`)
  await writeFile(join(data, 'state/token'), token, { mode: 0o600 })
  await startHost(); assert.equal((await request('POST', '/api/agents', { agentId: 'team' })).status, 201)
  current = await create('driver'); const admin = await create('operator')
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'], userDataDir: join(root, 'browser') })
  page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' }); await page.waitForSelector('#token')
  await page.type('#token', token); await page.click('button[type="submit"]'); await page.waitForSelector('button[aria-label="New session"]'); await waitForWebUiReady(page)

  await task([fn('discover-builtin', 'search_tools', { query: 'MCP server', sources: ['builtin'], limit: 10 }), fn('discover-node', 'search_tools', { query: 'read', sources: ['node'], limit: 1 })], { browserSend: true })
  assert.match((await pair('discover-builtin')).output, /builtin:mcp_config/); assert.match((await pair('discover-builtin')).output, /builtin:list_mcp_servers/)
  assert.match((await pair('discover-node')).output, /node:master\/read/); assert(!(await pair('discover-node')).output.includes('builtin:read'))
  const configFile = join(data, 'state', 'mcp.json')
  await writeFile(configFile, JSON.stringify({ servers: { malformed: { transport: 'synthetic-private-transport', token: 'synthetic-private-transport' } } }))
  for (let index = 0; index < 2; index++) {
    const partial = await perform('builtin:search_tools', { sources: ['builtin', 'mcp'], query: 'session', limit: 1 }, 'config-unavailable-' + index)
    assert.match(partial.output, /builtin:session/); assert.match(partial.output, /configuration is unavailable/); assert(!partial.output.includes('synthetic-private-transport'))
  }
  await writeFile(configFile, JSON.stringify({ servers: {} }))
  assert((await perform('builtin:skill', { action: 'load', skillName: 'mcp-management' }, 'guide')).output.includes('MCP management'))
  assert.equal((await perform('node:master/write', { filePath: 'same-owner.txt', content: 'one-write' }, 'owned-write')).error, undefined)
  assert.match((await perform({ source: 'node', name: 'read', nodeId: 'current' }, { filePath: 'same-owner.txt' }, 'owned-read')).output, /one-write/)
  await perform('builtin:set_goal', { goal: 'MCP-WORKFLOW-GOAL', remindEvery: 1000 }, 'owned-goal')
  assert((await readFile(join(data, 'state', 'sessions', current + '.json'), 'utf8')).includes('MCP-WORKFLOW-GOAL'))
  assert(!(await readFile(join(data, 'state', 'sessions', admin + '.json'), 'utf8')).includes('MCP-WORKFLOW-GOAL'))
  await task([invoke('bad-builtin-node', 'builtin:write', { filePath: 'wrong.txt', content: 'bad' }), invoke('bad-nonmaster', 'node:remote/write', { filePath: 'wrong.txt', content: 'bad' }), invoke('bad-recursion', 'builtin:call_tool', { toolId: 'node:master/write', args: { filePath: 'wrong.txt', content: 'bad' } })])
  for (const id of ['bad-builtin-node', 'bad-nonmaster', 'bad-recursion']) assert((await pair(id)).error)
  assert(!await exists(join(work, 'agents', 'team', 'wrong.txt')))

  const config = { name: 'local', transport: 'stdio', command: process.execPath, args: [peerFile, 'stdio', peerRoot, 'initial-label'], cwd: peerRoot,
    envJson: JSON.stringify({ MCP_SYNTHETIC_ENV: 'configured-test-value', MCP_SYNTHETIC_SECRET: 'synthetic-only-secret' }), timeoutSeconds: 4 }
  await perform('builtin:mcp_config', config, 'configure-local')
  const env = { MCP_SYNTHETIC_ENV: 'configured-test-value', MCP_SYNTHETIC_SECRET: 'synthetic-only-secret' }
  await perform('builtin:mcp_config', { name: 'local', env, envJson: '{malformed-ignored' }, 'env-primary')
  await perform('builtin:mcp_config', { name: 'local', env: 'not-object', envJson: JSON.stringify(env) }, 'env-json-fallback')
  assert((await perform('builtin:mcp_config', { name: 'local', env: null }, 'env-invalid-null')).error)
  await perform('builtin:mcp_config', { name: 'nonempty-invalid-url', url: 'not a URI' }, 'saved-nonempty-url')
  assert((await perform('mcp:nonempty-invalid-url/echo_effect', {}, 'invalid-url-connect')).error)
  await perform('builtin:mcp_config', { name: 'nonempty-invalid-url', enable: false }, 'disable-invalid-url')
  const before = (await lines('processes.ndjson')).length
  await task([fn('cancelled-discovery', 'search_tools', { sources: ['mcp'] }), fn('cancel-entire', 'write', { filePath: 'cancel-all.txt', content: 'bad', __cancelAllToolsThisTurn: true })])
  assert.equal((await pair('cancelled-discovery')).canceled, true); assert.equal((await lines('processes.ndjson')).length, before)
  assert(!await exists(join(work, 'agents', 'team', 'cancel-all.txt')))
  await task([fn('single-cancel', 'write', { filePath: 'cancel-one.txt', content: 'bad', __cancelTool: true }), fn('invalid-control', 'write', { filePath: 'cancel-invalid.txt', content: 'bad', __cancelTool: false }), invoke('normal-after-cancel', 'node:master/write', { filePath: 'after-cancel.txt', content: 'ok' })])
  assert.equal((await pair('single-cancel')).canceled, true); assert((await pair('invalid-control')).error)
  assert(!await exists(join(work, 'agents', 'team', 'cancel-one.txt')))
  const controls = (await history()).flatMap(row => row.parts || []).find(part => part.functionCall?.id === 'single-cancel').functionCall
  assert.equal(controls.args.__cancelTool, true)
  await task([fn('primary-object-wins', 'call_tool', { toolId: 'node:master/write', args: { filePath: 'fallback.txt', content: 'primary' }, argsJson: '{malformed-ignored' }),
    fn('invalid-primary-json-fallback', 'call_tool', { toolId: 'node:master/read', args: 'not-object', argsJson: JSON.stringify({ filePath: 'fallback.txt' }) }),
    fn('bad-json-fallback', 'call_tool', { toolId: 'node:master/write', argsJson: '[1,2]' })])
  assert.match((await pair('invalid-primary-json-fallback')).output, /primary/); assert((await pair('bad-json-fallback')).error)
  const discovery = await perform('builtin:search_tools', { sources: ['mcp'], server: 'local', limit: 1, query: 'echo_effect' }, 'discover-real')
  assert.match(discovery.output, /mcp:local\/echo_effect/)
  const echo = await perform('mcp:local/echo_effect', { tag: 'inner-data', value: { nested: true }, __cancelTool: true }, 'echo-inner')
  assert.equal(echo.args.__cancelTool, true); assert.equal(echo.configuredEnv, true); assert.equal(echo.inheritedProvider, false); assert.equal(echo.inheritedApi, false); assert.equal(echo.customSecret, false)
  assert(await exists(join(peerRoot, 'effect-inner-data.txt')))
  const safe = await perform('builtin:list_mcp_servers', {}, 'safe-summary'); assert.equal(safe.servers[0].timeoutSeconds, 4)
  assert(!JSON.stringify(safe).includes('synthetic-only-secret')); assert(!JSON.stringify(safe).includes('configured-test-value'))
  for (const kind of ['plain', 'primitive', 'array', 'multi', 'metadata', 'resource', 'isError', 'opaque', 'error_object']) {
    const result = await perform('mcp:local/result_case', { kind }, 'case-' + kind)
    if (kind === 'plain') assert.equal(result.output, 'plain text π')
    if (kind === 'primitive') assert.equal(result.output, '42')
    if (kind === 'array') assert.deepEqual(result, [1, { value: 'two' }])
    if (kind === 'multi') assert.equal(result.content.length, 2)
    if (kind === 'metadata') { assert.equal(result._meta.retained, true); assert.equal(result.structuredContent.nested.value, 7) }
    if (kind === 'resource') assert.equal(result.content[0].resource.text, 'RESOURCE-TEXT')
    if (kind === 'isError') { assert.equal(result.isError, true); assert.equal(result.error, undefined) }
    if (kind === 'opaque') assert.equal(result.customTag.retained, true)
    if (kind === 'error_object') {
      assert.equal(result.error.metadata.retained, true)
      const replay = requests.at(-1).body.input.find(item => item.call_id === 'case-error_object' && item.type === 'function_call_output')
      assert(Array.isArray(replay.output)); assert.match(replay.output[0].text, /<foxwarm-system kind="time"/)
      assert(replay.output.some(part => part.text?.includes('retained: true')))
    }
  }
  const protocol = await perform('mcp:local/result_case', { kind: 'protocol' }, 'protocol-error')
  assert(protocol.error); assert(!JSON.stringify(protocol).includes('synthetic-only-secret'))
  for (const kind of ['image', 'audio', 'blob']) {
    const result = await perform('mcp:local/result_case', { kind, tag: kind }, 'case-' + kind)
    assert.equal(result.error, undefined)
    assert(await exists(join(peerRoot, 'effect-' + kind + '.txt')))
    if (kind === 'image') {
      assert.equal(result.content[0].text, 'IMAGE-EXPLANATION')
      const persisted = (await history()).find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'case-image'))
      assert(persisted.parts.some(part => part.inlineDataRef && part.toolUseId === 'case-image'))
      assert(!JSON.stringify(persisted).includes('iVBOR'))
      const replay = requests.at(-1).body.input.find(item => item.call_id === 'case-image' && item.type === 'function_call_output')
      assert(replay.output.some(part => part.type === 'input_image'))
    } else if (kind === 'audio') assert.equal(result.content[0].type, 'audio')
    else assert.equal(result.content[0].resource.mimeType, 'application/octet-stream')
  }
  const large = await perform('mcp:local/result_case', { kind: 'large' }, 'case-large')
  assert.equal(large.outputTruncated, true); assert(large.output.length < 40000); assert.match(await readFile(large.outputFullPath, 'utf8'), /^long: START-/)
  assert((await readFile(large.outputFullPath, 'utf8')).includes('-END')); assert(large.outputOriginalLengthChars > 100000)
  const meta = await perform('builtin:search_tools', { sources: ['mcp'], server: 'local', limit: 200 }, 'all-metadata')
  assert(meta.output.length <= 32000); assert(!meta.output.includes('\u202e')); assert(meta.output.includes('schema omitted'))
  const unsafe = 'unsafe*/\nline\u202e'
  const dangerous = await perform('builtin:search_tools', { query: 'unsafe', sources: ['mcp'], server: 'local' }, 'unsafe-schema')
  assert.match(dangerous.output, /source: "mcp"/); assert(!dangerous.output.includes('\nDO-NOT-EXECUTE')); assert(dangerous.output.includes('\\u202e'))
  assert.equal((await perform({ source: 'mcp', server: 'local', name: unsafe }, { tag: 'unsafe-name', 'key*/\nname': 'exact' }, 'call-unsafe')).args['key*/\nname'], 'exact')
  for (const [query, expected] of [['schema_required_open', /extra: number/], ['schema_required_closed', /never/], ['schema_many', /required keys omitted/], ['schema_ref', /Record<string, unknown>/]])
    assert.match((await perform('builtin:search_tools', { sources: ['mcp'], server: 'local', query, limit: 1 }, 'schema-' + query)).output, expected)
  const bad = await perform('mcp:missing-server/echo_effect', { tag: 'unknown-server' }, 'unknown-server')
  assert(bad.error); assert(!await exists(join(peerRoot, 'effect-unknown-server.txt')))
  for (let index = 0; index < 15; index++) assert.equal((await perform('mcp:local/echo_effect', { tag: 'repeat-' + index }, 'repeat-' + index)).pid, echo.pid)

  // Established stdio calls keep their captured process while a process-key change retires it from new acquisitions.
  await task([invoke('held-old', 'mcp:local/hold_effect', { tag: 'old' })], { final: false })
  await until(() => exists(join(peerRoot, 'started-old')), 'old connection entered')
  await perform('builtin:mcp_config', { name: 'local', args: [peerFile, 'stdio', peerRoot, 'updated-label'] }, 'update-live', admin)
  assert.equal((await perform('mcp:local/echo_effect', { tag: 'new' }, 'new-client', admin)).label, 'updated-label')
  await perform('builtin:mcp_config', { name: 'local', enable: false }, 'disable-live', admin)
  assert((await perform('mcp:local/echo_effect', { tag: 'disabled' }, 'disabled-call', admin)).error)
  await writeFile(join(peerRoot, 'release-old'), 'release'); await idle(); assert.equal((await pair('held-old')).label, 'initial-label')
  await perform('builtin:mcp_config', { name: 'local', enable: true, timeoutSeconds: 1 }, 'timeout-setting')
  assert((await perform('mcp:local/hold_effect', { tag: 'timeout' }, 'real-timeout')).error)
  await until(() => exists(join(peerRoot, 'cancelled-timeout')), 'real SDK timeout cancellation')
  await perform('builtin:mcp_config', { name: 'local', timeoutSeconds: 0 }, 'timeout-clear')
  assert.equal((await perform('builtin:list_mcp_servers', {}, 'cleared-summary')).servers[0].timeoutSeconds, null)
  await task([invoke('held-stop', 'mcp:local/hold_effect', { tag: 'stop' }), invoke('after-stop-no-effect', 'mcp:local/echo_effect', { tag: 'after-stop' })], { final: false })
  await until(() => exists(join(peerRoot, 'started-stop')), 'held tool before Stop')
  assert.equal((await request('POST', route(current) + '/message', { text: '/stop' })).status, 200)
  await idle(); await until(() => exists(join(peerRoot, 'cancelled-stop')), 'actual peer observed Stop cancellation')
  assert(!await exists(join(peerRoot, 'effect-after-stop.txt')))
  assert.equal((await pair('after-stop-no-effect')).canceled, true); assert.equal((await pair('held-stop')).error.type, 'tool_call_cancelled')
  await perform('mcp:local/echo_effect', { tag: 'after-stop-valid' }, 'after-stop-valid')

  for (const [name, transport, endpoint] of [['http', 'streamable-http', '/mcp'], ['sse', 'sse', '/sse'], ['auto-http', 'auto', '/mcp'], ['auto-sse', 'auto', '/sse']]) {
    await perform('builtin:mcp_config', { name, transport, url: `http://127.0.0.1:${httpPort}${endpoint}`, token: 'synthetic-unused-auth', headersJson: JSON.stringify({ Authorization: 'Bearer synthetic-explicit-auth' }) }, 'config-' + name)
    assert.match((await perform('builtin:search_tools', { query: 'echo_effect', sources: ['mcp'], server: name }, 'discover-' + name)).output, /echo_effect/)
    assert.equal((await perform('mcp:' + name + '/echo_effect', { tag: name }, 'call-' + name)).label, 'http-label')
  }
  assert((await lines('calls.ndjson')).filter(row => row.event === 'http' && row.url === '/mcp').every(row => row.authMatched))
  // The same resolved handlers retain complete-batch handoff/finish/wait semantics.
  const sink = await create('sink')
  const sinkScript = 'task-' + (++serial); scripts.set(sinkScript, { calls: [], owner: sink })
  await task([invoke('unified-handoff', 'builtin:send_to_session', { sessionId: sink, message: 'MCP-TASK ' + sinkScript, afterSend: 'finish' }), invoke('handoff-following-write', 'node:master/write', { filePath: 'handoff-paired.txt', content: 'complete-batch' })], { final: false })
  await pair('unified-handoff'); await pair('handoff-following-write'); await idle()
  assert.equal(await readFile(join(work, 'agents', 'team', 'handoff-paired.txt'), 'utf8'), 'complete-batch')
  await until(async () => (await history(sink)).some(row => row.parts?.some(part => part.text === 'DONE-' + sinkScript)), 'delivered peer')
  await task([invoke('unified-wait', 'builtin:wait', { wakeIfNoActivityAfterSeconds: 0.2 }), invoke('wait-isError-data', 'mcp:local/result_case', { kind: 'isError' })], { final: false })
  await pair('unified-wait'); assert.equal((await pair('wait-isError-data')).isError, true)
  await until(async () => (await state()).runtimeState.state === 'waiting', 'resolved wait persists despite isError data')
  await until(async () => (await state()).runtimeState.state === 'idle', 'real one-shot wake finishes provider turn')

  const childTask = 'task-' + (++serial); const childId = current + '_mcp-kid'
  const parentTask = 'task-' + (++serial)
  scripts.set(childTask, { calls: [invoke('child-report', 'builtin:send_to_session', { sessionId: current, message: 'CHILD-RESULT', afterSend: 'finish' })], owner: childId })
  scripts.set(parentTask, { calls: [invoke('unified-create-child', 'builtin:create_child_session', { suffix: 'mcp-kid', message: 'MCP-TASK ' + childTask, afterSend: 'wait' }),
    invoke('child-parent-following-write', 'node:master/write', { filePath: 'child-parent-paired.txt', content: 'paired-before-postaction' })], owner: current })
  assert.equal((await request('POST', route(current) + '/message', { text: 'MCP-TASK ' + parentTask })).status, 202)
  await pair('unified-create-child'); await pair('child-parent-following-write'); await pair('child-report', childId)
  await until(async () => (await history()).some(row => row.parts?.some(part => part.text === 'DONE-' + parentTask)), 'resolved child wait/report')
  await idle(); assert.equal(await readFile(join(work, 'agents', 'team', 'child-parent-paired.txt'), 'utf8'), 'paired-before-postaction')
  const saved = await readFile(join(data, 'state', 'mcp.json'), 'utf8'); const countBeforeRestart = (await lines('calls.ndjson')).filter(row => row.event === 'call').length
  await stopHost(); const stdio = (await lines('processes.ndjson')).filter(row => row.mode === 'stdio'); await until(() => stdio.every(row => !alive(row.pid)), 'owned stdio cleanup')
  await startHost(); assert.equal(await readFile(join(data, 'state', 'mcp.json'), 'utf8'), saved)
  await sleep(250); assert.equal((await lines('calls.ndjson')).filter(row => row.event === 'call').length, countBeforeRestart)
  assert.equal((await perform('mcp:local/echo_effect', { tag: 'after-restart' }, 'after-restart')).label, 'updated-label')
  const archive = JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]);print(json.dumps(c.execute("select session_id,count(*) from archive_messages group by session_id").fetchall()))', join(data, 'state', 'archive-store.sqlite')], { encoding: 'utf8' }))
  for (const [id, count] of archive) assert.equal((await history(id)).length, count)
  assert.equal(failures.length, 0, failures.join('\n')); await stopHost()
  const allStd = (await lines('processes.ndjson')).filter(row => row.mode === 'stdio'); await until(() => allStd.every(row => !alive(row.pid)), 'all owned SDK children gone')
  console.log(JSON.stringify({ result: 'ok', hostPids: pids, stdioPids: allStd.map(row => row.pid), requests: requests.length, tasks: serial,
    realSdkStdioHttpSseAuto: true, exactOwnerAndIdentity: true, cancellationAndMetadata: true, managedFreezeAndRestart: true, archiveRows: archive.reduce((sum, row) => sum + row[1], 0) }))
} finally {
  await browser?.close().catch(() => {})
  if (host?.child.exitCode === null) { host.child.kill('SIGTERM'); await Promise.race([once(host.child, 'exit'), sleep(5000)]) }
  if (httpPeer?.exitCode === null) { httpPeer.kill('SIGTERM'); await Promise.race([once(httpPeer, 'exit'), sleep(1000)]) }
  provider?.closeAllConnections(); await new Promise(done => provider ? provider.close(done) : done())
  if (process.env.FOXWARM_KEEP_E2E_ROOT) console.error('Retained owned root:', root); else await rm(root, { recursive: true, force: true })
}
