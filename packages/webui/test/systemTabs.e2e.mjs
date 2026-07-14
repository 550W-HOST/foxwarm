import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL || 'http://localhost:3002'
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE || new URL('../../../test/state/token', import.meta.url)

let browser
let page

async function waitForSystemTab(tabId, heading) {
  await page.waitForSelector(`[data-tab-id=${JSON.stringify(tabId)}]`, { timeout: 15_000 })
  await page.waitForFunction((expected) => {
    if (expected === 'Agents') {
      return Array.from(document.querySelectorAll('h1')).some((element) => element.textContent?.trim() === expected)
    }
    return document.body.textContent?.includes(expected)
  }, { timeout: 15_000 }, heading)
}

before(async () => {
  const token = (await readFile(tokenFile, 'utf8')).trim()
  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
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

test('system tabs remain workbench tabs on a mobile viewport', async () => {
  await page.setViewport({ width: 390, height: 844, isMobile: true })
  await page.evaluate(() => { window.location.hash = 'setup' })
  await waitForSystemTab('system:setup', 'Foxwarm Setup')
  assert.ok(await page.$('[data-pane-id]'))
  assert.ok(await page.$('[data-tab-id="system:setup"]'))
})
