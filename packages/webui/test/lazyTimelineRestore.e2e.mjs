import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'

const baseUrl = process.env.FOXWARM_E2E_URL || 'http://localhost:3002'
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const tokenFile = process.env.FOXWARM_E2E_TOKEN_FILE || new URL('../../../test/state/token', import.meta.url)

const token = (await readFile(tokenFile, 'utf8')).trim()
const headers = { Authorization: `Bearer ${token}` }
const sessions = await fetch(`${baseUrl}/api/sessions`, { headers }).then(response => response.json())
const fixtureSessionId = sessions.sessions?.[0]?.id
assert.ok(fixtureSessionId, 'test environment needs one session for the intercepted history fixture')
const originalHistory = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(fixtureSessionId)}/history`, { headers })
  .then(response => response.json())

const text = (label, index) => `${label} ${index}\n${'content '.repeat(24)}\n${'detail '.repeat(24)}`
const ordinaryMessage = (index, stable = true) => ({
  role: index % 2 ? 'model' : 'user',
  parts: [{ text: text('message', index) }],
  ...(stable ? { __meta: { seq: index + 1, timestamp: 100_000 + index } } : {}),
})

function createMessages(shape) {
  const messages = Array.from({ length: 120 }, (_, index) => ordinaryMessage(index))
  if (shape === 'tool-boundary') {
    messages[19] = {
      role: 'model',
      parts: [{ functionCall: { id: 'boundary-call', name: 'read', args: { filePath: 'fixture.txt' } } }],
      __meta: { seq: 20, timestamp: 100_019 },
    }
    messages[20] = {
      role: 'tool',
      parts: [
        { text: Array.from({ length: 8 }, (_, index) => text('tool response line', index)).join('\n') },
        { functionResponse: { tool_use_id: 'boundary-call', name: 'read', response: { output: text('tool response', 5) } } },
      ],
      __meta: { seq: 21, timestamp: 100_020 },
    }
  }
  if (shape === 'missing-meta') {
    for (let index = 20; index < messages.length; index++) {
      messages[index] = ordinaryMessage(index, false)
    }
  }
  return messages
}

async function openFixture(shape) {
  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', request => {
    if (request.url().includes(`/api/sessions/${encodeURIComponent(fixtureSessionId)}/history`)) {
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...originalHistory,
          messages: createMessages(shape),
          persistentMemorySnapshot: '',
          queuedMessages: [],
          queueLength: 0,
        }),
      })
      return
    }
    void request.continue()
  })
  await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => !!window.foxwarmTest, { timeout: 15_000 })
  await page.evaluate(sessionId => window.foxwarmTest.switchToSession(sessionId), fixtureSessionId)
  await page.waitForFunction((sessionId) => {
    const root = document.querySelector('.foxwarm-chat-root')
    return (root?.textContent || '').includes(`session ${sessionId}`)
  }, { timeout: 15_000 }, fixtureSessionId)
  await page.waitForFunction(() => document.body.textContent?.includes('Scroll upward to load'), { timeout: 15_000 })
  return { browser, page }
}

async function triggerLazyExpansion(page) {
  return page.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const timeline = document.querySelector('[data-chat-timeline="committed"]')
    if (!(container instanceof HTMLElement) || !(timeline instanceof HTMLElement)) return null
    const viewport = container.getBoundingClientRect()
    const anchors = () => Array.from(timeline.querySelectorAll('[data-chat-message-anchor-key]'))
      .map(row => {
        const rect = row.getBoundingClientRect()
        return {
          key: row.getAttribute('data-chat-message-anchor-key'),
          offset: rect.top - viewport.top,
          visible: rect.bottom > viewport.top && rect.top < viewport.bottom,
        }
      })

    container.scrollTop = 115
    const before = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
      anchors: anchors(),
    }
    container.dispatchEvent(new Event('scroll'))
    return before
  })
}

test('lazy prepend preserves a nearby stable row when the leading tool-response anchor is regrouped away', async () => {
  const { browser, page } = await openFixture('tool-boundary')
  try {
    const before = await triggerLazyExpansion(page)
    const removedIndex = before?.anchors.findIndex(anchor => anchor.visible)
    assert.notEqual(removedIndex, -1)
    assert.equal(before.anchors[removedIndex].key, 'seq-local-21')
    assert.equal(before.anchors.filter(anchor => anchor.visible).length, 1, 'regrouped response should own the initial viewport')
    const survivor = before.anchors[removedIndex + 1]
    assert.ok(survivor, 'fixture needs a nearby surviving neighbor')

    await page.waitForFunction(() => !document.body.textContent?.includes('Scroll upward to load'), { timeout: 15_000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    const after = await page.evaluate(({ removedKey, survivorKey }) => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const rows = Array.from(document.querySelectorAll('[data-chat-timeline="committed"] [data-chat-message-anchor-key]'))
      const survivorRow = rows.find(row => row.getAttribute('data-chat-message-anchor-key') === survivorKey)
      if (!(container instanceof HTMLElement) || !(survivorRow instanceof HTMLElement)) return null
      return {
        removedAnchorExists: rows.some(row => row.getAttribute('data-chat-message-anchor-key') === removedKey),
        survivorOffset: survivorRow.getBoundingClientRect().top - container.getBoundingClientRect().top,
        distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
      }
    }, { removedKey: before.anchors[removedIndex].key, survivorKey: survivor.key })

    assert.ok(after)
    assert.equal(after.removedAnchorExists, false)
    assert.ok(Math.abs(after.survivorOffset - survivor.offset) <= 2, `survivor offset changed from ${survivor.offset} to ${after.survivorOffset}`)
    assert.ok(after.distanceFromBottom > 500, `lazy prepend unexpectedly moved to bottom (distance ${after.distanceFromBottom})`)
  } finally {
    await browser.close()
  }
})

test('lazy prepend uses scroll-height geometry when the visible slice has no stable anchors', async () => {
  const { browser, page } = await openFixture('missing-meta')
  try {
    const before = await triggerLazyExpansion(page)
    assert.equal(before?.anchors.length, 0)

    await page.waitForFunction(() => !document.body.textContent?.includes('Scroll upward to load'), { timeout: 15_000 })
    await new Promise(resolve => setTimeout(resolve, 100))
    const after = await page.$eval('.foxwarm-chat-messages', container => ({
      distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
    }))
    assert.ok(Math.abs(after.distanceFromBottom - before.distanceFromBottom) <= 2, `distance from bottom changed from ${before.distanceFromBottom} to ${after.distanceFromBottom}`)
    assert.ok(after.distanceFromBottom > 500)
  } finally {
    await browser.close()
  }
})
