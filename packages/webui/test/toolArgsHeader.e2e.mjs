import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from './browserFixtureBundle.mjs'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
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
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    import { BUILTIN_THEMES, initializeThemeRuntime, setThemeSelection } from './src/theme/index'

    initializeThemeRuntime()
    window.fixtureThemeCases = BUILTIN_THEMES.flatMap(theme => ['light', 'dark'].map(colorMode => ({
      themeId: theme.id,
      colorMode,
      headerTreatment: theme.variants[colorMode].composition.header,
    })))
    window.setFixtureTheme = (style, dark) => setThemeSelection({
      themeId: style.startsWith('foxwarm.') ? style : style === '550a' ? 'foxwarm.550a' : 'foxwarm.default',
      colorMode: dark ? 'dark' : 'light',
    })

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
        response: { tool_use_id: 'edit-call', name: 'edit', response: { output: 'File edited successfully' }, executionTiming: { startedAt: 200, completedAt: 150, durationMs: 100 } },
      },
      error: {
        call: { id: 'error-call', name: 'exec', args: { command: longCommand } },
        response: { tool_use_id: 'error-call', name: 'exec', response: { error: longResult } },
      },
      send: {
        call: { id: 'send-call', name: 'send_to_session', args: { sessionId: 'agent/child', message: 'handoff body' } },
        response: { tool_use_id: 'send-call', name: 'send_to_session', response: { output: 'sent' }, executionTiming: { startedAt: 100, completedAt: 1099, durationMs: 999 } },
      },
      sendAlias: {
        call: { id: 'send-alias-call', name: 'send_to_session', args: { sessionId: '<main>', message: 'alias body' } },
        response: { tool_use_id: 'send-alias-call', name: 'send_to_session', response: { output: 'sent' }, executionTiming: { startedAt: 100, completedAt: 1100, durationMs: 1000 } },
      },
      child: {
        call: { id: 'child-call', name: 'create_child_session', args: {
          suffix: 'task-child', taskId: 'task_demo', agentName: 'worker', displayName: 'Task child',
          node: 'remote-a', forceModel: { modelId: 'openai/gpt-5.6-sol', effort: 'high' },
          message: 'Start the assigned work.', afterSend: 'wait',
        } },
        response: { tool_use_id: 'child-call', name: 'create_child_session', response: { output: 'Child session created: \`agent/child\`' } },
      },
      malformedPatch: {
        call: { id: 'malformed-patch', name: 'apply_patch', args: {}, argsParseError: 'Invalid tool arguments JSON', rawArgsText: '<img src=x onerror=window.rawXss=1>\\n{not-json' },
        response: { tool_use_id: 'malformed-patch', name: 'apply_patch', response: { error: 'Invalid arguments' } },
      },
      malformedExec: {
        call: { id: 'malformed-exec', name: 'exec', args: {}, argsParseError: 'Invalid tool arguments JSON', rawArgsText: 'invalid command args' },
        response: { tool_use_id: 'malformed-exec', name: 'exec', response: { error: 'Invalid arguments' } },
      },
      rawNoError: {
        call: { id: 'raw-no-error', name: 'exec', args: { command: 'echo actual command' }, rawArgsText: 'wrong raw command' },
        response: { tool_use_id: 'raw-no-error', name: 'exec', response: { output: 'ok' } },
      },
      rawMissing: {
        call: { id: 'raw-missing', name: 'exec', args: { command: 'echo fallback' }, argsParseError: 'Invalid tool arguments JSON' },
        response: { tool_use_id: 'raw-missing', name: 'exec', response: { error: 'Invalid arguments' } },
      },
    }
    window.openedCodePaths = []
    const onOpenCodeFile = (filePath, lines) => window.openedCodePaths.push({ filePath, lines })
    for (const [id, fixture] of Object.entries(fixtures)) {
      const msg = { role: 'model', parts: [{ functionCall: fixture.call }], __meta: { timestamp: Date.now() } }
      const nextMsg = { role: 'tool', parts: [{ functionResponse: fixture.response }] }
      createRoot(document.getElementById(id)).render(React.createElement(InterleavedToolGroup, { msg, nextMsg, messageKeyPrefix: id, onOpenCodeFile }))
    }
    const timelineRoot = createRoot(document.getElementById('timeline'))
    const timelineMessages = [
      { role: 'model', parts: [{ functionCall: { id: 'timeline-call', name: 'exec', args: { command: 'printf selectable-command' } } }], __meta: { seq: 1 } },
      { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'timeline-call', name: 'exec', response: { output: 'Selectable result text\\n' + 'More result lines\\n'.repeat(12) } } }], __meta: { seq: 2 } },
      { role: 'model', parts: [{ text: 'Finished.' }], __meta: { seq: 3 } },
    ]
    window.renderFixtureTimeline = (timelineView, updated = false) => timelineRoot.render(React.createElement(ChatTimeline, {
      sessionId: 'fixture/' + timelineView,
      messages: updated ? [...timelineMessages, { role: 'user', parts: [{ text: 'Next input' }], __meta: { seq: 4 } }] : timelineMessages,
      timelineView, isMobile: false, showUsageBadge: false, showTimeDividers: false, onOpenCodeFile,
    }))
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
    window.setFixtureTheme(style, dark)
  }, { style, dark })
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-tool-card').length === 11)
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
    const actions = root.querySelector('.foxwarm-tool-header-toggle .foxwarm-tool-action-buttons')
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
      headerLeftOffset: headerRect.left - cardRect.left,
      headerRightGap: cardRect.right - headerRect.right,
      cardPaddingRight: getComputedStyle(card).paddingRight,
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
      resultTextCursor: result?.firstElementChild ? getComputedStyle(result.firstElementChild).cursor : null,
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
  assert.equal(state.cardCursor === 'pointer', !expanded)
  assert.equal(state.headerCursor === 'pointer', !expanded)
  assert.equal(state.toggleCursor, 'pointer')
  assert.equal(state.cardHasPointerClass, !expanded)
  assert.equal(state.headerHasPointerClass, false)
  assert.equal(state.toggleHasPointerClass, true)
  assert.equal(state.toggleHasTextHoverClass, false)
  if (state.argsCursor !== null) assert.notEqual(state.argsCursor, 'pointer')
  if (state.resultCursor !== null) assert.equal(state.resultCursor === 'pointer', !expanded)
  if (state.resultTextCursor !== null) assert.equal(state.resultTextCursor === 'pointer', !expanded)
}

