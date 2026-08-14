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

async function clickContextMenuItem(label) {
  await page.waitForSelector('[role="menu"]', { timeout: 5_000 })
  const clicked = await page.evaluate((expectedLabel) => {
    const button = Array.from(document.querySelectorAll('[role="menu"] button'))
      .find((element) => element.textContent?.trim() === expectedLabel)
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false
    button.click()
    return true
  }, label)
  assert.equal(clicked, true, `Expected enabled context-menu item: ${label}`)
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
  await page.waitForFunction(() => !!window.foxwarmTest, { timeout: 15_000 })
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
  await page.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
  const requestDeadline = Date.now() + 5_000
  while (modelListRequestCount <= previousRequests && Date.now() < requestDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const configureButton = await page.waitForSelector('button[aria-label="Configure models"]', { timeout: 15_000 })
  assert.equal((await configureButton.evaluate((button) => button.textContent || '')).trim(), '')
  assert.equal(await configureButton.evaluate((button) => button.title), 'Configure models')
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

test('Close all directly empties a multi-tab pane without route hydration', async () => {
  const closeAllPage = await browser.newPage()
  await closeAllPage.setViewport({ width: 1440, height: 900 })
  await closeAllPage.evaluateOnNewDocument(() => {
    const paneId = 'pane-e2e-close-all'
    localStorage.setItem('foxwarm_workbench_state_v4', JSON.stringify({
      state: {
        version: 4,
        tabsById: {
          'system:setup': { id: 'system:setup', type: 'setup', title: 'Setup' },
        },
        root: { id: paneId, kind: 'pane', tabIds: ['system:setup'], activeTabId: 'system:setup' },
        focusedPaneId: paneId,
      },
      version: 1,
    }))
    localStorage.removeItem('foxwarm_last_active_tab_v1')
  })

  try {
    await closeAllPage.goto(`${baseUrl}/#token=${encodeURIComponent(authToken)}`, { waitUntil: 'networkidle2' })
    await closeAllPage.waitForSelector('[data-tab-id="system:setup"]', { timeout: 15_000 })
    await closeAllPage.click('button[title="Open agents overview"]')
    await closeAllPage.waitForSelector('[data-tab-id="system:agents"]', { timeout: 15_000 })

    const sessionId = 'e2e-close-all-session'
    const chatTabId = `chat:${sessionId}`
    await closeAllPage.evaluate((id) => { window.location.hash = `session/${encodeURIComponent(id)}` }, sessionId)
    await closeAllPage.waitForSelector(`[data-tab-id=${JSON.stringify(chatTabId)}]`, { timeout: 15_000 })
    await closeAllPage.click('[data-tab-id="system:agents"]')

    assert.deepEqual(
      await closeAllPage.$$eval('[data-pane-id="pane-e2e-close-all"] [data-tab-id]', (elements) => elements.map((element) => element.getAttribute('data-tab-id')).sort()),
      ['chat:e2e-close-all-session', 'system:agents', 'system:setup'],
    )

    await closeAllPage.click('[data-tab-id="system:agents"]', { button: 'right' })
    await closeAllPage.waitForSelector('[role="menu"]', { timeout: 5_000 })
    const clicked = await closeAllPage.evaluate(() => {
      const button = Array.from(document.querySelectorAll('[role="menu"] button'))
        .find((element) => element.textContent?.trim() === 'Close all')
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false
      button.click()
      return true
    })
    assert.equal(clicked, true)

    await closeAllPage.waitForFunction(() => {
      const pane = document.querySelector('[data-pane-id="pane-e2e-close-all"]')
      return !!pane
        && pane.querySelectorAll('[data-tab-id]').length === 0
        && /Empty pane/.test(pane.textContent || '')
        && window.location.hash === ''
        && localStorage.getItem('foxwarm_last_active_tab_v1') === null
    }, { timeout: 5_000 })

    assert.equal(await closeAllPage.$$eval('[data-tab-id]', (elements) => elements.length), 0)
  } finally {
    await closeAllPage.close()
  }
})

test('tab context menu survives background scroll and bulk close actions remain distinct', async () => {
  await page.setViewport({ width: 1440, height: 900 })
  await page.evaluate(() => { window.location.hash = 'setup' })
  await waitForSystemTab('system:setup', 'Foxwarm Setup')
  await page.click('button[title="Open agents overview"]')
  await waitForSystemTab('system:agents', 'Agents')

  await page.click('[data-tab-id="system:setup"]', { button: 'right' })
  await page.waitForSelector('[role="menu"]', { timeout: 5_000 })
  await page.evaluate(() => {
    document.querySelector('[data-pane-id]')?.dispatchEvent(new Event('scroll'))
  })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(await page.$('[role="menu"]'), 'point-anchored tab menu should survive unrelated scroll events')

  await clickContextMenuItem('Close others')
  await page.waitForFunction(() => {
    const target = document.querySelector('[data-tab-id="system:setup"]')
    const pane = target?.closest('[data-pane-id]')
    return !!pane && pane.querySelectorAll('[data-tab-id]').length === 1
  }, { timeout: 5_000 })
  assert.ok(await page.$('[data-tab-id="system:setup"]'))
  assert.equal(await page.$('[data-tab-id="system:agents"]'), null)

  await page.click('[data-tab-id="system:setup"]', { button: 'right' })
  await clickContextMenuItem('Close all')
  await page.waitForFunction(() => document.querySelectorAll('[data-tab-id]').length === 0, { timeout: 5_000 })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(await page.$$eval('[data-tab-id]', (elements) => elements.length), 0)
  assert.match(await page.$eval('[data-pane-id]', (element) => element.textContent || ''), /Empty pane/)
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
