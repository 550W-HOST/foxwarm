#!/usr/bin/env node
// Original merged App, normal .NET host/login, real cross-site AS consent and official SDK resource.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer as httpServer, request as httpRequest } from 'node:http'
import { createServer as httpsServer, get as httpsGet } from 'node:https'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'
import { writeModelFixture } from './experimentModelFixture.mjs'
const require = createRequire(import.meta.url)
const { createMcpOAuthFixture } = require(resolve('lib/mcpOAuthTestFixture.js'))
assert(process.env.DOTNET_ROOT, 'Set DOTNET_ROOT to a .NET 10 SDK')
const root = await mkdtemp(join(tmpdir(), 'foxwarm-dotnet-oauth-'))
const data = join(root, 'data'), work = join(root, 'work')
const token = 'synthetic-oauth-administrator', providerToken = 'synthetic-oauth-model'
const scripts = new Map(), failures = [], records = []
const selected = process.env.FOXWARM_E2E_BROWSER || 'all'
let host, proxy, provider, peer, browser, port, url, serial = 0
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await sleep(30) }
  throw new Error(`Timeout: ${label}; host=${host?.output}; failures=${JSON.stringify(failures)}`)
}
async function api(method, path, body, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/preview${path}`, { method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
async function start() {
  const child = spawn(join(process.env.DOTNET_ROOT, 'dotnet'), [resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_DATA_DIR: data, FOXWARM_CONFIG_PATH: join(data, 'state/config.yaml'),
      FOXWARM_EXPERIMENT_DATA_ROOT: data, FOXWARM_EXPERIMENT_TOOL_ROOT: work, FOXWARM_EXPERIMENT_PORT: String(port),
      FOXWARM_EXPERIMENT_WEBUI_DIST: resolve('packages/webui/dist'), FOXWARM_PUBLIC_BASE_URL: url.replace(/\/$/, ''),
      FOXWARM_EXPERIMENT_MONTY_BINARY: resolve('node_modules/@pydantic/monty-linux-x64-gnu/monty') } })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-12000) })
  host = { child, get output() { return output } }
  await until(async () => {
    if (child.exitCode !== null) throw new Error(output)
    try { return (await api('GET', '/health')).status === 200 } catch { return false }
  }, 'normal host ready')
}
async function stop() {
  assert.equal((await api('POST', '/admin/shutdown')).status, 202)
  const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([code]) => code), sleep(15000).then(() => 'timeout')])
  assert.equal(code, 0, host.output)
}
async function pageApi(page, path, body, method = 'POST', headers = {}) {
  return page.evaluate(async ({ path, body, method, headers }) => {
    const response = await fetch('/preview/api/' + path, body === undefined ? {} : {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }, { path, body, method, headers })
}
async function articleButton(page, text) {
  for (const button of await page.$$('article button'))
    if (await button.evaluate((element, label) => element.textContent.trim() === label, text)) { await button.click(); return }
  throw new Error('Missing authorization button: ' + text)
}
async function login(page) {
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#token'); await page.type('#token', token)
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('#loginForm button')])
  await page.evaluate(() => { location.hash = '#setup' })
  await page.waitForSelector('[data-setup-tab="authorizations"]')
  await page.click('[data-setup-tab="authorizations"]'); await page.waitForSelector('article')
  assert.equal(await page.evaluate(() => document.querySelector('meta[name="foxwarm-host"]')?.content), 'dotnet')
}
async function configure(page, mode, clientId = '', secret = '') {
  await articleButton(page, 'Configure'); await page.waitForSelector('article form select')
  await page.select('article form select', mode)
  if (mode === 'oauth') {
    const inputs = await page.$$('article form input:not([type="checkbox"])')
    for (const [index, value] of [[0, 'read'], [1, clientId], [2, secret]]) {
      await inputs[index].click({ clickCount: 3 }); await inputs[index].press('Backspace')
      if (value) await inputs[index].type(value)
    }
  }
  await page.click('article form button[type="submit"]')
  await page.waitForFunction(() => !document.querySelector('article form'))
}
async function authorize(page) {
  const existing = new Set(browser.targets())
  const target = browser.waitForTarget(target => target.type() === 'page' && !existing.has(target))
  const article = await page.$eval('article', element => element.textContent)
  await articleButton(page, article.includes('Not authorized') ? 'Authorize' : 'Reauthorize')
  const popup = await (await target).page()
  await popup.waitForSelector('#consent')
  assert(new URL(popup.url()).hostname === '127.0.0.1', 'real cross-site AS page, not a callback-only navigation')
  await popup.click('#consent')
  await page.waitForFunction(() => document.querySelector('article')?.textContent.includes('Authorized'))
}
const fn = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
async function toolTurn(owner, calls) {
  const key = 'OAUTH-TURN-' + (++serial); scripts.set(key, calls)
  assert.equal((await api('POST', `/api/sessions/${encodeURIComponent(owner)}/message`, { text: key })).status, 202)
  let messages
  await until(async () => {
    messages = (await api('GET', `/api/sessions/${encodeURIComponent(owner)}/history`)).body.messages
    return messages.some(row => row.parts?.some(part => part.text === 'DONE-' + key))
  }, 'real tool turn ' + key)
  return calls.map(call => messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === call.call_id)?.functionResponse?.response)
}
const value = result => result.context ? result : JSON.parse(result.content[0].text)
try {
  await mkdir(join(data, 'state'), { recursive: true }); await mkdir(work)
  await writeFile(join(data, 'state/token'), token, { mode: 0o600 })
  peer = await createMcpOAuthFixture(); peer.state.browserConsent = true
  const reserve = httpServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); port = reserve.address().port
  await new Promise(done => reserve.close(done))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' })
  const cert = await readFile(join(root, 'cert.pem'))
  proxy = httpsServer({ key: await readFile(join(root, 'key.pem')), cert }, (req, res) => {
    records.push({ path: req.url.split('?')[0], method: req.method, cookie: !!req.headers.cookie?.includes('foxwarm_token='), site: req.headers['sec-fetch-site'] })
    const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() }); req.pipe(upstream)
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); url = `https://localhost:${proxy.address().port}/preview/`
  peer.state.fetchClientMetadata = metadataUrl => new Promise((resolve, reject) => {
    const request = httpsGet(metadataUrl, { ca: cert }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch (error) { reject(error) }
      })
    }); request.on('error', reject)
  })
  provider = httpServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(req.headers.authorization, 'Bearer ' + providerToken)
      const key = body.input.filter(item => item.role === 'user').flatMap(item => item.content || []).map(item => item.text || '').findLast(text => text.startsWith('OAUTH-TURN-'))
      const calls = scripts.get(key); assert(calls)
      const completed = calls.every(call => body.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id))
      const output = completed ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }] : calls
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 100, output_tokens: 10 } } })}\n\n`)
    } catch (error) { failures.push(String(error)); res.writeHead(500); res.end() }
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  await writeModelFixture(data, { default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${provider.address().port}`, apiKey: providerToken, models: ['wire'] } } })
  await writeFile(join(data, 'state/config.yaml'), JSON.stringify({ url: url.replace(/\/$/, ''), bot: { enableWebUI: true }, llm: { ollamaBaseUrl: 'http://127.0.0.1:1' } }))
  await writeFile(join(data, 'state/mcp.json'), JSON.stringify({ servers: { 'Fixture MCP': { url: peer.resource, transport: 'streamable-http' } } }), { mode: 0o600 })
  await start()
  // Public exceptions are exact GET documents, not a broad path or an exchange exemption.
  const anonymous = async (path, method = 'GET', body) => fetch(`http://127.0.0.1:${port}/preview${path}`, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  assert.equal((await anonymous('/api/setup/authorizations')).status, 401)
  assert.equal((await anonymous('/api/mcp/oauth/complete', 'POST', {})).status, 401)
  assert.equal((await anonymous('/api/mcp/oauth/callback', 'POST', {})).status, 401)
  const fixed = await (await anonymous('/api/mcp/oauth/callback?code=never-reflect-code&state=unused')).text()
  assert(!fixed.includes('never-reflect-code')); assert.equal(peer.state.exchanges, 0)
  assert.equal((await api('PUT', '/api/setup/authorizations/Fixture%20MCP', { authentication: 'oauth' }, { Origin: 'https://evil.example' })).status, 400)
  assert.equal((await api('POST', '/api/setup/authorizations/Fixture%20MCP/authorize', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 400)
  assert.equal((await api('POST', '/api/setup/authorizations/Fixture%20MCP/authorize', {}, { 'Content-Type': 'text/plain' })).status, 400)
  assert.equal((await api('GET', '/api/auth/session', undefined, { Origin: 'https://ordinary-origin.example' })).status, 200, 'no host-wide ordinary Origin gate')
  for (const browserName of ['chromium', 'firefox']) {
    if (selected !== 'all' && selected !== browserName) continue
    browser = await puppeteer.launch({ browser: browserName === 'firefox' ? 'firefox' : 'chrome',
      executablePath: browserName === 'firefox' ? process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox-esr' : process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
      headless: true, acceptInsecureCerts: true, args: browserName === 'firefox' ? [] : ['--no-sandbox', '--disable-dev-shm-usage'] })
    const page = await browser.newPage(); await login(page)
    const cookie = (await page.cookies()).find(cookie => cookie.name === 'foxwarm_token')
    assert.equal(cookie.path, '/preview/'); assert.equal(cookie.sameSite, 'Strict'); assert.equal(cookie.secure, true)
    assert((await page.$eval('[data-setup-section="authorizations"]', element => element.textContent)).includes('/preview/api/mcp/oauth/callback'))
    await configure(page, 'static'); peer.state.registration = 'dcr'
    await configure(page, 'oauth'); await authorize(page)
    const registrations = peer.state.registrations
    assert(!JSON.stringify((await pageApi(page, 'setup/authorizations')).body).includes('fixture-client-secret'))
    await articleButton(page, 'Disconnect'); await page.waitForFunction(() => document.querySelector('article')?.textContent.includes('Not authorized'))
    await configure(page, 'static'); peer.state.registration = 'cimd'
    await configure(page, 'oauth'); await authorize(page)
    assert.equal(peer.state.registrations, registrations, 'CIMD fetches real public metadata without DCR')
    const metadata = (await anonymous('/api/mcp/oauth/client.json')).status
    assert.equal(metadata, 200)
    await configure(page, 'static'); peer.state.registration = 'none'
    await configure(page, 'oauth', 'pre-registered', 'pre-registered-secret'); await authorize(page)
    assert.equal((await pageApi(page, 'setup/authorizations')).body.servers[0].hasClientSecret, true)
    assert(!(await page.$eval('article', element => element.textContent)).includes('pre-registered-secret'))
    const standalone = await browser.newPage()
    const admitted = await pageApi(page, 'setup/authorizations/Fixture%20MCP/authorize', {})
    assert.equal(admitted.status, 200)
    await standalone.goto(admitted.body.authorizationUrl); await standalone.waitForSelector('#consent')
    await Promise.all([standalone.waitForNavigation({ waitUntil: 'domcontentloaded' }), standalone.click('#consent')])
    await standalone.waitForNetworkIdle({ idleTime: 300 })
    assert.equal(await standalone.title(), 'Authorization complete'); assert.equal(await standalone.evaluate(() => window.opener), null)
    assert.equal(new URL(standalone.url()).search, ''); assert.equal(new URL(standalone.url()).pathname, '/preview/api/mcp/oauth/callback')
    assert.equal(await standalone.$eval('#home', element => element.href), url.replace(/\/$/, ''))
    await standalone.close()
    console.log(JSON.stringify({ browser: browserName, originalApp: true, dcr: true, cimd: true, preregistered: true, standalone: true }))
    await browser.close(); browser = null
  }
  const callbacks = records.filter(record => record.path === '/preview/api/mcp/oauth/callback' && record.site === 'cross-site')
  assert(callbacks.length >= 4); assert(callbacks.every(record => !record.cookie), 'Strict admin cookie is absent on genuine cross-site redirect')
  assert(records.filter(record => record.path === '/preview/api/mcp/oauth/complete').every(record => record.cookie), 'first-party POST authenticates completion')
  const first = (await api('POST', '/api/sessions', { agentId: 'main', sessionId: 'oauth-first' })).body.sessionId
  const second = (await api('POST', '/api/sessions', { agentId: 'main', sessionId: 'oauth-second' })).body.sessionId
  assert(first && second)
  const discovery = await toolTurn(first, [fn('oauth-search', 'search_tools', { sources: ['mcp'], server: 'Fixture MCP' }),
    fn('oauth-first-call', 'call_tool', { toolId: 'mcp:Fixture MCP/state', args: { value: 'first' } })])
  assert.match(discovery[0].output, /state/); const firstValue = value(discovery[1])
  const secondValue = value((await toolTurn(second, [fn('oauth-second-call', 'call_tool', { toolId: 'mcp:Fixture MCP/state', args: { value: 'second' } })]))[0])
  assert.notEqual(firstValue.context, secondValue.context)
  peer.state.force401 = 1
  const script = (await toolTurn(first, [fn('oauth-native', 'run_script', { code: "return call_tool('mcp:Fixture MCP/state', {})" })]))[0]
  assert.equal(script.status, 'completed'); assert.equal(value(script.result).context, firstValue.context)
  assert.equal(peer.state.refreshes, 1)
  await stop(); await start()
  const persisted = value((await toolTurn(first, [fn('oauth-after-restart', 'call_tool', { toolId: 'mcp:Fixture MCP/state', args: { value: 'saved-grant' } })]))[0])
  assert.equal(persisted.value, 'saved-grant'); assert.notEqual(persisted.context, firstValue.context)
  const saved = JSON.parse(await readFile(join(data, 'state/mcp-oauth.json'), 'utf8'))
  assert.equal(saved.version, 1); assert(saved.servers['Fixture MCP'].tokens.access_token)
  await stop()
  // Missing config.url is harmless to ordinary hosting and actionable only to Authorizations.
  await writeFile(join(data, 'state/config.yaml'), '{"bot":{"enableWebUI":true}}')
  await start()
  const missing = await api('GET', '/api/setup/authorizations')
  assert.equal(missing.status, 200); assert.match(missing.body.publicUrlError, /Set url in Config/)
  assert.equal((await api('POST', '/api/setup/authorizations/Fixture%20MCP/authorize', {})).status, 400)
  await stop()
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ qualified: true, crossSiteCallbacks: callbacks.length, rotatingTrustedOwners: true, normalSearchCallNative: true, hostRestart: true, registrations: peer.state.registrations, exchanges: peer.state.exchanges }))
} finally {
  if (browser) await browser.close()
  if (host?.child.exitCode === null) { host.child.kill('SIGKILL'); await once(host.child, 'exit') }
  if (proxy) { proxy.closeAllConnections(); await new Promise(done => proxy.close(done)) }
  if (provider) { provider.closeAllConnections(); await new Promise(done => provider.close(done)) }
  if (peer) await peer.close()
  await rm(root, { recursive: true, force: true })
}
