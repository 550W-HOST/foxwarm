import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const selected = process.env.FOXWARM_E2E_BROWSER || 'all'
async function fixture() {
  const process = spawn(globalThis.process.execPath, ['lib/mcpOAuthUiTestMain.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let errors = ''
  process.stderr.on('data', chunk => { errors += chunk })
  const exited = new Promise(resolve => process.once('exit', resolve))
  const close = async () => {
    if (!process.pid || process.exitCode !== null || process.signalCode !== null) return
    process.kill('SIGTERM')
    await exited
  }
  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`OAuth fixture did not start: ${errors}`)), 30000)
      process.once('error', error => { clearTimeout(timeout); reject(error) })
      process.once('exit', () => { clearTimeout(timeout); reject(new Error(`OAuth fixture exited: ${errors}`)) })
      process.stdout.on('data', chunk => {
        output += chunk
        for (const line of output.split('\n')) {
          try { const data = JSON.parse(line); if (data.ready) { clearTimeout(timeout); resolve(data) } } catch {}
        }
      })
    })
    return { ...ready, close }
  } catch (error) {
    await close()
    throw error
  }
}
async function articleButton(page, text) {
  const handles = await page.$$('article button')
  for (const handle of handles) {
    if ((await handle.evaluate(element => element.textContent.trim())) === text) { await handle.click(); return }
  }
  throw new Error(`Missing authorization action: ${text}`)
}
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(`/preview/api/${path}`, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: response.status, data: await response.json() }
  }, { path, body })
}
async function login(page, url, token) {
  await page.goto(url, { waitUntil: 'networkidle0' })
  await page.waitForSelector('#token')
  await page.type('#token', token)
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#loginForm button[type="submit"]')])
  await page.waitForSelector('[data-authorizations-fixture]')
}
async function configure(page, mode, credentials) {
  await articleButton(page, 'Configure')
  await page.waitForSelector('article form select')
  await page.select('article form select', mode)
  if (credentials) {
    const inputs = await page.$$('article form input:not([type="checkbox"])')
    for (const [index, value] of [[0, 'read'], [1, credentials.clientId], [2, credentials.secret]]) {
      await inputs[index].click({ clickCount: 3 })
      await inputs[index].press('Backspace')
      if (value) await inputs[index].type(value)
    }
  }
  await page.click('article form button[type="submit"]')
  await page.waitForFunction(() => !document.querySelector('article form'))
}
async function authorize(page) {
  await page.waitForFunction(() => ![...document.querySelectorAll('article button')].some(button => /^(Authorize|Reauthorize)$/.test(button.textContent.trim()) && button.disabled))
  const text = await page.$eval('article', element => element.textContent)
  const existingTargets = new Set(page.browser().targets())
  const popupTarget = page.browser().waitForTarget(target => target.type() === 'page' && !existingTargets.has(target))
  await articleButton(page, text.includes('Not authorized') ? 'Authorize' : 'Reauthorize')
  const popup = await (await popupTarget).page()
  await popup.waitForSelector('#consent')
  await popup.click('#consent')
  await page.waitForFunction(() => document.querySelector('article')?.textContent.includes('Authorized'))
}

