import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL
const dataRoot = process.env.FOXWARM_E2E_DATA_DIR
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE
const artifactDir = process.env.FOXWARM_E2E_ARTIFACT_DIR
assert.ok(baseUrl && dataRoot && tokenFile && artifactDir, 'Run through the disposable application E2E harness.')
const token = (await fs.readFile(tokenFile, 'utf8')).trim()
const logPath = path.join(dataRoot, 'state', 'logs', 'synthetic-e2e.log')
let browser
let page
let protocol
const sockets = new Set()
const frames = []
const errors = []

async function button(label, target = page) {
  const clicked = await target.evaluate(text => {
    const element = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === text)
    if (!element || element.disabled) return false
    element.click()
    return true
  }, label)
  assert.equal(clicked, true, `Expected enabled ${label} button`)
}
async function waitText(text, target = page) {
  await target.waitForFunction(value => document.querySelector('[data-logs-text]')?.textContent.includes(value), { timeout: 10000 }, text)
}
async function openMenu(target = page) {
  await target.click('button[aria-label="Open UI settings"]')
  await target.waitForSelector('[data-global-ui-settings-menu]', { visible: true })
}
async function waitLoaded(target = page) {
  await target.waitForFunction(() => {
    const view = document.querySelector('[data-logs-view]')
    return view && !view.querySelector('[role="status"]')?.textContent.includes('Loading')
  })
}

before(async () => {
  await fs.appendFile(logPath, ('[2026-01-02 00:00:00.000 +0000] INFO: synthetic history 汉字 ' + 'x'.repeat(120) + '\n').repeat(2500))
  await fs.appendFile(logPath, '\u001b[32m[2026-01-02 00:00:02.000 +0000] INFO: literal <img src=x onerror="window.logsMarkupExecuted=true"> <foxwarm-commit hash="synthetic" /> 🦊 synthetic latest\u001b[0m\n')
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  page.on('pageerror', error => errors.push(error.message))
  protocol = await page.createCDPSession()
  await protocol.send('Network.enable')
  protocol.on('Network.webSocketCreated', event => { if (event.url.includes('/api/webui/stream')) sockets.add(event.requestId) })
  protocol.on('Network.webSocketClosed', event => sockets.delete(event.requestId))
  protocol.on('Network.webSocketFrameSent', event => {
    try { frames.push(JSON.parse(event.response.payloadData)) } catch {}
  })
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('button[aria-label="Open UI settings"]')
})

after(async () => {
  if (errors.length) await fs.writeFile(path.join(artifactDir, 'logs-browser-errors.log'), errors.join('\n'))
  await browser?.close()
})

