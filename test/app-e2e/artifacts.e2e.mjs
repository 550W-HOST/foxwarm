import { appE2eRuntime } from './runtime.mjs'
import { waitForWebUiReady } from '../../packages/webui/test/webuiReadiness.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import puppeteer from 'puppeteer-core'

const { baseUrl, tokenFile, dataRoot } = appE2eRuntime()
const token = (await fs.readFile(tokenFile, 'utf8')).trim()
const artifactDir = process.env.FOXWARM_E2E_ARTIFACT_DIR
const imagePath = process.env.FOXWARM_E2E_TOOL_FILE + '.artifact.png'
const sessionId = 'app-e2e-artifacts'

async function api(route, init = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  })
  assert.ok(response.ok, `${route}: ${response.status}`)
  return response.json()
}

// This uses the same owned direct-process runtime as the other production-app
// scenarios. No route, token, stored revision or UI response is replaced.
test('fresh startup stays empty; real tool preparation renders pinned chart, React and image artifacts and survives reload', async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const page = await browser.newPage()
  const errors = []
  const requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => requests.push(new URL(request.url()).pathname))
  const image = await sharp({ create: { width: 36, height: 24, channels: 3, background: '#397eee' } }).png().toBuffer()
  await fs.writeFile(imagePath, image)
  try {
    await page.setViewport({ width: 1440, height: 1000 })
    await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
    await waitForWebUiReady(page)
    assert.equal(await page.evaluate(() => location.hash), '')
    assert.equal(await page.$('[data-chat-session-id="main"]'), null)
    assert.ok(!requests.some(route => /\/sessions\/main\/(history|state)/.test(route)), 'fresh startup does not load an implicit main Chat')
    assert.equal(await page.evaluate(() => document.body.innerText.includes('Session not found')), false)

    const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ agentId: 'main', sessionId }) })
    assert.equal(created.sessionId, sessionId)
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), sessionId)
    await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    await page.type('[role="textbox"][aria-label="Message"]', 'APP_E2E_ARTIFACT prepare the three owned examples')
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('Artifact end.'), { timeout: 30000 })
    await page.waitForSelector('.artifact-chart-plot svg', { timeout: 15000 })
    await page.waitForSelector('.artifact-run-placeholder')
    const imageElement = await page.waitForSelector('.artifact-image img')
    await imageElement.evaluate(element => element.scrollIntoView({ block: 'center' }))
    await page.waitForFunction(() => { const image = document.querySelector('.artifact-image img'); return image?.complete && image.naturalWidth === 36 })
    assert.equal((await page.$$('[data-artifact-id]')).length, 3)
    assert.equal(await page.$('.artifact-react iframe'), null, 'React never starts before Run')

    const history = await api(`/api/sessions/${sessionId}/history`)
    const ids = [...new Set(JSON.stringify(history).match(/art_[a-f0-9]{32}/g) || [])]
    assert.equal(ids.length, 3)
    const revisions = await Promise.all(ids.map(id => api(`/api/sessions/${sessionId}/artifacts/${id}/1`)))
    assert.deepEqual(revisions.map(record => record.receipt.type).sort(), ['chart', 'image', 'react'])
    const imageRecord = revisions.find(record => record.receipt.type === 'image')
    await fs.rm(imagePath)
    const resource = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${imageRecord.receipt.artifactId}/1/resources/image`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(resource.status, 200)
    assert.deepEqual(Buffer.from(await resource.arrayBuffer()), image, 'download is the original immutable image after source deletion')
    const onDisk = await fs.readdir(path.join(dataRoot, 'state', 'artifacts'))
    assert.ok(onDisk.length > 0, 'real Main-owned store persists revisions')

    await page.$eval('.artifact-run-placeholder', element => element.scrollIntoView({ block: 'center' }))
    await page.click('.artifact-run-placeholder')
    await page.waitForFunction(() => !!document.querySelector('iframe[data-ready="true"]'), { timeout: 15000 })
    const frame = page.frames().find(frame => frame.url().startsWith('blob:'))
    assert.ok(frame)
    await frame.waitForSelector('output')
    const before = await frame.$eval('.bars', element => element.textContent)
    await frame.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Step').click())
    await frame.waitForFunction(previous => document.querySelector('.bars').textContent !== previous, {}, before)
    await page.screenshot({ path: path.join(artifactDir, 'screenshots', 'artifacts-production-app.png'), fullPage: true })
    await page.reload({ waitUntil: 'networkidle2' })
    await waitForWebUiReady(page)
    assert.equal(decodeURIComponent(await page.evaluate(() => location.hash)), `#tab/chat:${sessionId}`)
    await page.waitForSelector('.artifact-chart-plot svg')
    await page.waitForSelector('.artifact-run-placeholder')
    assert.equal((await page.$$('[data-artifact-id]')).length, 3)
    assert.deepEqual(errors, [])
  } finally {
    await fs.writeFile(path.join(artifactDir, 'logs', 'artifacts-browser-errors.log'), errors.join('\n'))
    await browser.close()
    await fs.rm(imagePath, { force: true })
  }
})