async function assertHeaderHoverKeepsTextColor(id) {
  await page.mouse.move(0, 0)
  const before = await readCollapseTargetState(id)
  await page.hover(`#${id} .foxwarm-tool-header-toggle`)
  const hovered = await readCollapseTargetState(id)
  assert.equal(hovered.toggleColor, before.toggleColor)
  assert.equal(hovered.summaryColor, before.summaryColor)
}

async function waitForCardTransitions() {
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-tool-card, [data-tool-group]')].every(node => !node.style.height))
}

// Hit a painted surface at real pointer coordinates, rather than dispatching a DOM click.
async function clickSurface(selector, { x = 0.5, y = 0.5 } = {}) {
  await waitForCardTransitions()
  const element = await page.$(selector)
  await element.scrollIntoView()
  const point = await element.evaluate((node, { x, y }) => {
    const rect = node.getBoundingClientRect()
    const point = { x: rect.left + rect.width * x, y: rect.top + rect.height * y }
    const hit = document.elementFromPoint(point.x, point.y)
    return { ...point, hit: hit?.outerHTML.slice(0, 300), onSurface: node === hit || node.contains(hit) }
  }, { x, y })
  assert.equal(point.onSurface, true, `pointer hits ${selector}: ${JSON.stringify(point)}`)
  await page.mouse.click(point.x, point.y)
}

