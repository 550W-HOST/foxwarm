import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build as bundle } from 'esbuild'
import { build as viteBuild, loadConfigFromFile } from 'vite'
import puppeteer from 'puppeteer-core'

const webui = new URL('..', import.meta.url).pathname
const dist = path.join(webui, 'dist')
let browser, server, baseUrl, temp, theme, html, entry, staticDependency
let fixtures, fixtureHtml, serveVersion = 'a', staleHtml = false
let admin = false, authFailed = false, authGate = null, rootGate = null, cssGate = null
const missing = new Set()
const requests = []
const diagnostics = []
const artifacts = process.env.FOXWARM_BOOT_ARTIFACT_DIR
const firefox = process.env.FOXWARM_E2E_BROWSER === 'firefox'

before(async () => {
  temp = await mkdtemp(path.join(tmpdir(), 'foxwarm-html-boot-'))
  html = await readFile(path.join(dist, 'index.html'), 'utf8')
  entry = html.match(/<script type="module"[^>]+src="([^"]+)"/)[1].replace('./', '')
  const entryCode = await readFile(path.join(dist, entry), 'utf8')
  staticDependency = entryCode.match(/\bimport\s*\{[^;]*?\}\s*from\s*["']\.\/([^"']+)["']/)?.[1]
  assert.ok(staticDependency, 'the production entry must have a real static dependency for the network failure probe')
  const themeFile = path.join(temp, 'themes.mjs')
  await bundle({ entryPoints: [path.join(webui, 'src/theme/builtins/index.ts')], bundle: true, format: 'esm', platform: 'node', outfile: themeFile, logLevel: 'silent' })
  theme = await import(pathToFileURL(themeFile))

  // Two actual hashed deployments: the second output contains no old assets.
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'test' }, path.join(webui, 'vite.config.ts'))
  const bootPlugin = loaded.config.plugins.find(plugin => plugin.name === 'foxwarm-boot-html')
  fixtures = {}
  fixtureHtml = {}
  const template = await readFile(path.join(webui, 'index.html'), 'utf8')
  for (const version of ['a', 'b']) {
    const root = path.join(temp, version)
    await mkdir(root)
    await writeFile(path.join(root, 'index.html'), template.replace('/src/main.tsx', './entry.js'))
    await writeFile(path.join(root, 'fixture.css'), '#root { font-family: system-ui, sans-serif }')
    await writeFile(path.join(root, 'entry.js'), `
      import './fixture.css';
      document.getElementById('root').innerHTML = '<button id="open-lazy">Open</button><button id="working-action">Work</button><span>${version}</span>';
      window.fixtureReady = () => window.foxwarmBoot.ready();
      window.actions = 0;
      document.getElementById('working-action').onclick = () => window.actions++;
      window.fixtureLoadLazy = () => import('./lazy.js');
      document.getElementById('open-lazy').onclick = () => window.fixtureLoadLazy().then(module => module.open());
      if (new URLSearchParams(location.search).has('earlyReady')) window.foxwarmBoot.ready();
    `)
    await writeFile(path.join(root, 'lazy.js'), `export function open() { document.body.dataset.opened = '${version}' }`)
    await viteBuild({ configFile: false, root, base: './', plugins: [bootPlugin], logLevel: 'silent', build: { outDir: path.join(root, 'dist') } })
    fixtures[version] = path.join(root, 'dist')
    fixtureHtml[version] = await readFile(path.join(fixtures[version], 'index.html'), 'utf8')
  }
  assert.notEqual(fixtureHtml.a.match(/src="([^"]+\.js)"/)[1], fixtureHtml.b.match(/src="([^"]+\.js)"/)[1])

  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    requests.push(url.pathname)
    if (missing.has(url.pathname)) { response.writeHead(404); response.end('Removed deployment asset'); return }
    if (url.pathname.endsWith('/api/auth/session')) {
      if (authGate) await authGate
      response.writeHead(authFailed ? 401 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(admin ? { role: 'admin' } : { role: 'webui', identityId: 'test', sessionIds: [] }))
      return
    }
    if (url.pathname.includes('/api/')) { response.writeHead(503); response.end('Unavailable API'); return }
    const fixture = url.pathname.startsWith('/deployment/')
    const relative = url.pathname.replace(/^\/(preview|deployment)\//, '')
    try {
      let body
      if (!relative || relative === 'index.html') body = fixture ? fixtureHtml[staleHtml ? 'a' : serveVersion] : html
      else {
        if (rootGate && /WebUiIdentityApp-.*\.js$/.test(relative)) await rootGate
        if (cssGate && relative.endsWith('.css')) {
          await cssGate
          if (missing.has(url.pathname)) throw new Error('Removed stylesheet')
        }
        body = await readFile(path.join(fixture ? fixtures[serveVersion] : dist, relative))
      }
      const type = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : !relative || relative.endsWith('.html') ? 'text/html' : 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      response.end(body)
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch(firefox
    ? { browser: 'firefox', executablePath: process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox-esr', headless: true }
    : { executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  if (artifacts) await mkdir(artifacts, { recursive: true })
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
  if (artifacts) await writeFile(path.join(artifacts, 'browser-evidence.json'), JSON.stringify({ requests, diagnostics }, null, 2))
  if (temp) await rm(temp, { recursive: true, force: true })
})

async function newPage({ selection, custom, dark = false, reduced = false, blockAssets = false } = {}) {
  const page = await browser.newPage()
  page.on('pageerror', error => diagnostics.push({ kind: 'pageerror', message: error.message }))
  page.on('requestfailed', request => diagnostics.push({ kind: 'requestfailed', url: request.url(), reason: request.failure()?.errorText }))
  page.on('response', response => { if (response.status() >= 400) diagnostics.push({ kind: 'http', status: response.status(), url: response.url() }) })
  if (!firefox) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }])
  await page.evaluateOnNewDocument((selection, custom) => {
    localStorage.clear()
    if (selection) for (const [key, value] of Object.entries(selection)) localStorage.setItem(key, JSON.stringify(value))
    if (custom) localStorage.setItem('foxwarm_custom_themes_v3', JSON.stringify({ version: 3, themes: [custom] }))
  }, selection, custom)
  if (blockAssets) {
    await page.setRequestInterception(true)
    page.on('request', request => request.url().includes('/assets/') ? request.abort() : request.continue())
  }
  return page
}

