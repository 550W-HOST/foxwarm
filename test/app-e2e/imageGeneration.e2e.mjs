// Section 12.2 real-application scenario, part 1: a hosted image generation turn
// through the built WebUI against the scripted provider, then a follow-up edit
// that must receive the original image bytes. The restart half of the scenario
// lives in imageGenerationRestart.e2e.mjs, which runs after a real application
// restart against the same data root.
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

// Every rendered timeline image plus whether the browser really decoded it.
async function renderedImages() {
  return page.$$eval('[data-chat-timeline="committed"] img', nodes => nodes.map(node => ({
    alt: node.getAttribute('alt'),
    src: node.getAttribute('src'),
    loaded: node.complete && node.naturalWidth > 0,
  })))
}

async function waitForRenderedImages(count, timeout = 30_000) {
  await page.waitForFunction(expected => {
    const images = Array.from(document.querySelectorAll('[data-chat-timeline="committed"] img'))
    return images.length >= expected && images.every(image => image.complete && image.naturalWidth > 0)
  }, { timeout }, count)
  return renderedImages()
}

function generatedImageRefs(canonical) {
  return canonical.messages
    .filter(message => message.role === 'model')
    .flatMap(message => (message.parts || []).filter(part => part.inlineDataRef).map(part => part.inlineDataRef))
}

async function fetchBlob(apiPath, headers) {
  const response = await fetch(`${baseUrl}/api${apiPath}`, { headers })
  const bytes = Buffer.from(await response.arrayBuffer())
  return { status: response.status, contentType: response.headers.get('content-type'), bytes }
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
  await fs.writeFile(path.join(artifactDir, 'logs', 'image-generation-browser-console.log'), browserConsole.join('\n')).catch(() => {})
  await browser?.close()
})

test('a hosted image reply renders in the WebUI, reloads, and replays its bytes for an edit', async () => {
  const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId: 'main', sessionId }) })
  assert.equal(created.sessionId, sessionId)
  const model = await api(`/api/sessions/${sessionId}/model`, { method: 'POST', body: JSON.stringify({ model: 'images/mock-image', effort: 'none' }) })
  assert.ok(model && typeof model === 'object')

  await openSession(sessionId)
  await sendMessage('APP_E2E_IMAGE_ONE draw a small picture')
  const firstRendered = await waitForRenderedImages(1)
  await waitForIdle(sessionId)

  // Exactly one provider request produced this turn, and it declared the hosted tool.
  const state = await fetch(`${providerUrl}/__control/state`).then(response => response.json())
  assert.equal(state.requests.filter(entry => entry.marker === 'IMAGE_ONE').length, 1)
  assert.equal(state.requests.filter(entry => entry.marker === 'IMAGE_EDIT').length, 0)
  assert.equal(state.unexpected, null)

  // The reply is a real image part with no fabricated text.
  const canonical = await history(sessionId)
  const refs = generatedImageRefs(canonical)
  assert.equal(refs.length, 1)
  const imageTurn = canonical.messages.find(message => message.role === 'model' && (message.parts || []).some(part => part.inlineDataRef))
  assert.deepEqual((imageTurn.parts || []).filter(part => part.text?.trim()).map(part => part.text), [])
  assert.match(refs[0].apiPath, /^\/blobs\/[a-f0-9]{64}\.png$/)
  assert.match(refs[0].blobId, /^[a-f0-9]{64}\.png$/)
  assert.equal(refs[0].mimeType, 'image/png')
  assert.ok(refs[0].byteLength > 0)
  // The WebUI transport payload never carries raw image bytes.
  assert.equal(JSON.stringify(canonical).includes('iVBORw0KGgo'), false)

  // The rendered image really decoded, and it came from the blob route.
  assert.equal(firstRendered.length, 1)
  assert.equal(firstRendered[0].loaded, true)
  assert.match(firstRendered[0].src, /\/api\/blobs\/[a-f0-9]{64}\.png$/)

  // The blob route serves the bytes to an authenticated caller and rejects anonymous access.
  const authorized = await fetchBlob(refs[0].apiPath, { Authorization: `Bearer ${token}` })
  assert.equal(authorized.status, 200)
  assert.equal(authorized.contentType, 'image/png')
  assert.deepEqual(Array.from(authorized.bytes.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const anonymous = await fetchBlob(refs[0].apiPath)
  assert.equal(anonymous.status, 401)

  // A reload still shows the same image.
  await page.reload({ waitUntil: 'networkidle2' })
  await openSession(sessionId)
  const reloaded = await waitForRenderedImages(1)
  assert.equal(reloaded[0].loaded, true)
  assert.equal(reloaded[0].src, firstRendered[0].src)

  // A second turn asks for an edit; the provider verifies the original bytes and
  // the instruction arrive together as one native image call.
  await sendMessage('APP_E2E_IMAGE_EDIT make it warmer')
  const edited = await waitForRenderedImages(2)
  await waitForIdle(sessionId)
  const afterEdit = await fetch(`${providerUrl}/__control/state`).then(response => response.json())
  assert.equal(afterEdit.requests.filter(entry => entry.marker === 'IMAGE_EDIT').length, 1)
  assert.equal(afterEdit.unexpected, null)
  assert.notEqual(edited[0].src, edited[1].src)
  assert.deepEqual(edited.map(image => image.loaded), [true, true])

  const editedCanonical = await history(sessionId)
  const editedRefs = generatedImageRefs(editedCanonical)
  assert.equal(editedRefs.length, 2)
  assert.equal(new Set(editedRefs.map(ref => ref.blobId)).size, 2)
  for (const ref of editedRefs) {
    const blob = await fetchBlob(ref.apiPath, { Authorization: `Bearer ${token}` })
    assert.equal(blob.status, 200)
    assert.ok(blob.bytes.length > 0)
  }
  const userEdit = editedCanonical.messages.filter(message => message.role === 'user' && JSON.stringify(message.parts).includes('APP_E2E_IMAGE_EDIT'))
  assert.equal(userEdit.length, 1)
})
