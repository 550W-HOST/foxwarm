import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

let browser, server, origin, html
let status = 200, held = null, disconnect = false
const requests = []
before(async () => {
  html = await readFile(new URL('../public/login.html', import.meta.url), 'utf8')
  server = createServer(async (req, res) => {
    if (req.url.endsWith('/api/auth')) {
      let body = ''; for await (const chunk of req) body += chunk
      requests.push({ path: req.url, method: req.method, token: JSON.parse(body).token })
      if (held) await held
      if (disconnect) { res.destroy(); return }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ role: 'admin' })); return
    }
    if (req.url.split('?')[0].endsWith('/login.html')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html); return }
    if (req.url === '/nested/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>Signed in</h1>'); return }
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
})
after(async () => { await browser?.close(); server?.closeAllConnections?.(); await new Promise(resolve => server?.close(resolve)) })
async function pageFor({ width = 1200, height = 800, mode = 'light', reduced = false, blocked = false } = {}) {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width, height, isMobile: width < 701, hasTouch: width < 701 })
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }])
  await page.evaluateOnNewDocument((mode, blocked) => {
    localStorage.setItem('foxwarm_theme_selection_v3', JSON.stringify({ version: 3, themeId: 'foxwarm.foxwarm', lightThemeId: 'foxwarm.foxwarm', darkThemeId: 'foxwarm.foxwarm', colorMode: mode }))
    if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Disabled', 'SecurityError') } })
  }, mode, blocked)
  return { context, page }
}
async function screenshot(page, name) {
  if (!process.env.FOXWARM_LOGIN_PREVIEW_DIR) return
  await mkdir(process.env.FOXWARM_LOGIN_PREVIEW_DIR, { recursive: true })
  await page.screenshot({ path: `${process.env.FOXWARM_LOGIN_PREVIEW_DIR}/${name}.png` })
}

test('standalone login has real fox artwork, inherited light/dark themes and usable desktop/mobile/short layouts', async () => {
  const drawing = JSON.parse(await readFile(new URL('../src/components/foxDrawing.json', import.meta.url), 'utf8'))
  assert.equal(html, await readFile(new URL('../dist/login.html', import.meta.url), 'utf8'), 'served and deployed output agree')
  for (const options of [{}, { width: 390, height: 844 }, { width: 320, height: 360 }, { width: 844, height: 390, mode: 'dark' }, { mode: 'dark' }]) {
    const { context, page } = await pageFor(options)
    try {
      const traffic = []; page.on('request', request => traffic.push(request.url()))
      await page.goto(`${origin}/nested/login.html`)
      await page.waitForSelector('#token')
      assert.equal(await page.$$('.login-orbit, .login-wordmark').then(nodes => nodes.length),0)
      assert.equal(await page.$eval('main',main=>main.textContent.includes('Foxwarm')),false)
      await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).every(a => a.playState === 'finished'))
      assert.equal(await page.$eval('html', root => root.dataset.foxwarmTheme), 'foxwarm.foxwarm')
      assert.equal(await page.$eval('html', root => root.dataset.foxwarmThemeMode), options.mode || 'light')
      assert.equal(await page.$eval('input', input => getComputedStyle(input).fontSize), '16px')
      const geometry = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('input,button')].map(el => el.getBoundingClientRect())
        const h = document.querySelector('h1').getBoundingClientRect(), body = document.body.getBoundingClientRect()
        return { overflow: document.documentElement.scrollWidth > innerWidth, controls: controls.every(r => r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth), top: h.top >= 0 && body.top >= 0 }
      })
      assert.deepEqual(geometry, { overflow: false, controls: true, top: true })
      assert.deepEqual(await page.$$eval('.fw-fox-cub path', paths => paths.map(p => p.getAttribute('d')).sort()), ['back','haunch','tailTop','tailTip','head','chest','eyeLeft','eyeRight'].map(key => drawing.paths[key]).sort())
      assert.ok(traffic.every(url => url === `${origin}/nested/login.html` || url.startsWith('data:')), 'login needs no unauthenticated app assets or API prefetch')
      if ((options.height || 800) > 500) await screenshot(page, `login-${options.mode || 'light'}-${options.width || 1200}`)
      await page.$eval('#token', input => input.scrollIntoView({ block: 'center' }))
      assert.equal(await page.$eval('#token', el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight }), true)
    } finally { await context.close() }
  }
})

