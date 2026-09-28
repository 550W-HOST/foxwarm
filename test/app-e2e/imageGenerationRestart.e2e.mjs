// Section 12.2 real-application scenario, part 2: runs after the harness stopped
// and restarted the Foxwarm application against the same data root. The session,
// its canonical history, and the generated image blobs must all survive, the
// WebUI must still render and serve them, and a further edit must still replay
// both original images from storage.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE
const dataRoot = process.env.FOXWARM_E2E_DATA_DIR
const providerUrl = process.env.FOXWARM_E2E_PROVIDER_URL
const artifactDir = process.env.FOXWARM_E2E_ARTIFACT_DIR
const chromium = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
assert.ok(baseUrl && tokenFile && dataRoot && providerUrl && artifactDir)
const token = (await fs.readFile(tokenFile, 'utf8')).trim()
const sessionId = 'app-e2e-image'
let browser
let page
const browserConsole = []

async function api(pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
  })
  const body = await response.json().catch(() => null)
  assert.ok(response.ok, `${init.method || 'GET'} ${pathname} failed: ${response.status} ${JSON.stringify(body)}`)
  return body
}

function history(id) {
  return api(`/api/sessions/${encodeURIComponent(id)}/history`)
}

async function openSession(id) {
  await page.evaluate(value => window.foxwarmTest.switchToSession(value), id)
  await page.waitForFunction(value => (document.querySelector('.foxwarm-chat-root')?.textContent || '').includes(`session ${value}`), { timeout: 15_000 }, id)
  await page.waitForSelector('[role="textbox"][aria-label="Message"]', { timeout: 15_000 })
}

async function sendMessage(text) {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.click(editor)
  await page.type(editor, text)
  await page.click('button[aria-label="Send message"]')
}

async function waitForIdle(id, timeout = 30_000) {
  await page.waitForFunction(async value => {
    const response = await fetch(`./api/sessions/${encodeURIComponent(value)}/state`)
    if (!response.ok) return false
    const state = await response.json()
    return state.session?.runtimeState === 'idle' || state.runtimeState === 'idle' || state.session?.busy === false
  }, { timeout }, id)
}

async function waitForRenderedImages(count, timeout = 30_000) {
  await page.waitForFunction(expected => {
    const images = Array.from(document.querySelectorAll('[data-chat-timeline="committed"] img'))
    return images.length >= expected && images.every(image => image.complete && image.naturalWidth > 0)
  }, { timeout }, count)
  return page.$$eval('[data-chat-timeline="committed"] img', nodes => nodes.map(node => ({ src: node.getAttribute('src'), loaded: node.complete && node.naturalWidth > 0 })))
}

before(async () => {
  browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  page.on('console', message => browserConsole.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', error => browserConsole.push(`pageerror: ${error.stack || error.message}`))
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.foxwarmTest, { timeout: 15_000 })
})

after(async () => {
  await fs.writeFile(path.join(artifactDir, 'logs', 'image-generation-restart-browser-console.log'), browserConsole.join('\n')).catch(() => {})
  await browser?.close()
})

test('generated images survive an application restart and still replay for another edit', async () => {
  // The session and its two generated images are still there after the restart.
  const canonical = await history(sessionId)
  const refs = canonical.messages
    .filter(message => message.role === 'model')
    .flatMap(message => (message.parts || []).filter(part => part.inlineDataRef).map(part => part.inlineDataRef))
  assert.equal(refs.length, 2)
  assert.equal(new Set(refs.map(ref => ref.blobId)).size, 2)
  assert.equal(JSON.stringify(canonical).includes('iVBORw0KGgo'), false)
  for (const ref of refs) {
    const response = await fetch(`${baseUrl}/api${ref.apiPath}`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    const bytes = Buffer.from(await response.arrayBuffer())
    assert.ok(bytes.length > 0)
    assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x89, 0x50, 0x4e, 0x47])
  }

  // The restarted application is authenticated exactly like before: anonymous blob access still fails.
  const anonymous = await fetch(`${baseUrl}/api${refs[0].apiPath}`)
  assert.equal(anonymous.status, 401)

  // The WebUI still renders both stored images from the restarted server.
  await openSession(sessionId)
  const rendered = await waitForRenderedImages(2)
  assert.deepEqual(rendered.map(image => image.loaded), [true, true])
  assert.match(rendered[0].src, /\/api\/blobs\/[a-f0-9]{64}\.png$/)

  // Another edit still replays both original images as native calls: the scripted
  // provider fails the request unless both original byte strings arrive.
  await sendMessage('APP_E2E_IMAGE_RESTART adjust both images')
  await page.waitForFunction(() => (document.body.textContent || '').includes('generated images survived the restart'), { timeout: 30_000 })
  await waitForIdle(sessionId)
  const state = await fetch(`${providerUrl}/__control/state`).then(response => response.json())
  assert.equal(state.requests.filter(entry => entry.marker === 'IMAGE_RESTART').length, 1)
  assert.equal(state.unexpected, null)

  const finalCanonical = await history(sessionId)
  const finalRefs = finalCanonical.messages
    .filter(message => message.role === 'model')
    .flatMap(message => (message.parts || []).filter(part => part.inlineDataRef).map(part => part.inlineDataRef))
  assert.equal(finalRefs.length, 2)
  assert.deepEqual(new Set(finalRefs.map(ref => ref.blobId)), new Set(refs.map(ref => ref.blobId)))
})
