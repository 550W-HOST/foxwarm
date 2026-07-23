import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const toolEntry = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import { InterleavedToolGroup, ToolCallsBlock } from ${JSON.stringify(toolEntry)}

    const longPath = '/workspace/' + 'nested-directory/'.repeat(18) + 'tool-header.tsx'
    const longCommand = 'printf ' + 'long-command-argument '.repeat(45)
    const longResult = 'long result content '.repeat(70)
    const fixtures = {
      exec: {
        call: { id: 'exec-call', name: 'exec', args: { command: longCommand } },
        response: { tool_use_id: 'exec-call', name: 'exec', response: { output: longResult } },
      },
      edit: {
        call: { id: 'edit-call', name: 'edit', args: { filePath: longPath, oldText: 'before', newText: 'after' } },
        response: { tool_use_id: 'edit-call', name: 'edit', response: { output: 'File edited successfully' } },
      },
      error: {
        call: { id: 'error-call', name: 'exec', args: { command: longCommand } },
        response: { tool_use_id: 'error-call', name: 'exec', response: { error: longResult } },
      },
    }
    window.openedCodePaths = []
    const onOpenCodeFile = (filePath, lines) => window.openedCodePaths.push({ filePath, lines })
    for (const [id, fixture] of Object.entries(fixtures)) {
      const msg = { role: 'model', parts: [{ functionCall: fixture.call }], __meta: { timestamp: Date.now() } }
      const nextMsg = { role: 'tool', parts: [{ functionResponse: fixture.response }] }
      createRoot(document.getElementById(id)).render(React.createElement(InterleavedToolGroup, { msg, nextMsg, messageKeyPrefix: id, onOpenCodeFile }))
    }
    const noResult = { role: 'model', parts: [{ functionCall: { id: 'wait-call', name: 'wait', args: { reason: longResult, timeoutSeconds: 0 } } }], __meta: { timestamp: Date.now() } }
    createRoot(document.getElementById('noResult')).render(React.createElement(ToolCallsBlock, { msg: noResult }))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'tool-args-header-fixture.tsx' },
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

