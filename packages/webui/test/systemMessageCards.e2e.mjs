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

    const image = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png' }
    const longBody = 'overflow-safe-body-' + 'x'.repeat(360)
    const cases = {
      event: { messages: [{ role: 'user', parts: [{ text: '<foxwarm-system kind="event" type="wait-timeout">\\nwait timeout reached for sessionId: \`child/session\`\\n</foxwarm-system>' }, { inlineData: image }], __meta: { seq: 1 } }] },
      interAgent: { messages: [{ role: 'user', parts: [{ text: '<foxwarm-message type="inter-agent" sourceSessionId="parent/child">\\nchild report body\\n</foxwarm-message>' }], __meta: { seq: 2 } }] },
      sessionBoundary: { messages: [{ role: 'user', parts: [{ text: '<foxwarm-system kind="session-boundary" event="new-child">\\nboundary body\\n</foxwarm-system>' }], __meta: { seq: 21 } }] },
      legacy: { messages: [{ role: 'user', parts: [{ system: 'legacy system notification' }], __meta: { seq: 3 } }] },
      direct: { messages: [{ role: 'user', parts: [{ text: '<foxwarm-message type="channel">\\ndirect user body\\n</foxwarm-message>' }], __meta: { seq: 4 } }] },
      mixed: { messages: [{ role: 'user', parts: [{ text: '<foxwarm-message type="channel">\\nold wrapper\\n</foxwarm-message>\\n<foxwarm-system kind="event">\\n' + longBody + '\\n</foxwarm-system>' }], __meta: { seq: 5 } }] },
      nested: { nestedDepth: 1, messages: [{ role: 'user', parts: [{ text: '<foxwarm-system kind="snapshot">\\nnested system body\\n</foxwarm-system>' }], __meta: { seq: 6 } }] },
      spacing: { messages: [
        { role: 'model', parts: [{ text: 'first model response' }], __meta: { seq: 7 } },
        { role: 'user', parts: [{ text: '<foxwarm-system kind="event">\\nevent row\\n</foxwarm-system>' }], __meta: { seq: 8 } },
        { role: 'user', parts: [{ text: '<foxwarm-message type="inter-agent">\\nchild row\\n</foxwarm-message>' }], __meta: { seq: 9 } },
        { role: 'model', parts: [{ text: 'second model response' }], __meta: { seq: 10 } },
        { role: 'user', parts: [{ text: 'a direct user turn' }], __meta: { seq: 11 } },
        { role: 'model', parts: [{ text: 'model after direct user' }], __meta: { seq: 12 } },
      ] },
    }

    for (const [id, fixture] of Object.entries(cases)) {
      createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
        sessionId: 'fixture/main',
        messages: fixture.messages,
        isMobile: window.innerWidth < 768,
        groupTools: false,
        showUsageBadge: false,
        nestedDepth: fixture.nestedDepth || 0,
      }))
    }
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'system-message-cards-fixture.tsx' },
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

