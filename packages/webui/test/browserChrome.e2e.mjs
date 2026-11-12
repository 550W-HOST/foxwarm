import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { browserLaunchOptions } from './browserExecutable.mjs'

test('browser chrome colors follow the theme without changing PWA identity or viewport layout', async () => {
  const bundle = await build({ entryPoints: ['packages/webui/src/theme/browserChrome.ts'], bundle: true, format: 'iife', globalName: 'chromeTheme', write: false })
  const requests = []
  const server = createServer((req, res) => {
    if (req.url === '/nested/manifest.json') {
      requests.push(req.headers.cookie || '')
      res.setHeader('Content-Type', 'application/manifest+json'); res.end('{"name":"Foxwarm","start_url":"./"}'); return
    }
    res.setHeader('Content-Type', 'text/html')
    res.end('<meta name="theme-color" content="#f3f4f6"><link rel="manifest" crossorigin="use-credentials" href="./manifest.json"><div style="height:200px">Fixture</div>')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const browser = await puppeteer.launch(browserLaunchOptions())
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.address().port}/nested/`)
    await page.addScriptTag({content: bundle.outputFiles[0].text})
    for (const color of ['#252629', '#fff3e4', '#184052']) {
      await page.evaluate(c => chromeTheme.syncBrowserChrome(c), color)
      const state = await page.evaluate(() => ({meta:document.querySelector('meta[name="theme-color"]').content, href:document.querySelector('link[rel="manifest"]').getAttribute('href'), cookie:document.cookie, height:document.querySelector('div').getBoundingClientRect().height}))
      assert.equal(state.meta, color); assert.equal(state.href, './manifest.json'); assert.equal(state.height, 200)
      assert(state.cookie.includes('foxwarm_canvas=' + color.slice(1)))
    }
    const cookies = await page.cookies(); assert.equal(cookies.find(c=>c.name==='foxwarm_canvas').path, '/nested/')
    assert.equal(await page.evaluate(()=>{const link=document.querySelector('link[rel="manifest"]');chromeTheme.syncBrowserChrome('#184052');return link===document.querySelector('link[rel="manifest"]')}),true)
    await page.evaluate(()=>{Object.defineProperty(document,'cookie',{get(){throw Error('disabled')},set(){throw Error('disabled')}});chromeTheme.syncBrowserChrome('#ffffff')})
    assert.equal(await page.$eval('meta[name="theme-color"]',e=>e.content),'#ffffff')
  } finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
})