async function selectText(selector) {
  await waitForCardTransitions()
  await page.$eval(selector, node => node.scrollIntoView({ block: 'center' }))
  const points = await page.$eval(selector, node => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    const text = walker.nextNode()
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, Math.min(text.length, 12))
    const rect = range.getBoundingClientRect()
    window.getSelection().removeAllRanges()
    return { x: rect.left + 1, end: rect.right - 1, y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(points.x, points.y)
  await page.mouse.down()
  await page.mouse.move(points.end, points.y, { steps: 12 })
  await page.mouse.up()
  assert.ok((await page.evaluate(() => window.getSelection().toString())).length > 3, 'native pointer drag selects text')
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
  response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{width:100%;padding:12px}.fixture{width:100%;min-width:0}</style></head><body><main>${['exec', 'edit', 'error', 'send', 'sendAlias', 'child', 'malformedPatch', 'malformedExec', 'rawNoError', 'rawMissing', 'noResult', 'timeline'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
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

test('invalid tool arguments show escaped raw text instead of structured args in both card states', async () => {
  await mountFixture({ width: 900, height: 800 })
  const collapsedPatch = await page.$eval('#malformedPatch .foxwarm-tool-call-summary', element => element.textContent)
  assert.match(collapsedPatch, /<img src=x onerror=window.rawXss=1>/)
  assert.doesNotMatch(collapsedPatch, /invalid patch/)
  assert.equal(await page.$eval('#malformedExec .foxwarm-tool-call-summary', element => element.textContent), 'invalid command args')
  assert.match(await page.$eval('#rawNoError .foxwarm-tool-call-summary', element => element.textContent), /echo actual command/)
  assert.doesNotMatch(await page.$eval('#rawNoError .foxwarm-tool-call-summary', element => element.textContent), /wrong raw command/)
  assert.match(await page.$eval('#rawMissing .foxwarm-tool-call-summary', element => element.textContent), /echo fallback/)
  assert.match(await page.$eval('#noResult .foxwarm-tool-call-summary', element => element.textContent), /streaming tool call|reason/)

  await page.click('#malformedPatch .foxwarm-tool-header-toggle')
  const expanded = await page.$eval('#malformedPatch .foxwarm-tool-call-args pre', element => ({ text: element.textContent, whiteSpace: getComputedStyle(element).whiteSpace }))
  assert.equal(expanded.text, '<img src=x onerror=window.rawXss=1>\n{not-json')
  assert.equal(expanded.whiteSpace, 'pre-wrap')
  assert.equal(await page.$eval('#malformedPatch .foxwarm-tool-call-args img', element => element).catch(() => null), null)
  assert.equal(await page.evaluate(() => window.rawXss), undefined)
  await page.click('#rawNoError .foxwarm-tool-header-toggle')
  assert.match(await page.$eval('#rawNoError .foxwarm-tool-call-args', element => element.textContent), /echo actual command/)
  assert.doesNotMatch(await page.$eval('#rawNoError .foxwarm-tool-call-args', element => element.textContent), /wrong raw command/)
})

test('tool headers show valid invocation durations only at one second or above', async () => {
  await mountFixture({ width: 900, height: 800 })
  assert.equal(await page.$eval('#sendAlias [data-tool-execution-time]', element => element.textContent.trim()), '1s')
  for (const id of ['send', 'exec', 'edit', 'noResult']) {
    assert.equal(await page.$$eval(`#${id} [data-tool-execution-time]`, elements => elements.length), 0)
  }
  await page.click('#send .foxwarm-tool-tag')
  await page.click('#sendAlias .foxwarm-tool-tag')
  assert.equal(await page.$$eval('#send [data-tool-execution-time]', elements => elements.length), 0)
  assert.equal(await page.$eval('#sendAlias [data-tool-execution-time]', element => element.textContent.trim()), '1s')
})

test('default desktop keeps call args in the dark header and results on the light surface', async () => {
  await mountFixture({ width: 900, height: 800 })
  for (const id of ['exec', 'edit', 'error']) assertCollapsed(await readVisualState(id))

  await page.click('#edit .foxwarm-tool-code-open')
  assert.equal(await page.evaluate(() => window.openedCodePaths.length), 1)
  assert.equal(await page.$eval('#edit', root => !!root.querySelector('.foxwarm-tool-call-args')), false, 'Code click does not expand')

  for (const id of ['exec', 'edit', 'error', 'noResult']) {
    await page.click(`#${id} .foxwarm-tool-tag`)
    assertExpanded(await readVisualState(id), { hasResult: id !== 'noResult' })
  }
  await page.click('#edit .foxwarm-tool-call-args .foxwarm-tool-code-open')
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

test('every built-in applies its declared full-width or inset tool-header geometry when collapsed and expanded', async () => {
  const cases = await page.evaluate(() => window.fixtureThemeCases)
  assert.equal(cases.length, 16)
  for (const { themeId, colorMode, headerTreatment } of cases) {
    await mountFixture({ width: 900, height: 800, style: themeId, dark: colorMode === 'dark' })
    const collapsed = await readVisualState('exec')
    const expectedInset = ['banded', 'tab'].includes(headerTreatment) ? 0 : Number.parseFloat(collapsed.cardPaddingRight)
    assert.ok(Math.abs(collapsed.headerLeftOffset - expectedInset) <= 1, `${themeId} ${colorMode} ${headerTreatment} collapsed left offset ${collapsed.headerLeftOffset}px`)
    assert.ok(Math.abs(collapsed.headerRightGap - expectedInset) <= 1, `${themeId} ${colorMode} ${headerTreatment} collapsed right gap ${collapsed.headerRightGap}px`)
    await page.click('#exec .foxwarm-tool-header-toggle')
    const expanded = await readVisualState('exec')
    assert.ok(Math.abs(expanded.headerLeftOffset - expectedInset) <= 1, `${themeId} ${colorMode} ${headerTreatment} expanded left offset ${expanded.headerLeftOffset}px`)
    assert.ok(Math.abs(expanded.headerRightGap - expectedInset) <= 1, `${themeId} ${colorMode} ${headerTreatment} expanded right gap ${expanded.headerRightGap}px`)
  }
})

test('send_to_session To prefixes inherit ordinary call text in collapsed and expanded cards', async () => {
  const readTo = (id, expanded) => page.$eval(`#${id}`, (root, expanded) => {
    const prefix = root.querySelector('.foxwarm-tool-session-prefix')
    const container = expanded
      ? root.querySelector('.foxwarm-tool-call-args')
      : root.querySelector('.foxwarm-tool-call-summary')
    const prefixRow = prefix.parentElement
    const link = prefixRow.querySelector('a')
    const alias = prefixRow.querySelector('span.font-mono')
    return {
      prefixColor: getComputedStyle(prefix).color,
      containerColor: getComputedStyle(container).color,
      linkHref: link?.getAttribute('href') || null,
      aliasText: alias?.textContent || null,
      text: prefixRow.textContent,
    }
  }, expanded)

  for (const fixture of [
    { width: 900, height: 800 },
    { width: 900, height: 800, style: '550a', dark: false },
    { width: 390, height: 760, style: '550a', dark: true },
  ]) {
    await mountFixture(fixture)
    for (const [id, expected] of [['send', { href: '#session/agent%2Fchild', alias: null }], ['sendAlias', { href: null, alias: '<main>' }]]) {
      const collapsed = await readTo(id, false)
      assert.equal(collapsed.prefixColor, collapsed.containerColor, `${id} collapsed To inherits foreground`)
      assert.equal(collapsed.linkHref, expected.href)
      assert.equal(collapsed.aliasText, expected.alias)
      assert.match(collapsed.text, /^To/)

      await page.click(`#${id} .foxwarm-tool-tag`)
      const expanded = await readTo(id, true)
      assert.equal(expanded.prefixColor, expanded.containerColor, `${id} expanded To inherits foreground`)
      assert.equal(expanded.linkHref, expected.href)
      assert.equal(expanded.aliasText, expected.alias)
      assert.match(expanded.text, /^To/)
    }
  }
})

test('create_child_session identifies task assignments and shows supplied creation fields when expanded', async () => {
  await mountFixture({ width: 900, height: 800 })
  assert.match(await page.$eval('#child .foxwarm-tool-call-summary', element => element.textContent), /childtask-child\(new, task, message\)/)
  await page.click('#child .foxwarm-tool-header-toggle')
  const expanded = await page.$eval('#child .foxwarm-tool-call-args', element => element.textContent)
  for (const value of ['task_demo', 'worker', 'Task child', 'remote-a', 'openai/gpt-5.6-sol', 'high', 'Start the assigned work.', 'wait']) {
    assert.match(expanded, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('collapsed native cards expand across their non-action surface and expanded content stays selectable', async () => {
  for (const fixture of [
    { width: 900, height: 800 },
    { width: 390, height: 760, style: '550a', dark: true },
  ]) {
    await mountFixture(fixture)
    const expanded = async () => !!(await page.$('#exec .foxwarm-tool-call-args'))
    for (const [selector, point] of [
      ['#exec .foxwarm-tool-result-preview .cursor-text', { x: 0.25, y: 0.1 }],
      ['#exec .foxwarm-tool-card', { x: 0.99, y: 0.99 }],
      ['#exec .foxwarm-tool-header', { x: 0.5, y: 0.01 }],
      ['#exec .foxwarm-tool-header-toggle', {}],
    ]) {
      const collapsed = await readCollapseTargetState('exec')
      await assertHeaderHoverKeepsTextColor('exec')
      await clickSurface(selector, point)
      await page.waitForSelector('#exec .foxwarm-tool-call-args', { timeout: 3000 })
      assertCollapseTargetState(collapsed, false)
      assertCollapseTargetState(await readCollapseTargetState('exec'), true)
      await assertHeaderHoverKeepsTextColor('exec')
      await page.click('#exec .foxwarm-tool-header-toggle')
      assert.equal(await expanded(), false)
    }

    await page.click('#exec [aria-label="Expand exec tool"]')
    await selectText('#exec .foxwarm-tool-call-args')
    assert.equal(await expanded(), true)
    await selectText('#exec .foxwarm-tool-result-content')
    assert.equal(await expanded(), true)
    await clickSurface('#exec .foxwarm-tool-card', { x: 0.99, y: 0.99 })
    await clickSurface('#exec .foxwarm-tool-header', { x: 0.99, y: 0.99 })
    assert.equal(await expanded(), true, 'expanded padding does not collapse')
    await page.click('#exec [aria-label="Collapse exec tool"]')
    assert.equal(await expanded(), false)
  }
})

test('Code, JSON, links, and diff actions keep their own behavior without toggling the card', async () => {
  await mountFixture({ width: 900, height: 800 })
  for (const selector of ['#send .foxwarm-tool-call-summary a', '#child .foxwarm-tool-result-preview a']) {
    await page.click(selector)
    assert.equal(await page.evaluate(() => location.hash), '#session/agent%2Fchild')
    assert.equal(await page.$('#send .foxwarm-tool-call-args, #child .foxwarm-tool-call-args'), null, 'session links navigate without expanding')
  }
  await page.click('#edit .foxwarm-tool-code-open')
  assert.equal(await page.evaluate(() => window.openedCodePaths.length), 1)
  assert.equal(await page.$('#edit .foxwarm-tool-call-args'), null)
  await page.hover('#edit .foxwarm-tool-header-toggle')
  await page.click('#edit button[title="JSON"]')
  await page.waitForSelector('[data-json-inspector-dialog]')
  assert.equal(await page.$('#edit .foxwarm-tool-call-args'), null)
  await page.click('[data-json-inspector-dialog] button[title="Close"]')
  assert.equal(await page.$('#edit .foxwarm-tool-call-args'), null, 'portal close does not expand the card')
  await page.click('#edit .foxwarm-tool-result-preview')
  await page.waitForSelector('#edit .foxwarm-tool-call-args')
  await page.click('#edit button[title="Split"]')
  assert.ok(await page.$('#edit .foxwarm-tool-call-args'))
  await page.click('#edit .foxwarm-tool-code-open')
  assert.equal(await page.evaluate(() => window.openedCodePaths.length), 2)
  assert.ok(await page.$('#edit .foxwarm-tool-call-args'))
})

test('Detailed and expanded-group member result clicks use the Timeline manual disclosure owner', async () => {
  await mountFixture({ width: 900, height: 800 })
  const card = '#timeline .foxwarm-tool-card:not(.foxwarm-tool-group-card)'
  for (const view of ['detailed', 'grouped']) {
    await page.evaluate(view => window.renderFixtureTimeline(view), view)
    if (view === 'grouped') {
      await page.waitForSelector('#timeline [aria-label="Expand tool group"]')
      await page.click('#timeline [aria-label="Expand tool group"]')
    }
    await page.waitForSelector(`${card} .foxwarm-tool-result-preview`)
    assert.equal(await page.$eval(`${card} .foxwarm-tool-result-preview .cursor-text`, node => getComputedStyle(node).cursor), 'pointer')
    await clickSurface(`${card} .foxwarm-tool-result-preview`, { x: 0.3, y: 0.1 })
    await page.waitForSelector(`${card} .foxwarm-tool-call-args`)
    await selectText(`${card} .foxwarm-tool-call-args`)
    await selectText(`${card} .foxwarm-tool-result-content`)
    assert.ok(await page.$(`${card} .foxwarm-tool-call-args`))
    if (view === 'grouped' && process.env.FOXWARM_E2E_SCREENSHOT_PATH) await page.screenshot({ path: process.env.FOXWARM_E2E_SCREENSHOT_PATH })
    await page.evaluate(view => window.renderFixtureTimeline(view, true), view)
    await page.waitForFunction(() => document.querySelector('#timeline').textContent.includes('Next input'))
    assert.ok(await page.$(`${card} .foxwarm-tool-call-args`), 'ordinary Timeline updates retain the manual choice')
    if (view === 'grouped') {
      await page.click('#timeline [aria-label="Collapse tool group"]')
      await page.waitForSelector('#timeline [aria-label="Expand tool group"]')
      await page.click('#timeline [aria-label="Expand tool group"]')
      await page.waitForSelector(`${card} .foxwarm-tool-call-args`)
    }
    await page.click(`${card} .foxwarm-tool-header-toggle`)
    await page.waitForSelector(`${card} .foxwarm-tool-result-preview`)
    assert.equal(await page.$(`${card} .foxwarm-tool-call-args`), null)
  }
})