for (const browserName of ['chromium', 'firefox']) {
  if (selected !== 'all' && selected !== browserName) continue
  const executablePath = browserName === 'firefox'
    ? process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox-esr'
    : process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
  test(`${browserName}: administrator OAuth, cross-site Strict cookie completion, prefix/CIMD and scoped denial`, {
    skip: !existsSync(executablePath), timeout: 180000,
  }, async t => {
    const env = await fixture()
    t.after(() => env.close())
    const browser = await puppeteer.launch({ browser: browserName === 'firefox' ? 'firefox' : 'chrome', executablePath,
      headless: true, acceptInsecureCerts: true, args: browserName === 'firefox' ? [] : ['--no-sandbox', '--disable-dev-shm-usage'] })
    try {
      const page = await browser.newPage()
      if (browserName === 'chromium') await page.setViewport({ width: 1100, height: 850 })
      await login(page, env.url, 'fixture-admin')
      await page.waitForSelector('article')
      assert((await page.$eval('article', element => element.textContent)).includes('Static authentication'))
      assert((await page.$eval('[data-authorizations-fixture]', element => element.textContent)).includes('/preview/api/mcp/oauth/callback'))
      await configure(page, 'oauth')
      await authorize(page)
      const dcr = (await api(page, 'test/state')).data
      assert.equal(dcr.exchanges, 1)
      assert.equal(dcr.registrations, 1)
      assert.equal(dcr.callback.cookieOnRedirect, false, 'Strict admin cookie does not accompany the AS redirect')
      assert.equal(dcr.callback.cookieOnComplete, true, 'first-party complete POST authenticates the administrator')
      assert(!JSON.stringify((await api(page, 'setup/authorizations')).data).includes('fixture-client-secret'))
      await articleButton(page, 'Disconnect')
      await page.waitForFunction(() => document.querySelector('article')?.textContent.includes('Not authorized'))

      await api(page, 'test/registration', { mode: 'cimd' })
      await configure(page, 'static')
      await configure(page, 'oauth')
      await authorize(page)
      const cimd = (await api(page, 'test/state')).data
      assert.equal(cimd.exchanges, 2)
      assert.equal(cimd.registrations, 1, 'CIMD does not register a new client')
      const metadata = await page.evaluate(async () => (await fetch('/preview/api/mcp/oauth/client.json')).json())
      assert.equal(metadata.client_id, new URL('api/mcp/oauth/client.json', env.url).href)
      assert.deepEqual(metadata.redirect_uris, [new URL('api/mcp/oauth/callback', env.url).href])

      await api(page, 'test/registration', { mode: 'none' })
      await configure(page, 'oauth', { clientId: 'pre-registered', secret: 'pre-registered-secret' })
      await authorize(page)
      assert.equal((await api(page, 'test/state')).data.exchanges, 3)
      assert.equal((await api(page, 'setup/authorizations')).data.servers[0].hasClientSecret, true)
      assert(!(await page.$eval('article', element => element.textContent)).includes('pre-registered-secret'))

      // The same bridge also completes without an opener. It removes code and
      // state before the exchange and leaves a useful fixed completion page.
      const standalone = await browser.newPage()
      const initiation = await api(page, 'setup/authorizations/Fixture%20MCP/authorize', {})
      assert.equal(initiation.status, 200)
      await standalone.goto(initiation.data.authorizationUrl)
      await standalone.waitForSelector('#consent')
      await Promise.all([standalone.waitForNavigation({ waitUntil: 'domcontentloaded' }), standalone.click('#consent')])
      await standalone.waitForNetworkIdle({ idleTime: 300 })
      assert.equal(await standalone.title(), 'Authorization complete')
      const callbackUrl = new URL(standalone.url())
      assert.equal(callbackUrl.pathname, '/preview/api/mcp/oauth/callback')
      assert.equal(callbackUrl.search, '')
      assert.equal(await standalone.evaluate(() => window.opener), null)
      assert.equal(await standalone.$eval('#home', element => element.href), env.url.replace(/\/$/, ''))
      await standalone.close()

      const scopedContext = await browser.createBrowserContext()
      const scopedPage = await scopedContext.newPage()
      await login(scopedPage, env.url, 'fixture-scoped')
      await scopedPage.waitForFunction(() => document.querySelector('[data-authorizations-fixture]')?.textContent.includes('Forbidden'))
      assert.equal((await api(scopedPage, 'setup/authorizations')).status, 403)
      assert.equal((await api(scopedPage, 'setup/authorizations/Fixture%20MCP/authorize', {})).status, 403)
      assert.equal((await api(scopedPage, 'mcp/oauth/complete', { state: 'cannot-create-authority', code: 'not-a-code' })).status, 403)
      await scopedContext.close()

      await api(page, 'test/missing-url', {})
      await page.click('button[aria-label="Refresh authorizations"]')
      await page.waitForFunction(() => document.querySelector('[data-authorizations-fixture]')?.textContent.includes('Set url in Config'))
      assert.equal(await page.$eval('article', element => [...element.querySelectorAll('button')].find(button => /^(Authorize|Reauthorize)$/.test(button.textContent.trim())).disabled), true)
    } finally { await browser.close() }
  })
}