const current = (lightThemeId, darkThemeId = lightThemeId, colorMode = 'light') => ({ foxwarm_theme_selection_v3: { version: 3, themeId: lightThemeId, lightThemeId, darkThemeId, colorMode } })
const errorScreen = '#foxwarm-boot[data-state="error"]'
const resourceNotice = '#foxwarm-boot[data-state="notice"]'
async function screenshot(page, name) { if (artifacts) await page.screenshot({ path: path.join(artifacts, name + '.png') }) }

async function assertPalette(page, expected) {
  const actual = await page.evaluate(() => ({ canvas: getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-color-canvas').trim(), accent: getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-color-accent').trim(), stroke: getComputedStyle(document.querySelector('#foxwarm-boot svg')).stroke }))
  assert.equal(actual.canvas.toLowerCase(), expected.canvas.toLowerCase())
  assert.equal(actual.accent.toLowerCase(), expected.accent.toLowerCase())
  assert.notEqual(actual.stroke, 'none')
  assert.equal(await page.$eval('#foxwarm-boot svg', node => node.getBoundingClientRect().width > 0), true)
}

test('inline HTML draws with correct built-in, independent auto slots, custom and fallback colors when all app assets fail', async () => {
  const custom = structuredClone(theme.DEFAULT_THEME)
  custom.id = 'test.boot'
  custom.name = 'Boot test'
  custom.variants.dark.colors.canvas = '#152535'
  custom.variants.dark.colors.accent = '#83b9ef'
  const cases = [
    { selection: current('foxwarm.foxwarm'), expected: theme.THEME_FOXWARM.variants.light.colors, name: 'builtin-light' },
    { selection: current('foxwarm.foxwarm', 'foxwarm.catppuccin', 'auto'), dark: true, expected: theme.THEME_CATPPUCCIN.variants.dark.colors, name: 'auto-dark' },
    { selection: current('foxwarm.foxwarm', 'foxwarm.catppuccin', 'auto'), expected: theme.THEME_FOXWARM.variants.light.colors, name: 'auto-light' },
    { selection: current(custom.id, custom.id, 'dark'), custom, expected: custom.variants.dark.colors, name: 'custom-dark' },
    { selection: current('missing.theme'), expected: theme.DEFAULT_THEME.variants.light.colors, name: 'missing-fallback' },
    { selection: { foxwarm_theme_selection_v2: { version: 2, themeId: 'foxwarm.550a', colorMode: 'dark' } }, expected: theme.THEME_550A.variants.dark.colors, name: 'legacy-selection' },
  ]
  for (const scenario of cases) {
    const page = await newPage({ ...scenario, blockAssets: true })
    try {
      await page.goto(baseUrl + '/preview/')
      await page.waitForSelector(errorScreen, { visible: true })
      await assertPalette(page, scenario.expected)
      await screenshot(page, scenario.name)
      assert.equal(await page.$eval('#foxwarm-boot-reload', button => button.disabled), false)
    } finally { await page.close() }
  }
  const invalid = structuredClone(custom)
  invalid.variants.light.colors.canvas = 'red; background:url(javascript:alert(1))'
  const page = await newPage({ selection: current(invalid.id), custom: invalid, blockAssets: true })
  try {
    await page.goto(baseUrl + '/preview/')
    await page.waitForSelector(errorScreen, { visible: true })
    await assertPalette(page, theme.DEFAULT_THEME.variants.light.colors)
  } finally { await page.close() }
})

