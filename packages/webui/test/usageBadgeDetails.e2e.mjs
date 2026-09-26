import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
const fixtureIds = ['concrete', 'virtual', 'missing', 'invalid', 'timed', 'ordinaryBelowMinute', 'ordinaryAtMinute', 'groupSame', 'groupDifferent', 'groupBelowMinute', 'groupAtMinute', 'longMobile', 'hidden', 'groupSeq', 'oneModelManyCalls', 'groupMissingSeq', 'seqMissing', 'seqZero', 'seqFraction', 'seqString', 'seqUnsafe', 'stream']

let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}

    const usage = (cachedTokens, inputTokens, outputTokens) => ({ cachedTokens, inputTokens, outputTokens })
    const requestTiming = (startedAt, completedAt) => ({ startedAt, completedAt, durationMs: completedAt - startedAt })
    const toolResponse = (id) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'read', response: { output: 'ok' } } }], __meta: { seq: id + '-response', timestamp: 1700000001000 } })
    const toolCall = (id, modelId, virtualModelKey, timestamp, startedAt, completedAt) => ({
      role: 'model',
      parts: [{ functionCall: { id, name: 'read', args: { filePath: '/tmp/example.txt' } } }],
      __meta: { seq: id, usage: usage(10, 20, 30), modelId, virtualModelKey, timestamp, llmRequestTiming: requestTiming(startedAt, completedAt) },
    })
    const manyCalls = { role: 'model', parts: [
      { functionCall: { id: 'first-tool-id', name: 'read', args: { filePath: 'first' } } },
      { functionCall: { id: 'second-tool-id', name: 'read', args: { filePath: 'second' } } },
    ], __meta: { llmRequestId: 'usage-first-model', seq: 123, usage: usage(1, 2, 3) } }
    const twoResults = { role: 'tool', parts: [
      { functionResponse: { tool_use_id: 'first-tool-id', name: 'read', response: { output: 'first' } } },
      { functionResponse: { tool_use_id: 'second-tool-id', name: 'read', response: { output: 'second' } } },
    ], __meta: { seq: 124 } }
    const laterCall = { role: 'model', parts: [{ functionCall: { id: 'third-tool-id', name: 'read', args: { filePath: 'third' } } }], __meta: { seq: 130, usage: usage(4, 5, 6) } }
    const laterResult = { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'third-tool-id', name: 'read', response: { output: 'third' } } }], __meta: { seq: 131 } }
    const finish = { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 132 } }
    const groupSeqMessages = [manyCalls, twoResults, { role: 'user', parts: [{ text: '<foxwarm-system kind="event">\\nBetween tool calls\\n</foxwarm-system>' }], __meta: { seq: 901 } }, laterCall, laterResult, finish]
    const streamMessage = { role: 'model', parts: [{ text: 'Streaming message' }], __meta: { llmRequestId: 'stream-usage-message', usage: usage(2, 3, 4) } }
    const longVirtualKey = 'virtual/' + 'route-key-'.repeat(45)
    const cases = {
      concrete: { messages: [{ role: 'model', parts: [{ text: 'Concrete response' }], __meta: { seq: 123, usage: usage(11, 22, 33), modelId: 'provider/real-model', timestamp: 1700000000000, llmRequestTiming: requestTiming(1699999999000, 1700000000000) } }] },
      virtual: { messages: [{ role: 'model', parts: [{ text: 'Virtual response' }], __meta: { seq: 2, usage: usage(1, 2, 3), modelId: 'provider/real-model', virtualModelKey: 'session-hash/virtual', timestamp: 1700000000000, llmRequestTiming: requestTiming(1699999997500, 1700000000000) } }] },
      missing: { messages: [{ role: 'model', parts: [{ text: 'Legacy response' }], __meta: { seq: 3, usage: usage(1, 2, 3) } }] },
      invalid: { messages: [{ role: 'model', parts: [{ text: 'Invalid legacy response' }], __meta: { seq: 31, usage: usage(1, 2, 3), modelId: 'provider/invalid', timestamp: 'not-a-persisted-timestamp', llmRequestTiming: { startedAt: 10, completedAt: 5, durationMs: -1 } } }] },
      timed: { messages: [
        { role: 'model', parts: [{ text: 'Previous request' }], __meta: { seq: 'timed-prior', llmRequestTiming: requestTiming(1000, 2000) } },
        { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'timed-tool', name: 'exec', response: { output: 'ok' } } }], __meta: { seq: 'timed-tool' } },
        { role: 'model', parts: [{ text: 'Timed response' }], __meta: { seq: 'timed-current', usage: usage(4, 5, 6), modelId: 'provider/timed', timestamp: 6500, llmRequestTiming: requestTiming(5000, 6500) } },
      ] },
      ordinaryBelowMinute: { messages: [
        { role: 'model', parts: [{ text: 'Previous boundary request' }], __meta: { seq: 'ordinary-below-prior', llmRequestTiming: requestTiming(0, 1000) } },
        { role: 'model', parts: [{ text: 'Below-minute response' }], __meta: { seq: 'ordinary-below-current', usage: usage(7, 8, 9), modelId: 'provider/below-minute', timestamp: 62499, llmRequestTiming: requestTiming(60999, 62499) } },
      ] },
      ordinaryAtMinute: { messages: [
        { role: 'model', parts: [{ text: 'Previous boundary request' }], __meta: { seq: 'ordinary-at-prior', llmRequestTiming: requestTiming(0, 1000) } },
        { role: 'model', parts: [{ text: 'One-minute response' }], __meta: { seq: 'ordinary-at-current', usage: usage(7, 8, 9), modelId: 'provider/at-minute', timestamp: 62500, llmRequestTiming: requestTiming(61000, 62500) } },
      ] },
      groupSame: { groupTools: true, messages: [toolCall('same-one', 'provider/real-model', 'virtual/same', 1700000000000, 1000, 2000), toolResponse('same-one'), toolCall('same-two', 'provider/real-model', 'virtual/same', 1700000000000, 5000, 7000), toolResponse('same-two'), { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 'same-final' } }] },
      groupDifferent: { groupTools: true, messages: [toolCall('different-one', 'provider/first-model', 'virtual/first', 1700000000000, 1000, 2000), toolResponse('different-one'), toolCall('different-two', 'provider/second-model', 'virtual/second', 1700000060000, 5000, 7000), toolResponse('different-two'), { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 'different-final' } }] },
      groupBelowMinute: { groupTools: true, messages: [toolCall('group-below-one', 'provider/group-below', null, 1700000000000, 0, 1000), toolResponse('group-below-one'), toolCall('group-below-two', 'provider/group-below', null, 1700000062499, 60999, 62499), toolResponse('group-below-two'), { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 'group-below-final' } }] },
      groupAtMinute: { groupTools: true, messages: [toolCall('group-at-one', 'provider/group-at', null, 1700000000000, 0, 1000), toolResponse('group-at-one'), toolCall('group-at-two', 'provider/group-at', null, 1700000062500, 61000, 62500), toolResponse('group-at-two'), { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 'group-at-final' } }] },
      longMobile: { messages: [{ role: 'model', parts: [{ text: 'Long route response' }], __meta: { seq: 4, usage: usage(1, 2, 3), modelId: 'provider/real-model', virtualModelKey: longVirtualKey, timestamp: 1700000000000 } }] },
      hidden: { showUsageBadge: false, messages: [{ role: 'model', parts: [{ text: 'Hidden usage' }], __meta: { seq: 5, usage: usage(1, 2, 3), modelId: 'provider/hidden', timestamp: 1700000000000 } }] },
      groupSeq: { groupTools: true, messages: groupSeqMessages },
      oneModelManyCalls: { groupTools: true, messages: [manyCalls, twoResults, finish] },
      groupMissingSeq: { groupTools: true, messages: [manyCalls, twoResults, { ...laterCall, __meta: { usage: usage(4, 5, 6) } }, laterResult, finish] },
      seqMissing: { messages: [{ role: 'model', parts: [{ text: 'No persisted sequence' }], __meta: { usage: usage(1, 2, 3) } }] },
      seqZero: { messages: [{ role: 'model', parts: [{ text: 'Zero sequence' }], __meta: { seq: 0, usage: usage(1, 2, 3) } }] },
      seqFraction: { messages: [{ role: 'model', parts: [{ text: 'Fraction sequence' }], __meta: { seq: 12.7, usage: usage(1, 2, 3) } }] },
      seqString: { messages: [{ role: 'model', parts: [{ text: 'String sequence' }], __meta: { seq: '123', usage: usage(1, 2, 3) } }] },
      seqUnsafe: { messages: [{ role: 'model', parts: [{ text: 'Unsafe integer sequence' }], __meta: { seq: Number.MAX_SAFE_INTEGER + 1, usage: usage(1, 2, 3) } }] },
      stream: { messages: [streamMessage] },
    }

    const roots = {}
    for (const [id, fixture] of Object.entries(cases)) {
      roots[id] = createRoot(document.getElementById(id))
      roots[id].render(React.createElement(ChatTimeline, {
        sessionId: 'example/main',
        messages: fixture.messages,
        isMobile: window.innerWidth < 768,
        groupTools: fixture.groupTools || false,
        showUsageBadge: fixture.showUsageBadge !== false,
      }))
    }
    window.commitStreamSeq = seq => {
      streamMessage.__meta.seq = seq
      roots.stream.render(React.createElement(ChatTimeline, { sessionId: 'example/main', messages: [...cases.stream.messages], isMobile: false, groupTools: false, showUsageBadge: true }))
    }
    window.commitGroupSeq = seq => {
      manyCalls.__meta.seq = seq
      roots.groupSeq.render(React.createElement(ChatTimeline, { sessionId: 'example/main', messages: [...groupSeqMessages], isMobile: false, groupTools: true, showUsageBadge: true }))
    }
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'usage-badge-details-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

