import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL || 'http://localhost:3002'
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE || new URL('../../../test/state/token', import.meta.url)

let browser
let page
let sessions
let primarySessionId
let secondarySessionId
let sidebarPrimarySessionId
let sidebarSecondarySessionId

async function waitForChat(sessionId) {
  await page.waitForFunction((expected) => {
    const subtitle = document.querySelector('.foxwarm-chat-root header')?.textContent || document.querySelector('.foxwarm-chat-root')?.textContent || ''
    return subtitle.includes(`session ${expected}`)
  }, { timeout: 15_000 }, sessionId)
  await page.waitForSelector('.foxwarm-chat-messages', { timeout: 15_000 })
}

async function openPersistentChat(sessionId) {
  await page.evaluate((id) => {
    window.location.hash = `session/${encodeURIComponent(id)}`
  }, sessionId)
  await waitForChat(sessionId)
}

async function selectTab(sessionId) {
  await page.click(`[data-tab-id=${JSON.stringify(`chat:${sessionId}`)}]`)
  await waitForChat(sessionId)
}

async function readTopAnchor() {
  return page.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const timeline = document.querySelector('[data-chat-timeline="committed"]')
    if (!(container instanceof HTMLElement) || !(timeline instanceof HTMLElement)) return null
    const viewport = container.getBoundingClientRect()
    const rows = Array.from(timeline.querySelectorAll('[data-chat-message-anchor-key]'))
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < viewport.bottom
    })
    if (!(row instanceof HTMLElement)) return null
    return {
      key: row.dataset.chatMessageAnchorKey,
      offset: row.getBoundingClientRect().top - viewport.top,
    }
  })
}

async function readAnchorOffset(messageKey) {
  return page.evaluate((key) => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const row = Array.from(document.querySelectorAll('[data-chat-timeline="committed"] [data-chat-message-anchor-key]'))
      .find((candidate) => candidate.getAttribute('data-chat-message-anchor-key') === key)
    if (!(container instanceof HTMLElement) || !(row instanceof HTMLElement)) return null
    return row.getBoundingClientRect().top - container.getBoundingClientRect().top
  }, messageKey)
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
  await page.waitForFunction(() => !!window.alphabotTest, { timeout: 15_000 })
  await page.waitForSelector('[data-session-list-scroll-container]', { timeout: 15_000 })

  sessions = await page.evaluate(async () => {
    const response = await fetch('./api/sessions')
    return (await response.json()).sessions
  })
  const renderedIds = await page.$$eval('[data-session-id]', (rows) => rows.map((row) => row.getAttribute('data-session-id')))
  const longSessions = sessions
    .filter((session) => session.messageCount > 120)
    .sort((a, b) => b.messageCount - a.messageCount)
  assert.ok(longSessions.length >= 1, 'test environment needs a session with more than 120 messages')
  assert.ok(renderedIds.length >= 2, 'test environment needs two rendered sidebar rows')
  primarySessionId = longSessions[0].id
  secondarySessionId = longSessions[1]?.id || renderedIds[0]
  sidebarPrimarySessionId = renderedIds[0]
  sidebarSecondarySessionId = renderedIds.find((id) => id !== sidebarPrimarySessionId)
})

after(async () => {
  await browser?.close()
})