test('Logs menu, bounded history/live, approximate time jump, restoration, popup and mobile themed entry use the production app', async () => {
  await openMenu()
  const labels = await page.$$eval('[data-global-ui-settings-menu] button', buttons => buttons.map(item => item.textContent.trim()))
  assert.ok(labels.includes('Open setup'))
  assert.ok(labels.includes('Reload WebUI'))
  assert.ok(labels.includes('Open logs'))
  await button('Open logs')
  await waitText('synthetic latest')
  assert.equal(sockets.size, 1, 'Logs uses the existing page realtime WebSocket')
  await page.click('button[title="Collapse sidebar"]')
  await openMenu()
  await button('Open logs')
  assert.equal(await page.$$eval('[data-tab-id="system:logs"]', elements => elements.length), 1)
  await page.click('button[title="Expand sidebar"]')
  const snapshot = await page.$eval('[data-logs-text]', element => ({ text: element.textContent, start: Number(element.dataset.startOffset), end: Number(element.dataset.endOffset) }))
  assert.ok(snapshot.start > 0)
  assert.ok(snapshot.end - snapshot.start <= 100 * 1024)
  assert.ok(snapshot.text.includes('<img src=x'))
  assert.equal(await page.$('[data-logs-text] img'), null)
  assert.equal(await page.evaluate(() => !!window.logsMarkupExecuted), false)
  assert.ok(!snapshot.text.includes('\u001b'))
  await fs.appendFile(logPath, 'synthetic live append\n')
  await waitText('synthetic live append')
  await button('Older')
  await waitLoaded()
  const old = await page.$eval('[data-logs-text]', element => ({ text: element.textContent, start: Number(element.dataset.startOffset), end: Number(element.dataset.endOffset) }))
  assert.ok(old.end <= snapshot.end)
  assert.equal(old.text.includes('synthetic latest'), false)
  await page.waitForFunction(() => document.querySelector('[data-logs-view] [role="status"]')?.textContent === 'History')
  await fs.appendFile(logPath, 'synthetic while browsing\n')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(await page.$eval('[data-logs-text]', element => element.textContent), old.text)
  assert.equal(frames.at(-1).logs, undefined, 'history releases the logs topic without closing list/Chat')
  await button('Newer')
  await waitLoaded()
  assert.equal(await page.$eval('[data-logs-text]', element => Number(element.dataset.startOffset)), old.end)
  const position = await page.$eval('[data-logs-text]', element => element.dataset.startOffset)
  // React's controlled input requires its native value setter.
  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Log date and time"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1900-01-01T00:00:00')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await button('Jump near time')
  await page.waitForSelector('[data-logs-view] [role="alert"]')
  assert.equal(await page.$eval('[data-logs-text]', element => element.dataset.startOffset), position, 'failed time lookup preserves the history window')
  await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Log date and time"]')
    const time = new Date('2026-01-02T00:00:01Z')
    const local = new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, local)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await button('Jump near time')
  await page.waitForFunction(() => document.querySelector('[data-logs-view]')?.textContent.includes('Located near'))
  assert.ok(await page.$eval('[data-logs-view]', element => element.textContent.includes('(approximate)')))
  await button('Latest · Live')
  await waitText('synthetic while browsing')
  await page.reload({ waitUntil: 'networkidle2' })
  await waitText('synthetic while browsing')
  assert.equal(decodeURIComponent(await page.evaluate(() => location.hash)), '#tab/system:logs')
  assert.ok(await page.$('[data-tab-id="system:logs"]'))

  const popupPromise = new Promise(resolve => page.once('popup', resolve))
  await page.click('[data-tab-id="system:logs"]', { button: 'right' })
  await page.waitForSelector('[role="menu"]')
  await button('Move to new window')
  const popup = await popupPromise
  await popup.waitForSelector('[data-foxwarm-popup-root="logs"]')
  await waitText('synthetic while browsing', popup)
  assert.equal(await popup.$('[data-pane-id]'), null, 'popup is a leaf, not another workbench')
  assert.equal(await page.$('[data-tab-id="system:logs"]'), null)
  await fs.appendFile(logPath, 'synthetic popup live\n')
  await waitText('synthetic popup live', popup)
  await popup.close()

  const embedded = await browser.newPage()
  await embedded.goto(`${baseUrl}/?foxwarmEmbed=sidebar&foxwarmEmbedNonce=synthetic_logs_embed_nonce`, { waitUntil: 'networkidle2' })
  await openMenu(embedded)
  const embeddedPopupPromise = new Promise(resolve => embedded.once('popup', resolve))
  await button('Open logs', embedded)
  const embeddedPopup = await embeddedPopupPromise
  await embeddedPopup.waitForSelector('[data-foxwarm-popup-root="logs"]')
  await waitText('synthetic popup live', embeddedPopup)
  assert.equal(new URL(embeddedPopup.url()).searchParams.has('foxwarmEmbedNonce'), false)
  await embeddedPopup.close()
  await embedded.close()

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('button[aria-label="Open UI settings"]')
  await openMenu()
  await button('dark')
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true)
  await openMenu()
  const bounds = await page.$eval('[data-global-ui-settings-menu]', element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }))
  assert.ok(bounds.left >= 7 && bounds.right <= 383)
  await button('Open logs')
  await waitText('synthetic popup live')
  const character = Buffer.from('🦊')
  await fs.appendFile(logPath, Buffer.concat([Buffer.from('synthetic partial '), character.subarray(0, 2)]))
  await waitText('synthetic partial ')
  assert.ok(!await page.$eval('[data-logs-text]', element => element.textContent.includes('\ufffd')))
  await fs.appendFile(logPath, Buffer.concat([character.subarray(2), Buffer.from('\n')]))
  await waitText('synthetic partial 🦊')
  for (let index = 0; index < 4; index++) {
    const marker = `synthetic bounded live ${index}`
    await fs.appendFile(logPath, `${'x'.repeat(70 * 1024)} ${marker}\n`)
    await waitText(marker)
    const bounded = await page.$eval('[data-logs-text]', element => ({ bytes: Number(element.dataset.endOffset) - Number(element.dataset.startOffset), length: element.textContent.length, childElements: element.childElementCount }))
    assert.ok(bounded.bytes <= 200 * 1024)
    assert.ok(bounded.length <= 200 * 1024)
    assert.equal(bounded.childElements, 0)
  }
  await fs.rename(logPath, `${logPath}.saved`)
  try {
    await fs.writeFile(logPath, 'synthetic replacement\n')
    await page.waitForSelector('[data-logs-view] [role="alert"]')
    await button('Latest · Live')
    await waitText('synthetic replacement')
    await page.screenshot({ path: path.join(artifactDir, 'logs-mobile-dark.png') })
  } finally {
    await fs.rm(logPath, { force: true })
    await fs.rename(`${logPath}.saved`, logPath)
  }
  assert.deepEqual(errors, [])
})