async function mountFixture(width = 1100) {
  await page.setViewport({ width, height: 900, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(expected => document.querySelectorAll('.foxwarm-chat-timeline').length === expected, {}, fixtureIds.length)
  assert.equal(await page.$$eval('[data-usage-badge]', badges => badges.length), fixtureIds.length - 1)
}

async function badgeState(id) {
  return page.$eval(`#${id} [data-usage-badge]`, (badge) => ({
    expanded: badge.querySelector('[data-usage-badge-toggle]').getAttribute('aria-expanded'),
    className: badge.className,
    text: badge.textContent.replace(/\s+/g, ' ').trim(),
    fixtureOverflow: badge.closest('.fixture').scrollWidth - badge.closest('.fixture').clientWidth,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
}

const clipboardWrites = () => page.evaluate(() => window.usageClipboard.writes)

async function badgePosition(id) {
  return page.$eval(`#${id}`, (fixture) => {
    const timeline = fixture.querySelector('.foxwarm-chat-timeline')
    const row = timeline?.firstElementChild
    const message = row?.firstElementChild
    const anchor = fixture.querySelector('[data-usage-badge-anchor]')
    const badge = fixture.querySelector('[data-usage-badge]')
    const rect = (element) => {
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect()
      return { left, right, top, bottom, width, height }
    }
    return {
      timeline: rect(timeline),
      message: rect(message),
      anchor: rect(anchor),
      badge: rect(badge),
      anchorPosition: getComputedStyle(anchor).position,
      anchorTransform: anchor.style.transform,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the usage badge browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()

  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{padding:16px}.fixture{width:1400px;max-width:100%;min-width:0;margin-bottom:24px}</style></head><body><main>${fixtureIds.map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
  await page.evaluateOnNewDocument(() => {
    window.usageClipboard = { writes: [], fail: false }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
      if (window.usageClipboard.fail) throw new Error('Simulated clipboard failure')
      window.usageClipboard.writes.push(text)
    } } })
  })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('collapsed badge preserves compact labels and mouse, Enter, and Space toggle details', async () => {
  await mountFixture()
  const collapsed = await badgeState('concrete')
  assert.equal(collapsed.expanded, 'false')
  assert.ok(collapsed.className.includes('inline-flex'))
  assert.ok(collapsed.className.includes('flex-row'))
  assert.equal(collapsed.text, 'C11I22O331s')
  assert.deepEqual(await page.$$eval('#concrete [data-usage-timing-kind]', items => items.map(item => ({
    kind: item.getAttribute('data-usage-timing-kind'),
    text: item.textContent.trim(),
    title: item.getAttribute('title'),
  }))), [{ kind: 'api', text: '1s', title: 'API response: 1s (1000ms)' }])
  const timingSummaryClass = await page.$eval('#concrete [data-usage-timing-summary]', item => item.className)
  assert.ok(timingSummaryClass.includes('border-l'), timingSummaryClass)
  assert.ok(!timingSummaryClass.includes('rounded'), timingSummaryClass)
  assert.ok(!timingSummaryClass.includes('bg-'), timingSummaryClass)

  await page.click('#concrete [data-usage-badge]')
  const expanded = await badgeState('concrete')
  assert.equal(expanded.expanded, 'true')
  for (const label of ['Cached11', 'Input22', 'Output33', 'Betweenunavailable', 'API1s (1000ms)', 'Time', 'Modelprovider/real-model']) {
    assert.ok(expanded.text.includes(label), `expanded badge should include ${label}`)
  }

  await page.focus('#concrete [data-usage-badge-toggle]')
  await page.keyboard.press('Enter')
  assert.equal((await badgeState('concrete')).expanded, 'false')
  await page.keyboard.press('Space')
  assert.equal((await badgeState('concrete')).expanded, 'true')
})

test('details use persisted concrete/virtual metadata and show legacy omissions honestly', async () => {
  await mountFixture()
  await page.click('#virtual [data-usage-badge]')
  assert.ok((await badgeState('virtual')).text.includes('Modelsession-hash/virtual → provider/real-model'))

  await page.click('#missing [data-usage-badge]')
  const missing = await badgeState('missing')
  assert.ok(missing.text.includes('Timeunavailable'))
  assert.ok(missing.text.includes('Modelunavailable'))

  await page.click('#invalid [data-usage-badge]')
  const invalid = await badgeState('invalid')
  assert.ok(invalid.text.includes('Timeinvalid timestamp'))
  assert.ok(invalid.text.includes('APIinvalid timing'))
})

test('request timing shows API latency and the tool-inclusive interval between requests', async () => {
  await mountFixture()
  assert.deepEqual(await page.$$eval('#timed [data-usage-timing-kind]', items => items.map(item => ({
    kind: item.getAttribute('data-usage-timing-kind'),
    text: item.textContent.trim(),
    title: item.getAttribute('title'),
  }))), [
    { kind: 'api', text: '1s', title: 'API response: 1s (1500ms)' },
  ])

  await page.click('#timed [data-usage-badge]')
  const expanded = await badgeState('timed')
  assert.ok(expanded.text.includes('Between3s (3000ms)'), expanded.text)
  assert.ok(expanded.text.includes('API1s (1500ms)'), expanded.text)
})

test('collapsed ordinary and grouped badges show between timing only from the raw one-minute boundary', async () => {
  await mountFixture()

  for (const id of ['ordinaryBelowMinute', 'groupBelowMinute']) {
    assert.deepEqual(await page.$$eval(`#${id} [data-usage-timing-kind]`, items => items.map(item => item.getAttribute('data-usage-timing-kind'))), ['api'])
    const collapsed = await badgeState(id)
    assert.ok(collapsed.text.includes('C'), collapsed.text)
    await page.click(`#${id} [data-usage-badge]`)
    const expanded = await badgeState(id)
    assert.ok(expanded.text.includes('Between59s (59999ms)'), expanded.text)
    assert.ok(expanded.text.includes('API'), expanded.text)
  }

  for (const id of ['ordinaryAtMinute', 'groupAtMinute']) {
    assert.deepEqual(await page.$$eval(`#${id} [data-usage-timing-kind]`, items => items.map(item => ({
      kind: item.getAttribute('data-usage-timing-kind'),
      text: item.textContent.trim(),
      title: item.getAttribute('title'),
    }))), [
      { kind: 'between', text: '1m', title: 'Between requests: 1m (60000ms)' },
      { kind: 'api', text: id === 'ordinaryAtMinute' ? '1s' : '2s', title: id === 'ordinaryAtMinute' ? 'API response: 1s (1500ms)' : 'API response: 2s (2500ms)' },
    ])
  }
})

test('collapsed tool-group details aggregate calls without attributing them to the first route, and badge click does not expand the group', async () => {
  await mountFixture()
  await page.click('#groupSame [data-usage-badge]')
  const same = await badgeState('groupSame')
  assert.ok(same.text.includes('Calls2'), same.text)
  assert.ok(same.text.includes('Modelvirtual/same → provider/real-model'), same.text)
  assert.ok(same.text.includes('Between3s (3000ms)'), same.text)
  assert.ok(same.text.includes('API3s (3000ms)'), same.text)
  assert.equal(await page.$eval('#groupSame [data-usage-badge-toggle]', button => button.getAttribute('aria-expanded')), 'true')
  assert.equal(await page.$eval('#groupSame button[aria-label="Expand tool group"]', button => button.getAttribute('aria-expanded')), 'false', 'badge click must not expand the tool group')
  assert.equal(await page.$$eval('#groupSame .foxwarm-tool-card', cards => cards.length), 1, 'the collapsed group keeps its one summary card')
  assert.equal(await page.$$eval('#groupSame [data-usage-badge]', badges => badges.length), 1, 'badge remains the collapsed-group interaction target')

  await page.click('#groupDifferent [data-usage-badge]')
  const different = await badgeState('groupDifferent')
  assert.ok(different.text.includes('Modelvirtual/first → provider/first-model • virtual/second → provider/second-model'), different.text)
  assert.ok(different.text.includes(' – '), 'different persisted call times render as an accurate range')
})

test('desktop expansion preserves the external lower-right gap until timeline-space clamping is necessary', async () => {
  await mountFixture(1600)
  const collapsed = await badgePosition('concrete')
  assert.equal(collapsed.anchorTransform, '')
  assert.ok(Math.abs(collapsed.badge.left - collapsed.message.right - 8) <= 1, 'collapsed badge keeps its original external gap')

  await page.click('#concrete [data-usage-badge]')
  const wide = await badgePosition('concrete')
  assert.ok(Math.abs(wide.badge.left - wide.message.right - 8) <= 1, 'wide expanded badge remains wholly outside with the original gap')
  assert.ok(wide.badge.right <= wide.timeline.right + 1)

  await page.setViewport({ width: 700, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await page.waitForFunction(() => {
    const timeline = document.querySelector('#concrete .foxwarm-chat-timeline')
    const badge = document.querySelector('#concrete [data-usage-badge]')
    return timeline && badge && Math.abs(timeline.getBoundingClientRect().right - badge.getBoundingClientRect().right) <= 1
  })
  const resized = await badgePosition('concrete')
  assert.ok(resized.badge.right <= resized.timeline.right + 1)
  assert.ok(resized.badge.left < resized.message.right + 7, 'the resize clamp shifts only when the preferred outside position no longer fits')

  await page.setViewport({ width: 1600, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await page.waitForFunction(() => {
    const timeline = document.querySelector('#concrete .foxwarm-chat-timeline')
    const message = timeline?.firstElementChild?.firstElementChild
    const badge = document.querySelector('#concrete [data-usage-badge]')
    return message && badge && Math.abs(badge.getBoundingClientRect().left - message.getBoundingClientRect().right - 8) <= 1
  })
})

test('constrained desktop clamps expanded long keys to the timeline edge without overflow', async () => {
  await mountFixture(900)
  await page.click('#longMobile [data-usage-badge]')
  const constrained = await badgePosition('longMobile')
  assert.ok(Math.abs(constrained.badge.right - constrained.timeline.right) <= 1, 'only the expanded panel is shifted to align with the actual timeline edge')
  assert.ok(constrained.documentOverflow <= 1, `constrained document overflowed by ${constrained.documentOverflow}px`)
})

test('mobile expansion stays in the existing flow layout, and the setting still hides badges', async () => {
  await mountFixture(1100)
  await page.click('#longMobile [data-usage-badge]')
  let layout = await badgeState('longMobile')
  assert.ok(layout.fixtureOverflow <= 1, `desktop fixture overflowed by ${layout.fixtureOverflow}px`)
  assert.ok(layout.documentOverflow <= 1, `desktop document overflowed by ${layout.documentOverflow}px`)
  assert.equal(await page.$$eval('#hidden [data-usage-badge]', badges => badges.length), 0)

  await mountFixture(390)
  await page.click('#longMobile [data-usage-badge]')
  layout = await badgeState('longMobile')
  assert.equal((await badgePosition('longMobile')).anchorPosition, 'static')
  assert.ok(layout.fixtureOverflow <= 1, `mobile fixture overflowed by ${layout.fixtureOverflow}px`)
  assert.ok(layout.documentOverflow <= 1, `mobile document overflowed by ${layout.documentOverflow}px`)
  await page.click('#groupSeq [data-usage-badge-toggle]')
  assert.equal(await page.$eval('#groupSeq [data-usage-seq-value]', node => node.textContent), '123 ~ 130')
  layout = await badgeState('groupSeq')
  assert.equal((await badgePosition('groupSeq')).anchorPosition, 'static')
  assert.ok(layout.fixtureOverflow <= 1, `mobile group fixture overflowed by ${layout.fixtureOverflow}px`)
  assert.ok(layout.documentOverflow <= 1, `mobile group document overflowed by ${layout.documentOverflow}px`)
})

test('Seq stays out of the compact badge; expanded copy is a sibling button with the exact session reference', async () => {
  await mountFixture()
  const compact = await badgeState('concrete')
  assert.equal(compact.text, 'C11I22O331s')
  assert.equal(await page.$$eval('#concrete [data-usage-seq-row], #concrete [data-usage-seq-copy]', nodes => nodes.length), 0)
  const geometry = await page.$eval('#concrete [data-usage-badge]', badge => {
    const toggle = badge.querySelector('[data-usage-badge-toggle]')
    const style = getComputedStyle(badge)
    return { width: badge.getBoundingClientRect().width, innerWidth: toggle.getBoundingClientRect().width, chrome: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth) }
  })
  assert.ok(Math.abs(geometry.width - geometry.innerWidth - geometry.chrome) < 1, `collapsed badge has no extra wrapper width: ${JSON.stringify(geometry)}`)
  await page.click('#concrete [data-usage-badge-toggle]')
  assert.equal((await badgeState('concrete')).expanded, 'true')
  assert.equal(await page.$eval('#concrete [data-usage-seq-value]', node => node.textContent), '123')
  assert.deepEqual(await page.$eval('#concrete [data-usage-seq-copy]', button => ({
    outerTag: button.closest('[data-usage-badge]').tagName,
    toggleTag: button.closest('[data-usage-badge]').querySelector('[data-usage-badge-toggle]').tagName,
    copyTag: button.tagName,
    nested: !!button.closest('[data-usage-badge-toggle]'),
    label: button.getAttribute('aria-label'),
    title: button.getAttribute('title'),
  })), { outerTag: 'DIV', toggleTag: 'BUTTON', copyTag: 'BUTTON', nested: false, label: 'Copy message reference', title: 'Copy message reference' })
  const scrollBefore = await page.$eval('#concrete [data-usage-seq-copy]', button => { button.scrollIntoView({ block: 'center' }); return window.scrollY })
  await page.click('#concrete [data-usage-seq-copy]')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 1)
  assert.deepEqual(await clipboardWrites(), ['sessionId=example/main msg#123'])
  assert.equal((await badgeState('concrete')).expanded, 'true', 'copy never toggles the badge')
  assert.equal(await page.evaluate(() => window.scrollY), scrollBefore, 'copy does not scroll to bottom')
  assert.equal(await page.$eval('#concrete [data-usage-seq-copy]', node => node.getAttribute('title')), 'Copied message reference')
  await page.focus('#concrete [data-usage-seq-copy]')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 2)
  await page.keyboard.press('Space')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 3)
  assert.deepEqual(await clipboardWrites(), Array(3).fill('sessionId=example/main msg#123'))
  assert.equal((await badgeState('concrete')).expanded, 'true')
  await page.click('#concrete [data-usage-seq-value]')
  assert.equal((await badgeState('concrete')).expanded, 'false', 'normal Seq row area still collapses the badge')
})

test('an aggregate shows one actual model-seq range and one recall-range copy, then separate member badges', async () => {
  await mountFixture()
  assert.ok((await badgeState('groupSeq')).text.includes('C5I7O9'))
  assert.equal(await page.$$eval('#groupSeq [data-usage-seq-row], #groupSeq [data-usage-seq-copy]', nodes => nodes.length), 0)
  await page.click('#groupSeq [data-usage-badge-toggle]')
  assert.equal(await page.$eval('#groupSeq [data-usage-seq-value]', node => node.textContent), '123 ~ 130')
  assert.equal(await page.$$eval('#groupSeq [data-usage-seq-copy]', nodes => nodes.length), 1)
  assert.ok((await badgeState('groupSeq')).text.includes('Calls2'))
  await page.click('#groupSeq [data-usage-seq-copy]')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 1)
  assert.deepEqual(await clipboardWrites(), ['sessionId=example/main msg#123-130'])
  assert.equal(await page.$eval('#groupSeq [data-tool-group]', node => node.dataset.toolGroupExpanded), 'false', 'copy does not expand the tool group')
  assert.equal((await badgeState('groupSeq')).expanded, 'true')

  await page.click('#groupSeq [aria-label="Expand tool group"]')
  await page.waitForFunction(() => document.querySelectorAll('#groupSeq [data-usage-badge]').length === 2)
  const members = await page.$$eval('#groupSeq [data-usage-badge]', badges => badges.map(badge => badge.textContent.replace(/\s+/g, '').trim()))
  assert.equal(members.length, 2, 'two usage-bearing model messages, not three tool calls or either tool response')
  assert.equal(await page.$$eval('#groupSeq .foxwarm-system-message-card', cards => cards.length), 1, 'intervening event belongs in the range but contributes no usage badge')
  assert.ok(members[0].includes('C1I2O3'), members[0])
  assert.ok(members[1].includes('C4I5O6'), members[1])
  const memberBadges = await page.$$('#groupSeq [data-usage-badge]')
  for (const [index, badge] of memberBadges.entries()) {
    await badge.$eval('[data-usage-badge-toggle]', toggle => toggle.click())
    assert.equal(await badge.$eval('[data-usage-seq-value]', node => node.textContent), index === 0 ? '123' : '130')
    await badge.$eval('[data-usage-seq-copy]', button => button.click())
    await page.waitForFunction(expected => window.usageClipboard.writes.length === expected, {}, index + 2)
    await badge.$eval('[data-usage-badge-toggle]', toggle => toggle.click())
  }
  assert.deepEqual(await clipboardWrites(), [
    'sessionId=example/main msg#123-130',
    'sessionId=example/main msg#123',
    'sessionId=example/main msg#130',
  ])
  assert.equal(await page.$eval('#groupSeq [data-tool-group]', node => node.dataset.toolGroupExpanded), 'true', 'copy keeps the expanded group open')

  await page.click('#oneModelManyCalls [data-usage-badge-toggle]')
  assert.equal(await page.$eval('#oneModelManyCalls [data-usage-seq-value]', node => node.textContent), '123', 'multiple calls in one model message keep one sequence')
  assert.ok((await badgeState('oneModelManyCalls')).text.includes('Calls1'))
  await page.click('#oneModelManyCalls [data-usage-seq-copy]')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 4)
  assert.equal((await clipboardWrites())[3], 'sessionId=example/main msg#123')
})

test('keyboard copy on an aggregate leaves the badge and tool group open state untouched', async () => {
  await mountFixture()
  await page.click('#groupSeq [data-usage-badge-toggle]')
  await page.focus('#groupSeq [data-usage-seq-copy]')
  const scrollBefore = await page.evaluate(() => window.scrollY)
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 1)
  await page.keyboard.press('Space')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 2)
  assert.deepEqual(await clipboardWrites(), Array(2).fill('sessionId=example/main msg#123-130'))
  assert.equal((await badgeState('groupSeq')).expanded, 'true')
  assert.equal(await page.$eval('#groupSeq [data-tool-group]', node => node.dataset.toolGroupExpanded), 'false')
  assert.equal(await page.evaluate(() => window.scrollY), scrollBefore)
})

test('missing, invalid or unsafe persisted sequences cannot produce a copyable reference', async () => {
  await mountFixture()
  for (const id of ['seqMissing', 'seqZero', 'seqFraction', 'seqString', 'seqUnsafe', 'groupMissingSeq']) {
    await page.$eval(`#${id} [data-usage-badge-toggle]`, toggle => toggle.click())
    assert.equal(await page.$eval(`#${id} [data-usage-seq-value]`, node => node.textContent), 'unavailable', id)
    assert.equal(await page.$$eval(`#${id} [data-usage-seq-copy]`, buttons => buttons.length), 0, id)
  }
  assert.deepEqual(await clipboardWrites(), [])
})

test('stream commit updates an already-expanded badge and the stable collapsed-group attribution cache', async () => {
  await mountFixture()
  await page.click('#stream [data-usage-badge-toggle]')
  assert.equal(await page.$eval('#stream [data-usage-seq-value]', node => node.textContent), 'unavailable')
  await page.evaluate(() => {
    window.streamBadgeBeforeCommit = document.querySelector('#stream [data-usage-badge]')
    window.commitStreamSeq(432)
  })
  await page.waitForFunction(() => document.querySelector('#stream [data-usage-seq-value]')?.textContent === '432')
  assert.equal(await page.evaluate(() => document.querySelector('#stream [data-usage-badge]') === window.streamBadgeBeforeCommit), true, 'stable request key retains the expanded badge')
  assert.equal((await badgeState('stream')).expanded, 'true')
  await page.click('#stream [data-usage-seq-copy]')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 1)
  assert.deepEqual(await clipboardWrites(), ['sessionId=example/main msg#432'])

  await page.click('#groupSeq [data-usage-badge-toggle]')
  await page.evaluate(() => window.commitGroupSeq(125))
  await page.waitForFunction(() => document.querySelector('#groupSeq [data-usage-seq-value]')?.textContent === '125 ~ 130')
  assert.equal((await badgeState('groupSeq')).expanded, 'true')
  await page.click('#groupSeq [data-usage-seq-copy]')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 2)
  assert.deepEqual(await clipboardWrites(), ['sessionId=example/main msg#432', 'sessionId=example/main msg#125-130'])
})

test('clipboard rejection never shows a false copied state or toggles the badge', async () => {
  await mountFixture()
  await page.click('#concrete [data-usage-badge-toggle]')
  await page.evaluate(() => { window.usageClipboard.fail = true })
  await page.click('#concrete [data-usage-seq-copy]')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(await page.$eval('#concrete [data-usage-seq-copy]', button => button.getAttribute('title')), 'Copy message reference')
  assert.deepEqual(await clipboardWrites(), [])
  assert.equal((await badgeState('concrete')).expanded, 'true')
  await page.evaluate(() => { window.usageClipboard.fail = false })
  await page.click('#concrete [data-usage-seq-copy]')
  await page.waitForFunction(() => window.usageClipboard.writes.length === 1)
  assert.equal(await page.$eval('#concrete [data-usage-seq-copy]', node => node.getAttribute('title')), 'Copied message reference')
})
