import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
let browser, page, server, fixtureUrl

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build the WebUI before running browser tests')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    const root = createRoot(document.getElementById('main'))
    const queuedRoot = createRoot(document.getElementById('queued'))
    const nestedRoot = createRoot(document.getElementById('nested'))
    const base = Date.UTC(2026, 8, 26, 14)
    const timed = (seq, parts, timestamp, extra = {}) => ({ role: 'model', parts, __meta: { seq, timestamp, ...extra } })
    const call = (id, seq, timestamp, startedAt) => timed(seq, [{ functionCall: { id, name: 'exec', args: { command: 'echo ' + id } } }], timestamp, { usage: { cachedTokens: 2, inputTokens: 3, outputTokens: 4 }, ...(startedAt !== undefined ? { llmRequestTiming: { startedAt, completedAt: timestamp, durationMs: timestamp - startedAt } } : {}) })
    const result = (id, seq, timestamp, output) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'exec', response: { output } } }], __meta: { seq, timestamp } })
    const received = (seq, timestamp) => ({ role: 'user', parts: [{ text: 'A later user message' }], __meta: { seq, timestamp } })
    const mainProps = messages => ({ sessionId: 'fixture/timeline', messages, isMobile: false, groupTools: true, showUsageBadge: true })
    const groupMessages = () => {
      const aEnd = base + 40 * 60_000
      const bStart = aEnd + 59_999
      const bEnd = bStart + 4 * 60_000
      const bResultEnd = bEnd + 1000
      const cStart = bResultEnd + 60_000
      const cEnd = cStart + 5 * 60_000
      const cResultEnd = cEnd + 1000
      return [
        call('a', 11, base),
        { role: 'user', parts: [{ system: '<foxwarm-system kind="event">\\nA tool event\\n</foxwarm-system>' }], __meta: { seq: 12, timestamp: base + 20 * 60_000 } },
        result('a', 13, aEnd, 'A result'),
        call('b', 14, bEnd, bStart), result('b', 15, bResultEnd, 'B result'),
        call('c', 16, cEnd, cStart), result('c', 17, cResultEnd, 'C result'),
        timed(18, [{ thinking: 'FOLDED_AFTER_C' }, { text: 'FINAL OUTSIDE GROUP' }], cResultEnd + 6000),
        received(19, base + 12 * 3600_000),
      ]
    }
    window.fixture = {
      renderGroup: () => root.render(React.createElement(ChatTimeline, mainProps(groupMessages()))),
      renderNoBadgeGroup: () => root.render(React.createElement(ChatTimeline, { ...mainProps(groupMessages()), showUsageBadge: false })),
      renderStream: (committed) => root.render(React.createElement(ChatTimeline, mainProps([
        received(31, base),
        committed
          ? timed(32, [{ text: 'Committed reply' }], base + 60_000, { llmRequestId: 'stream-row-32' })
          : { role: 'model', parts: [{ text: 'Streaming reply' }], __meta: { temporary: true, synthetic: 'stream-row', llmRequestId: 'stream-row-32', timestamp: base + 60_000 } },
      ]))),
      renderQueue: (committed) => {
        const queued = received(42, base + 3600_000)
        if (committed) root.render(React.createElement(ChatTimeline, mainProps([received(41, base), queued])))
        else root.render(React.createElement(ChatTimeline, mainProps([received(41, base)])))
        queuedRoot.render(React.createElement(ChatTimeline, { ...mainProps(committed ? [] : [{ ...queued, __meta: { ...queued.__meta, temporary: true, queuedPreview: true } }]), showTimeDividers: false }))
        nestedRoot.render(React.createElement(ChatTimeline, { ...mainProps([timed(43, [{ text: 'Nested CTX message' }], base + 3 * 3600_000)]), nestedDepth: 1 }))
      },
      renderPrefix: (withPrefix) => root.render(React.createElement(ChatTimeline, mainProps([
        ...(withPrefix ? [received(51, base), timed(52, [{ text: 'Earlier reply' }], base + 60_000)] : []),
        timed(53, [{ text: 'LATE_STABLE_ROW' }], base + 2 * 3600_000),
      ]))),
    }
    window.fixture.renderGroup()
  `
  const bundle = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'timeline-time-fixture.tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{background:#1b1d23;color:#e3e6ee;margin:0}#main,#queued,#nested{max-width:930px;margin:20px auto}.fixture-viewport{max-height:760px;overflow:auto}</style></head><body><div class="fixture-viewport"><div id="main"></div><div id="queued"></div><div id="nested"></div></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  const isFirefox = process.env.FOXWARM_E2E_BROWSER === 'firefox'
  browser = await puppeteer.launch({ browser: isFirefox ? 'firefox' : 'chrome', executablePath: isFirefox ? (process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox') : (process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'), headless: true, args: isFirefox ? [] : ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  if (!isFirefox) await page.setViewport({ width: 1200, height: 820, deviceScaleFactor: 1 })
})

after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)) })
const mount = async () => { await page.goto(fixtureUrl, { waitUntil: 'load' }); await page.waitForSelector('#main [data-tool-group]') }
const labels = () => page.$$eval('#main [data-timeline-time-separator]', nodes => nodes.map(node => node.textContent.trim()))

test('slow requests stay in their tool group while a real idle gap splits only complete pairs', async () => {
  await mount()
  const initial = await page.evaluate(() => ({
    groups: [...document.querySelectorAll('#main [data-tool-group]')].map(group => ({ key: group.dataset.toolGroup, header: group.querySelector('.foxwarm-tool-group-header')?.textContent, anchor: group.dataset.chatMessageAnchorKey })),
    dividers: [...document.querySelectorAll('#main [data-timeline-time-separator]')].map(node => ({ before: node.nextElementSibling?.querySelector('[data-tool-group]')?.dataset.toolGroup, ancestors: !!node.closest('[data-tool-group]'), anchor: !!node.getAttribute('data-chat-message-anchor-key') })),
  }))
  assert.equal(initial.groups.length, 2, JSON.stringify(initial))
  assert.match(initial.groups[0].header, /exec ×2/)
  assert.match(initial.groups[1].header, /exec ×1/)
  assert.deepEqual(initial.groups.map(group => group.anchor), ['seq-local-11', 'seq-local-16'])
  assert.ok(initial.dividers.every(row => !row.ancestors && !row.anchor), JSON.stringify(initial))
  assert.equal(initial.dividers[1].before, initial.groups[1].key, 'verified one-minute gap is ahead of the later group')
  assert.match((await labels())[1], /\d{2}:\d{2}$/)
  assert.equal(await page.$$eval('#main [data-timeline-time-separator] time', nodes => nodes[1].dateTime), '2026-09-26T14:46:00.999Z', 'the divider shows the selected request start, not its completion')
  assert.ok((await labels()).every(label => !label.includes(' · ') && !label.includes(' later')), 'separators show only the timestamp')
  assert.equal(await page.$$eval('#main [data-usage-timing-kind="between"]', items => items.length), 0)
  if (process.env.FOXWARM_E2E_SCREENSHOT_PATH) await page.screenshot({ path: process.env.FOXWARM_E2E_SCREENSHOT_PATH })
  await page.click('#main [data-tool-group] [aria-label="Expand tool group"]')
  await page.waitForFunction(() => {
    const group = document.querySelector('#main [data-tool-group="seq-local-11-toolgroup"]')
    return group?.dataset.toolGroupExpanded === 'true' && group.style.height === ''
  })
  assert.ok((await page.$eval('#main [data-tool-group]', node => node.textContent)).includes('A result'))
  assert.ok((await page.$eval('#main [data-tool-group]', node => node.textContent)).includes('B result'))
  assert.equal(await page.$$eval('#main [data-tool-group]', groups => groups[0].querySelectorAll('[data-tool-group-card]').length), 1)
  const afterExpand = await page.evaluate(() => [...document.querySelectorAll('#main [data-tool-group]')].map(group => group.dataset.chatMessageAnchorKey))
  assert.deepEqual(afterExpand, initial.groups.map(group => group.anchor))
  assert.equal((await labels()).length, initial.dividers.length, 'expand/collapse never hides or duplicates a time line')
  await page.click('#main [data-tool-group] [aria-label="Collapse tool group"]')
  await page.waitForFunction(() => {
    const group = document.querySelector('#main [data-tool-group="seq-local-11-toolgroup"]')
    return group?.dataset.toolGroupExpanded === 'false' && group.style.height === ''
  })
  const groupButtons = await page.$$eval('#main [data-tool-group]', groups => groups.map(group => ({
    key: group.dataset.toolGroup, expanded: group.dataset.toolGroupExpanded,
    buttons: [...group.querySelectorAll('button[aria-label]')].map(button => button.getAttribute('aria-label')),
  })))
  assert.ok(groupButtons[1].buttons.includes('Expand tool group'), JSON.stringify(groupButtons))
  await page.click(`#main [data-tool-group="${initial.groups[1].key}"] [aria-label="Expand tool group"]`)
  assert.ok((await page.$eval('#main', node => node.textContent)).includes('FINAL OUTSIDE GROUP'))
  assert.ok((await page.$eval('#main [data-model-thread-card="reasoning"]', node => node.textContent)).includes('FOLDED_AFTER_C'))
  await page.evaluate(() => window.fixture.renderNoBadgeGroup())
  await page.waitForFunction(() => document.querySelectorAll('#main [data-usage-badge]').length === 0)
  assert.equal((await labels()).length, initial.dividers.length, 'time rows do not depend on the usage-badge setting')
})

