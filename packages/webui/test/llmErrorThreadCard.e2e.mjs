import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname

const call = (id, seq) => ({ role: 'model', parts: [{ functionCall: { id, name: 'exec', args: { command: `echo ${id}` } } }], __meta: { seq } })
const result = (id, seq, response = { output: `${id} result` }) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'exec', response } }], __meta: { seq } })
const llmRetry = (text, seq) => ({ role: 'model', modelVisible: false, parts: [{ text }], __meta: { seq, noticeType: 'llm-retry' } })

const groupedMessages = [
  call('one', 1),
  llmRetry('⚠️ LLM Error: Attempt 1/5 failed: first line\nAttempt 2/5 failed: second line\n\nAttempt 3/5 failed: third line', 2),
  result('one', 3),
  call('two', 4),
  llmRetry('⚠️ LLM Error: Attempt 1/5 failed: one line', 5),
  result('two', 6),
  { role: 'model', parts: [{ text: 'ordinary answer' }], __meta: { seq: 7 } },
]

const tailMessages = [
  call('tail', 11),
  result('tail', 12),
  llmRetry('⚠️ LLM Error: Attempt 1/5 failed: tail error', 13),
]

const ungroupedMessages = [
  call('off', 21),
  llmRetry('⚠️ LLM Error: Attempt 1/5 failed: visible without grouping', 22),
  result('off', 23, { error: 'llm error: tool response text' }),
  { role: 'model', parts: [{ text: 'assistant quote: llm error: not a prefix' }], __meta: { seq: 24 } },
  { role: 'user', parts: [{ text: 'quoted content: llm error: not a prefix' }], __meta: { seq: 25 } },
]

const standaloneMessages = [llmRetry('⚠️ LLM Error: Attempt 1/5 failed: standalone', 31)]
const missingPrefixMessages = [llmRetry('Attempt 1/5 failed without warning prefix\nsecond line', 41)]
const ordinaryTextMessages = [{ role: 'model', parts: [{ text: 'ordinary assistant text mentions llm error but is not a retry notice' }], __meta: { seq: 51 } }]
const operationalEventMessages = [
  call('before-event', 61),
  result('before-event', 62),
  { role: 'model', modelVisible: false, parts: [{ text: 'Internal compaction diagnostic' }], __meta: { seq: 63, noticeType: 'system-event', sessionNotice: {
    version: 1, id: 'compaction-fixture', source: 'compaction', severity: 'error', title: 'Compaction failed', summary: 'No valid plan was produced.', details: 'Original compaction diagnostic',
  } } },
  call('after-event', 64),
  result('after-event', 65),
  { role: 'model', parts: [{ text: 'answer after event' }], __meta: { seq: 66 } },
]
const fixtureCases = { groupedMessages, tailMessages, ungroupedMessages, standaloneMessages, missingPrefixMessages, ordinaryTextMessages, operationalEventMessages }

let browser
let page
let server

before(async () => {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}

    const cases = ${JSON.stringify(fixtureCases)}
    for (const [id, messages] of Object.entries(cases)) {
      createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main',
        messages,
        isMobile: false,
        timelineView: id === 'ungroupedMessages' ? 'detailed' : 'grouped',
        showUsageBadge: false,
      }))
    }
  `
  const bundle = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'llm-error-thread-card-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body>${Object.keys(fixtureCases).map(id => `<div id="${id}"></div>`).join('')}<script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'load' })
  await page.waitForSelector('#groupedMessages [aria-label="Expand tool group"]')
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

const cardSnapshot = async selector => page.$eval(selector, card => ({
  title: card.getAttribute('aria-label'),
  severity: card.getAttribute('data-event-severity'),
  heading: card.querySelector('h3')?.textContent,
  details: card.querySelector('[data-event-details] pre')?.textContent,
  open: card.querySelector('[data-event-details]')?.open,
}))

const groupTags = async (id) => page.$$eval(`#${id} [data-tool-group-card] [data-tool-tag-tone]`, tags => tags.map(tag => [tag.querySelector('span:last-child')?.textContent, tag.getAttribute('data-tool-tag-tone')]))

