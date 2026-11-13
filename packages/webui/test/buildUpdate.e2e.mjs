import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { loadConfigFromFile } from 'vite'
import puppeteer from 'puppeteer-core'
import { browserLaunchOptions } from './browserExecutable.mjs'
import { webuiReactAliases } from './reactRendererAliases.mjs'

const webui = fileURLToPath(new URL('..', import.meta.url))
let browser, server, origin, renderHtml, moduleCode
let version = 'one', responseMode = 'app', checks = 0
const notice = '#foxwarm-boot[data-state="notice"]'

before(async () => {
  const config = await loadConfigFromFile({ command: 'build', mode: 'test' }, `${webui}/vite.config.ts`, undefined, undefined, undefined, 'runner')
  renderHtml = config.config.plugins.find(plugin => plugin.name === 'foxwarm-boot-html').transformIndexHtml.handler
  const result = await build({
    stdin: { contents: `
      import React, { useEffect } from 'react';
      import { createRoot } from 'react-dom/client';
      import BuildUpdateNotice from './src/components/BuildUpdateNotice';
      import { frontendBuild } from './src/buildUpdate';
      window.fixtureBuild = html => frontendBuild(new DOMParser().parseFromString(html, 'text/html'), location.href);
      function Fixture() {
        useEffect(() => { window.foxwarmBoot.ready(); window.fixtureReady = true }, []);
        return <><button id="work" onClick={() => window.worked = true}>Work</button><BuildUpdateNotice /></>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    `, resolveDir: webui, loader: 'tsx' },
    bundle: true, jsx: 'automatic', format: 'iife', write: false,
    alias: webuiReactAliases, define: { 'process.env.NODE_ENV': '"test"' },
  })
  moduleCode = result.outputFiles[0].text
  const template = await readFile(`${webui}/index.html`, 'utf8')
  const pages = Object.fromEntries(await Promise.all(['one', 'two', 'three'].map(async name => [name,
    await renderHtml(template.replace('/src/main.tsx', `./assets/${name}.js`)),
  ])))
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname.includes('/assets/')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(moduleCode); return
    }
    if (url.pathname === '/frame-host') {
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<iframe src="/nested/"></iframe>'); return
    }
    if (req.headers['sec-fetch-dest'] === 'empty') checks++
    res.writeHead(responseMode === 'error' ? 503 : 200, { 'Content-Type': 'text/html' })
    res.end(responseMode === 'login' ? '<form id="loginForm"></form>' : pages[version])
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch(browserLaunchOptions())
})
after(async () => {
  await browser?.close()
  server?.closeAllConnections()
  await new Promise(resolve => server?.close(resolve))
})

async function newPage(route = '/nested/') {
  version = 'one'; responseMode = 'app'; checks = 0
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  page.on('pageerror', error => console.error(error))
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.evaluateOnNewDocument(() => {
    const now = Date.now
    let offset = 0
    Date.now = () => now() + offset
    window.advanceCheck = () => { offset += 16000; window.dispatchEvent(new Event('focus')) }
  })
  await page.goto(origin + route)
  return page
}
async function check(page) {
  const response = page.waitForResponse(response => response.url() === origin + '/nested/' && response.request().resourceType() === 'fetch')
  await page.evaluate(() => window.advanceCheck())
  await response
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)))
}
async function resourceFailure(page) {
  await page.evaluate(() => {
    const event = new Event('vite:preloadError')
    event.payload = new Error('Deleted lazy chunk')
    window.dispatchEvent(event)
  })
}

test('build signatures ignore login, foreign assets and non-entry scripts', async () => {
  const page = await newPage()
  try {
    await page.waitForFunction(() => window.fixtureReady)
    const values = await page.evaluate(() => [
      window.fixtureBuild('<form></form>'),
      window.fixtureBuild('<div id="root"></div><script type="module" src="https://other.invalid/assets/a.js"></script>'),
      window.fixtureBuild('<div id="root"></div><script src="./assets/a.js"></script>'),
      window.fixtureBuild('<div id="root"></div><script type="module" src="./assets/b.js"></script><script type="module" src="./assets/a.js"></script>'),
    ])
    assert.deepEqual(values, [null, null, null, '/nested/assets/a.js\n/nested/assets/b.js'])
  } finally { await page.close() }
})

