import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { startChatFixture } from './chatFixture.mjs'

let browser
let fixtureUrl
let fixture

before(async () => {
  fixture = await startChatFixture()
  ;({ browser, fixtureUrl } = fixture)
})

after(() => fixture?.close())

async function openContinuousChat(query = '') {
  const chatPage = await browser.newPage()
  await chatPage.setViewport({ width: 1000, height: 760 })
  await chatPage.goto(`${fixtureUrl}?continuous=1${query}`, { waitUntil: 'load' })
  await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
  await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Generated summary, not original history' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 594 } } }, ...window.fixtureArchive.slice(-6)], 1, { latestSeq: 600 }))
  await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
  return chatPage
}

const readingAnchor = chatPage => chatPage.evaluate(() => {
  const container = document.querySelector('.foxwarm-chat-messages')
  const viewport = container.getBoundingClientRect()
  const anchor = [...container.querySelectorAll('[data-chat-message-anchor-key]')].find(element => element.getBoundingClientRect().bottom > viewport.top)
  return { key: anchor?.getAttribute('data-chat-message-anchor-key'), offset: anchor?.getBoundingClientRect().top - viewport.top }
})

async function loadContinuousEarlier(chatPage) {
  await chatPage.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
    container.scrollTop = 5
    container.dispatchEvent(new Event('scroll'))
  })
}

test('continuous Chat loads one recent page, retries earlier pages, bounds mounted rows, and keeps independent mode positions', async () => {
  const chatPage = await openContinuousChat()
  try {
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 1)
    assert.equal(await chatPage.evaluate(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary')), false)
    assert.equal(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length), 100)
    await chatPage.evaluate(() => { window.fixtureFailArchive = true })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForFunction(() => document.querySelector('[data-continuous-history]')?.textContent.includes('could not be loaded'))
    await chatPage.click('[data-continuous-history] button')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.scrollTop = 800
      container.dispatchEvent(new Event('scroll'))
    })
    const reading = await readingAnchor(chatPage)
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.fixtureHistoryMode = 'active'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary'))
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'conversation'; window.fixtureHistoryMode = 'continuous'; window.renderFixtureChats() })
    await chatPage.waitForSelector(`[data-chat-message-anchor-key="${reading.key}"]`)
    await chatPage.waitForFunction(expected => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[data-chat-message-anchor-key="' + expected.key + '"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
    }, {}, reading)
    // The two internal axes also support Detailed over the already-loaded raw source.
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.renderFixtureChats() })
    await chatPage.waitForSelector(`[data-chat-message-anchor-key="${reading.key}"]`)
    assert.equal(await chatPage.evaluate(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary')), false)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
    const requestsBeforeSearch = await chatPage.evaluate(() => window.fixtureArchiveRequests.length)
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Original narrative 301')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), requestsBeforeSearch, 'Search mounts loaded history without fetching Archive')
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    await chatPage.click('[aria-label="Close search"]')
  } finally { await chatPage.close() }
})

test('continuous Chat preserves raw reading anchors through a concurrent compact and live append', async () => {
  const chatPage = await openContinuousChat()
  try {
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.scrollTop = 900
      container.dispatchEvent(new Event('scroll'))
    })
    const reading = await readingAnchor(chatPage)
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Live reply after another compact' }], __meta: { seq: 601, timestamp: 1700000001000 } }
      window.fixtureArchive.push(message)
      window.emitFixtureMessage(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Second generated summary' }], __meta: { contextBlock: { id: 2, level: 2, sourceKind: 'block', rawStartSeq: 1, rawEndSeq: 600 } } }, window.fixtureArchive.at(-1)], 2, { latestSeq: 601 }))
    await chatPage.waitForFunction(expected => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[data-chat-message-anchor-key="' + expected.key + '"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
    }, {}, reading)
    assert.equal(await chatPage.evaluate(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Second generated summary')), false)
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
    assert.equal(await chatPage.$$eval('[data-chat-message-anchor-key="seq-local-601"]', nodes => nodes.length), 1)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})

test('continuous Chat reconciles optimistic sends and live drafts while an older page is pending', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    const reading = await readingAnchor(chatPage)
    await chatPage.type('[role="textbox"][aria-label="Message"]', 'Concurrent original input')
    await chatPage.click('[aria-label="Send message"]')
    await chatPage.waitForFunction(() => window.fixtureMessageBodies.length === 1)
    await chatPage.evaluate(() => {
      const clientMessageId = window.fixtureMessageBodies[0].clientMessageId
      const message = { role: 'user', parts: [{ text: 'Concurrent original input' }], __meta: { seq: 601, timestamp: 1700000000601, clientMessageId } }
      window.fixtureArchive.push(message)
      window.emitFixtureMessage(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model', busy: true, queueLength: 0 }, queueLength: 0, messageCount: 8, historyVersion: 1, modelKey: 'fixture/model' } })
      window.emitFixtureEvent({ type: 'session-event', event: { type: 'model-stream-update', streamId: 'continuous-stream', text: 'Live uncommitted reply' } })
      window.resolveFixtureMessages()
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
    })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.waitForFunction(expected => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[data-chat-message-anchor-key="' + expected.key + '"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
    }, { timeout: 5000 }, reading)
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-601"]'), null, 'an old window does not append a disconnected live tail')
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
    await chatPage.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Live uncommitted reply'))
    assert.equal(await chatPage.$$eval('[data-chat-message-anchor-key="seq-local-601"]', nodes => nodes.length), 1)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})


test('continuous Chat ignores a pending page viewport correction after switching to active history', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.fixtureHistoryMode = 'active'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary'))
    const before = await readingAnchor(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const after = await readingAnchor(chatPage)
    assert.equal(after.key, before.key)
    assert.ok(Math.abs(after.offset - before.offset) < 3)
    assert.equal(await chatPage.$('[data-continuous-history]'), null)
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'conversation'; window.fixtureHistoryMode = 'continuous'; window.renderFixtureChats() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-501"]')
  } finally { await chatPage.close() }
})

test('continuous Chat commits a queued input and removes its preview in the same frame', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model', busy: true, queueLength: 1 }, queueLength: 1, messageCount: 7, historyVersion: 1, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(1, [], 1, { latestSeq: 600, messageCount: 7, busy: true, queuedMessages: [{ role: 'user', parts: [{ text: 'Continuous queued input' }], __meta: { temporary: true, queuedPreview: true, synthetic: 'queued-0-user-fixture', queueType: 'user', queueIndex: 0 } }] }))
    await chatPage.waitForFunction(() => document.querySelector('[data-queued-preview]')?.textContent.includes('Continuous queued input'))
    await chatPage.evaluate(() => {
      window.fixtureQueueFrames = []
      const sample = () => {
        window.fixtureQueueFrames.push({ committed: !!document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('Continuous queued input'), queued: !!document.querySelector('[data-queued-preview]')?.textContent.includes('Continuous queued input') })
        if (window.fixtureQueueFrames.length < 12) requestAnimationFrame(sample)
      }
      sample()
      const message = { role: 'user', parts: [{ text: 'Continuous queued input' }], __meta: { seq: 601, timestamp: 1700000000601 } }
      window.fixtureArchive.push(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: true, runtimeState: { state: 'requesting-model', busy: true, queueLength: 0 }, queueLength: 0, messageCount: 8, historyVersion: 1, modelKey: 'fixture/model' } })
      window.emitFixtureEvent({ type: 'history-append', messages: [message], queuedMessages: [], queueLength: 0, messageCount: 8, historyVersion: 1 })
    })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
    await chatPage.waitForFunction(() => window.fixtureQueueFrames.length === 12)
    assert.equal(await chatPage.$('[data-queued-preview]'), null)
    assert.equal(await chatPage.evaluate(() => window.fixtureQueueFrames.every(frame => frame.committed !== frame.queued)), true)
    assert.equal(await chatPage.$$eval('[data-chat-message-anchor-key="seq-local-601"]', nodes => nodes.length), 1)
  } finally { await chatPage.close() }
})