async function mountFixture(width = 900, dark = false) {
  await page.setViewport({ width, height: 700, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate((dark) => document.documentElement.classList.toggle('dark', dark), dark)
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-chat-timeline').length === 8)
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the system message card browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()

  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{padding:16px}.fixture{width:900px;max-width:100%;min-width:0;margin-bottom:20px}</style></head><body><main>${['event', 'interAgent', 'sessionBoundary', 'legacy', 'direct', 'mixed', 'nested', 'spacing'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
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

test('heavy system and non-channel messages use kind-tagged thread cards while direct users stay bubbles', async () => {
  await mountFixture()
  for (const [id, kind] of [['event', 'event'], ['interAgent', 'inter-agent'], ['sessionBoundary', 'session-boundary'], ['legacy', 'system'], ['mixed', 'event'], ['nested', 'snapshot']]) {
    const card = await page.$eval(`#${id} [data-system-message-card]`, element => ({
      kind: element.getAttribute('data-system-message-kind'),
      expanded: element.querySelector('button')?.getAttribute('aria-expanded'),
      tag: element.querySelector('.foxwarm-system-message-tag')?.textContent?.trim(),
      hasThreadLine: !!element.querySelector('.foxwarm-system-message-thread-line'),
      marginTop: getComputedStyle(element).marginTop,
      marginBottom: getComputedStyle(element).marginBottom,
    }))
    assert.equal(card.kind, kind, `${id} tag kind`)
    assert.equal(card.expanded, 'false', `${id} starts collapsed`)
    assert.equal(card.tag, kind, `${id} visible tag`)
    assert.equal(card.hasThreadLine, true, `${id} has shared thread-line control`)
    assert.equal(card.marginTop, '2px', `${id} uses the shared thread-card top margin`)
    assert.equal(card.marginBottom, '2px', `${id} uses the shared thread-card bottom margin`)
  }
  assert.match((await page.$eval('#event [data-system-message-card]', element => element.querySelector('.foxwarm-system-message-tag svg')?.getAttribute('class') || '')).toString(), /lucide-bell/)
  assert.match((await page.$eval('#interAgent [data-system-message-card]', element => element.querySelector('.foxwarm-system-message-tag svg')?.getAttribute('class') || '')).toString(), /lucide-messages-square/)
  assert.match((await page.$eval('#legacy [data-system-message-card]', element => element.querySelector('.foxwarm-system-message-tag svg')?.getAttribute('class') || '')).toString(), /lucide-info/)

  assert.equal(await page.$$('#direct [data-system-message-card]').then(nodes => nodes.length), 0)
  assert.equal(await page.$$('#direct .foxwarm-user-message-bubble').then(nodes => nodes.length), 1)
  assert.equal(await page.$eval('#direct .foxwarm-chat-timeline > div', row => getComputedStyle(row).justifyContent), 'flex-end')
  assert.equal(await page.$eval('#event .foxwarm-chat-timeline > div', row => getComputedStyle(row).justifyContent), 'flex-start')
  assert.equal(await page.$eval('#event .foxwarm-system-message-preview', preview => preview.textContent), 'wait-timeout: wait timeout reached for sessionId: `child/session`')
  assert.equal(await page.$eval('#interAgent .foxwarm-system-message-preview', preview => preview.textContent), 'parent/child: child report body')
  assert.equal(await page.$eval('#sessionBoundary .foxwarm-system-message-preview', preview => preview.textContent), 'new-child: boundary body')
  assert.equal(await page.$eval('#interAgent .foxwarm-system-message-preview a', link => link.getAttribute('href')), '#session/parent%2Fchild')
  await page.click('#interAgent .foxwarm-system-message-preview a')
  assert.match(page.url(), /#session\/parent%2Fchild$/)
  assert.equal(await page.$eval('#interAgent [data-system-message-card] button', button => button.getAttribute('aria-expanded')), 'false', 'preview link navigation does not expand the card')
  assert.equal(await page.$$('#event img').then(nodes => nodes.length), 1, 'event image remains rendered')
})

test('system cards expand/collapse, preserve session links, and retain width containment', async () => {
  await mountFixture(390)
  await page.click('#event [data-system-message-card]')
  assert.equal(await page.$eval('#event [data-system-message-card] button', button => button.getAttribute('aria-expanded')), 'true')
  assert.equal(await page.$eval('#event .foxwarm-system-message-body a', link => link.getAttribute('href')), '#session/child%2Fsession')
  assert.ok(await page.$eval('#event .foxwarm-system-message-body', body => body.textContent.includes('wait timeout reached')))

  await page.click('#event .foxwarm-system-message-header')
  assert.equal(await page.$eval('#event [data-system-message-card] button', button => button.getAttribute('aria-expanded')), 'false')

  await page.click('#interAgent [data-system-message-card] button')
  assert.equal(await page.$eval('#interAgent .foxwarm-system-message-body a', link => link.getAttribute('href')), '#session/parent%2Fchild')
  assert.equal(await page.$eval('#interAgent .foxwarm-system-message-body', body => body.textContent), '<foxwarm-message type="inter-agent" sourceSessionId="parent/child">child report body</foxwarm-message>')

  const overflow = await page.$eval('#mixed', fixture => ({
    fixture: fixture.scrollWidth - fixture.clientWidth,
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    nestedWidth: document.querySelector('#nested [data-system-message-card]')?.getBoundingClientRect().width || 0,
    nestedTimelineWidth: document.querySelector('#nested .foxwarm-chat-timeline')?.getBoundingClientRect().width || 0,
  }))
  assert.ok(overflow.fixture <= 1)
  assert.ok(overflow.document <= 1)
  assert.ok(overflow.nestedWidth <= overflow.nestedTimelineWidth + 1)
})

test('every system kind uses the yellow thread-card palette in light and dark themes', async () => {
  await mountFixture()
  const previewLight = await page.$$eval('#event .foxwarm-system-message-preview, #interAgent .foxwarm-system-message-preview', previews => previews.map(preview => getComputedStyle(preview).color))
  await page.click('#event [data-system-message-card]')
  await page.click('#interAgent [data-system-message-card]')
  await page.mouse.move(0, 0)
  await new Promise(resolve => setTimeout(resolve, 200))

  const colors = await page.evaluate(() => {
    const sample = (id) => {
      const card = document.querySelector(`#${id} [data-system-message-card]`)
      const header = card.querySelector('.foxwarm-system-message-header')
      const tag = card.querySelector('.foxwarm-system-message-tag')
      const line = card.querySelector('.foxwarm-system-message-thread-line')
      const body = card.querySelector('.foxwarm-system-message-body')
      return {
        tone: card.getAttribute('data-system-message-tone'),
        surface: getComputedStyle(card).backgroundColor,
        header: getComputedStyle(header).backgroundColor,
        tag: getComputedStyle(tag).backgroundColor,
        line: getComputedStyle(line).color,
        body: getComputedStyle(body).color,
      }
    }
    return { event: sample('event'), interAgent: sample('interAgent') }
  })

  assert.deepEqual(colors.event, {
    tone: 'system',
    surface: 'rgba(254, 252, 232, 0.55)',
    header: 'rgba(254, 249, 195, 0.8)',
    tag: 'rgb(254, 249, 195)',
    line: 'rgb(253, 224, 71)',
    body: 'rgb(51, 65, 85)',
  })
  assert.deepEqual(colors.interAgent, colors.event, 'every system kind shares the amber card tone')
  assert.deepEqual(previewLight, ['rgb(51, 65, 85)', 'rgb(51, 65, 85)'])

  await mountFixture(900, true)
  const previewDark = await page.$$eval('#event .foxwarm-system-message-preview, #interAgent .foxwarm-system-message-preview', previews => previews.map(preview => getComputedStyle(preview).color))
  await page.click('#event [data-system-message-card]')
  await page.click('#interAgent [data-system-message-card]')
  await page.mouse.move(0, 0)
  await new Promise(resolve => setTimeout(resolve, 200))
  const systemDark = await page.evaluate(() => {
    const sample = (id) => {
      const card = document.querySelector(`#${id} [data-system-message-card]`)
      return {
        surface: getComputedStyle(card).backgroundColor,
        header: getComputedStyle(card.querySelector('.foxwarm-system-message-header')).backgroundColor,
        tag: getComputedStyle(card.querySelector('.foxwarm-system-message-tag')).backgroundColor,
        line: getComputedStyle(card.querySelector('.foxwarm-system-message-thread-line')).color,
        body: getComputedStyle(card.querySelector('.foxwarm-system-message-body')).color,
      }
    }
    return { event: sample('event'), interAgent: sample('interAgent') }
  })
  const expectedDark = {
    surface: 'rgba(113, 63, 18, 0.1)',
    header: 'rgba(133, 77, 14, 0.2)',
    tag: 'rgba(113, 63, 18, 0.2)',
    line: 'rgb(161, 98, 7)',
    body: 'rgb(203, 213, 225)',
  }
  assert.deepEqual(systemDark.event, expectedDark)
  assert.deepEqual(systemDark.interAgent, expectedDark)
  assert.deepEqual(previewDark, ['rgb(203, 213, 225)', 'rgb(203, 213, 225)'])
})

test('heavy system cards stay in thread row groups while direct users remain turn breaks', async () => {
  await mountFixture()
  const rows = await page.$$eval('#spacing .foxwarm-chat-timeline > div', rows => rows.map(row => ({
    hasTopMargin: row.classList.contains('mt-4'),
    justifyContent: getComputedStyle(row).justifyContent,
  })))
  assert.deepEqual(rows, [
    { hasTopMargin: true, justifyContent: 'flex-start' },
    { hasTopMargin: false, justifyContent: 'flex-start' },
    { hasTopMargin: false, justifyContent: 'flex-start' },
    { hasTopMargin: false, justifyContent: 'flex-start' },
    { hasTopMargin: true, justifyContent: 'flex-end' },
    { hasTopMargin: true, justifyContent: 'flex-start' },
  ])
})