test('update and stale-chunk failure share one dismissible notice and guarded reload', async () => {
  const page = await newPage()
  try {
    await page.waitForFunction(() => window.fixtureReady)
    responseMode = 'login'; await check(page); assert.equal(await page.$(notice), null)
    responseMode = 'error'; await check(page); assert.equal(await page.$(notice), null)
    responseMode = 'app'; version = 'two'; await check(page)
    await page.waitForSelector(notice)
    assert.match(await page.$eval('#foxwarm-boot-title', el => el.textContent), /new version/)
    assert.equal(await page.$eval('#foxwarm-boot-details', el => el.hidden), true)
    await resourceFailure(page)
    assert.equal((await page.$$(notice)).length, 1)
    assert.match(await page.$eval('#foxwarm-boot-error', el => el.textContent), /Deleted lazy chunk/)
    await page.click('#work'); assert.equal(await page.evaluate(() => window.worked), true)
    await page.evaluate(() => window.addEventListener('foxwarm-before-update-reload', event => event.preventDefault(), { once: true }))
    await page.click('#foxwarm-boot-reload')
    assert.match(await page.$eval('#foxwarm-boot-description', el => el.textContent), /Finish sending/)
    await page.click('#foxwarm-boot-dismiss'); await check(page)
    assert.equal(await page.$(notice), null, 'dismissed deployment stays dismissed')
    version = 'three'; await check(page); await page.waitForSelector(notice)
    await page.evaluate(async () => {
      const frame = document.createElement('iframe')
      frame.srcdoc = '<p>Embedded editor</p>'
      const loaded = new Promise(resolve => { frame.onload = resolve })
      document.body.append(frame); await loaded
      frame.contentWindow.addEventListener('foxwarm-before-update-reload', event => event.preventDefault(), { once: true })
    })
    await page.click('#foxwarm-boot-reload')
    assert.match(await page.$eval('#foxwarm-boot-description', el => el.textContent), /Finish sending/)
    page.once('dialog', dialog => dialog.dismiss())
    await page.click('#foxwarm-boot-reload')
    assert.equal(await page.$eval('script[type="module"]', el => el.getAttribute('src')), './assets/one.js')
    assert.doesNotMatch(await page.$eval('#foxwarm-boot-description', el => el.textContent), /Finish sending/)
    page.once('dialog', dialog => dialog.accept())
    await Promise.all([page.waitForNavigation(), page.click('#foxwarm-boot-reload')])
    assert.equal(await page.$eval('script[type="module"]', el => el.getAttribute('src')), './assets/three.js')
  } finally { await page.close() }
})

test('stale-chunk-only reload uses the same preparation and update rollback clears only build notices', async () => {
  const page = await newPage()
  try {
    await page.waitForFunction(() => window.fixtureReady)
    version = 'two'; await check(page); await page.waitForSelector(notice)
    version = 'one'; await check(page); assert.equal(await page.$(notice), null)
    await resourceFailure(page); await page.waitForSelector(notice)
    await page.evaluate(() => window.addEventListener('foxwarm-before-update-reload', event => event.preventDefault(), { once: true }))
    await page.click('#foxwarm-boot-reload')
    assert.match(await page.$eval('#foxwarm-boot-description', el => el.textContent), /Finish sending/)
    version = 'two'; await check(page)
    version = 'one'; await check(page)
    assert.match(await page.$eval('#foxwarm-boot-title', el => el.textContent), /Some features/)
  } finally { await page.close() }
})

test('popup, embedded leaves and arbitrary iframes have no polling or live notices', async () => {
  for (const route of [
    '/nested/?foxwarmPopup=chat&foxwarmPopupVersion=1&sessionId=test',
    '/nested/?foxwarmEmbed=chat&foxwarmEmbedNonce=abcdefghijklmnop&sessionId=test',
    '/frame-host',
  ]) {
    const page = await newPage(route)
    try {
      const frame = route === '/frame-host' ? page.frames().find(frame => frame.parentFrame()) : page.mainFrame()
      await frame.waitForFunction(() => window.fixtureReady)
      await frame.evaluate(() => {
        window.advanceCheck()
        window.foxwarmBoot.update('new-build')
        const event = new Event('vite:preloadError'); event.payload = new Error('Deleted lazy chunk'); window.dispatchEvent(event)
      })
      await new Promise(resolve => setTimeout(resolve, 100))
      assert.equal(checks, 0, route)
      assert.equal(await frame.$(notice), null, route)
    } finally { await page.close() }
  }
})