test('continuous Chat Search follows active retry visibility instead of the Archive tail', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      const retry = { role: 'model', modelVisible: false, parts: [{ text: '⚠️ LLM Error: Old archived retry' }], __meta: { seq: 601, timestamp: 1700000000601, noticeType: 'llm-retry', retry: { final: true } } }
      window.fixtureArchive.push(retry)
      window.emitFixtureMessage(retry)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 1, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForSelector('[data-chat-timeline="committed"] [data-system-event]')
    assert.equal(await chatPage.$eval('[data-chat-timeline="committed"] [data-system-event]', node => !!node.closest('[data-activity-details]')), false)
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary covering the old retry' }], __meta: { contextBlock: { id: 2, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 601 } } }], 2, { latestSeq: 601 }))
    await chatPage.waitForFunction(() => !document.querySelector('[data-chat-timeline="committed"] [data-system-event]'))
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Old archived retry')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '0/0')
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.fixtureHistoryMode = 'continuous'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
  } finally { await chatPage.close() }
})


test('continuous Chat catches up by one bounded page and returns to latest without draining a disconnected Archive gap', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      for (let seq = 601; seq <= 800; seq++) window.fixtureArchive.push({ role: seq % 2 ? 'user' : 'model', parts: [{ text: 'Offline original ' + seq }], __meta: { seq, timestamp: 1700000000000 + seq } })
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary after offline work' }], __meta: { contextBlock: { id: 2, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 799 } } }, window.fixtureArchive.at(-1)], 2, { latestSeq: 800 }))
    await chatPage.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Load newer messages'))
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-800"]'), null)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Live commit while returning to latest' }], __meta: { seq: 801, timestamp: 1700000000801 } }
      window.fixtureArchive.push(message)
      window.emitFixtureMessage(message)
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
    })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-800"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-801"]')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 3)
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    assert.equal(await chatPage.evaluate(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Load newer messages')), false)
  } finally { await chatPage.close() }
})

test('continuous Chat displays pruned active contents after bounded Archive catch-up', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      window.fixtureTimelineView = 'detailed'
      window.fixtureHistoryMode = 'continuous'
      window.renderFixtureChats()
      window.fixtureDelayArchive = true
      const original = { role: 'tool', parts: [{ functionResponse: { id: 'archive-tool', name: 'exec', response: { result: 'FullOriginalArchiveResult' } } }], __meta: { seq: 601, timestamp: 1700000000601 } }
      window.fixtureArchive.push(original)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => {
      const pruned = structuredClone(window.fixtureArchive.at(-1))
      pruned.parts[0].functionResponse.response.result = 'PrunedActiveSnapshotResult'
      window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary before the tool result' }], __meta: { contextBlock: { id: 2, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 600 } } }, pruned], 2, { latestSeq: 601 })
    })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'PrunedActiveSnapshotResult')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '0/0')
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-601"]'), null)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
    await chatPage.click('[aria-label="Search messages"]', { clickCount: 3 })
    await chatPage.type('[aria-label="Search messages"]', 'PrunedActiveSnapshotResult')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    assert.equal(await chatPage.evaluate(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('FullOriginalArchiveResult')), false)
  } finally { await chatPage.close() }
})


async function readOlderContinuousPosition(chatPage) {
  await loadContinuousEarlier(chatPage)
  await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
  await loadContinuousEarlier(chatPage)
  await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
  await chatPage.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    container.scrollTop = 900
    container.dispatchEvent(new Event('scroll'))
  })
  await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return readingAnchor(chatPage)
}

async function waitForReadingPosition(chatPage, expected) {
  await chatPage.waitForFunction(expected => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const anchor = [...container.querySelectorAll('[data-chat-message-anchor-key]')].find(element => element.getBoundingClientRect().bottom > container.getBoundingClientRect().top)
    return anchor?.getAttribute('data-chat-message-anchor-key') === expected.key
      && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
  }, {}, expected)
}

