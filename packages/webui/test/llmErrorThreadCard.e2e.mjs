import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { build } from 'esbuild'
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
const fixtureCases = { groupedMessages, tailMessages, ungroupedMessages, standaloneMessages, missingPrefixMessages, ordinaryTextMessages }

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
        groupTools: id !== 'ungroupedMessages',
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

const cardSnapshot = async (selector) => page.$eval(selector, card => ({
  kind: card.getAttribute('data-system-message-kind'),
  tag: card.querySelector('.foxwarm-system-message-tag span:last-child')?.textContent,
  preview: card.querySelector('.foxwarm-system-message-preview')?.textContent,
  body: card.querySelector('.foxwarm-system-message-body')?.textContent?.trim() || null,
}))

const groupTags = async (id) => page.$$eval(`#${id} [data-tool-group-card] [data-tool-tag-tone]`, tags => tags.map(tag => [tag.querySelector('span:last-child')?.textContent, tag.getAttribute('data-tool-tag-tone')]))

test('LLM retry notices render as body-only thread cards and count body lines in tool groups', async () => {
  assert.deepEqual(await groupTags('groupedMessages'), [
    ['LLM error ×5', 'system'],
    ['exec ×2', 'success'],
  ])
  assert.equal(await page.$$('#groupedMessages [data-system-message-card]').then(nodes => nodes.length), 0, 'collapsed groups hide the member card')
  assert.match(await page.$eval('#groupedMessages', root => root.textContent), /ordinary answer/)

  await page.click('#groupedMessages [aria-label="Expand tool group"]')
  await page.waitForSelector('#groupedMessages [data-tool-group-card] [data-system-message-card]')
  await page.$$eval('#groupedMessages [data-system-message-card] button', buttons => buttons.forEach(button => button.click()))
  await page.waitForFunction(() => document.querySelectorAll('#groupedMessages .foxwarm-system-message-body').length === 2)
  const cards = await page.$$eval('#groupedMessages [data-system-message-card]', nodes => nodes.map(card => ({
    kind: card.getAttribute('data-system-message-kind'),
    tag: card.querySelector('.foxwarm-system-message-tag span:last-child')?.textContent,
    body: card.querySelector('.foxwarm-system-message-body')?.textContent?.trim() || null,
    insideGroup: !!card.closest('[data-tool-group-card]'),
  })))
  assert.deepEqual(cards, [
    { kind: 'llm error', tag: 'LLM error ×4', body: 'Attempt 1/5 failed: first line\nAttempt 2/5 failed: second line\n\nAttempt 3/5 failed: third line', insideGroup: true },
    { kind: 'llm error', tag: 'LLM error ×1', body: 'Attempt 1/5 failed: one line', insideGroup: true },
  ])
  assert.equal(await page.$eval('#groupedMessages', root => root.textContent.includes('LLM ERROR:')), false, 'the source prefix is not rendered')
  assert.equal(await page.$eval('#groupedMessages', root => root.textContent.includes('llm error:')), false, 'the source prefix is not rendered in any case')
})

test('group tools off keeps the LLM error card and tool error response separate', async () => {
  const card = await cardSnapshot('#ungroupedMessages [data-system-message-card]')
  assert.deepEqual(card, {
    kind: 'llm error',
    tag: 'LLM error ×1',
    preview: 'Attempt 1/5 failed: visible without grouping',
    body: null,
  })
  assert.equal(await page.$$('#ungroupedMessages [data-system-message-card]').then(nodes => nodes.length), 1)
  assert.ok(await page.$eval('#ungroupedMessages', root => root.textContent.includes('llm error: tool response text')))
  assert.ok(await page.$eval('#ungroupedMessages', root => root.textContent.includes('assistant quote: llm error: not a prefix')))
  assert.equal(await page.$$('#ungroupedMessages [data-system-message-kind="llm error"] .foxwarm-system-message-body').then(nodes => nodes.length), 0, 'collapsed card body is not mounted until opened')
})

test('tail LLM errors stay in the forced-open historical group', async () => {
  const card = await cardSnapshot('#tailMessages [data-system-message-card]')
  assert.deepEqual(card, {
    kind: 'llm error',
    tag: 'LLM error ×1',
    preview: 'Attempt 1/5 failed: tail error',
    body: null,
  })
  assert.equal(await page.$$('#tailMessages [aria-label="Expand tool group"]').then(nodes => nodes.length), 0)
  assert.equal(await page.$eval('#tailMessages [data-system-message-card]', node => !!node.closest('[data-tool-group]')), true)
})

test('a standalone LLM retry is a normal thread card and malformed prefix text remains intact', async () => {
  const card = await cardSnapshot('#standaloneMessages [data-system-message-card]')
  assert.deepEqual(card, {
    kind: 'llm error',
    tag: 'LLM error ×1',
    preview: 'Attempt 1/5 failed: standalone',
    body: null,
  })
  assert.equal(await page.$$('#standaloneMessages [data-system-message-body]').then(nodes => nodes.length), 0)
  const malformed = await cardSnapshot('#missingPrefixMessages [data-system-message-card]')
  assert.deepEqual(malformed, {
    kind: 'llm error',
    tag: 'LLM error ×2',
    preview: 'Attempt 1/5 failed without warning prefix',
    body: null,
  })
  assert.equal(await page.$$('#ordinaryTextMessages [data-system-message-card]').then(nodes => nodes.length), 0)
  assert.ok(await page.$eval('#ordinaryTextMessages', root => root.textContent.includes('ordinary assistant text mentions llm error')))
})