test('sidebar refresh does not refocus the unchanged current session, but a real selection does', async () => {
  await page.evaluate((sessionId) => window.alphabotTest.switchToSession(sessionId), sidebarPrimarySessionId)
  await waitForChat(sidebarPrimarySessionId)
  await page.waitForFunction((sessionId) => {
    const container = document.querySelector('[data-session-list-scroll-container]')
    const row = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`)
    if (!(container instanceof HTMLElement) || !(row instanceof HTMLElement)) return false
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return rowRect.top >= containerRect.top && rowRect.bottom <= containerRect.bottom
  }, { timeout: 5_000 }, sidebarPrimarySessionId)
  await new Promise((resolve) => setTimeout(resolve, 50))

  const beforeRefresh = await page.evaluate((sessionId) => {
    const container = document.querySelector('[data-session-list-scroll-container]')
    const row = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`)
    if (!(container instanceof HTMLElement) || !(row instanceof HTMLElement)) return null
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    container.scrollTop = rowRect.top < containerRect.top + container.clientHeight / 2
      ? container.scrollHeight
      : 0
    container.dispatchEvent(new Event('scroll'))
    const movedRowRect = row.getBoundingClientRect()
    return {
      scrollTop: container.scrollTop,
      rowVisible: movedRowRect.bottom > containerRect.top && movedRowRect.top < containerRect.bottom,
    }
  }, sidebarPrimarySessionId)
  assert.equal(beforeRefresh?.rowVisible, false)

  const namedSession = sessions.find((session) => typeof session.displayName === 'string' && session.displayName)
  assert.ok(namedSession)
  await page.evaluate(async ({ id, displayName }) => {
    const response = await fetch(`./api/sessions/${encodeURIComponent(id)}/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: displayName }),
    })
    if (!response.ok) throw new Error(`same-name refresh failed: ${response.status}`)
  }, namedSession)
  await new Promise((resolve) => setTimeout(resolve, 500))

  const afterRefresh = await page.evaluate((sessionId) => {
    const container = document.querySelector('[data-session-list-scroll-container]')
    const row = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`)
    if (!(container instanceof HTMLElement) || !(row instanceof HTMLElement)) return null
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return {
      scrollTop: container.scrollTop,
      rowVisible: rowRect.bottom > containerRect.top && rowRect.top < containerRect.bottom,
    }
  }, sidebarPrimarySessionId)
  assert.equal(afterRefresh?.rowVisible, false)
  assert.ok(Math.abs(afterRefresh.scrollTop - beforeRefresh.scrollTop) <= 2)

  await page.evaluate((sessionId) => window.alphabotTest.switchToSession(sessionId), sidebarSecondarySessionId)
  await waitForChat(sidebarSecondarySessionId)
  await page.waitForFunction((sessionId) => {
    const container = document.querySelector('[data-session-list-scroll-container]')
    const row = document.querySelector(`[data-session-id="${CSS.escape(sessionId)}"]`)
    if (!(container instanceof HTMLElement) || !(row instanceof HTMLElement)) return false
    const containerRect = container.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return rowRect.top >= containerRect.top && rowRect.bottom <= containerRect.bottom
  }, { timeout: 5_000 }, sidebarSecondarySessionId)
})

test('full timeline prepend preserves a stable row while content below resizes', async () => {
  await openPersistentChat(primarySessionId)
  await page.waitForFunction(() => document.body.textContent?.includes('Scroll upward to load'), { timeout: 15_000 })

  const expected = await page.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const timeline = document.querySelector('[data-chat-timeline="committed"]')
    const content = container?.firstElementChild
    if (!(container instanceof HTMLElement) || !(timeline instanceof HTMLElement) || !(content instanceof HTMLElement)) return null
    container.scrollTop = 115
    const viewport = container.getBoundingClientRect()
    const row = Array.from(timeline.querySelectorAll('[data-chat-message-anchor-key]')).find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < viewport.bottom
    })
    if (!(row instanceof HTMLElement)) return null
    const result = {
      key: row.dataset.chatMessageAnchorKey,
      offset: row.getBoundingClientRect().top - viewport.top,
    }
    container.dispatchEvent(new Event('scroll'))
    setTimeout(() => {
      const belowResize = document.createElement('div')
      belowResize.dataset.e2eBelowResize = 'true'
      belowResize.style.height = '333px'
      content.appendChild(belowResize)
    }, 0)
    return result
  })
  assert.ok(expected?.key)

  await page.waitForFunction(() => !document.body.textContent?.includes('Scroll upward to load'), { timeout: 15_000 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const actualOffset = await readAnchorOffset(expected.key)
  assert.notEqual(actualOffset, null)
  assert.ok(Math.abs(actualOffset - expected.offset) <= 2, `anchor offset changed from ${expected.offset} to ${actualOffset}`)
  await page.evaluate(() => document.querySelector('[data-e2e-below-resize]')?.remove())
})