test('continuous Chat keeps its older window when active history returns to bottom', async () => {
  const chatPage = await openContinuousChat()
  try {
    const before = await readOlderContinuousPosition(chatPage)
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.fixtureHistoryMode = 'active'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]').textContent.includes('Generated summary'))
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
      container.scrollTop = 20
      container.dispatchEvent(new Event('scroll'))
    })
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'conversation'; window.fixtureHistoryMode = 'continuous'; window.renderFixtureChats() })
    await waitForReadingPosition(chatPage, before)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})

test('continuous Chat remount locates an older saved row with two bounded pages', async () => {
  const chatPage = await openContinuousChat()
  try {
    const before = await readOlderContinuousPosition(chatPage)
    const requestsBefore = await chatPage.evaluate(() => window.fixtureArchiveRequests.length)
    await chatPage.evaluate(() => window.renderFixtureChats(1, 1))
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Generated summary' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 594 } } }, ...window.fixtureArchive.slice(-6)], 1, { latestSeq: 600 }))
    await waitForReadingPosition(chatPage, before)
    const requests = await chatPage.evaluate(() => window.fixtureArchiveRequests)
    const seq = Number(before.key.match(/-(\d+)$/)[1])
    assert.deepEqual(requests.slice(requestsBefore).map(url => new URL(url, 'http://fixture').search), [`?beforeSeq=${seq + 1}`, `?afterSeq=${seq}`])
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
  } finally { await chatPage.close() }
})

test('continuous Chat retains live commits racing the final later page and accepts subsequent commits', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      for (let seq = 601; seq <= 800; seq++) window.fixtureArchive.push({ role: seq % 2 ? 'user' : 'model', parts: [{ text: 'Offline original ' + seq }], __meta: { seq, timestamp: 1700000000000 + seq } })
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 2, historyVersion: 2, modelKey: 'fixture/model' } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary after offline work' }], __meta: { contextBlock: { id: 2, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 799 } } }, window.fixtureArchive.at(-1)], 2, { latestSeq: 800 }))
    await chatPage.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === 'Load newer messages'))
    await chatPage.evaluate(() => {
      window.fixtureDelayArchive = true
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Load newer messages').click()
    })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Racing canonical 801' }], __meta: { seq: 801, timestamp: 1700000000801 } }
      window.fixtureArchive.push(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 3, historyVersion: 2, modelKey: 'fixture/model' } })
      window.emitFixtureMessage(message)
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
    })
    await chatPage.waitForFunction(() => ![...document.querySelectorAll('button')].some(button => button.textContent === 'Load newer messages'))
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Subsequent canonical 802' }], __meta: { seq: 802, timestamp: 1700000000802 } }
      window.fixtureArchive.push(message)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, runtimeState: { state: 'idle' }, queueLength: 0, messageCount: 4, historyVersion: 2, modelKey: 'fixture/model' } })
      window.emitFixtureMessage(message)
    })
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Racing canonical 801')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    await chatPage.click('[aria-label="Search messages"]', { clickCount: 3 })
    await chatPage.type('[aria-label="Search messages"]', 'Subsequent canonical 802')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 3)
    assert.equal(await chatPage.evaluate(() => window.fixtureHistoryRequestCount), 2)
  } finally { await chatPage.close() }
})

test('continuous Chat remount mounts its saved window even when a live burst outgrows the recent tail', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
      const anchor = container.querySelector('[data-chat-message-anchor-key="seq-local-550"]')
      container.scrollTop += anchor.getBoundingClientRect().top - container.getBoundingClientRect().top + 29.5
      container.dispatchEvent(new Event('scroll'))
    })
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const before = await readingAnchor(chatPage)
    assert.equal(before.key, 'seq-local-550')
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true; window.renderFixtureChats(1, 1) })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2 && window.fixtureArchiveRequests.length === 3)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Generated summary' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 594 } } }, ...window.fixtureArchive.slice(-6)], 1, { latestSeq: 600 }))
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await chatPage.evaluate(() => {
      for (let seq = 601; seq <= 900; seq++) {
        const message = { role: 'model', parts: [{ text: 'Concurrent canonical ' + seq }], __meta: { seq, timestamp: 1700000000000 + seq } }
        window.fixtureArchive.push(message)
        window.emitFixtureMessage(message)
      }
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
      window.resolveFixtureArchive()
    })
    await waitForReadingPosition(chatPage, before)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})

async function observeNativeHistoryInput(chatPage) {
  await chatPage.evaluate(() => {
    window.fixtureNativeHistoryInput = []
    const container = document.querySelector('.foxwarm-chat-messages')
    for (const type of ['wheel', 'touchmove', 'scroll']) container.addEventListener(type, event => {
      window.fixtureNativeHistoryInput.push({ type, trusted: event.isTrusted, top: container.scrollTop })
    }, { passive: true })
  })
  const rect = await chatPage.$eval('.foxwarm-chat-messages', element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  })
  await chatPage.mouse.move(rect.x, rect.y)
  return rect
}

async function openContinuousTopEdge() {
  const chatPage = await openContinuousChat()
  await chatPage.waitForSelector('[aria-label="Scroll to top"]')
  await chatPage.click('[aria-label="Scroll to top"]')
  await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop === 0)
  await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  return chatPage
}