test('the HTML illustration paints while external stylesheets are still pending', async () => {
  let releaseCss
  cssGate = new Promise(resolve => { releaseCss = resolve })
  const page = await newPage()
  let navigation
  try {
    const cssRequested = page.waitForRequest(request => request.url().endsWith('.css'))
    navigation = page.goto(baseUrl + '/preview/', { waitUntil: 'domcontentloaded' })
    await cssRequested
    await page.waitForFunction(() => window.foxwarmBoot && document.querySelector('#foxwarm-boot'))
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.ok(await page.evaluate(() => performance.getEntriesByName('first-paint').length > 0), 'inline startup must paint before external CSS finishes')
    assert.equal(await page.$eval('#foxwarm-boot', node => node.dataset.state), 'shown')
    await page.waitForSelector('[data-webui-role="webui"]')
    assert.equal(await page.$eval('#root', node => getComputedStyle(node).visibility), 'hidden')
    await screenshot(page, 'loading-with-css-pending')
    releaseCss()
    await navigation
    await page.waitForSelector('[data-webui-role="webui"]')
    await page.waitForSelector('#foxwarm-boot', { hidden: true })
  } finally { releaseCss(); cssGate = null; await navigation?.catch(() => {}); await page.close() }
})

test('a caught module failure while entry CSS is pending does not prevent readiness or usable content', async () => {
  let releaseCss
  cssGate = new Promise(resolve => { releaseCss = resolve })
  serveVersion = 'a'
  const page = await newPage({ reduced: true })
  let navigation
  try {
    const cssRequested = page.waitForRequest(request => request.url().endsWith('.css'))
    navigation = page.goto(baseUrl + '/deployment/', { waitUntil: 'domcontentloaded' })
    await cssRequested
    await page.waitForSelector('#open-lazy')
    serveVersion = 'b'
    await page.evaluate(() => {
      window.fixtureReady()
      window.fixtureLoadLazy().catch(() => { window.localFallback = true })
    })
    await page.waitForFunction(() => window.localFallback)
    assert.equal(await page.$eval('#foxwarm-boot', node => node.dataset.state), 'shown')
    assert.equal(await page.$eval('#root', node => getComputedStyle(node).visibility), 'hidden')
    releaseCss()
    await navigation
    await page.waitForSelector(resourceNotice, { visible: true })
    assert.equal(await page.$('[data-fox-splash]'), null)
    assert.equal(await page.$eval('#root', node => getComputedStyle(node).visibility), 'visible')
    await page.click('#working-action')
    assert.equal(await page.evaluate(() => window.actions), 1)
    await screenshot(page, 'caught-module-with-pending-css')
    await page.click('#foxwarm-boot-dismiss')
    assert.equal(await page.$('#foxwarm-boot'), null)
  } finally { releaseCss(); cssGate = null; serveVersion = 'a'; await navigation?.catch(() => {}); await page.close() }
})

