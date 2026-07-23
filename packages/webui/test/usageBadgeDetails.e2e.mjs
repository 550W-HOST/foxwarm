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
    const toolResponse = (id) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'read', response: { output: 'ok' } } }], __meta: { seq: id + '-response', timestamp: 1700000001000 } })
    const toolCall = (id, modelId, virtualModelKey, timestamp) => ({
      role: 'model',
      parts: [{ functionCall: { id, name: 'read', args: { filePath: '/tmp/example.txt' } } }],
      __meta: { seq: id, usage: usage(10, 20, 30), modelId, virtualModelKey, timestamp },
    })
    const longVirtualKey = 'virtual/' + 'route-key-'.repeat(45)
    const cases = {
      concrete: { messages: [{ role: 'model', parts: [{ text: 'Concrete response' }], __meta: { seq: 1, usage: usage(11, 22, 33), modelId: 'provider/real-model', timestamp: 1700000000000 } }] },
      virtual: { messages: [{ role: 'model', parts: [{ text: 'Virtual response' }], __meta: { seq: 2, usage: usage(1, 2, 3), modelId: 'provider/real-model', virtualModelKey: 'session-hash/virtual', timestamp: 1700000000000 } }] },
      missing: { messages: [{ role: 'model', parts: [{ text: 'Legacy response' }], __meta: { seq: 3, usage: usage(1, 2, 3) } }] },
      invalid: { messages: [{ role: 'model', parts: [{ text: 'Invalid legacy response' }], __meta: { seq: 31, usage: usage(1, 2, 3), modelId: 'provider/invalid', timestamp: 'not-a-persisted-timestamp' } }] },
      groupSame: { groupTools: true, messages: [toolCall('same-one', 'provider/real-model', 'virtual/same', 1700000000000), toolResponse('same-one'), toolCall('same-two', 'provider/real-model', 'virtual/same', 1700000000000), toolResponse('same-two'), { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 'same-final' } }] },
      groupDifferent: { groupTools: true, messages: [toolCall('different-one', 'provider/first-model', 'virtual/first', 1700000000000), toolResponse('different-one'), toolCall('different-two', 'provider/second-model', 'virtual/second', 1700000060000), toolResponse('different-two'), { role: 'model', parts: [{ text: 'Tools complete.' }], __meta: { seq: 'different-final' } }] },
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
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-chat-timeline').length === 8)
  assert.equal(await page.$$eval('[data-usage-badge]', badges => badges.length), 7)
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

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the usage badge browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()

  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{padding:16px}.fixture{width:900px;max-width:100%;min-width:0;margin-bottom:24px}</style></head><body><main>${['concrete', 'virtual', 'missing', 'invalid', 'groupSame', 'groupDifferent', 'longMobile', 'hidden'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
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
  assert.equal(collapsed.text, 'C11I22O33')

  await page.click('#concrete [data-usage-badge]')
  const expanded = await badgeState('concrete')
  assert.equal(expanded.expanded, 'true')
  for (const label of ['Cached11', 'Input22', 'Output33', 'Time', 'Modelprovider/real-model']) {
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
  await page.click('#virtual [data-usage-badge]')
  assert.ok((await badgeState('virtual')).text.includes('Modelsession-hash/virtual → provider/real-model'))

  await page.click('#missing [data-usage-badge]')
  const missing = await badgeState('missing')
  assert.ok(missing.text.includes('Timeunavailable'))
  assert.ok(missing.text.includes('Modelunavailable'))

  await page.click('#invalid [data-usage-badge]')
  assert.ok((await badgeState('invalid')).text.includes('Timeinvalid timestamp'))
})

test('collapsed tool-group details aggregate calls without attributing them to the first route, and badge click does not expand the group', async () => {
  await mountFixture()
  await page.click('#groupSame [data-usage-badge]')
  const same = await badgeState('groupSame')
  assert.ok(same.text.includes('Calls2'), same.text)
  assert.ok(same.text.includes('Modelvirtual/same → provider/real-model'), same.text)
  assert.equal(await page.$$eval('#groupSame .foxwarm-tool-card', cards => cards.length), 0, 'badge click must not expand the tool group')
  assert.equal(await page.$$eval('#groupSame [data-usage-badge]', badges => badges.length), 1, 'badge remains the collapsed-group interaction target')

  await page.click('#groupDifferent [data-usage-badge]')
  const different = await badgeState('groupDifferent')
  assert.ok(different.text.includes('Modelvirtual/first → provider/first-model • virtual/second → provider/second-model'), different.text)
  assert.ok(different.text.includes(' – '), 'different persisted call times render as an accurate range')
})

test('expanded long model keys remain contained on desktop and mobile, and the setting still hides badges', async () => {
  await mountFixture(1100)
  await page.click('#longMobile [data-usage-badge]')
  let layout = await badgeState('longMobile')
  assert.ok(layout.fixtureOverflow <= 1, `desktop fixture overflowed by ${layout.fixtureOverflow}px`)
  assert.ok(layout.documentOverflow <= 1, `desktop document overflowed by ${layout.documentOverflow}px`)
  assert.equal(await page.$$eval('#hidden [data-usage-badge]', badges => badges.length), 0)

  await mountFixture(390)
  await page.click('#longMobile [data-usage-badge]')
  layout = await badgeState('longMobile')
  assert.ok(layout.fixtureOverflow <= 1, `mobile fixture overflowed by ${layout.fixtureOverflow}px`)
  assert.ok(layout.documentOverflow <= 1, `mobile document overflowed by ${layout.documentOverflow}px`)
})