test('continuous Chat rechecks a rapid upward gesture that reaches the top during a slow page', async () => {
  const chatPage = await openContinuousChat()
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop === 0)
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.filter(event => event.type === 'wheel' && event.trusted).length >= 3)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2)
    const reading = await readingAnchor(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => !document.querySelector('[data-continuous-history]').textContent.includes('Loading messages'))
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]', { timeout: 5000 })
    const result = await chatPage.evaluate(() => ({
      top: document.querySelector('.foxwarm-chat-messages').scrollTop,
      first: document.querySelector('[data-chat-message-anchor-key]')?.getAttribute('data-chat-message-anchor-key'),
      requests: window.fixtureArchiveRequests.length,
      inputs: window.fixtureNativeHistoryInput,
    }))
    console.log('RAPID_TOP_PAGE', JSON.stringify(result))
    assert.equal(result.first, 'seq-local-401')
    assert.equal(result.requests, 2, 'completing one page must not drain Archive without another gesture')
    assert.ok(result.top > 0, 'earlier rows must become reachable without a downward gesture')
    await chatPage.waitForFunction(expected => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[data-chat-message-anchor-key="' + expected.key + '"]')
      return anchor && Math.abs(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - expected.offset) < 3
    }, { timeout: 5000 }, reading)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    assert.equal(await chatPage.evaluate(() => new URL(window.fixtureArchiveRequests[2], location.href).searchParams.get('beforeSeq')), '401')
  } finally { await chatPage.close() }
})

test('continuous Chat accepts an upward wheel at the top without a native scroll event', async () => {
  const chatPage = await openContinuousTopEdge()
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.some(event => event.type === 'wheel' && event.trusted))
    const result = await chatPage.evaluate(() => ({ requests: window.fixtureArchiveRequests.length, inputs: window.fixtureNativeHistoryInput }))
    console.log('CLAMPED_TOP_WHEEL', JSON.stringify(result))
    assert.equal(result.inputs.filter(event => event.type === 'scroll').length, 0)
    assert.equal(result.requests, 2)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
  } finally { await chatPage.close() }
})

test('continuous Chat accepts an upward-history touch gesture at the clamped top', async () => {
  const chatPage = await openContinuousTopEdge()
  try {
    const rect = await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    const client = await chatPage.createCDPSession()
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y - 100 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: rect.x, y: rect.y + 80 }] })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.some(event => event.type === 'touchmove' && event.trusted))
    const result = await chatPage.evaluate(() => ({ requests: window.fixtureArchiveRequests.length, inputs: window.fixtureNativeHistoryInput }))
    console.log('CLAMPED_TOP_TOUCH', JSON.stringify(result))
    assert.equal(result.inputs.filter(event => event.type === 'scroll').length, 0)
    assert.equal(result.requests, 2)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await client.detach()
  } finally { await chatPage.close() }
})

test('continuous Chat keeps top-edge failures explicit and retries without a reverse gesture', async () => {
  const chatPage = await openContinuousTopEdge()
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true; window.fixtureFailArchive = true })
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.evaluate(() => window.resolveFixtureArchive())
    await chatPage.waitForFunction(() => document.querySelector('[data-continuous-history]').textContent.includes('Messages could not be loaded'))
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.filter(event => event.type === 'wheel' && event.trusted).length >= 3)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2, 'an upward gesture must not silently retry an error')
    await chatPage.click('[data-continuous-history] button')
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    const rect = await chatPage.$eval('.foxwarm-chat-messages', element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })
    await chatPage.mouse.move(rect.x, rect.y)
    await chatPage.mouse.wheel({ deltaY: -800 })
    await chatPage.evaluate(() => {
      const message = { role: 'model', parts: [{ text: 'Canonical live input during top-edge retry' }], __meta: { seq: 601, timestamp: 1700000000601 } }
      window.fixtureArchive.push(message)
      window.emitFixtureMessage(message)
      window.fixtureDelayArchive = false
      window.resolveFixtureArchive()
    })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 3)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-601"]')
  } finally { await chatPage.close() }
})

async function sampleHistoryFrames(chatPage, key, attribute = 'data-chat-message-anchor-key') {
  await chatPage.evaluate(({ key, attribute }) => {
    window.fixtureHistoryFrames = []
    const sample = () => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const anchor = container.querySelector('[' + attribute + '="' + key + '"]')
      window.fixtureHistoryFrames.push({ top: container.scrollTop, height: container.scrollHeight,
        offset: anchor ? anchor.getBoundingClientRect().top - container.getBoundingClientRect().top : null,
        first: container.querySelector('[data-chat-message-anchor-key]')?.getAttribute('data-chat-message-anchor-key') })
      if (window.fixtureHistoryFrames.length < 26) requestAnimationFrame(sample)
    }
    sample()
  }, { key, attribute })
}

async function wheelHistoryTo(chatPage, top) {
  const rect = await chatPage.$eval('.foxwarm-chat-messages', element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, top: element.scrollTop }
  })
  await chatPage.mouse.move(rect.x, rect.y)
  await chatPage.mouse.wheel({ deltaY: top - rect.top })
  await chatPage.waitForFunction(top => Math.abs(document.querySelector('.foxwarm-chat-messages').scrollTop - top) < 2, {}, top)
}

test('continuous Chat requests history within 500px and mounts a slow reply at the current reading point without more input', async () => {
  const chatPage = await openContinuousChat('&variedHistory=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await wheelHistoryTo(chatPage, 400)
    await chatPage.waitForFunction(() => window.fixtureNativeHistoryInput.some(event => event.type === 'wheel' && event.trusted))
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2, 'request while still hundreds of pixels above the boundary')
    await chatPage.mouse.wheel({ deltaY: 70 })
    await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop > 450)
    const reading = await readingAnchor(chatPage)
    const protectedSurfaces = await protectedHistorySurfaces(chatPage)
    await sampleHistoryFrames(chatPage, reading.key)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    await assertProtectedHistorySurfaces(chatPage, protectedSurfaces)
    console.log('SLOW_HISTORY_CURRENT_READER_FRAMES', JSON.stringify(frames))
    assert.ok(frames.some(frame => frame.first === 'seq-local-401'), 'a successful page mounts even after the reader changed direction and stopped')
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - reading.offset) < 3), 'every sampled paint retains the current reading point, not the request-time point')
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), 2)
  } finally { await chatPage.close() }
})

