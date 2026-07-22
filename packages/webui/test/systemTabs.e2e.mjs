import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL || 'http://localhost:3002'
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE || new URL('../../../test/state/token', import.meta.url)

let browser
let page
let authToken
let modelListRequestCount = 0

async function waitForSystemTab(tabId, heading) {
  await page.waitForSelector(`[data-tab-id=${JSON.stringify(tabId)}]`, { timeout: 15_000 })
  await page.waitForFunction((expected) => {
    if (expected === 'Agents') {
      return Array.from(document.querySelectorAll('h1')).some((element) => element.textContent?.trim() === expected)
    }
    return document.body.textContent?.includes(expected)
  }, { timeout: 15_000 }, heading)
}

async function closeTab(tabId) {
  await page.click(`[data-tab-id=${JSON.stringify(tabId)}] button[title="Close tab"]`)
  await page.waitForFunction((id) => !document.querySelector(`[data-tab-id="${CSS.escape(id)}"]`), { timeout: 5_000 }, tabId)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await page.$(`[data-tab-id=${JSON.stringify(tabId)}]`), null)
}

before(async () => {
  authToken = (await readFile(tokenFile, 'utf8')).trim()
  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  page = await browser.newPage()
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/api/models')) modelListRequestCount += 1
  })
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(authToken)}`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.alphabotTest, { timeout: 15_000 })
  await page.evaluate(() => {
    const token = localStorage.getItem('foxwarm_token')
    localStorage.clear()
    if (token) localStorage.setItem('foxwarm_token', token)
  })
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })
})

after(async () => {
  await browser?.close()
})

test('Agents and Setup use persistent workbench tabs without replacing the desktop shell', async () => {
  await page.click('button[title="Open agents overview"]')
  await waitForSystemTab('system:agents', 'Agents')
  assert.ok(await page.$('[data-pane-id]'))
  assert.ok(await page.$('[data-session-list-scroll-container]'))

  await page.evaluate(() => { window.location.hash = 'setup' })
  await waitForSystemTab('system:setup', 'Foxwarm Setup')
  assert.ok(await page.$('[data-tab-id="system:agents"]'))
  assert.ok(await page.$('[data-session-list-scroll-container]'))

  await page.reload({ waitUntil: 'networkidle2' })
  await waitForSystemTab('system:setup', 'Foxwarm Setup')
  assert.ok(await page.$('[data-tab-id="system:agents"]'))

  await page.click('[data-tab-id="system:agents"]')
  await waitForSystemTab('system:agents', 'Agents')
})

test('closing active system and chat tabs advances the route instead of hydrating the closed tab', async () => {
  await page.click('[data-tab-id="system:setup"]')
  await waitForSystemTab('system:setup', 'Foxwarm Setup')
  await closeTab('system:setup')
  assert.equal(decodeURIComponent(await page.evaluate(() => window.location.hash)), '#tab/system:agents')

  await closeTab('system:agents')
  assert.notEqual(decodeURIComponent(await page.evaluate(() => window.location.hash)), '#agents')

  const sessionId = 'e2e-close-session-tab'
  const chatTabId = `chat:${sessionId}`
  await page.evaluate((id) => { window.location.hash = `session/${encodeURIComponent(id)}` }, sessionId)
  await page.waitForSelector(`[data-tab-id=${JSON.stringify(chatTabId)}]`, { timeout: 15_000 })
  await closeTab(chatTabId)
  assert.notEqual(decodeURIComponent(await page.evaluate(() => window.location.hash)), `#tab/${chatTabId}`)
})

test('model popup refreshes models and opens the singleton Setup models editor', async () => {
  await page.setViewport({ width: 1440, height: 900 })
  const sessionId = 'e2e-model-settings-session'
  await page.evaluate((id) => { window.location.hash = `session/${encodeURIComponent(id)}` }, sessionId)
  const modelButton = await page.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
  const previousRequests = modelListRequestCount
  await modelButton.click()
  await page.waitForFunction(() => !!document.activeElement?.closest('[data-model-selector-popup="true"]'))
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.matches('button[aria-haspopup="dialog"]'))
  await modelButton.click()
  await page.waitForFunction(() => !!document.activeElement?.closest('[data-model-selector-popup="true"]'))
  const requestDeadline = Date.now() + 5_000
  while (modelListRequestCount <= previousRequests && Date.now() < requestDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const configureButton = await page.waitForSelector('button::-p-text(Configure models…)', { timeout: 15_000 })
  await configureButton.click()

  await waitForSystemTab('system:setup', 'Foxwarm Setup')
  await page.waitForSelector('[data-setup-section="models"] [data-editor-ready="true"]', { timeout: 15_000 })
  await page.waitForFunction(() => {
    const active = document.activeElement
    return !!active?.closest('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]')
  }, { timeout: 15_000 })
  assert.equal(await page.$$eval('[data-tab-id="system:setup"]', (elements) => elements.length), 1)
  assert.ok(modelListRequestCount > previousRequests)
})

test('system tabs remain workbench tabs on a mobile viewport', async () => {
  await page.setViewport({ width: 390, height: 844, isMobile: true })
  await page.evaluate(() => { window.location.hash = 'setup' })
  await waitForSystemTab('system:setup', 'Foxwarm Setup')
  assert.ok(await page.$('[data-pane-id]'))
  assert.ok(await page.$('[data-tab-id="system:setup"]'))
})

test('forced OOBE Setup still rejects workbench close requests', async () => {
  const forcedPage = await browser.newPage()
  await forcedPage.setViewport({ width: 1440, height: 900 })
  await forcedPage.setRequestInterception(true)
  forcedPage.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/api/setup/status')) {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          oobe: true,
          models: {
            exists: false,
            path: 'state/models.yaml',
            templatePath: '',
            providerCount: 0,
            defaultModel: null,
            hasPlaceholderSecrets: false,
            placeholderProviders: [],
          },
          config: {
            appConfigPath: 'state/config.yaml',
            channelsYaml: '',
            channelCount: 0,
          },
          channels: [],
        }),
      })
      return
    }
    void request.continue()
  })

  try {
    await forcedPage.goto(`${baseUrl}/#token=${encodeURIComponent(authToken)}`, { waitUntil: 'networkidle2' })
    await forcedPage.waitForSelector('[data-tab-id="system:setup"]', { timeout: 15_000 })
    await forcedPage.waitForFunction(() => document.body.textContent?.includes('Foxwarm first-time setup'), { timeout: 15_000 })
    await forcedPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-ready="true"]', { timeout: 15_000 })
    assert.equal(await forcedPage.$('button::-p-text(Form)'), null)
    await forcedPage.click('[data-tab-id="system:setup"] button[title="Close tab"]')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(await forcedPage.$('[data-tab-id="system:setup"]'))
  } finally {
    await forcedPage.close()
  }
})