test('temporary stream, queued preview and nested CTX never duplicate committed separators', async () => {
  await mount()
  await page.evaluate(() => window.fixture.renderStream(false))
  await page.waitForFunction(() => document.querySelector('#main')?.textContent.includes('Streaming reply'))
  assert.equal((await labels()).length, 1)
  await page.evaluate(() => window.fixture.renderStream(true))
  await page.waitForFunction(() => document.querySelector('#main')?.textContent.includes('Committed reply'))
  assert.equal((await labels()).length, 2)
  assert.ok((await labels()).every(label => !label.includes(' · ') && !label.includes(' later')))
  assert.equal(await page.$$eval('#main [data-timeline-time-separator] time', nodes => nodes.at(-1)?.dateTime), '2026-09-26T14:01:00.000Z')
  await page.evaluate(() => window.fixture.renderQueue(false))
  await page.waitForFunction(() => document.querySelector('#queued')?.textContent.includes('A later user message'))
  assert.equal(await page.$$eval('#queued [data-timeline-time-separator], #nested [data-timeline-time-separator]', nodes => nodes.length), 0)
  assert.equal((await labels()).length, 1)
  await page.evaluate(() => window.fixture.renderQueue(true))
  await page.waitForFunction(() => document.querySelector('#queued')?.textContent.trim() === '')
  assert.equal((await labels()).length, 2)
  assert.equal(await page.$$eval('body [data-timeline-time-separator]', nodes => nodes.length), 2)
})

test('prefix arrival and reload preserve committed row identity without an invented missing-prefix gap', async () => {
  await mount()
  await page.evaluate(() => window.fixture.renderPrefix(false))
  await page.waitForFunction(() => document.querySelector('#main')?.textContent.includes('LATE_STABLE_ROW'))
  assert.equal((await labels()).length, 1)
  assert.ok(!(await labels())[0].includes(' · '))
  await page.evaluate(() => { window.lateRow = document.querySelector('#main [data-chat-message-anchor-key="seq-local-53"]'); window.fixture.renderPrefix(true) })
  await page.waitForFunction(() => document.querySelector('#main [data-chat-message-anchor-key="seq-local-51"]'))
  assert.equal(await page.evaluate(() => window.lateRow === document.querySelector('#main [data-chat-message-anchor-key="seq-local-53"]')), true)
  assert.equal((await labels()).length, 3)
  assert.equal(await page.$$eval('#main [data-timeline-time-separator] [data-chat-message-anchor-key]', nodes => nodes.length), 0)
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('#main [data-tool-group]')
  assert.equal((await labels()).length, 3, 'reload reproduces source-derived timestamps without render-time data')
})