test('continuous Chat retains a visible outcome across Conversation process merging and window replacement in every frame', async () => {
  const chatPage = await openContinuousChat('&denseProcess=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.evaluate(() => window.resolveFixtureArchive())
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    await sampleHistoryFrames(chatPage, 'seq-local-600')
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    console.log('MERGED_PROCESS_REPLACEMENT_FRAMES', JSON.stringify(frames))
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - frames[0].offset) < 3), 'the visible outcome cannot disappear or jump during a folded process replacement')
    assert.ok(frames.some(frame => frame.first === 'seq-local-301'))
  } finally { await chatPage.close() }
})

test('continuous Chat replaces variable-height windows without a displaced frame', async () => {
  const chatPage = await openContinuousChat('&variedHistory=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await wheelHistoryTo(chatPage, 400)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.evaluate(() => window.resolveFixtureArchive())
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await wheelHistoryTo(chatPage, 400)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 3)
    await chatPage.mouse.wheel({ deltaY: 70 })
    await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').scrollTop > 450)
    const reading = await readingAnchor(chatPage)
    const protectedSurfaces = await protectedHistorySurfaces(chatPage)
    await sampleHistoryFrames(chatPage, reading.key)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    await assertProtectedHistorySurfaces(chatPage, protectedSurfaces)
    console.log('VARIABLE_HEIGHT_REPLACEMENT_FRAMES', JSON.stringify(frames))
    assert.ok(frames.some(frame => frame.first === 'seq-local-301'))
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - reading.offset) < 3))
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200))
  } finally { await chatPage.close() }
})

test('continuous Chat retains an opened process and its reading point when a slow earlier page joins it', async () => {
  const chatPage = await openContinuousChat('&denseProcess=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.click('[aria-label="Expand activity"]')
    await chatPage.waitForFunction(() => {
      const activity = document.querySelector('[data-timeline-activity]')
      return activity?.dataset.activityExpanded === 'true' && !activity.style.height
    })
    await chatPage.waitForSelector('[data-search-row="seq-local-502"]')
    await chatPage.click('[data-search-row="seq-local-502"] [aria-label="Expand exec tool"]')
    await chatPage.waitForSelector('[data-search-row="seq-local-502"] .foxwarm-tool-call-args')
    await chatPage.waitForFunction(() => [...document.querySelectorAll('[data-activity-details] [style]')].every(element => !element.style.transition.includes('height')))
    await sampleHistoryFrames(chatPage, 'seq-local-502', 'data-search-row')
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    console.log('OPEN_PROCESS_RESPONSE_FRAMES', JSON.stringify(frames))
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - frames[0].offset) < 3))
    assert.equal(await chatPage.$eval('[data-timeline-activity]', node => node.dataset.activityExpanded), 'true')
    assert.ok(await chatPage.$('[data-search-row="seq-local-502"] .foxwarm-tool-call-args'), 'the reader’s nested tool disclosure stays open')
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'detailed'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => !document.querySelector('[data-timeline-activity]'))
    await chatPage.evaluate(() => { window.fixtureTimelineView = 'conversation'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => document.querySelector('[data-timeline-activity]')?.dataset.activityExpanded === 'true')
  } finally { await chatPage.close() }
})

test('continuous Chat keeps loaded Search navigation authoritative after extending a folded process window', async () => {
  const chatPage = await openContinuousChat('&denseProcess=1')
  try {
    await observeNativeHistoryInput(chatPage)
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.mouse.wheel({ deltaY: -100000 })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
    for (const seq of [201, 101]) {
      await chatPage.mouse.wheel({ deltaY: -100000 })
      await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-' + seq + '"]')
    }
    await chatPage.evaluate(() => { window.fixtureHistoryMode = 'continuous'; window.fixtureTimelineView = 'detailed'; window.renderFixtureChats() })
    await chatPage.waitForFunction(() => !document.querySelector('[data-timeline-activity]'))
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
    await chatPage.mouse.wheel({ deltaY: -100 })
    await chatPage.waitForSelector('[aria-label="Scroll to bottom"]')
    const requests = await chatPage.evaluate(() => window.fixtureArchiveRequests.length)
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Earlier process checkpoint 102')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    await chatPage.keyboard.press('Enter')
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const row = container.querySelector('[data-search-row="seq-local-102"]')
      if (!row) return false
      return row.getBoundingClientRect().bottom > container.getBoundingClientRect().top && row.getBoundingClientRect().top < container.getBoundingClientRect().bottom
    }), true)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), requests)
  } finally { await chatPage.close() }
})


async function protectedHistorySurfaces(chatPage) {
  return chatPage.evaluate(() => {
    const container = document.querySelector('.foxwarm-chat-messages')
    const viewport = container.getBoundingClientRect()
    return [...container.querySelectorAll('[data-chat-history-start-key], [data-chat-message-anchor-key]')].flatMap(element => {
      const rect = element.getBoundingClientRect()
      if (rect.bottom <= viewport.top - 500 || rect.top >= viewport.bottom + 500) return []
      const seq = key => Number(key?.replace('seq-local-', ''))
      const startKey = element.dataset.chatHistoryStartKey || element.dataset.chatMessageAnchorKey
      return [{
        activity: element.hasAttribute('data-timeline-activity'),
        start: seq(startKey),
        end: seq(element.dataset.chatHistoryEndKey || startKey),
        top: rect.top - viewport.top,
        bottom: rect.bottom - viewport.top,
      }]
    })
  })
}

async function assertProtectedHistorySurfaces(chatPage, surfaces, tolerance = 3) {
  const after = await protectedHistorySurfaces(chatPage)
  for (const before of surfaces) {
    const retained = after.find(surface => surface.activity === before.activity && surface.start <= before.start && surface.end >= before.end)
    assert.ok(retained, 'retains protected sources ' + JSON.stringify(before) + ' in ' + JSON.stringify(after))
    assert.ok(Math.abs(retained.top - before.top) < tolerance && Math.abs(retained.bottom - before.bottom) < tolerance,
      'no protected surface jump: ' + JSON.stringify({ before, retained }))
  }
}