test('entry stylesheet failure remains fatal even after the selected root mounts', async () => {
  let releaseCss
  cssGate = new Promise(resolve => { releaseCss = resolve })
  const page = await newPage({ reduced: true })
  let navigation
  try {
    navigation = page.goto(baseUrl + '/preview/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-webui-role="webui"]')
    for (const request of requests) if (request.startsWith('/preview/') && request.endsWith('.css')) missing.add(request)
    releaseCss()
    await navigation
    await page.waitForSelector(errorScreen, { visible: true })
    assert.equal(await page.$(resourceNotice), null)
    assert.match(await page.$eval('#foxwarm-boot-error', node => node.textContent), /resource/i)
    missing.clear()
    await Promise.all([page.waitForNavigation(), page.click('#foxwarm-boot-reload')])
    await page.waitForSelector('#foxwarm-boot', { hidden: true })
  } finally { releaseCss(); cssGate = null; missing.clear(); await navigation?.catch(() => {}); await page.close() }
})

test('real auth and lazy root readiness, not entry execution or minimum elapsed time, remove the screen', async () => {
  let releaseAuth, releaseRoot
  authGate = new Promise(resolve => { releaseAuth = resolve })
  rootGate = new Promise(resolve => { releaseRoot = resolve })
  const page = await newPage()
  try {
    await page.goto(baseUrl + '/preview/', { waitUntil: 'domcontentloaded' })
    await page.keyboard.press('Escape')
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal(await page.$eval('#foxwarm-boot', node => node.dataset.state), 'shown')
    await screenshot(page, 'loading-before-auth-ready')
    const rootRequested = page.waitForRequest(request => /WebUiIdentityApp-.*\.js$/.test(request.url()))
    releaseAuth()
    await rootRequested
    assert.equal(await page.$eval('#foxwarm-boot', node => node.dataset.state), 'shown')
    await screenshot(page, 'loading-before-root-ready')
    releaseRoot()
    await page.waitForSelector('[data-webui-role="webui"]')
    await page.waitForSelector('#foxwarm-boot', { hidden: true })
    assert.equal(await page.$('#foxwarm-boot'), null)
    // The real identity root's sessions API returns 503: ordinary API failure
    // does not resurrect a global startup error.
    assert.equal(await page.$(errorScreen), null)
    await screenshot(page, 'normal-ready')
  } finally { releaseAuth(); releaseRoot(); authGate = rootGate = null; await page.close() }
})

test('the administrator workbench mounts normally while ordinary API failures stay local', async () => {
  admin = true
  const page = await newPage({ reduced: true })
  try {
    await page.goto(baseUrl + '/preview/')
    await page.waitForSelector('[data-workbench-status-bar]', { visible: true })
    await page.waitForSelector('#foxwarm-boot', { hidden: true })
    assert.equal(await page.$('#foxwarm-boot'), null)
    assert.equal(await page.$(errorScreen), null)
    await screenshot(page, 'administrator-ready')
  } finally { admin = false; await page.close() }
})

test('authentication failure reveals sign-in recovery, including popup/embed without a full-screen animation', async () => {
  authFailed = true
  try {
    for (const search of ['', '?foxwarmPopupVersion=1&foxwarmPopup=setup', '?foxwarmEmbed=setup&foxwarmEmbedNonce=0123456789abcdef']) {
      let releaseAuth
      authGate = new Promise(resolve => { releaseAuth = resolve })
      const page = await newPage({ reduced: true })
      try {
        await page.goto(baseUrl + '/preview/' + search)
        assert.equal(await page.$eval('#foxwarm-boot', node => getComputedStyle(node).display === 'none'), !!search)
        releaseAuth()
        await page.waitForSelector('a[href="login.html"]', { visible: true })
        await page.waitForSelector('#foxwarm-boot', { hidden: true })
        assert.equal(await page.$('#foxwarm-boot'), null)
      } finally { releaseAuth(); authGate = null; await page.close() }
    }
  } finally { authFailed = false }
})