test('typed LLM retry cards retain line-count tags, tool pairing and historical group disclosure', async () => {
  assert.deepEqual(await groupTags('groupedMessages'), [
    ['LLM error ×5', 'system'],
    ['exec ×2', 'neutral'],
  ])
  assert.equal(await page.$$('#groupedMessages [data-system-event]').then(nodes => nodes.length), 0, 'collapsed groups hide the member cards')
  assert.match(await page.$eval('#groupedMessages', root => root.textContent), /ordinary answer/)

  await page.click('#groupedMessages [aria-label="Expand tool group"]')
  await page.waitForSelector('#groupedMessages [data-tool-group-card] [data-system-event]')
  assert.equal(await page.$$eval('#groupedMessages [data-system-event]', nodes => nodes.length), 2)
  assert.equal(await page.$$eval('#groupedMessages [data-event-details]', nodes => nodes.every(node => !node.open)), true)
  await page.$$eval('#groupedMessages [data-event-details] summary', summaries => summaries.forEach(summary => summary.click()))
  const cards = await page.$$eval('#groupedMessages [data-system-event]', nodes => nodes.map(card => ({
    title: card.getAttribute('aria-label'),
    severity: card.getAttribute('data-event-severity'),
    details: card.querySelector('[data-event-details] pre')?.textContent,
    open: card.querySelector('[data-event-details]')?.open,
    insideGroup: !!card.closest('[data-tool-group-card]'),
  })))
  assert.deepEqual(cards, [
    { title: 'Request retry', severity: 'warning', details: '⚠️ LLM Error: Attempt 1/5 failed: first line\nAttempt 2/5 failed: second line\n\nAttempt 3/5 failed: third line', open: true, insideGroup: true },
    { title: 'Request retry', severity: 'warning', details: '⚠️ LLM Error: Attempt 1/5 failed: one line', open: true, insideGroup: true },
  ])
  const results = await page.$$eval('#groupedMessages .foxwarm-tool-card:not([data-tool-group-card])', cards => cards.map(card => card.textContent))
  assert.equal(results.length, 2, 'retry records do not break or duplicate paired tool cards')
  assert.match(results[0], /one result/)
  assert.match(results[1], /two result/)
  await page.click('#groupedMessages [aria-label="Collapse tool group"]')
  await page.waitForSelector('#groupedMessages [data-system-event]', { hidden: true })
  assert.equal(await page.$('#groupedMessages [data-system-event]'), null, 'explicit group collapse still hides retry cards')
})

test('Detailed keeps the typed retry card and tool error response separate', async () => {
  assert.deepEqual(await cardSnapshot('#ungroupedMessages [data-system-event]'), {
    title: 'Request retry',
    severity: 'warning',
    heading: 'Request retry: A model request attempt failed.',
    details: '⚠️ LLM Error: Attempt 1/5 failed: visible without grouping',
    open: false,
  })
  assert.equal(await page.$$('#ungroupedMessages [data-system-event]').then(nodes => nodes.length), 1)
  assert.equal(await page.$eval('#ungroupedMessages [data-system-event]', node => !!node.closest('[data-tool-group]')), false)
  assert.ok(await page.$eval('#ungroupedMessages', root => root.textContent.includes('llm error: tool response text')))
  assert.ok(await page.$eval('#ungroupedMessages', root => root.textContent.includes('assistant quote: llm error: not a prefix')))
  assert.ok(await page.$eval('#ungroupedMessages', root => root.textContent.includes('quoted content: llm error: not a prefix')))
})

test('tail retry events stay in the forced-open historical tool run', async () => {
  assert.deepEqual(await cardSnapshot('#tailMessages [data-system-event]'), {
    title: 'Request retry',
    severity: 'warning',
    heading: 'Request retry: A model request attempt failed.',
    details: '⚠️ LLM Error: Attempt 1/5 failed: tail error',
    open: false,
  })
  assert.equal(await page.$$('#tailMessages [aria-label="Expand tool group"]').then(nodes => nodes.length), 0)
  assert.equal(await page.$eval('#tailMessages [data-system-event]', node => !!node.closest('[data-tool-group]')), true)
})

test('standalone and missing-prefix retries retain complete diagnostics without classifying ordinary prose', async () => {
  assert.deepEqual(await cardSnapshot('#standaloneMessages [data-system-event]'), {
    title: 'Request retry',
    severity: 'warning',
    heading: 'Request retry: A model request attempt failed.',
    details: '⚠️ LLM Error: Attempt 1/5 failed: standalone',
    open: false,
  })
  assert.deepEqual(await cardSnapshot('#missingPrefixMessages [data-system-event]'), {
    title: 'Request retry',
    severity: 'warning',
    heading: 'Request retry: A model request attempt failed.',
    details: 'Attempt 1/5 failed without warning prefix\nsecond line',
    open: false,
  })
  assert.equal(await page.$('#ordinaryTextMessages [data-system-event]'), null)
  assert.ok(await page.$eval('#ordinaryTextMessages', root => root.textContent.includes('ordinary assistant text mentions llm error')))
})

test('non-retry operational events still split Grouped tool runs and remain standalone', async () => {
  assert.deepEqual(await groupTags('operationalEventMessages'), [['exec ×1', 'neutral'], ['exec ×1', 'neutral']])
  assert.equal(await page.$eval('#operationalEventMessages [data-system-event]', node => !!node.closest('[data-tool-group]')), false)
  assert.deepEqual(await cardSnapshot('#operationalEventMessages [data-system-event]'), {
    title: 'Compaction failed',
    severity: 'error',
    heading: 'Compaction failed: No valid plan was produced.',
    details: 'Original compaction diagnostic',
    open: false,
  })
})