test('continuous Chat protects folded processes 500px above and below the viewport while advancing either direction', async () => {
  const chatPage = await openContinuousChat('&bufferedProcesses=1')
  try {
    await observeNativeHistoryInput(chatPage)
    for (const first of [401, 301, 201, 101, 1]) {
      await chatPage.mouse.wheel({ deltaY: -100000 })
      await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-' + first + '"]')
    }
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'Buffered process outcome 250')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    await chatPage.keyboard.press('Enter')
    await chatPage.click('[aria-label="Close search"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-230"]')
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      const process = [...container.querySelectorAll('[data-timeline-activity]')].at(-1)
      container.scrollTop += process.getBoundingClientRect().top - container.getBoundingClientRect().bottom - 240
    })
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const before = await protectedHistorySurfaces(chatPage)
    const viewportHeight = await chatPage.$eval('.foxwarm-chat-messages', element => element.clientHeight)
    assert.ok(before.some(surface => surface.end === 250 && surface.bottom < 0 && surface.bottom > -500), JSON.stringify(before))
    assert.ok(before.some(surface => surface.start === 252 && surface.top > viewportHeight && surface.top < viewportHeight + 500), JSON.stringify(before))
    const requests = await chatPage.evaluate(() => window.fixtureArchiveRequests.length)
    await observeNativeHistoryInput(chatPage)
    await sampleHistoryFrames(chatPage, 'seq-local-251')
    await chatPage.mouse.wheel({ deltaY: 1 })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-500"]', { timeout: 5000 })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    let frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - frames[0].offset) < 3), JSON.stringify(frames))
    await assertProtectedHistorySurfaces(chatPage, before)
    assert.equal(await chatPage.evaluate(() => window.fixtureArchiveRequests.length), requests, 'advances cached rows, not Archive requests')
    if (process.env.FOXWARM_E2E_SCREENSHOT_DIR) await chatPage.screenshot({ path: join(process.env.FOXWARM_E2E_SCREENSHOT_DIR, 'conversation-buffer-later.png') })
    const later = await protectedHistorySurfaces(chatPage)
    await sampleHistoryFrames(chatPage, 'seq-local-251')
    await chatPage.mouse.wheel({ deltaY: -1 })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-130"]', { timeout: 5000 })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - frames[0].offset) < 3), JSON.stringify(frames))
    await assertProtectedHistorySurfaces(chatPage, later)
    if (process.env.FOXWARM_E2E_SCREENSHOT_DIR) await chatPage.screenshot({ path: join(process.env.FOXWARM_E2E_SCREENSHOT_DIR, 'conversation-buffer-earlier.png') })
  } finally { await chatPage.close() }
})

test('continuous Chat advances cached ordinary messages within 500px of the bottom and preserves both buffers', async () => {
  const chatPage = await openContinuousChat('&variedHistory=1')
  try {
    await observeNativeHistoryInput(chatPage)
    for (const first of [401, 301]) {
      await chatPage.mouse.wheel({ deltaY: -100000 })
      await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-' + first + '"]')
    }
    const beforeNavigation = await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.scrollTop = container.scrollHeight - container.clientHeight - 350
      return container.scrollTop
    })
    await chatPage.waitForFunction(top => Math.abs(document.querySelector('.foxwarm-chat-messages').scrollTop - top) < 2, {}, beforeNavigation)
    await chatPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const before = await protectedHistorySurfaces(chatPage)
    const first = await chatPage.$eval('[data-chat-message-anchor-key]', node => node.dataset.chatMessageAnchorKey)
    await chatPage.mouse.wheel({ deltaY: 1 })
    await chatPage.waitForFunction(first => document.querySelector('[data-chat-message-anchor-key]')?.dataset.chatMessageAnchorKey !== first, { timeout: 5000 }, first)
    await assertProtectedHistorySurfaces(chatPage, before)
    assert.ok(await chatPage.$$eval('[data-chat-message-anchor-key]', nodes => nodes.length <= 200), 'ordinary rows retain a bounded display window')
    if (process.env.FOXWARM_E2E_SCREENSHOT_DIR) await chatPage.screenshot({ path: join(process.env.FOXWARM_E2E_SCREENSHOT_DIR, 'conversation-buffer-ordinary.png') })
  } finally { await chatPage.close() }
})


test('continuous Chat protects later body parts when their sole message anchor is outside the 500px buffer', async () => {
  const chatPage = await openContinuousChat('&multiPartHistory=1')
  try {
    await observeNativeHistoryInput(chatPage)
    for (const first of [401, 301]) {
      await chatPage.mouse.wheel({ deltaY: -100000 })
      await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-' + first + '"]')
    }
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await wheelHistoryTo(chatPage, 400)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 4)
    await chatPage.click('[aria-label="Find in chat"]')
    await chatPage.type('[aria-label="Search messages"]', 'MULTIPART_READER')
    await chatPage.waitForFunction(() => document.querySelector('[role="search"] [aria-live]')?.textContent === '1/1')
    await chatPage.keyboard.press('Enter')
    await chatPage.click('[aria-label="Close search"]')
    await observeNativeHistoryInput(chatPage)
    await chatPage.mouse.wheel({ deltaY: 900 })
    await chatPage.waitForFunction(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      return container.querySelector('[data-chat-message-anchor-key="seq-local-500"]').getBoundingClientRect().bottom < container.getBoundingClientRect().top - 500
    })
    const before = await protectedHistorySurfaces(chatPage)
    assert.ok(before.some(surface => surface.start === 500), JSON.stringify(before))
    await sampleHistoryFrames(chatPage, 'seq-local-500-part-1', 'data-search-row')
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForFunction(() => window.fixtureHistoryFrames.length === 26)
    const frames = await chatPage.evaluate(() => window.fixtureHistoryFrames)
    assert.ok(frames.every(frame => frame.offset !== null && Math.abs(frame.offset - frames[0].offset) < 3), JSON.stringify(frames))
    await assertProtectedHistorySurfaces(chatPage, before)
  } finally { await chatPage.close() }
})


