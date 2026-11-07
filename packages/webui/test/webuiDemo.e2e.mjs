#!/usr/bin/env node
// Static WebUI demo: builds the demo bundle, serves it under /demo/ from a plain
// static server, and checks that it boots from the recorded snapshot with no
// failed or unrecorded requests, renders every view, and refuses write actions.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import test from 'node:test'
import puppeteer from 'puppeteer-core'
import { unpackSnapshot } from '../demo/src/pack.mjs'

const webui = resolve(import.meta.dirname, '..')
const snapshot = unpackSnapshot(JSON.parse(await readFile(join(webui, 'demo/fixtures/snapshot.json'), 'utf8')))
const showcase = ['tidepool/fix-ci', 'tidepool/release', 'tidepool/support', 'tidepool/runner', 'tidepool/proration-v2']
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }

async function buildDemo() {
  if (process.env.FOXWARM_DEMO_DIST) return { dir: resolve(process.env.FOXWARM_DEMO_DIST), owned: false }
  const dir = await mkdtemp(join(tmpdir(), 'fw-webui-demo-'))
  const result = spawnSync(process.execPath, [join(webui, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.demo.config.ts', '--configLoader', 'runner', '--logLevel', 'error'], {
    cwd: webui, env: { ...process.env, FOXWARM_DEMO_OUT_DIR: dir }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, `demo build failed:\n${result.stdout}\n${result.stderr}`)
  return { dir, owned: true }
}

// Serves the build only under /demo/, like the website deployment.
async function serve(dir) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith('/demo/')) { res.writeHead(404); res.end(); return }
    let file = normalize(join(dir, url.pathname.slice('/demo/'.length)))
    if (!file.startsWith(dir)) { res.writeHead(403); res.end(); return }
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html') } catch {}
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' })
      res.end(body)
    } catch { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

test('static WebUI demo boots from the snapshot and stays read-only', { timeout: 180_000 }, async () => {
  const build = await buildDemo()
  const server = await serve(build.dir)
  const browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const problems = []
  try {
    const html = await readFile(join(build.dir, 'index.html'), 'utf8')
    assert.match(html, /<meta name="robots" content="noindex, nofollow"/)

    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    page.on('requestfailed', request => problems.push(`failed ${request.url()} ${request.failure()?.errorText}`))
    page.on('response', response => { if (response.status() >= 400) problems.push(`HTTP ${response.status()} ${response.url()}`) })
    page.on('pageerror', error => problems.push(`pageerror ${error.message}`))
    page.on('console', message => { if (message.text().includes('[Foxwarm demo]') || message.type() === 'error') problems.push(`console ${message.type()} ${message.text()}`) })
    const base = `http://127.0.0.1:${server.address().port}/demo/`
    await page.goto(base, { waitUntil: 'networkidle0' })
    await page.waitForSelector('[data-fox-splash]', { hidden: true })

    // Showcase Sessions are listed before the gallery.
    const names = Object.fromEntries(snapshot.sessions.map(id => [id, snapshot.rows[id]?.displayName || id]))
    await page.waitForFunction(text => document.body.innerText.includes(text), { timeout: 15000 }, names['tidepool/fix-ci'])
    const order = await page.evaluate(labels => {
      const text = document.body.innerText
      return labels.map(label => text.indexOf(label))
    }, [...showcase.map(id => names[id]), names['gallery/markdown']])
    assert(order.every(index => index >= 0), `missing Sessions in the list: ${order}`)
    assert(Math.max(...order.slice(0, -1)) < order.at(-1), 'showcase Sessions precede the gallery')

    for (const view of ['conversation', 'grouped', 'detailed']) {
      await page.evaluate(value => localStorage.setItem('foxwarm_timeline_view_v1', value), view)
      await page.reload({ waitUntil: 'networkidle0' })
      for (const id of [...showcase, ...snapshot.sessions.filter(id => id.startsWith('gallery'))]) {
        await page.evaluate(value => { location.hash = value }, `#tab/chat:${id}`)
        await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent?.trim(), { timeout: 15000 })
        await page.waitForNetworkIdle({ idleTime: 200, timeout: 10000 }).catch(() => {})
      }
    }

    // A write action is refused with the read-only notice and changes nothing.
    await page.evaluate(() => { location.hash = '#tab/chat:gallery/markdown' })
    await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    await page.click('[role="textbox"][aria-label="Message"]')
    await page.type('[role="textbox"][aria-label="Message"]', 'Hello from the demo')
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(() => document.getElementById('foxwarm-demo-notice')?.textContent === 'Demo mode — read-only' && document.getElementById('foxwarm-demo-notice').style.opacity === '1', { timeout: 5000 })

    // The WebUI logs the refused send as an ordinary failed request.
    assert.deepEqual(problems.filter(problem => !/Failed to send message \(403\)/.test(problem)), [])
  } finally {
    await browser.close()
    server.close()
    if (build.owned) await rm(build.dir, { recursive: true, force: true })
  }
})
