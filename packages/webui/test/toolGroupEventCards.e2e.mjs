import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const call = (id, seq) => ({ role: 'model', parts: [{ functionCall: { id, name: 'exec', args: { command: `echo ${id}` } } }], __meta: { seq } })
const result = (id, seq) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'exec', response: { output: `RESULT ${id}` } } }], __meta: { seq } })
const event = (id, seq, field = 'system') => ({
  role: 'user', parts: [{ [field]: `<foxwarm-system kind="event" type="${id}">\nEVENT BODY ${id}\n</foxwarm-system>` }], __meta: { seq },
})
const direct = (text, seq) => ({ role: 'user', parts: [{ text }], __meta: { seq } })
const final = (seq) => ({ role: 'model', parts: [{ text: 'FINAL ANSWER' }], __meta: { seq } })

const EVENTS_BETWEEN_TOOLS = [
  call('one', 1), event('one', 2), result('one', 3), event('two', 4, 'text'), call('two', 5), result('two', 6), final(7),
]
const CASES = {
  collapsed: { messages: EVENTS_BETWEEN_TOOLS, groupTools: true },
  ungrouped: { messages: EVENTS_BETWEEN_TOOLS, groupTools: false },
  tail: { messages: [call('tail', 11), event('tail-first', 12), result('tail', 13), event('tail-last', 14, 'text')], groupTools: true },
  standalone: { messages: [event('outside', 20, 'text'), call('standalone', 21), result('standalone', 22), final(23)], groupTools: true },
  noTools: { messages: [event('alone', 30), event('still-alone', 31, 'text')], groupTools: true },
  direct: { messages: [call('before', 40), result('before', 41), direct('Please explain the text <foxwarm-system kind="event" type="quote"> inside this message.', 42), call('after', 43), result('after', 44), final(45)], groupTools: true },
  external: { messages: [call('external-before', 50), result('external-before', 51), { role: 'user', parts: [{ system: '<foxwarm-system kind="external-input" />' }, { text: 'actual external user input' }], __meta: { seq: 52 } }, call('external-after', 53), result('external-after', 54), final(55)], groupTools: true },
  otherKind: { messages: [call('other-before', 60), result('other-before', 61), { role: 'user', parts: [{ system: '<foxwarm-system kind="goal-reminder">\nRemember the goal.\n</foxwarm-system>' }], __meta: { seq: 62 } }, call('other-after', 63), result('other-after', 64), final(65)], groupTools: true },
  userBoundary: { messages: [call('boundary', 70), result('boundary', 71), event('before-user', 72), direct('NEW USER INPUT', 73), final(74)], groupTools: true },
}

let browser, page, server

before(async () => {
  const fixture = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    const cases = ${JSON.stringify(CASES)}
    const roots = {}
    for (const [name, { messages, groupTools }] of Object.entries(cases)) {
      roots[name] = createRoot(document.getElementById(name))
      roots[name].render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main', messages, isMobile: false, groupTools, showUsageBadge: false,
      }))
    }
    window.moveTailToHistory = () => roots.tail.render(React.createElement(ChatTimeline, {
      sessionId: 'fixture/main', messages: [...cases.tail.messages, { role: 'model', parts: [{ text: 'NEW ANSWER' }], __meta: { seq: 15 } }], isMobile: false, groupTools: true, showUsageBadge: false,
    }))
  `
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'tool-group-event-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body>${Object.keys(CASES).map(name => `<div id="${name}"></div>`).join('')}<script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
  await page.waitForSelector('#collapsed [aria-label="Expand tool group"]')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

const snapshot = async (name) => page.$eval(`#${name}`, element => ({
  summaries: element.querySelectorAll('[aria-label="Expand tool group"]').length,
  summaryTags: [...element.querySelectorAll('.foxwarm-tool-card:has([aria-label="Expand tool group"]) [data-tool-tag-tone]')].map(tag => [tag.querySelector('span:last-child')?.textContent, tag.getAttribute('data-tool-tag-tone')]),
  eventCards: [...element.querySelectorAll('[data-system-message-kind="event"]')].map(card => card.textContent),
  toolCards: element.querySelectorAll('.foxwarm-tool-card:not(:has([aria-label="Expand tool group"]))').length,
  toolText: [...element.querySelectorAll('.foxwarm-tool-card:not(:has([aria-label="Expand tool group"]))')].map(card => card.textContent),
  rows: [...element.querySelectorAll('.foxwarm-chat-timeline [data-chat-message-anchor-key]')].map(row => row.getAttribute('data-chat-message-anchor-key')),
  fullText: element.textContent,
}))