test('continuous Chat excludes deleted active rows from an in-flight older page and a fresh remount', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => { window.fixtureDelayArchive = true })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.evaluate(() => window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, queueLength: 0, messageCount: 6, historyVersion: 2 } }))
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 594 } } }, ...window.fixtureArchive.slice(-6, -1)], 2, { latestSeq: 600 }))
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.click('[aria-label="Scroll to bottom"]')
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-599"]')
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
    await chatPage.evaluate(() => window.renderFixtureChats(1, 1))
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 3)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 594 } } }, ...window.fixtureArchive.slice(-6, -1)], 2, { latestSeq: 600 }))
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-599"]')
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
  } finally { await chatPage.close() }
})

test('continuous Chat resolves nested CTX members without resurrecting gaps in their envelopes', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      const block = (id, start, end, level = 1) => ({ role: 'model', parts: [{ text: 'Summary' }], __meta: { contextBlock: { id, level, sourceKind: level === 1 ? 'message' : 'block', rawStartSeq: start, rawEndSeq: end } } })
      window.fixtureBlockExpansions[20] = [block(21, 1, 590), block(22, 592, 598, 2)]
      window.fixtureBlockExpansions[22] = [block(23, 592, 594), block(24, 596, 598)]
      window.fixtureHigherBlock = block(20, 1, 598, 3)
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, queueLength: 0, messageCount: 3, historyVersion: 2 } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [window.fixtureHigherBlock, ...window.fixtureArchive.slice(-2)], 2, { latestSeq: 600 }))
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-598"]')
    await chatPage.waitForFunction(() => window.fixtureRequests.some(url => url.includes('/context-blocks/22/expand')))
    await chatPage.waitForFunction(() => !document.querySelector('[data-chat-message-anchor-key="seq-local-595"]'))
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-591"]'), null)
    assert.ok(await chatPage.$('[data-chat-message-anchor-key="seq-local-594"]'))
    assert.ok(await chatPage.$('[data-chat-message-anchor-key="seq-local-596"]'))
    assert.equal(await chatPage.evaluate(() => window.fixtureRequests.some(url => /context-blocks\/(21|23|24)\//.test(url))), false, 'leaf originals still use bounded Archive pages')
  } finally { await chatPage.close() }
})


test('continuous Chat waits for complete active authority and retries a failed bootstrap prefix', async () => {
  const chatPage = await browser.newPage()
  try {
    await chatPage.goto(fixtureUrl + '?continuous=1', { waitUntil: 'load' })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, window.fixtureArchive.slice(-100), 1, { latestSeq: 600, prefixLength: 1, historyComplete: false, messageCount: 101 }))
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-600"]'), null)
    await chatPage.evaluate(() => window.rejectFixtureHistory(503))
    await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('Earlier messages could not be loaded.'))
    await chatPage.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Retry').click())
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 3)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Summary' }], __meta: { contextBlock: { id: 1, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 500 } } }, ...window.fixtureArchive.slice(-100)], 1, { latestSeq: 600 }))
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
    assert.equal(await chatPage.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('Earlier messages could not be loaded.')), false)
  } finally { await chatPage.close() }
})

test('continuous Chat leaves unresolved higher CTX hidden and retries its membership failure explicitly', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      window.fixtureFailBlocks = true
      window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, queueLength: 0, messageCount: 2, historyVersion: 2 } })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Higher summary' }], __meta: { contextBlock: { id: 2, level: 2, sourceKind: 'block', rawStartSeq: 1, rawEndSeq: 599 } } }, window.fixtureArchive.at(-1)], 2, { latestSeq: 600 }))
    await chatPage.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('Earlier messages could not be loaded.'))
    assert.equal(await chatPage.$('[data-chat-message-anchor-key="seq-local-599"]'), null, 'unknown membership is not replaced by its envelope')
    assert.equal(await chatPage.evaluate(() => window.fixtureRequests.filter(url => url.includes('/context-blocks/2/expand')).length), 1, 'failure waits for explicit Retry')
    await chatPage.evaluate(() => { window.fixtureFailBlocks = false; [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Retry').click() })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 3)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [{ role: 'model', parts: [{ text: 'Higher summary' }], __meta: { contextBlock: { id: 2, level: 2, sourceKind: 'block', rawStartSeq: 1, rawEndSeq: 599 } } }, window.fixtureArchive.at(-1)], 2, { latestSeq: 600 }))
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-599"]')
    assert.equal(await chatPage.evaluate(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('Earlier messages could not be loaded.')), false)
  } finally { await chatPage.close() }
})


