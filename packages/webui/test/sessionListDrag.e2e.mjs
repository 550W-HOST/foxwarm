import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL || 'http://localhost:3002'
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE || new URL('../../../test/state/token', import.meta.url)

let browser

async function openSessionList(viewport) {
  const token = (await readFile(tokenFile, 'utf8')).trim()
  const page = await browser.newPage()
  await page.setViewport(viewport)
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!localStorage.getItem('foxwarm_token'), { timeout: 15_000 })
  await page.evaluate(() => history.replaceState(null, '', location.pathname))
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })
  await page.waitForSelector('[data-session-id]', { timeout: 15_000 })
  return page
}

async function readSessionPlacement(page) {
  return page.evaluate(async () => {
    const response = await fetch('./api/sessions')
    const payload = await response.json()
    return payload.sessions.map((session) => ({
      id: session.id,
      parentSessionId: session.parentSessionId ?? null,
      sidebarOrder: session.sidebarOrder ?? null,
    })).sort((a, b) => a.id.localeCompare(b.id))
  })
}

async function getVisibleSessionRow(page) {
  await page.evaluate(() => {
    const container = document.querySelector('[data-session-list-scroll-container]')
    if (container instanceof HTMLElement) {
      container.scrollTop = Math.min(500, Math.max(0, container.scrollHeight - container.clientHeight - 1))
    }
  })
  const handle = await page.evaluateHandle(() => {
    const container = document.querySelector('[data-session-list-scroll-container]')
    if (!(container instanceof HTMLElement)) return null
    const containerRect = container.getBoundingClientRect()
    return Array.from(document.querySelectorAll('[data-session-id]')).find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.top >= containerRect.top + 4 && rect.bottom <= containerRect.bottom - 4
    }) || null
  })
  const row = handle.asElement()
  assert.ok(row, 'expected a fully visible session row')
  return row
}

before(async () => {
  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
})

after(async () => {
  await browser?.close()
})

test('mobile touch swipe scrolls the session list without entering drag or changing placement', async () => {
  const page = await openSessionList({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  try {
    const placementBefore = await readSessionPlacement(page)
    const row = await getVisibleSessionRow(page)
    const box = await row.boundingBox()
    assert.ok(box)
    assert.equal(await row.evaluate((element) => element.getAttribute('role')), null)

    const scrollTopBefore = await page.$eval('[data-session-list-scroll-container]', (element) => element.scrollTop)
    const client = await page.createCDPSession()
    const x = box.x + box.width * 0.55
    const y = box.y + box.height * 0.5
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })

    for (const offset of [8, 16, 32, 64, 100]) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - offset }] })
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(await page.$('[data-session-drag-overlay]'), null, `drag overlay appeared after ${offset}px touch movement`)
      assert.equal(await page.$('[data-session-id].opacity-50'), null, `a session row entered dragging state after ${offset}px touch movement`)
    }

    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const scrollTopAfter = await page.$eval('[data-session-list-scroll-container]', (element) => element.scrollTop)
    assert.ok(scrollTopAfter > scrollTopBefore + 40, `expected touch scroll to advance, got ${scrollTopBefore} -> ${scrollTopAfter}`)
    assert.deepEqual(await readSessionPlacement(page), placementBefore)
  } finally {
    await page.close()
  }
})

test('desktop mouse drag still starts and can be cancelled without changing placement', async () => {
  const page = await openSessionList({ width: 1440, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  try {
    const placementBefore = await readSessionPlacement(page)
    const row = await getVisibleSessionRow(page)
    const box = await row.boundingBox()
    assert.ok(box)
    assert.equal(await row.evaluate((element) => element.getAttribute('role')), 'button')

    const x = box.x + box.width * 0.55
    const y = box.y + box.height * 0.5
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 12, y, { steps: 3 })
    await page.waitForSelector('[data-session-drag-overlay]', { timeout: 5_000 })
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await page.waitForSelector('[data-session-drag-overlay]', { hidden: true, timeout: 5_000 })
    assert.deepEqual(await readSessionPlacement(page), placementBefore)
  } finally {
    await page.close()
  }
})