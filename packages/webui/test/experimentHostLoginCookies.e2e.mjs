// Original standalone login, one .NET configuration, direct and prefix-stripping proxy URLs.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { createHmac } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { createHostFixture } from './experimentHostFixture.mjs'

const options = { normalStartup: true, env: { FOXWARM_BIND_ADDRESS: '127.0.0.1' } }
const host = await createHostFixture('login-cookies', options)
options.cwd = host.root
let browser
const seen = []
const proxy = createServer((request, response) => {
  const path = request.url.startsWith('/proxy/') ? request.url.slice('/proxy'.length) : request.url
  const upstream = httpRequest(host.origin + path, { method: request.method, headers: request.headers }, incoming => {
    if (path === '/api/auth') seen.push({ referer: request.headers.referer, cookie: request.headers.cookie, setCookie: incoming.headers['set-cookie'] })
    response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response)
  })
  upstream.on('error', error => response.destroy(error)); request.pipe(upstream)
})
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
const proxyRoot = `http://127.0.0.1:${proxy.address().port}/proxy/`
let config = { url: proxyRoot, bot: { httpPort: host.port }, access: { identities: { reader: { token: 'synthetic-reader-cookie', surfaces: { webui: { sessions: ['main'] } } } } } }
await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify(config))
const derived = createHmac('sha256', host.token).update('foxwarm-experiment-cookie-v1').digest('hex')

async function login(root, token, oldValue) {
  const context = await browser.createBrowserContext(), page = await context.newPage()
  const path = new URL(root).pathname
  try {
    if (oldValue) await context.setCookie({ name: 'foxwarm_token', value: oldValue, domain: '127.0.0.1', path, httpOnly: true, sameSite: 'Strict', expires: Date.now() / 1000 + 28800 })
    // A sibling cookie must survive the transition, even on the same host.
    await context.setCookie({ name: 'foxwarm_token', value: 'unrelated-sibling', domain: '127.0.0.1', path: '/sibling/', httpOnly: true })
    await page.goto(root + 'login.html', { waitUntil: 'domcontentloaded' })
    if (oldValue) {
      await page.evaluate(() => { document.cookie = 'foxwarm_token=blocked-script-write; path=' + location.pathname.replace(/[^/]+$/, '') })
      assert.equal((await context.cookies()).find(cookie => cookie.path === path)?.value, oldValue, 'An old HttpOnly cookie really blocks the unchanged script write')
      console.log('Confirmed old HttpOnly replacement barrier at ' + path)
    }
    const authResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === root + 'api/auth')
    const before = Date.now() / 1000
    await page.type('#token', token); await page.click('#submit')
    const authenticated = await authResponse
    assert.equal(authenticated.status(), 200)
    assert.equal(authenticated.headers()['set-cookie'], undefined, 'Browser auth must not issue or remove a server cookie')
    await page.waitForFunction(expected => location.pathname === expected, {}, path)
    if (oldValue) {
      const retained = (await context.cookies()).find(cookie => cookie.name === 'foxwarm_token' && cookie.path === path)
      assert.equal(retained.value, oldValue); assert.equal(retained.httpOnly, true)
      assert.equal(await page.evaluate(async () => (await fetch('./api/auth/session')).status), oldValue === derived ? 200 : 401)
      console.log('Confirmed retained old HttpOnly cookie after successful original login at ' + path)
      return { context, page }
    }
    await page.waitForFunction(() => !document.querySelector('#token'))
    const cookies = await context.cookies(), cookie = cookies.find(cookie => cookie.name === 'foxwarm_token' && cookie.path === path)
    assert(cookie); assert.equal(cookie.value, token); assert.equal(cookie.httpOnly, false); assert.equal(cookie.secure, false); assert.equal(cookie.sameSite, 'Strict')
    assert(cookie.expires >= before + 31536000 - 2 && cookie.expires <= Date.now() / 1000 + 31536000 + 2, JSON.stringify(cookie))
    assert(cookies.some(cookie => cookie.path === '/sibling/' && cookie.value === 'unrelated-sibling'))
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_token')), token)
    const role = await page.evaluate(async () => (await (await fetch('./api/auth/session')).json()).role)
    assert.equal(role, token === host.token ? 'admin' : 'webui')
    assert.equal(await page.evaluate(async () => (await fetch('./api/setup/status')).status), token === host.token ? 200 : 403)
    return { context, page }
  } catch (error) { await context.close(); throw error }
}

try {
  await host.start()
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: join(host.root, 'browser') })
  for (const root of [host.origin + '/', proxyRoot]) {
    assert.equal((await fetch(root + 'api/auth/session')).status, 401)
    assert.equal((await fetch(root + 'api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) })).status, 401)
    for (const oldValue of [derived, 'revoked-old-scoped-cookie', null]) {
      const opened = await login(root, host.token, oldValue)
      await opened.context.close()
    }
  }
  const scoped = await login(proxyRoot, 'synthetic-reader-cookie', null)
  config.access.identities.reader.token = 'synthetic-reader-rotated'
  assert.equal((await host.api('POST', '/api/setup/config', { yaml: JSON.stringify(config) })).status, 200)
  assert.equal(await scoped.page.evaluate(async () => (await fetch('./api/auth/session')).status), 401, 'Long-lived browser cookies do not bypass live revocation')
  await scoped.context.close()
  assert(seen.some(request => request.referer === proxyRoot + 'login.html'))
  assert(seen.every(request => request.setCookie === undefined), 'The backend never guesses a proxy-visible cookie path')
  // Existing raw and derived cookies remain valid inputs, even without a new login.
  for (const value of [host.token, derived]) assert.equal((await fetch(host.origin + '/api/auth/session', { headers: { cookie: 'foxwarm_token=' + value } })).status, 200)
  console.log('PASS original login: 365-day frontend cookies, one-config root/proxy paths, old HttpOnly limitation, sibling isolation, scoped roles and revocation')
  await host.stop()
} finally {
  await browser?.close(); await host.cleanup(); await new Promise(done => proxy.close(done))
}
