import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

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
    const longVirtualKey = 'virtual/' + 'route-key-'.repeat(45)
    const cases = {
      concrete: { messages: [{ role: 'model', parts: [{ text: 'Concrete response' }], __meta: { seq: 1, usage: usage(11, 22, 33), modelId: 'provider/real-model', timestamp: 1700000000000, llmRequestTiming: requestTiming(1699999999000, 1700000000000) } }] },
      virtual: { messages: [{ role: 'model', parts: [{ text: 'Virtual response' }], __meta: { seq: 2, usage: usage(1, 2, 3), modelId: 'provider/real-model', virtualModelKey: 'session-hash/virtual', timestamp: 1700000000000, llmRequestTiming: requestTiming(1699999965000, 1700000000000) } }] },
      missing: { messages: [{ role: 'model', parts: [{ text: 'Legacy response' }], __meta: { seq: 3, usage: usage(1, 2, 3) } }] },
      invalid: { messages: [{ role: 'model', parts: [{ text: 'Invalid legacy response' }], __meta: { seq: 31, usage: usage(1, 2, 3), modelId: 'provider/invalid', timestamp: 'not-a-persisted-timestamp', llmRequestTiming: { startedAt: 10, completedAt: 5, durationMs: -1 } } }] },
      timed: { messages: [
        { role: 'model', parts: [{ text: 'Previous request' }], __meta: { seq: 'timed-prior', llmRequestTiming: requestTiming(1000, 2000) } },
        { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'timed-tool', name: 'exec', response: { output: 'ok' } } }], __meta: { seq: 'timed-tool' } },
        { role: 'model', parts: [{ text: 'Timed response' }], __meta: { seq: 'timed-current', usage: usage(4, 5, 6), modelId: 'provider/timed', timestamp: 6500, llmRequestTiming: requestTiming(5000, 6500) } },
      ] },
      groupSame: { groupTools: true, messages: [toolCall('same-one', 'provider/real-model', 'virtual/same', 1700000000000, 1000, 2000), toolResponse('same-one'), toolCall('same-two', 'provider/real-model', 'virtual/same', 1700000000000, 5000, 7000), toolResponse('same-two'), { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 'same-final' } }] },
      groupDifferent: { groupTools: true, messages: [toolCall('different-one', 'provider/first-model', 'virtual/first', 1700000000000, 1000, 41000), toolResponse('different-one'), toolCall('different-two', 'provider/second-model', 'virtual/second', 1700000060000, 45000, 85000), toolResponse('different-two'), { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 'different-final' } }] },
      longMobile: { messages: [{ role: 'model', parts: [{ text: 'Long route response' }], __meta: { seq: 4, usage: usage(1, 2, 3), modelId: 'provider/real-model', virtualModelKey: longVirtualKey, timestamp: 1700000000000 } }] },
      hidden: { showUsageBadge: false, messages: [{ role: 'model', parts: [{ text: 'Hidden usage' }], __meta: { seq: 5, usage: usage(1, 2, 3), modelId: 'provider/hidden', timestamp: 1700000000000 } }] },
    }

    for (const [id, fixture] of Object.entries(cases)) {
      createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main',
        messages: fixture.messages,
        isMobile: window.innerWidth < 768,
        groupTools: fixture.groupTools || false,
        showUsageBadge: fixture.showUsageBadge !== false,
      }))
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
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-chat-timeline').length === 9)
  assert.equal(await page.$$eval('[data-usage-badge]', badges => badges.length), 8)
}

async function badgeState(id) {
  return page.$eval(`#${id} [data-usage-badge]`, (badge) => ({
    expanded: badge.getAttribute('aria-expanded'),
    className: badge.className,
    text: badge.textContent.replace(/\s+/g, ' ').trim(),
    fixtureOverflow: badge.closest('.fixture').scrollWidth - badge.closest('.fixture').clientWidth,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
}

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
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{padding:16px}.fixture{width:1400px;max-width:100%;min-width:0;margin-bottom:24px}</style></head><body><main>${['concrete', 'virtual', 'missing', 'invalid', 'timed', 'groupSame', 'groupDifferent', 'longMobile', 'hidden'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
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
    tone: item.getAttribute('data-usage-timing-tone'),
  }))), [{ kind: 'api', text: '1s', title: 'API response: 1s (1000ms)', tone: 'normal' }])
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

  await page.focus('#concrete [data-usage-badge]')
  await page.keyboard.press('Enter')
  assert.equal((await badgeState('concrete')).expanded, 'false')
  await page.keyboard.press('Space')
  assert.equal((await badgeState('concrete')).expanded, 'true')
})

test('details use persisted concrete/virtual metadata and show legacy omissions honestly', async () => {
  await mountFixture()
  assert.equal(await page.$eval('#virtual [data-usage-timing-kind="api"]', item => item.getAttribute('data-usage-timing-tone')), 'warning')
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
    { kind: 'between', text: '3s', title: 'Between requests: 3s (3000ms)' },
    { kind: 'api', text: '1s', title: 'API response: 1s (1500ms)' },
  ])

  await page.click('#timed [data-usage-badge]')
  const expanded = await badgeState('timed')
  assert.ok(expanded.text.includes('Between3s (3000ms)'), expanded.text)
  assert.ok(expanded.text.includes('API1s (1500ms)'), expanded.text)
})

test('collapsed tool-group details aggregate calls without attributing them to the first route, and badge click does not expand the group', async () => {
  await mountFixture()
  await page.click('#groupSame [data-usage-badge]')
  const same = await badgeState('groupSame')
  assert.ok(same.text.includes('Calls2'), same.text)
  assert.ok(same.text.includes('Modelvirtual/same → provider/real-model'), same.text)
  assert.ok(same.text.includes('Between3s (3000ms)'), same.text)
  assert.ok(same.text.includes('API3s (3000ms)'), same.text)
  assert.equal(await page.$$eval('#groupSame .foxwarm-tool-card', cards => cards.length), 0, 'badge click must not expand the tool group')
  assert.equal(await page.$$eval('#groupSame [data-usage-badge]', badges => badges.length), 1, 'badge remains the collapsed-group interaction target')

  assert.equal(await page.$eval('#groupDifferent [data-usage-timing-kind="api"]', item => item.getAttribute('data-usage-timing-tone')), 'critical')
  await page.click('#groupDifferent [data-usage-badge]')
  const different = await badgeState('groupDifferent')
  assert.ok(different.text.includes('Modelvirtual/first → provider/first-model • virtual/second → provider/second-model'), different.text)
  assert.ok(different.text.includes(' – '), 'different persisted call times render as an accurate range')
  assert.ok(different.text.includes('API1m20s (80000ms)'), different.text)
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
})