async function mountFixture({ width, height, style = 'default', dark = false }) {
  await page.setViewport({ width, height, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.evaluate(({ style, dark }) => {
    document.documentElement.classList.toggle('dark', dark)
    if (style === '550a') document.documentElement.setAttribute('data-foxwarm-ui-style', '550a')
    else document.documentElement.removeAttribute('data-foxwarm-ui-style')
  }, { style, dark })
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-tool-card').length === 4)
}

async function readVisualState(id) {
  return page.$eval(`#${id}`, (root) => {
    const effectiveBackground = (element) => {
      for (let current = element; current instanceof Element; current = current.parentElement) {
        const color = getComputedStyle(current).backgroundColor
        if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
      }
      return 'transparent'
    }
    const card = root.querySelector('.foxwarm-tool-card')
    const header = root.querySelector('.foxwarm-tool-header')
    const actions = root.querySelector('.foxwarm-tool-card > .foxwarm-tool-action-buttons')
    const args = root.querySelector('.foxwarm-tool-call-args')
    const result = root.querySelector('.foxwarm-tool-result-content, .foxwarm-tool-result-preview') || header?.nextElementSibling
    const summary = root.querySelector('.foxwarm-tool-call-summary')
    const expandedText = args?.querySelector('.whitespace-pre-wrap')
    const resultText = result?.querySelector('.whitespace-pre-wrap') || result
    const cardRect = card.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    const argsRect = args?.getBoundingClientRect()
    const resultRect = result?.getBoundingClientRect()
    const summaryStyle = summary ? getComputedStyle(summary) : null
    const expandedStyle = expandedText ? getComputedStyle(expandedText) : null
    const resultStyle = resultText ? getComputedStyle(resultText) : null
    return {
      headerBackground: effectiveBackground(header),
      argsBackground: args ? effectiveBackground(args) : null,
      resultBackground: result ? effectiveBackground(result) : null,
      argsInsideHeader: !!args && header.contains(args),
      headerLeftDelta: Math.abs(headerRect.left - cardRect.left),
      headerRightDelta: Math.abs(headerRect.right - cardRect.right),
      actionsWithinHeader: actionsRect.top >= headerRect.top - 1 && actionsRect.bottom <= headerRect.bottom + 1,
      argsBottomDelta: argsRect ? Math.abs(headerRect.bottom - argsRect.bottom) : null,
      resultStartsAfterHeader: resultRect ? resultRect.top >= headerRect.bottom - 1 : null,
      dividerCount: root.querySelectorAll('.foxwarm-tool-expanded-content > .my-2.border-t').length,
      summaryWhiteSpace: summaryStyle?.whiteSpace || null,
      summaryOverflow: summaryStyle?.overflowX || null,
      summaryTextOverflow: summaryStyle?.textOverflow || null,
      summaryHeight: summary?.getBoundingClientRect().height || null,
      summaryLineHeight: summaryStyle ? Number.parseFloat(summaryStyle.lineHeight) : null,
      expandedWhiteSpace: expandedStyle?.whiteSpace || null,
      expandedHeight: expandedText?.getBoundingClientRect().height || null,
      expandedLineHeight: expandedStyle ? Number.parseFloat(expandedStyle.lineHeight) : null,
      resultHeight: resultText?.getBoundingClientRect().height || null,
      resultLineHeight: resultStyle ? Number.parseFloat(resultStyle.lineHeight) : null,
      rootOverflow: root.scrollWidth - root.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

async function readCollapseTargetState(id) {
  return page.$eval(`#${id}`, (root) => {
    const card = root.querySelector('.foxwarm-tool-card')
    const header = root.querySelector('.foxwarm-tool-header')
    const toggle = root.querySelector('.foxwarm-tool-header-toggle')
    const args = root.querySelector('.foxwarm-tool-call-args')
    const result = root.querySelector('.foxwarm-tool-result-content, .foxwarm-tool-result-preview')
    const summary = root.querySelector('.foxwarm-tool-call-summary')
    return {
      expanded: !!args,
      cardCursor: getComputedStyle(card).cursor,
      headerCursor: getComputedStyle(header).cursor,
      toggleCursor: getComputedStyle(toggle).cursor,
      argsCursor: args ? getComputedStyle(args).cursor : null,
      resultCursor: result ? getComputedStyle(result).cursor : null,
      toggleColor: getComputedStyle(toggle).color,
      summaryColor: summary ? getComputedStyle(summary).color : null,
      cardHasPointerClass: card.classList.contains('cursor-pointer'),
      headerHasPointerClass: header.classList.contains('cursor-pointer'),
      toggleHasPointerClass: toggle.classList.contains('cursor-pointer'),
      toggleHasTextHoverClass: [...toggle.classList].some(className => className.startsWith('hover:text-') || className.startsWith('dark:hover:text-')),
    }
  })
}

function assertCollapseTargetState(state, expanded) {
  assert.equal(state.expanded, expanded)
  assert.notEqual(state.cardCursor, 'pointer')
  assert.notEqual(state.headerCursor, 'pointer')
  assert.equal(state.toggleCursor, 'pointer')
  assert.equal(state.cardHasPointerClass, false)
  assert.equal(state.headerHasPointerClass, false)
  assert.equal(state.toggleHasPointerClass, true)
  assert.equal(state.toggleHasTextHoverClass, false)
  if (state.argsCursor !== null) assert.notEqual(state.argsCursor, 'pointer')
  if (state.resultCursor !== null) assert.notEqual(state.resultCursor, 'pointer')
}

async function assertHeaderHoverKeepsTextColor(id) {
  await page.mouse.move(0, 0)
  const before = await readCollapseTargetState(id)
  await page.hover(`#${id} .foxwarm-tool-header-toggle`)
  const hovered = await readCollapseTargetState(id)
  assert.equal(hovered.toggleColor, before.toggleColor)
  assert.equal(hovered.summaryColor, before.summaryColor)
}

async function clickWithoutToggling(selector, expectedExpanded) {
  await page.$eval(selector, (element) => element.click())
  assert.equal(await page.$eval('#exec', root => !!root.querySelector('.foxwarm-tool-call-args')), expectedExpanded)
}

function assertCollapsed(state) {
  assert.equal(state.summaryWhiteSpace, 'nowrap')
  assert.equal(state.summaryOverflow, 'hidden')
  assert.equal(state.summaryTextOverflow, 'ellipsis')
  assert.ok(state.summaryHeight <= state.summaryLineHeight + 2)
  assert.notEqual(state.headerBackground, state.resultBackground)
  assert.equal(state.actionsWithinHeader, true)
  assert.ok(state.headerLeftDelta <= 1 && state.headerRightDelta <= 1)
  assert.ok(state.rootOverflow <= 1 && state.documentOverflow <= 1)
}

function assertExpanded(state, { hasResult = true } = {}) {
  assert.equal(state.argsInsideHeader, true)
  assert.equal(state.argsBackground, state.headerBackground)
  assert.ok(state.argsBottomDelta <= 5)
  assert.equal(state.dividerCount, 0)
  assert.equal(state.actionsWithinHeader, true)
  assert.ok(state.headerLeftDelta <= 1 && state.headerRightDelta <= 1)
  if (hasResult) {
    assert.notEqual(state.headerBackground, state.resultBackground)
    assert.equal(state.resultStartsAfterHeader, true)
  }
  assert.ok(state.rootOverflow <= 1 && state.documentOverflow <= 1)
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the tool args/header browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{width:100%;padding:12px}.fixture{width:100%;min-width:0}</style></head><body><main>${['exec', 'edit', 'error', 'noResult'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
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

test('default desktop keeps call args in the dark header and results on the light surface', async () => {
  await mountFixture({ width: 900, height: 800 })
  for (const id of ['exec', 'edit', 'error']) assertCollapsed(await readVisualState(id))

  await page.click('#edit .foxwarm-tool-code-path')
  assert.equal(await page.evaluate(() => window.openedCodePaths.length), 1)
  assert.equal(await page.$eval('#edit', root => !!root.querySelector('.foxwarm-tool-call-args')), false, 'Code click does not expand')

  for (const id of ['exec', 'edit', 'error', 'noResult']) {
    await page.click(`#${id} .foxwarm-tool-tag`)
    assertExpanded(await readVisualState(id), { hasResult: id !== 'noResult' })
  }
  await page.click('#edit .foxwarm-tool-call-args .foxwarm-tool-code-path')
  assert.equal(await page.evaluate(() => window.openedCodePaths.length), 2)
  assert.equal(await page.$eval('#edit', root => !!root.querySelector('.foxwarm-tool-call-args')), true, 'expanded Code click does not collapse')
  const exec = await readVisualState('exec')
  assert.equal(exec.expandedWhiteSpace, 'pre-wrap')
  assert.ok(exec.expandedHeight > exec.expandedLineHeight * 1.5)
  assert.ok(exec.resultHeight > exec.resultLineHeight * 1.5)
})

test('dark and mobile 550A retain header continuity and bounded call/result content', async () => {
  for (const fixture of [
    { width: 900, height: 800, dark: true },
    { width: 390, height: 760, style: '550a', dark: false },
    { width: 390, height: 760, style: '550a', dark: true },
  ]) {
    await mountFixture(fixture)
    assertCollapsed(await readVisualState('exec'))
    await page.click('#exec .foxwarm-tool-tag')
    assertExpanded(await readVisualState('exec'))
  }
})

test('only the top tool header row advertises and handles collapse toggling', async () => {
  for (const fixture of [
    { width: 900, height: 800 },
    { width: 390, height: 760, style: '550a', dark: true },
  ]) {
    await mountFixture(fixture)
    assertCollapseTargetState(await readCollapseTargetState('exec'), false)
    await assertHeaderHoverKeepsTextColor('exec')

    await clickWithoutToggling('#exec .foxwarm-tool-card', false)
    await clickWithoutToggling('#exec .foxwarm-tool-header', false)
    await clickWithoutToggling('#exec .foxwarm-tool-result-preview', false)

    await page.click('#exec .foxwarm-tool-header-toggle')
    assertCollapseTargetState(await readCollapseTargetState('exec'), true)
    await assertHeaderHoverKeepsTextColor('exec')

    await clickWithoutToggling('#exec .foxwarm-tool-header', true)
    await clickWithoutToggling('#exec .foxwarm-tool-call-args', true)
    await clickWithoutToggling('#exec .foxwarm-tool-result-content', true)

    await page.click('#exec .foxwarm-tool-header-toggle')
    assertCollapseTargetState(await readCollapseTargetState('exec'), false)
  }
})