test('event wrappers between tool calls collapse into counted tags; expanding restores complete cards and paired results in message order', async () => {
  const collapsed = await snapshot('collapsed')
  assert.deepEqual(collapsed.summaryTags, [['exec ×2', 'success'], ['Event ×2', 'system']])
  assert.equal(collapsed.summaries, 1)
  assert.equal(collapsed.eventCards.length, 0)
  assert.equal(collapsed.toolCards, 0)
  assert.ok(collapsed.fullText.includes('FINAL ANSWER'))
  await page.click('#collapsed [aria-label="Expand tool group"]')
  const expanded = await snapshot('collapsed')
  assert.equal(expanded.summaries, 0)
  assert.equal(expanded.eventCards.length, 2)
  assert.equal(expanded.toolCards, 2)
  assert.ok(expanded.toolText[0].includes('RESULT one'))
  assert.ok(expanded.toolText[1].includes('RESULT two'))
  assert.deepEqual(expanded.rows, ['seq-local-1', 'seq-local-2', 'seq-local-4', 'seq-local-5', 'seq-local-7'])
  assert.ok(expanded.eventCards[0].includes('EVENT BODY one'))
  assert.ok(expanded.eventCards[1].includes('EVENT BODY two'))
  await page.waitForFunction(() => !document.querySelector('#collapsed [data-tool-group]')?.style.height)
  await page.click('#collapsed [data-system-message-kind="event"] [aria-label="Expand event message"]')
  assert.equal(await page.$eval('#collapsed', el => !!el.querySelector('.foxwarm-system-message-body') && el.querySelector('.foxwarm-system-message-body').textContent.includes('EVENT BODY one')), true, JSON.stringify(await page.$eval('#collapsed', el => [...el.querySelectorAll('[data-system-message-kind=event] button')].map(b => [b.getAttribute('aria-label'), b.getAttribute('aria-expanded')]))))
})

test('a final tool run with a trailing event stays expanded, including a result separated from its call by an event', async () => {
  const tail = await snapshot('tail')
  assert.equal(tail.summaries, 0)
  assert.equal(tail.toolCards, 1)
  assert.equal(tail.eventCards.length, 2)
  assert.ok(tail.toolText[0].includes('RESULT tail'))
  assert.deepEqual(tail.rows, ['seq-local-11', 'seq-local-12', 'seq-local-14'])
})

test('Group tools off keeps individual paired tool cards and original event cards visible', async () => {
  const ungrouped = await snapshot('ungrouped')
  assert.equal(ungrouped.summaries, 0)
  assert.equal(ungrouped.toolCards, 2)
  assert.equal(ungrouped.eventCards.length, 2)
  assert.ok(ungrouped.toolText[0].includes('RESULT one'))
  assert.ok(ungrouped.toolText[1].includes('RESULT two'))
})

test('standalone events do not claim a following tool run or disappear without any tools', async () => {
  const outside = await snapshot('standalone')
  assert.equal(outside.eventCards.length, 1)
  assert.equal(outside.summaries, 1)
  assert.deepEqual(outside.summaryTags, [['exec ×1', 'success']])
  const alone = await snapshot('noTools')
  assert.equal(alone.eventCards.length, 2)
  assert.equal(alone.summaries, 0)
})

test('quoted event text, external input, other system kinds, and a new user turn stay visible and split tool runs', async () => {
  for (const [name, visibleText] of [
    ['direct', 'Please explain the text'], ['external', 'actual external user input'], ['otherKind', 'Remember the goal.'],
  ]) {
    const view = await snapshot(name)
    assert.equal(view.summaries, 2, name)
    assert.equal(view.eventCards.length, 0, name)
    assert.ok(view.fullText.includes(visibleText), name)
  }
  const boundary = await snapshot('userBoundary')
  assert.equal(boundary.summaries, 1)
  assert.deepEqual(boundary.summaryTags, [['exec ×1', 'success'], ['Event ×1', 'system']])
  assert.equal(boundary.eventCards.length, 0)
  assert.ok(boundary.fullText.includes('NEW USER INPUT'))
  assert.ok(boundary.fullText.includes('FINAL ANSWER'))
  assert.deepEqual(boundary.rows, ['seq-local-70', 'seq-local-73', 'seq-local-74'])
})


test('the final keep-expanded group has no collapse control, retains wrapper identity as it becomes history, and then follows ordinary grouping', async () => {
  const before = await page.$eval('#tail [data-tool-group]', node => {
    window.tailGroupNode = node
    return { key: node.dataset.toolGroup, expanded: node.dataset.toolGroupExpanded, groupControl: !!node.querySelector('.foxwarm-tool-group-collapse') }
  })
  assert.equal(before.expanded, 'true')
  assert.equal(before.groupControl, false)
  await page.evaluate(() => window.moveTailToHistory())
  await page.waitForSelector('#tail [aria-label="Expand tool group"]')
  assert.equal(await page.$eval('#tail [data-tool-group]', node => node === window.tailGroupNode), true, 'tail-to-history keeps the same group wrapper')
  assert.equal(await page.$eval('#tail [data-tool-group]', node => node.dataset.toolGroup), before.key)
  await page.click('#tail [aria-label="Expand tool group"]')
  await page.waitForSelector('#tail .foxwarm-tool-group-collapse')
  assert.equal(await page.$eval('#tail [data-tool-group]', node => node === window.tailGroupNode), true)
  await page.waitForFunction(() => !document.querySelector('#tail [data-tool-group]')?.style.height)
  await page.click('#tail .foxwarm-tool-group-collapse')
  await page.waitForSelector('#tail [aria-label="Expand tool group"]')
})
