import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const browserKind = process.env.FOXWARM_E2E_BROWSER === 'firefox' ? 'firefox' : 'chrome'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const themeEntry = new URL('../src/theme/index.ts', import.meta.url).pathname
const assetsPath = new URL('../dist/assets/', import.meta.url).pathname
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
let browser, page, server, baseUrl

before(async () => {
  const cssName = (await readdir(assetsPath)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(`${assetsPath}${cssName}`, 'utf8')
  const source = `
    import React from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    import { initializeThemeRuntime, setThemeSelection, THEME_550A, DEFAULT_THEME } from ${JSON.stringify(themeEntry)}

    const params = new URLSearchParams(location.search)
    initializeThemeRuntime()
    setThemeSelection({ themeId: params.get('theme') === 'default' ? DEFAULT_THEME.id : THEME_550A.id, colorMode: params.get('mode') === 'dark' ? 'dark' : 'light' })
    const call = (id, seq, thinking = '') => ({ role: 'model', parts: [...(thinking ? [{ thinking }] : []), { functionCall: { id, name: 'exec', args: { command: 'echo ' + id } } }], __meta: { seq } })
    const result = (id, seq, failed = false) => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'exec', response: failed ? { error: 'failed ' + id } : { output: 'ok ' + id } } }], __meta: { seq } })
    const last = seq => ({ role: 'model', parts: [{ text: 'done' }], __meta: { seq } })
    window.fetch = async input => {
      if (String(input).includes('/context-blocks/4/expand')) return new Response(JSON.stringify({ sessionId: 'fixture/main', blockId: 4, expansionKind: 'messages', messages: [
        { role: 'model', parts: [{ text: ${JSON.stringify('ASSISTANT_A\n\n\\[\nx^2+1\n\\]')} }], __meta: { seq: 101 } },
        { role: 'model', parts: [{ text: ${JSON.stringify('ASSISTANT_B\n\n\\[\ny^2\n\\]')} }], __meta: { seq: 102 } },
        call('ctx-success', 103), result('ctx-success', 104),
        { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: ${JSON.stringify(png)} } }], __meta: { seq: 105 } },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } })
    }
    const cases = {
      standaloneSuccess: { groupTools: false, messages: [call('one', 1), result('one', 2), last(3)] },
      standaloneError: { groupTools: false, messages: [call('bad', 4), result('bad', 5, true), last(6)] },
      nested: { groupTools: true, messages: [call('one', 7, 'THOUGHT_A'), result('one', 8), call('bad', 9), result('bad', 10, true), last(11)] },
      ctx: { groupTools: false, messages: [{ role: 'model', parts: [{ text: '[CTX-BLOCK L1 B#4 raw#1-#5] context summary' }], __meta: { seq: 12, contextBlock: { id: 4, level: 1, sourceKind: 'message', rawStartSeq: 1, rawEndSeq: 5 } } }] },
    }
    for (const [id, config] of Object.entries(cases)) createRoot(document.getElementById(id)).render(React.createElement(ChatTimeline, {
      sessionId: 'fixture/main', messages: config.messages, groupTools: config.groupTools, isMobile: false, showUsageBadge: false,
    }))
  `
  const result = await build({ stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'nested-hover-fixture.tsx' }, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false, define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent' })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>body{margin:0}main{padding:16px}.fixture{max-width:900px;margin-bottom:12px}</style></head><body><main>${['standaloneSuccess', 'standaloneError', 'nested', 'ctx'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${result.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}/`
  browser = await puppeteer.launch({ browser: browserKind, executablePath: browserKind === 'firefox' ? (process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox') : (process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'), headless: true, args: browserKind === 'firefox' ? [] : ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

const pause = () => new Promise(resolve => setTimeout(resolve, 220))
const mount = async (theme = 'console', mode = 'light', viewport = { width: 1150, height: 920 }) => {
  if (browserKind !== 'firefox') await page.setViewport(viewport)
  await page.goto(`${baseUrl}?theme=${theme}&mode=${mode}`, { waitUntil: 'load' })
  await page.waitForSelector('#nested [aria-label="Expand tool group"]')
  await page.$eval('#nested [aria-label="Expand tool group"]', button => button.click())
  await page.waitForSelector('#nested .foxwarm-tool-card.foxwarm-tool-tone-error:not(.foxwarm-tool-group-card)')
  await page.$eval('#ctx .foxwarm-context-block-card > .foxwarm-thread-line-button', button => button.click())
  await page.waitForSelector('#ctx .foxwarm-context-block-nested .foxwarm-tool-card.foxwarm-tool-tone-success')
  await page.waitForSelector('#ctx .foxwarm-special-block[data-special-block-kind="latex"]')
  await page.waitForSelector('#ctx .foxwarm-image-item')
}
const headerColors = () => page.evaluate(() => {
  const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor
  return {
    success: color('#standaloneSuccess .foxwarm-tool-header'),
    error: color('#standaloneError .foxwarm-tool-header'),
    neutral: color('#nested .foxwarm-tool-group-header'),
    nestedSuccess: color('#nested .foxwarm-tool-card.foxwarm-tool-tone-success:not(.foxwarm-tool-group-card) .foxwarm-tool-header'),
    nestedError: color('#nested .foxwarm-tool-card.foxwarm-tool-tone-error:not(.foxwarm-tool-group-card) .foxwarm-tool-header'),
    ctxSuccess: color('#ctx .foxwarm-tool-card.foxwarm-tool-tone-success .foxwarm-tool-header'),
    bodySuccess: color('#standaloneSuccess .foxwarm-tool-card.foxwarm-tool-tone-success'),
    bodyError: color('#standaloneError .foxwarm-tool-card.foxwarm-tool-tone-error'),
    bodyNeutral: color('#nested .foxwarm-tool-group-card'),
    bodyNestedSuccess: color('#nested .foxwarm-tool-card.foxwarm-tool-tone-success:not(.foxwarm-tool-group-card)'),
    bodyNestedError: color('#nested .foxwarm-tool-card.foxwarm-tool-tone-error:not(.foxwarm-tool-group-card)'),
  }
})
const moveTo = async selector => {
  const box = await page.$eval(selector, node => {
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = node.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.mouse.move(box.x, box.y)
  await pause()
}
const moveAway = async () => {
  const point = await page.evaluate(() => ({ x: innerWidth - 4, y: innerHeight - 4 }))
  await page.mouse.move(point.x, point.y)
  await pause()
}
const hoverState = () => page.evaluate(() => {
  const outer = document.querySelector('#nested .foxwarm-tool-group-card')
  const nested = [...document.querySelectorAll('#nested .foxwarm-tool-card:not(.foxwarm-tool-group-card)')]
  const ctx = document.querySelector('#ctx .foxwarm-context-block-card')
  const assistants = [...ctx.querySelectorAll('.foxwarm-assistant-message-card')]
  const specials = [...ctx.querySelectorAll('.foxwarm-special-block[data-special-block-kind="latex"]')]
  const image = ctx.querySelector('.foxwarm-image-item')
  const overlay = image?.querySelector('.foxwarm-image-hover-overlay')
  return {
    outer: { hovered: outer.matches(':hover'), line: getComputedStyle(outer.querySelector(':scope > .foxwarm-thread-line-button > .foxwarm-thread-line-stroke')).opacity },
    nested: nested.map(card => ({ hovered: card.matches(':hover'), actions: getComputedStyle(card.querySelector(':scope > .foxwarm-tool-action-buttons')).opacity, line: getComputedStyle(card.querySelector(':scope > .foxwarm-thread-line-button > .foxwarm-thread-line-stroke')).opacity })),
    ctxHovered: ctx.matches(':hover'),
    assistants: assistants.map(card => ({ hovered: card.matches(':hover'), actions: getComputedStyle(card.querySelector(':scope > .foxwarm-assistant-action-buttons')).opacity })),
    specials: specials.map(block => ({ hovered: block.matches(':hover'), focused: block.matches(':focus-within'), controls: getComputedStyle(block.querySelector(':scope > [data-special-block-controls]')).opacity })),
    image: { hovered: image?.matches(':hover'), tint: overlay ? getComputedStyle(overlay).backgroundColor : null },
  }
})

test('console light/dark and header recipes use each Tool header’s own status tone inside a neutral group', async () => {
  for (const mode of ['light', 'dark']) {
    await mount('console', mode)
    for (const recipe of ['banded', 'integrated']) {
      await page.evaluate(recipe => document.documentElement.setAttribute('data-foxwarm-header-treatment', recipe), recipe)
      const colors = await headerColors()
      assert.equal(colors.nestedSuccess, colors.success, `${mode}/${recipe} nested success header uses its own success color`)
      assert.equal(colors.nestedError, colors.error, `${mode}/${recipe} nested error header uses its own error color`)
      assert.equal(colors.ctxSuccess, colors.success, `${mode}/${recipe} direct CTX nesting keeps success`)
      if (recipe === 'banded') {
        assert.notEqual(colors.nestedSuccess, colors.neutral, `${mode}/${recipe} success header does not inherit neutral group header`)
        assert.notEqual(colors.nestedError, colors.neutral, `${mode}/${recipe} error header does not inherit neutral group header`)
      } else {
        assert.equal(colors.nestedSuccess, 'rgba(0, 0, 0, 0)', 'integrated recipe intentionally makes headers transparent')
        assert.equal(colors.nestedError, colors.neutral)
      }
      assert.equal(colors.bodyNestedSuccess, colors.bodySuccess, `${mode}/${recipe} nested success card keeps its own surface`)
      assert.equal(colors.bodyNestedError, colors.bodyError, `${mode}/${recipe} nested error card keeps its own surface`)
      assert.notEqual(colors.bodyNestedSuccess, colors.bodyNeutral)
      assert.notEqual(colors.bodyNestedError, colors.bodyNeutral)
    }
  }
})

test('standard theme also keeps nested status colors and owned hover controls', async () => {
  for (const mode of ['light', 'dark']) {
    await mount('default', mode)
    const colors = await headerColors()
    assert.equal(colors.nestedSuccess, colors.success, `${mode} standard nested success header`)
    assert.equal(colors.nestedError, colors.error, `${mode} standard nested error header`)
    await moveTo('#nested .foxwarm-tool-group-header')
    assert.deepEqual((await hoverState()).nested.map(card => card.actions), ['0', '0'])
    await moveTo('#nested .foxwarm-tool-card.foxwarm-tool-tone-success:not(.foxwarm-tool-group-card) .foxwarm-tool-header')
    assert.deepEqual((await hoverState()).nested.map(card => card.actions), ['1', '0'])
  }
})

test('outer hover activates its own line but not descendant actions or sibling rails', async () => {
  await mount()
  await moveAway()
  const baseline = await hoverState()
  assert.deepEqual(baseline.nested.map(card => card.actions), ['0', '0'])
  await moveTo('#nested .foxwarm-tool-group-header')
  const outer = await hoverState()
  assert.equal(outer.outer.hovered, true)
  assert.equal(outer.outer.line, '1')
  assert.deepEqual(outer.nested.map(card => [card.hovered, card.actions, card.line]), [[false, '0', baseline.nested[0].line], [false, '0', baseline.nested[1].line]])
  await moveTo('#nested .foxwarm-tool-card.foxwarm-tool-tone-success:not(.foxwarm-tool-group-card) .foxwarm-tool-header')
  const success = await hoverState()
  assert.equal(success.outer.hovered, true, 'child hover still activates ancestor itself')
  assert.equal(success.outer.line, '1')
  assert.deepEqual(success.nested.map(card => [card.hovered, card.actions, card.line]), [[true, '1', '1'], [false, '0', baseline.nested[1].line]])
  await moveAway()
  assert.deepEqual((await hoverState()).nested.map(card => card.actions), ['0', '0'])
  await moveTo('#nested .foxwarm-tool-card.foxwarm-tool-tone-error:not(.foxwarm-tool-group-card) .foxwarm-tool-header')
  const error = await hoverState()
  assert.deepEqual(error.nested.map(card => [card.hovered, card.actions, card.line]), [[false, '0', baseline.nested[0].line], [true, '1', '1']])
  await page.$eval('#nested .foxwarm-tool-card.foxwarm-tool-tone-success:not(.foxwarm-tool-group-card) > .foxwarm-tool-action-buttons button', button => button.focus())
  await moveAway()
  const focused = await hoverState()
  assert.deepEqual(focused.nested.map(card => [card.hovered, card.actions]), [[false, '1'], [false, '0']], 'keyboard focus retains only its owning tool actions')
})

test('CTX parent hover does not activate unhovered assistant, image or LaTeX controls; own focus remains visible', async () => {
  await mount()
  await moveAway()
  const baseline = await hoverState()
  assert.equal(baseline.specials.length, 2)
  assert.deepEqual(baseline.specials.map(block => block.controls), ['0', '0'])
  await moveTo('#ctx .foxwarm-context-block-header')
  const ctx = await hoverState()
  assert.equal(ctx.ctxHovered, true)
  assert.deepEqual(ctx.assistants.map(card => [card.hovered, card.actions]), [[false, '0'], [false, '0']])
  assert.equal(ctx.image.hovered, false)
  assert.equal(ctx.image.tint, baseline.image.tint)
  assert.deepEqual(ctx.specials.map(block => block.controls), ['0', '0'])
  await moveTo('#ctx .foxwarm-assistant-message-card:first-of-type')
  const first = await hoverState()
  assert.deepEqual(first.assistants.map(card => [card.hovered, card.actions]), [[true, '1'], [false, '0']])
  await moveTo('#ctx .foxwarm-special-block[data-special-block-kind="latex"]')
  const latex = await hoverState()
  assert.deepEqual(latex.specials.map(block => block.controls), ['1', '0'])
  await moveTo('#ctx .foxwarm-image-item')
  const image = await hoverState()
  assert.equal(image.image.hovered, true)
  assert.notEqual(image.image.tint, baseline.image.tint)
  await page.$eval('#ctx .foxwarm-special-block[data-special-block-kind="latex"] button[title="Raw LaTeX"]', button => button.focus())
  await moveAway()
  const focused = await hoverState()
  assert.deepEqual(focused.specials.map(block => [block.hovered, block.focused, block.controls]), [[false, true, '1'], [false, false, '0']])
  assert.deepEqual(focused.assistants.map(card => card.actions), ['1', '0'], 'keyboard focus preserves own assistant controls')
})

test('narrow chevron keeps own status headers and does not light non-hovered sibling actions', { skip: browserKind === 'firefox' && 'Puppeteer BiDi does not support Firefox viewport emulation' }, async () => {
  await mount('console', 'light', { width: 380, height: 640, hasTouch: true, isMobile: true })
  await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-separator-treatment', 'chevron'))
  const colors = await headerColors()
  assert.equal(colors.nestedSuccess, colors.success)
  assert.equal(colors.nestedError, colors.error)
  await moveTo('#nested .foxwarm-tool-group-header')
  const outer = await hoverState()
  assert.deepEqual(outer.nested.map(card => card.actions), ['0', '0'])
  await moveTo('#nested .foxwarm-tool-card.foxwarm-tool-tone-success:not(.foxwarm-tool-group-card) .foxwarm-tool-header')
  const inner = await hoverState()
  assert.deepEqual(inner.nested.map(card => card.actions), ['1', '0'])
  const chevron = await page.$eval('#nested .foxwarm-tool-card.foxwarm-tool-tone-success:not(.foxwarm-tool-group-card)', card => ({
    stroke: getComputedStyle(card.querySelector('.foxwarm-thread-line-stroke')).display,
    icon: getComputedStyle(card.querySelector('.foxwarm-thread-disclosure-icon')).display,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))
  assert.equal(chevron.stroke, 'none')
  assert.notEqual(chevron.icon, 'none')
  assert.ok(chevron.overflow <= 1)
  const target = await page.$eval('#nested .foxwarm-tool-card.foxwarm-tool-tone-success:not(.foxwarm-tool-group-card) .foxwarm-tool-header', header => {
    const rect = header.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })
  await page.touchscreen.tap(target.x, target.y)
  await pause()
  assert.equal((await hoverState()).nested[1].actions, '0', 'touching one member does not show a sibling’s actions')
})
