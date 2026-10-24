#!/usr/bin/env node
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as tcpServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, brotliDecompressSync } from 'node:zlib'
import puppeteer from 'puppeteer-core'
import yamlReader from 'js-yaml'
import { saveModelsInOriginalApp } from './experimentHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, label, ms = 18000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(25) } throw new Error('Timed out: ' + label) }
async function port() { const server = tcpServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const number = server.address().port; await new Promise(resolve => server.close(resolve)); return number }
const root = await mkdtemp(join(tmpdir(), 'foxwarm-models-yaml-')); const data = join(root, 'data'), work = join(data, 'agents', 'main')
await mkdir(join(data, 'state'), { recursive: true }); const modelPath = join(data, 'state/models.yaml')
await writeFile(join(data, 'state/config.yaml'), 'llm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\nchannels:\n  configured-only:\n    type: telegram\n    enabled: false\n    token: synthetic-channel-only\n')
const token = 'synthetic-models-api', oldSecret = 'synthetic-old-provider', newSecret = 'synthetic-new-provider'
const dotnet = process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT, 'dotnet') : 'dotnet'
const hostPort = await port(), origin = `http://127.0.0.1:${hostPort}`
await writeFile(join(data, 'state/config.yaml'), (await readFile(join(data, 'state/config.yaml'), 'utf8')) + `bot: {httpPort: ${hostPort}}\n`)
await writeFile(join(data, 'state/token'), token, { mode: 0o600 })
let host, browser, page, current, held; const hosts = [], requests = []
function sse(res, event) { res.write('data: ' + JSON.stringify(event) + '\n\n') }
function finish(res, id, text) {
  sse(res, { type: 'response.created', response: { id } }); sse(res, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: id + '-msg', role: 'assistant', content: [] } })
  sse(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }); sse(res, { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: id + '-msg', role: 'assistant', content: [{ type: 'output_text', text }] } })
  sse(res, { type: 'response.completed', response: { id, status: 'completed', output: [], usage: { input_tokens: 14, output_tokens: 7 } } }); res.end()
}
function peer(label) {
  return createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); let bytes = Buffer.concat(chunks)
    if (req.headers['content-encoding'] === 'gzip') bytes = gunzipSync(bytes)
    if (req.headers['content-encoding'] === 'br') bytes = brotliDecompressSync(bytes)
    assert.notEqual(req.headers['user-agent'], 'foxwarm/1.0', 'Responses must not acquire the Completions transport default'); const body = JSON.parse(bytes); const user = body.input.filter(item => item.role === 'user').at(-1)?.content?.map(part => part.text || '').join('') || ''
    requests.push({ label, headers: req.headers, body, user }); res.setHeader('content-type', 'text/event-stream')
    const retryCase = ['inactivity', 'whitespace-guard'].find(name => user.includes(name))
    if (retryCase && requests.filter(record => record.user.includes(retryCase)).length > 1) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"synthetic terminal after observed first failure"}'); return }
    const id = 'response-' + requests.length
    if (user.includes('hold-old')) { held = { finish: () => finish(res, id, 'OLD-FROZEN'), request: requests.at(-1) }; return }
    if (user.includes('paired') && !body.input.some(item => item.call_id === 'yaml-write')) {
      sse(res, { type: 'response.created', response: { id } }); sse(res, { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'yaml-write', call_id: 'yaml-write', name: 'write', arguments: '' } }); const args = JSON.stringify({ filePath: 'configured-effect.txt', content: 'source-yaml-effect' }); sse(res, { type: 'response.function_call_arguments.delta', output_index: 0, delta: args }); sse(res, { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'yaml-write', call_id: 'yaml-write', name: 'write', arguments: args } }); sse(res, { type: 'response.completed', response: { id, status: 'completed', output: [] } }); res.end(); return
    }
    if (user.includes('inactivity')) { sse(res, { type: 'response.created', response: { id } }); sse(res, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: id + '-msg', role: 'assistant', content: [] } }); sse(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'activity' }); return }
    if (user.includes('whitespace')) { finish(res, id, '  \t'); return }
    finish(res, id, 'DONE-' + label)
  })
}
const first = peer('first'), second = peer('second'); first.listen(0, '127.0.0.1'); second.listen(0, '127.0.0.1'); await Promise.all([once(first, 'listening'), once(second, 'listening')])
const url = server => `http://127.0.0.1:${server.address().port}/v1`
function yaml(server, secret, compression = 'gzip') {
  return `# actual raw configuration; keep this comment\r\ndefault: unknown-falls-back\r\nproviders:\r\n  alpha:\r\n    providerType: openai\r\n    baseUrl: '${url(server)}'\r\n    apiKey: '${secret}'\r\n    contextLimit: 19000\r\n    requestCompression: ${compression}\r\n    extraHeaders: &shared\r\n      X-Provider: inherited\r\n      X-Auth-Value: '${secret}'\r\n      Content-Encoding: intentionally-overridden\r\n      Content-Length: '1'\r\n    extraFields:\r\n      nested: { old: kept, replace: inherited }\r\n      cache: '\${SESSION_CACHE_KEY}'\r\n      turn: '\${TURN_ID}'\r\n      max_output_tokens: 911\r\n      reasoning: { effort: max, summary: detailed, vendor: preserved }\r\n      include: [vendor.option, reasoning.encrypted_content]\r\n      yesWord: yes\r\n    effort: { allowed: [none, low, high], default: high }\r\n    models:\r\n      - id: wire/slash\r\n        extraHeaders: { X-Provider: overridden }\r\n        extraFields: { nested: { replace: model, addition: 4 } }\r\n        effort: { default: low }\r\n  beta:\r\n    providerType: openai-responses\r\n    baseUrl: '${url(second)}'\r\n    apiKey: '${newSecret}'\r\n    models: [second-a, second-b]\r\n  future:\r\n    providerType: openai-responses\r\n    keepReasoningOnError: true\r\n    baseUrl: '${url(second)}'\r\n    apiKey: '${newSecret}'\r\n    models: [future-wire]\r\n  route:\r\n    providerType: session-hash\r\n    targets: [alpha, beta/second-a]\r\n`
}
async function api(method, path, body, authorized = true) { const response = await fetch(origin + path, { method, headers: { ...(authorized ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json().catch(() => ({})) } }
async function start() {
  const child = spawn(dotnet, [resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...testEnvironment.isolatedApplicationEnv(data), FOXWARM_DATA_DIR: data, } }); let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-20000) }); host = { child, get output() { return output } }; hosts.push(child.pid)
  await until(async () => { if (child.exitCode !== null) throw new Error(output); try { return (await api('GET', '/health')).status === 200 } catch { return false } }, 'host ready')
}
const route = id => '/api/sessions/' + encodeURIComponent(id)
async function history(id = current) { return (await api('GET', route(id) + '/history')).body }
async function idle() { return until(async () => !(await history()).session.busy, 'owner idle') }
async function send(text, expected = null) { const count = requests.length; assert.equal((await api('POST', route(current) + '/message', { text })).status, 202); if (expected) await until(async () => (await history()).messages.some(row => row.parts?.some(part => part.text === expected)), expected); await idle(); return requests.slice(count) }
async function save(raw) { const result = await api('POST', '/api/setup/models', { yaml: raw }); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(await readFile(modelPath, 'utf8'), raw); return result.body }
async function stop() { assert.equal((await api('POST', '/admin/shutdown')).status, 202); const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([code]) => code), sleep(12000).then(() => 'timeout')]); assert.equal(code, 0, host.output) }
try {
  await start(); assert.equal((await api('GET', '/api/setup/status', undefined, false)).status, 401); assert.equal((await api('POST', '/api/setup/models', { yaml: 'apiKey: private' }, false)).status, 401)
  const missing = (await api('GET', '/api/setup/status')).body; assert.equal(missing.models.exists, false); assert.equal(missing.models.rawYaml, ''); assert.equal(missing.config.channelCount, 1); assert.equal(yamlReader.load(missing.config.channelsYaml)['configured-only'].enabled, false)
  current = (await api('POST', '/api/sessions', {})).body.sessionId
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: join(root, 'browser') }); page = await browser.newPage(); await page.goto(origin, { waitUntil: 'networkidle0' }); await page.waitForSelector('input[type="password"]'); await page.type('input[type="password"]', token); await page.click('button[type="submit"]'); await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession); await waitForWebUiReady(page)
  const raw = yaml(first, oldSecret); await saveModelsInOriginalApp(page, raw, modelPath); const browserRaw = await readFile(modelPath, 'utf8'); assert.equal(browserRaw.replaceAll('\r\n', '\n'), raw.replaceAll('\r\n', '\n')); await save(raw)
  const models = (await api('GET', '/api/models')).body; assert.equal(models.defaultKey, 'alpha'); assert.deepEqual(models.models.map(model => model.key), ['alpha', 'beta/second-a', 'beta/second-b', 'future', 'route']); assert(!JSON.stringify(models).includes(oldSecret)); assert(models.models.find(model => model.key === 'route').isVirtual)
  const changed = await send('paired', 'DONE-first'); assert.equal(changed.length, 2); assert.equal(changed[0].headers['x-provider'], 'overridden'); assert.equal(changed[0].headers['x-auth-value'], oldSecret); assert.equal(changed[0].headers.authorization, 'Bearer ' + oldSecret); assert.equal(changed[0].body.model, 'wire/slash'); assert.equal(changed[0].body.max_output_tokens, 911); assert.equal(changed[0].body.yesWord, 'yes'); assert.deepEqual(changed[0].body.nested, { old: 'kept', replace: 'model', addition: 4 }); assert.equal(changed[0].body.reasoning.effort, 'low'); assert.equal(changed[0].body.reasoning.summary, 'detailed'); assert.equal(changed[0].body.reasoning.vendor, 'preserved'); assert.deepEqual(changed[0].body.include, ['vendor.option', 'reasoning.encrypted_content']); assert.equal(changed[0].body.turn, changed[1].body.turn); assert.equal(typeof changed[0].body.turn, 'string'); assert(changed[0].body.turn.length > 0); assert.equal(changed[0].body.cache, JSON.parse(await readFile(join(data, 'state/sessions', current + '.json'), 'utf8')).promptCacheKey); assert.equal(await readFile(join(work, 'configured-effect.txt'), 'utf8'), 'source-yaml-effect')
  const before = await readFile(modelPath, 'utf8'); for (const bad of ['providers: [\n secret: synthetic-new-provider', raw.replace('default: high', 'default: max'), raw.replace('targets: [alpha, beta/second-a]', 'targets: [route]')]) { const failed = await api('POST', '/api/setup/models', { yaml: bad }); assert.equal(failed.status, 400); assert(!JSON.stringify(failed.body).includes(newSecret)); assert.equal(await readFile(modelPath, 'utf8'), before) }
  const validCatalog = (await api('GET', '/api/models')).body
  const invalidConfiguration = async mutate => {
    const config = yamlReader.load(raw); mutate(config.providers.alpha, config.providers.alpha.models[0])
    const rejected = await api('POST', '/api/setup/models', { yaml: JSON.stringify(config) })
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body)); assert.equal(await readFile(modelPath, 'utf8'), raw)
    assert.deepEqual((await api('GET', '/api/models')).body, validCatalog)
  }
  for (const property of ['effort', 'streamContentInactivityTimeoutMs', 'webSearch', 'imageGeneration']) {
    await invalidConfiguration(provider => { provider[property] = null })
    await invalidConfiguration((provider, model) => { model[property] = null })
  }
  for (const property of ['outputFormat', 'outputCompression']) await invalidConfiguration(provider => { provider.imageGeneration = { enabled: false, [property]: null } })
  await invalidConfiguration(provider => { provider.webSearch = { enabled: false, userLocation: null } })
  await invalidConfiguration((provider, model) => { provider.imageGeneration = { quality: 'invalid' }; model.imageGeneration = { quality: 'high' } })
  await invalidConfiguration((provider, model) => { provider.imageGeneration = { outputFormat: 'jpeg', background: 'transparent' }; model.imageGeneration = { outputFormat: 'png' } })
  await invalidConfiguration((provider, model) => { provider.imageGeneration = { background: 'transparent' }; model.imageGeneration = { outputFormat: 'jpeg' } })
  const open = yamlReader.load(raw); delete open.providers.alpha.effort; delete open.providers.alpha.models[0].effort
  open.providers.alpha.effort = { ignoredOpenKey: { nested: null } }
  open.providers.alpha.models[0].effort = { anotherOpenKey: true }
  open.providers.alpha.webSearch = { enabled: false, userLocation: { country: ' US ', city: 'provider' }, ignored: null }
  open.providers.alpha.models[0].webSearch = { enabled: false, userLocation: { city: 'model' } }
  open.providers.alpha.imageGeneration = { enabled: false, outputFormat: 'png', outputCompression: 0 }
  open.providers.alpha.extraFields.allowedNulls = { object: null, array: [null] }
  open.providers.empty = { providerType: 'openai-responses', models: null }
  await save(JSON.stringify(open)); const openRequest = await send('open-extra-and-null-values', 'DONE-first')
  assert.deepEqual(openRequest[0].body.allowedNulls, { object: null, array: [null] }); assert.equal(openRequest[0].body.reasoning.effort, 'high')
  await save(raw)
  const count = requests.length; await api('POST', route(current) + '/message', { text: 'hold-old' }); await until(() => held, 'old request held'); const captured = held.request; const updated = yaml(second, newSecret, 'br'); await save(updated); held.finish(); await until(async () => (await history()).messages.some(row => row.parts?.some(part => part.text === 'OLD-FROZEN')), 'held completion'); await idle(); assert.equal(captured.headers.authorization, 'Bearer ' + oldSecret); assert.equal(captured.body.model, 'wire/slash'); assert.equal(requests.length, count + 1)
  const next = await send('next-config', 'DONE-second'); assert.equal(next[0].headers.authorization, 'Bearer ' + newSecret); assert.equal(next[0].headers['content-encoding'], 'br'); assert.equal(next[0].body.cache, captured.body.cache); assert.notEqual(next[0].body.turn, captured.body.turn)
  for (const model of ['future']) { assert.equal((await api('POST', route(current) + '/model', { model })).status, 200); const enabled = await send('configured-' + model, 'DONE-second'); assert.equal(enabled.length, 1); assert.equal(enabled[0].body.model, 'future-wire'); assert(!JSON.stringify(await history()).includes(newSecret)) }
  assert.equal((await api('POST', route(current) + '/model', { model: 'alpha/wire/slash', effort: 'low' })).status, 200); await send('qualified-lookup', 'DONE-second')
  assert.equal((await api('POST', route(current) + '/model', { model: 'alpha', effort: 'none' })).status, 200)
  const none = await send('effort-none', 'DONE-second'); assert.equal(none[0].body.reasoning.effort, 'none'); assert(!('summary' in none[0].body.reasoning)); assert.deepEqual(none[0].body.include, ['vendor.option'])
  for (const addition of ['imageGeneration: { enabled: true, quality: high, size: 1024x1024 }', 'webSearch: { enabled: true, allowedDomains: [example.test] }', 'keepReasoningOnError: true']) {
    await save(updated.replace('    contextLimit:', '    ' + addition + '\r\n    contextLimit:')); const enabled = await send('configured-feature', 'DONE-second'); assert.equal(enabled.length, 1); if (addition.startsWith('imageGeneration')) assert(enabled[0].body.tools.some(tool => tool.type === 'image_generation')); if (addition.startsWith('webSearch')) assert(enabled[0].body.tools.some(tool => tool.type === 'web_search'))
  }
  for (const addition of ['tools: [{ type: image_generation }]', 'tool_choice: { type: image_generation }']) {
    await save(updated.replace('      nested:', '      ' + addition + '\r\n      nested:')); const count = requests.length; await send('unsupported-extra-media'); assert.equal(requests.length, count)
  }
  await save(updated.replace('    contextLimit:', '    disallowEmptyResponse: true\r\n    streamContentInactivityTimeoutMs: 150\r\n    contextLimit:'))
  const empty = await send('whitespace-guard'); assert.equal(empty.length, 2); assert(!(await history()).messages.some(row => row.parts?.some(part => part.text === '  \t')))
  const stalled = await send('inactivity'); assert.equal(stalled.length, 2); assert(!(await history()).session.busy)
  await save(updated.replace('    contextLimit:', '    disallowEmptyResponse: false\r\n    contextLimit:')); await send('whitespace', '  \t'); assert((await history()).messages.some(row => row.parts?.some(part => part.text === '  \t')))
  await save(updated)
  const form = await api('POST', '/api/setup/models', { providers: [{ id: 'alpha', providerType: 'openai-responses', models: 'wire/slash' }], default: 'alpha' }); assert.equal(form.status, 200); const formYaml = yamlReader.load(await readFile(modelPath, 'utf8')); assert.equal(formYaml.providers.alpha.models[0].id, 'wire/slash'); assert.equal(formYaml.providers.alpha.extraFields.nested.old, 'kept')
  await save(updated.replace('providers:', 'models:')); assert.equal((await api('GET', '/api/models')).body.defaultKey, 'alpha'); await stop(); await start(); const restart = await send('after-restart', 'DONE-second'); assert.equal(restart[0].body.cache, captured.body.cache); assert.notEqual(restart[0].body.turn, next[0].body.turn); assert.equal((await api('GET', '/api/setup/status')).body.models.rawYaml, updated.replace('providers:', 'models:')); assert.equal((await history()).messages.flatMap(row => row.parts || []).filter(part => part.functionCall?.id === 'yaml-write').length, 1)
  await stop(); console.log(JSON.stringify({ result: 'ok', hostPids: hosts, requests: requests.length, originalSetupRawSave: true, immutableConfiguredResponses: true, pairedCacheTurnIdentity: true, canonicalYamlAndRestart: true, sourcePresenceAndMediaValidation: true }))
} catch (error) { console.error("HOST-FAILURE", host?.output, "REQUESTS", JSON.stringify(requests.map(request => ({ label: request.label, user: request.user, encoding: request.headers["content-encoding"], effort: request.body.reasoning })))); throw error; } finally {
  held?.finish(); await browser?.close().catch(() => {}); if (host?.child.exitCode === null) { host.child.kill('SIGTERM'); await Promise.race([once(host.child, 'exit'), sleep(3000)]); if (host.child.exitCode === null) host.child.kill('SIGKILL') }
  first.closeAllConnections(); second.closeAllConnections(); await Promise.all([new Promise(resolve => first.close(resolve)), new Promise(resolve => second.close(resolve))]); if (process.env.FOXWARM_KEEP_E2E_ROOT) console.log('Retained owned root: ' + root); else await rm(root, { recursive: true, force: true })
}