test('continuous Chat loads an active-only tail without traversing historical CTX and resolves only paged candidates', async t => {
  const chatPage = await browser.newPage()
  try {
    await chatPage.goto(fixtureUrl + '?continuous=1', { waitUntil: 'load' })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 1)
    await chatPage.evaluate(() => {
      const block = (id, start, end, level, children = []) => ({ role: 'model', parts: [{ text: 'Historical summary' }], __meta: { contextBlock: {
        id, level, sourceKind: level === 1 ? 'message' : 'block', rawStartSeq: start, rawEndSeq: end,
        ...(children.length ? { sourceStart: children[0].__meta.contextBlock.id, sourceEnd: children.at(-1).__meta.contextBlock.id, sourceBlockIds: children.map(child => child.__meta.contextBlock.id) } : { sourceStart: start, sourceEnd: end }),
      } } })
      const roots = []
      let seq = 1
      let childIndex = 0
      for (let index = 0; index < 58; index++) {
        const start = seq
        const children = []
        for (let child = 0; child < (index < 44 ? 7 : 6); child++) {
          const leaf = block(3000 + childIndex, seq, seq, 1)
          const parent = block(2000 + childIndex, seq, seq, 2, [leaf])
          window.fixtureBlockExpansions[parent.__meta.contextBlock.id] = [leaf]
          children.push(parent)
          childIndex += 1
          seq += 1
        }
        const root = block(1000 + index, start, seq - 1, 3, children)
        window.fixtureBlockExpansions[root.__meta.contextBlock.id] = children
        roots.push(root)
      }
      for (let index = 0; index < 19; index++) roots.push(block(1100 + index, 393 + Math.floor(index * 108 / 19), 392 + Math.floor((index + 1) * 108 / 19), 1))
      window.fixtureManyRoots = roots
      window.fixtureFailBlocks = true
      window.resolveFixtureHistory(0, window.fixtureArchive.slice(-100), 1, { latestSeq: 600, prefixLength: 77, historyComplete: false, messageCount: 177 })
    })
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, window.fixtureManyRoots, 1, { latestSeq: 600 }))
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-600"]')
    const normalLoad = await chatPage.evaluate(() => ({
      roots: window.fixtureManyRoots.length,
      nonLeafRoots: window.fixtureManyRoots.filter(message => message.__meta.contextBlock.sourceKind === 'block').length,
      reachableNonLeaf: Object.keys(window.fixtureBlockExpansions).length,
      blockRequests: window.fixtureRequests.filter(url => url.includes('/context-blocks/')).length,
      archiveRequests: window.fixtureArchiveRequests.length,
      error: document.querySelector('.foxwarm-chat-root').textContent.includes('Earlier messages could not be loaded.'),
    }))
    assert.deepEqual(normalLoad, { roots: 77, nonLeafRoots: 58, reachableNonLeaf: 450, blockRequests: 0, archiveRequests: 1, error: false })
    await chatPage.evaluate(() => { window.fixtureFailBlocks = false })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    assert.equal(await chatPage.evaluate(() => window.fixtureRequests.filter(url => url.includes('/context-blocks/')).length), 0, 'message-backed older ranges need no non-leaf reads')
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-301"]')
    const paged = await chatPage.evaluate(() => {
      const expected = []
      for (const root of window.fixtureManyRoots) {
        const block = root.__meta.contextBlock
        if (block.sourceKind !== 'block' || block.rawEndSeq < 301 || block.rawStartSeq > 400) continue
        expected.push(block.id)
        for (const child of window.fixtureBlockExpansions[block.id]) {
          const childBlock = child.__meta.contextBlock
          if (childBlock.rawEndSeq >= 301 && childBlock.rawStartSeq <= 400) expected.push(childBlock.id)
        }
      }
      return { expected: expected.sort((a, b) => a - b), actual: window.fixtureRequests.filter(url => url.includes('/context-blocks/')).map(url => Number(url.match(/context-blocks\/(\d+)/)[1])).sort((a, b) => a - b) }
    })
    t.diagnostic(JSON.stringify({ normalLoad, historicalPageBlockRequests: paged.actual.length }))
    assert.equal(paged.expected.length, 108)
    assert.deepEqual(paged.actual, paged.expected, 'only the 16 intersecting roots and 92 candidate child branches are read, once each')
  } finally { await chatPage.close() }
})


test('continuous Chat includes a racing older page before publishing compacted membership', async () => {
  const chatPage = await openContinuousChat()
  try {
    await chatPage.evaluate(() => {
      const block = (id, start, end, level = 1) => ({ role: 'model', parts: [{ text: 'Summary' }], __meta: { contextBlock: { id, level, sourceKind: level === 1 ? 'message' : 'block', rawStartSeq: start, rawEndSeq: end } } })
      window.fixtureDelayArchive = true
      window.fixtureDelayBlockIds = [21, 22]
      window.fixtureBlockExpansions[20] = [block(21, 1, 500, 2), block(22, 501, 600, 2)]
      window.fixtureBlockExpansions[21] = [block(23, 1, 500)]
      window.fixtureBlockExpansions[22] = [block(24, 501, 600)]
      window.fixtureCompactedRoot = block(20, 1, 600, 3)
    })
    await loadContinuousEarlier(chatPage)
    await chatPage.waitForFunction(() => window.fixtureArchiveRequests.length === 2)
    await chatPage.evaluate(() => window.emitFixtureEvent({ type: 'session-state', session: { id: 'fixture/main', busy: false, queueLength: 0, messageCount: 1, historyVersion: 2 } }))
    await chatPage.waitForFunction(() => window.fixtureHistoryRequestCount === 2)
    await chatPage.evaluate(() => window.resolveFixtureHistory(0, [window.fixtureCompactedRoot], 2, { latestSeq: 600 }))
    await chatPage.waitForFunction(() => !!window.fixtureDelayedBlocks[22])
    await chatPage.evaluate(() => { window.fixtureDelayArchive = false; window.resolveFixtureArchive() })
    await chatPage.waitForSelector('[data-chat-message-anchor-key="seq-local-401"]')
    await chatPage.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.scrollTop = 900
      container.dispatchEvent(new Event('scroll'))
    })
    const before = await readingAnchor(chatPage)
    await chatPage.evaluate(() => window.resolveFixtureBlock(22))
    await chatPage.waitForFunction(() => !!window.fixtureDelayedBlocks[21])
    await waitForReadingPosition(chatPage, before)
    assert.ok(await chatPage.$('[data-chat-message-anchor-key="seq-local-401"]'), 'older page remains represented while its new branch is unresolved')
    await chatPage.evaluate(() => { window.fixtureDelayBlockIds = []; window.resolveFixtureBlock(21) })
    await chatPage.waitForFunction(() => !document.querySelector('[data-continuous-history]')?.textContent.includes('Loading'))
    await waitForReadingPosition(chatPage, before)
    assert.ok(await chatPage.$('[data-chat-message-anchor-key="seq-local-401"]'))
    assert.deepEqual(await chatPage.evaluate(() => window.fixtureRequests.filter(url => url.includes('/context-blocks/')).map(url => Number(url.match(/context-blocks\/(\d+)/)[1]))), [20, 22, 21])
  } finally { await chatPage.close() }
})