test('invalid and network responses keep an editable masked token and accessible inline errors', async () => {
  const { context, page } = await pageFor()
  try {
    await page.goto(`${origin}/nested/login.html`)
    await page.type('#token', 'not-a-real-token')
    await page.click('#reveal'); assert.equal(await page.$eval('#token', el => el.type), 'text')
    await page.click('#reveal'); assert.equal(await page.$eval('#token', el => el.type), 'password')
    status = 401
    await page.click('#submit')
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Invalid token'))
    assert.equal(await page.$eval('#token', el => el.getAttribute('aria-invalid')), 'true')
    assert.equal(await page.$eval('#token', el => document.activeElement === el && !el.readOnly), true)
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_token')), null)
    await page.type('#token', 'x'); assert.equal(await page.$eval('#error', el => el.textContent), '')
    disconnect = true
    await page.click('#submit'); await page.waitForFunction(() => document.querySelector('#error').textContent.includes('connect'))
    assert.equal(await page.$eval('#submit', el => el.disabled), false)
    status = 503; disconnect = false
    await page.click('#submit'); await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Couldn’t sign in'))
  } finally { status = 200; disconnect = false; await context.close() }
})

test('pending authentication prevents duplicate submits, persists the scoped token and navigates after success', async () => {
  const { context, page } = await pageFor()
  let release; held = new Promise(resolve => { release = resolve })
  try {
    const start = requests.length
    await page.goto(`${origin}/nested/login.html`)
    await page.type('#token', '  demo-admin-token  ')
    await page.click('#submit')
    await page.waitForFunction(() => document.body.dataset.state === 'pending')
    await page.$eval('form', form => { form.dispatchEvent(new Event('submit', { cancelable: true })); form.dispatchEvent(new Event('submit', { cancelable: true })) })
    assert.equal(await page.$eval('form', el => el.getAttribute('aria-busy')), 'true')
    assert.equal(await page.$eval('#token', el => el.readOnly), true)
    await screenshot(page, 'login-pending')
    release(); held = null
    await page.waitForFunction(() => location.pathname === '/nested/')
    assert.deepEqual(requests.slice(start), [{ path: '/nested/api/auth', method: 'POST', token: 'demo-admin-token' }])
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_token')), 'demo-admin-token')
    assert.ok((await context.cookies()).some(cookie => cookie.name === 'foxwarm_token' && cookie.path === '/nested/' && cookie.sameSite === 'Strict'))
  } finally { release(); held = null; await context.close() }
})

test('hash login clears credentials from history and malformed fragments leave the form usable', async () => {
  const { context, page } = await pageFor({ reduced: true })
  try {
    await page.evaluateOnNewDocument(() => { HTMLFormElement.prototype.requestSubmit = undefined })
    await page.goto(`${origin}/nested/login.html#token=demo-link-token`)
    await page.waitForFunction(() => location.pathname === '/nested/')
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_token')), 'demo-link-token')
    await page.goto(`${origin}/nested/login.html#token=%E0%A4`)
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('Invalid sign-in link'))
    assert.equal(new URL(page.url()).hash, '')
    assert.equal(await page.$eval('#submit', el => el.disabled), false)
  } finally { await context.close() }
})

test('storage denial does not block cookie sign-in and reduced motion leaves the artwork static', async () => {
  const { context, page } = await pageFor({ reduced: true, blocked: true })
  try {
    await page.goto(`${origin}/nested/login.html`)
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0)
    await page.type('#token', 'demo-cookie-token'); await page.keyboard.press('Enter')
    await page.waitForFunction(() => location.pathname === '/nested/')
    assert.ok((await context.cookies()).some(cookie => cookie.name === 'foxwarm_token' && cookie.value === 'demo-cookie-token'))
  } finally { await context.close() }
})

test('authentication timeout returns to a usable form', async () => {
  const { context, page } = await pageFor()
  let release; held = new Promise(resolve => { release = resolve })
  try {
    await page.evaluateOnNewDocument(() => { const timeout = window.setTimeout; window.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 15000 ? 80 : ms, ...args) })
    await page.goto(`${origin}/nested/login.html`)
    await page.type('#token', 'demo-timeout-token'); await page.click('#submit')
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('timed out'))
    assert.equal(await page.$eval('#token', el => !el.readOnly), true)
    assert.equal(await page.$eval('#submit', el => !el.disabled), true)
  } finally { release(); held = null; await context.close() }
})