test('continued user scrolling cancels the stale prepend restore target', async () => {
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.alphabotTest, { timeout: 15_000 })
  await openPersistentChat(primarySessionId)
  await page.waitForFunction(() => document.body.textContent?.includes('Scroll upward to load'), { timeout: 15_000 })

  const positions = await page.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const timeline = document.querySelector('[data-chat-timeline="committed"]')
    if (!(container instanceof HTMLElement) || !(timeline instanceof HTMLElement)) return null
    const readAnchor = () => {
      const viewport = container.getBoundingClientRect()
      const row = Array.from(timeline.querySelectorAll('[data-chat-message-anchor-key]')).find((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.bottom > viewport.top && rect.top < viewport.bottom
      })
      if (!(row instanceof HTMLElement)) return null
      return {
        key: row.dataset.chatMessageAnchorKey,
        offset: row.getBoundingClientRect().top - viewport.top,
      }
    }

    container.scrollTop = 115
    const stale = readAnchor()
    container.dispatchEvent(new Event('scroll'))
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }))
    container.scrollTop = Math.min(500, container.scrollHeight - container.clientHeight - 250)
    const latest = readAnchor()
    container.dispatchEvent(new Event('scroll'))
    return { stale, latest }
  })
  assert.ok(positions?.stale?.key)
  assert.ok(positions?.latest?.key)
  assert.notEqual(positions.latest.key, positions.stale.key)

  await page.waitForFunction(() => !document.body.textContent?.includes('Scroll upward to load'), { timeout: 15_000 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  const latestOffset = await readAnchorOffset(positions.latest.key)
  assert.notEqual(latestOffset, null)
  assert.ok(Math.abs(latestOffset - positions.latest.offset) <= 2, `latest user anchor changed from ${positions.latest.offset} to ${latestOffset}`)
})

test('tab remount restores an old message anchor and bottom-follow state', async () => {
  await openPersistentChat(secondarySessionId)
  await selectTab(primarySessionId)
  await page.waitForFunction(() => document.querySelectorAll('[data-chat-timeline="committed"] [data-chat-message-anchor-key]').length > 10, { timeout: 15_000 })

  const expectedAnchor = await page.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const timeline = document.querySelector('[data-chat-timeline="committed"]')
    if (!(container instanceof HTMLElement) || !(timeline instanceof HTMLElement)) return null
    const rows = Array.from(timeline.querySelectorAll('[data-chat-message-anchor-key]'))
    const target = rows[Math.max(1, Math.floor(rows.length / 3))]
    if (!(target instanceof HTMLElement)) return null
    container.scrollTop += target.getBoundingClientRect().top - container.getBoundingClientRect().top - 37
    container.dispatchEvent(new Event('scroll'))
    const viewport = container.getBoundingClientRect()
    const firstVisible = rows.find((row) => row.getBoundingClientRect().bottom > viewport.top)
    if (!(firstVisible instanceof HTMLElement)) return null
    return {
      key: firstVisible.dataset.chatMessageAnchorKey,
      offset: firstVisible.getBoundingClientRect().top - viewport.top,
    }
  })
  assert.ok(expectedAnchor?.key)

  await selectTab(secondarySessionId)
  await selectTab(primarySessionId)
  await page.waitForFunction((key) => !!Array.from(document.querySelectorAll('[data-chat-timeline="committed"] [data-chat-message-anchor-key]')).find((row) => row.getAttribute('data-chat-message-anchor-key') === key), { timeout: 15_000 }, expectedAnchor.key)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const restoredOffset = await readAnchorOffset(expectedAnchor.key)
  assert.notEqual(restoredOffset, null)
  assert.ok(Math.abs(restoredOffset - expectedAnchor.offset) <= 2, `restored offset changed from ${expectedAnchor.offset} to ${restoredOffset}`)

  await page.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    if (container instanceof HTMLElement) {
      container.scrollTop = container.scrollHeight
      container.dispatchEvent(new Event('scroll'))
    }
  })
  await selectTab(secondarySessionId)
  await selectTab(primarySessionId)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const distanceFromBottom = await page.$eval('.foxwarm-chat-messages', (container) => container.scrollHeight - container.scrollTop - container.clientHeight)
  assert.ok(distanceFromBottom <= 2, `expected bottom restore, got distance ${distanceFromBottom}`)
})