test('entry 404 and its static dependency 404 produce visible recovery; user Reload loads the real root', async () => {
  for (const resource of [entry, 'assets/' + staticDependency]) {
    const page = await newPage({ reduced: true })
    missing.add('/preview/' + resource)
    try {
      await page.goto(baseUrl + '/preview/', { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(errorScreen, { visible: true })
      assert.match(await page.$eval('#foxwarm-boot-error', node => node.textContent), /module|resource/i)
      await screenshot(page, resource === entry ? 'entry-404' : 'static-dependency-404')
      missing.clear()
      await page.click('#foxwarm-boot-reload')
      await page.waitForSelector('[data-webui-role="webui"]')
      await page.waitForSelector('#foxwarm-boot', { hidden: true })
    } finally { missing.clear(); await page.close() }
  }
})

test('popup and embedded entry failures show recovery even though their loading animation stays hidden', async () => {
  missing.add('/preview/' + entry)
  try {
    for (const search of ['?foxwarmPopupVersion=1&foxwarmPopup=setup', '?foxwarmEmbed=setup&foxwarmEmbedNonce=0123456789abcdef']) {
      const page = await newPage()
      try {
        await page.goto(baseUrl + '/preview/' + search)
        assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-foxwarm-boot-leaf')), true)
        await page.waitForSelector(errorScreen, { visible: true })
        await screenshot(page, search.includes('Popup') ? 'popup-failure' : 'embed-failure')
      } finally { await page.close() }
    }
  } finally { missing.clear() }
})

test('startup execution exceptions retain their safe text without executing error markup or swallowing diagnostics', async () => {
  const page = await newPage()
  await page.setRequestInterception(true)
  const message = '<img src=x onerror="window.injected=true"> startup exploded'
  page.on('request', request => request.url().endsWith('/' + entry)
    ? request.respond({ status: 200, contentType: 'text/javascript', body: `throw new Error(${JSON.stringify(message)})` })
    : request.continue())
  try {
    await page.goto(baseUrl + '/preview/')
    await page.waitForSelector(errorScreen, { visible: true })
    assert.equal(await page.$eval('#foxwarm-boot-error', node => node.textContent), message)
    assert.equal(await page.$('#foxwarm-boot-error img'), null)
    assert.equal(await page.evaluate(() => window.injected), undefined)
    assert.ok(diagnostics.some(item => item.kind === 'pageerror' && item.message === message))
  } finally { await page.close() }
})

test('an uncaught selected-root render exception uses the HTML recovery screen', async () => {
  const page = await newPage()
  await page.setRequestInterception(true)
  page.on('request', request => /WebUiIdentityApp-.*\.js$/.test(request.url())
    ? request.respond({ status: 200, contentType: 'text/javascript', body: 'export default function BrokenRoot() { throw new Error("Selected root failed") }' })
    : request.continue())
  try {
    await page.goto(baseUrl + '/preview/')
    await page.waitForSelector(errorScreen, { visible: true })
    assert.equal(await page.$eval('#foxwarm-boot-error', node => node.textContent), 'Selected root failed')
    assert.equal(await page.$('[data-webui-role="webui"]'), null)
  } finally { await page.close() }
})

test('lazy root chunk 404 is reported before readiness instead of leaving an empty React root', async () => {
  const rootChunk = html.match(/WebUiIdentityApp-[^"\s]+?\.js/)?.[0]
    || (await readFile(path.join(dist, entry), 'utf8')).match(/WebUiIdentityApp-[^"\s]+?\.js/)[0]
  missing.add('/preview/assets/' + rootChunk)
  const page = await newPage()
  try {
    await page.goto(baseUrl + '/preview/')
    await page.waitForSelector(errorScreen, { visible: true })
    assert.match(await page.$eval('#foxwarm-boot-error', node => node.textContent), /import|fetch|load/i)
    await screenshot(page, 'lazy-root-failure')
  } finally { missing.clear(); await page.close() }
})

test('old HTML against a new hashed deployment and an old live page importing a deleted chunk both recover', async () => {
  serveVersion = 'b'
  staleHtml = true
  let page = await newPage({ reduced: true })
  try {
    await page.goto(baseUrl + '/deployment/')
    await page.waitForSelector(errorScreen, { visible: true })
    await screenshot(page, 'old-html-new-assets')
    staleHtml = false
    await Promise.all([page.waitForNavigation(), page.click('#foxwarm-boot-reload')])
    await page.waitForSelector('#open-lazy')
    await page.evaluate(() => window.fixtureReady())
    await page.waitForSelector('#foxwarm-boot', { hidden: true })
  } finally { await page.close() }
  serveVersion = 'a'
  page = await newPage({ reduced: true })
  try {
    await page.goto(baseUrl + '/deployment/?earlyReady')
    await page.waitForSelector('#foxwarm-boot', { hidden: true })
    serveVersion = 'b'
    await page.click('#open-lazy')
    await page.waitForSelector(resourceNotice, { visible: true })
    assert.equal(await page.$('[data-fox-splash]'), null)
    await page.click('#working-action')
    assert.equal(await page.evaluate(() => window.actions), 1)
    assert.match(await page.$eval('#foxwarm-boot-error', node => node.textContent), /import|fetch/i)
    await screenshot(page, 'deleted-async-chunk')
    assert.ok(diagnostics.some(item => item.kind === 'pageerror' && /import|fetch/i.test(item.message)))
    await Promise.all([page.waitForNavigation(), page.click('#foxwarm-boot-reload')])
    await page.waitForSelector('#foxwarm-boot', { hidden: true })
    assert.equal(await page.$eval('#root span', node => node.textContent), 'b')
  } finally { await page.close(); serveVersion = 'a'; staleHtml = false }
})

test('recovery groups stay centered and compact, with separated actions and keyboard-accessible diagnostics', async () => {
  const message = 'Could not load application resource:\nhttps://example.invalid/assets/' + 'unavailable-bundle-'.repeat(90) + '.js\n' + 'Module import failed.\n'.repeat(12)
  for (const scenario of [
    { name: 'desktop-light', width: 1440, height: 900, blockAssets: true },
    { name: 'mobile-light', width: 390, height: 844, blockAssets: true },
    { name: 'short-light', width: 320, height: 360, blockAssets: true },
    { name: 'desktop-dark', width: 1440, height: 900, dark: true },
    { name: 'landscape-dark', width: 844, height: 390, dark: true },
  ]) {
    const page = await newPage({ ...scenario, reduced: true, selection: current('foxwarm.catppuccin', 'foxwarm.catppuccin', scenario.dark ? 'dark' : 'light') })
    await page.setViewport({ width: scenario.width, height: scenario.height, hasTouch: scenario.width < 500 })
    if (!scenario.blockAssets) {
      await page.setRequestInterception(true)
      page.on('request', request => request.url().endsWith('/' + entry)
        ? request.respond({status: 200, contentType: 'text/javascript', body: `throw new Error(${JSON.stringify(message)})`})
        : request.continue())
    }
    try {
      await page.goto(baseUrl + '/preview/')
      await page.waitForSelector(errorScreen, { visible: true })
      const layout = await page.evaluate(() => {
        const bounds = selector => document.querySelector(selector).getBoundingClientRect()
        const fox = bounds('#foxwarm-boot > svg'), title = bounds('#foxwarm-boot-title'), description = bounds('#foxwarm-boot-description')
        const button = bounds('#foxwarm-boot-reload'), details = bounds('#foxwarm-boot-details')
        return { foxWidth: fox.width, centers: [fox, title, description, button, details].map(box => box.left + box.width / 2),
          centerY: (fox.top + details.bottom) / 2, gap: details.top - button.bottom,
          collapsed: !document.querySelector('#foxwarm-boot-details').open, hiddenError: bounds('#foxwarm-boot-error').height === 0,
          overflow: document.querySelector('#foxwarm-boot').scrollWidth > innerWidth }
      })
      assert.equal(layout.foxWidth, 88)
      assert.ok(layout.centers.every(center => Math.abs(center - scenario.width / 2) < 1), JSON.stringify(layout))
      assert.ok(Math.abs(layout.centerY - scenario.height / 2) < 1, JSON.stringify(layout))
      assert.ok(layout.gap >= 20)
      assert.equal(layout.collapsed, true)
      assert.equal(layout.hiddenError, true)
      assert.equal(layout.overflow, false)
      await screenshot(page, 'recovery-' + scenario.name)
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement.id), 'foxwarm-boot-reload')
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => document.querySelector('#foxwarm-boot-details').open)
      const opened = await page.$eval('#foxwarm-boot-error', node => {
        const box = node.getBoundingClientRect(), button = document.querySelector('#foxwarm-boot-reload').getBoundingClientRect()
        return { left: box.left, right: box.right, height: box.height, maxHeight: parseFloat(getComputedStyle(node).maxHeight), gap: box.top - button.bottom,
          overflow: node.scrollWidth > node.clientWidth, original: node.textContent }
      })
      assert.ok(opened.height <= opened.maxHeight + 1)
      assert.ok(opened.left >= 24 && opened.right <= scenario.width - 24)
      assert.ok(opened.gap >= 48)
      assert.equal(opened.overflow, false)
      if (!scenario.blockAssets) assert.equal(opened.original, message)
      await screenshot(page, 'recovery-' + scenario.name + '-details')
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => !document.querySelector('#foxwarm-boot-details').open)
    } finally { await page.close() }
  }
})
