import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const reasoningEntry = new URL('../src/components/ReasoningCard.tsx', import.meta.url).pathname
const webSearchEntry = new URL('../src/components/WebSearchCard.tsx', import.meta.url).pathname
const contextEntry = new URL('../src/components/ContextBlockCard.tsx', import.meta.url).pathname
const toolEntry = new URL('../src/components/ToolTimelineItems.tsx', import.meta.url).pathname
const themeEntry = new URL('../src/theme/index.ts', import.meta.url).pathname
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
    import ReasoningCard from ${JSON.stringify(reasoningEntry)}
    import WebSearchCard from ${JSON.stringify(webSearchEntry)}
    import ContextBlockCard from ${JSON.stringify(contextEntry)}
    import { InterleavedToolGroup, ToolCallsBlock, ToolGroupSummaryCard } from ${JSON.stringify(toolEntry)}
    import { DEFAULT_THEME, initializeThemeRuntime, installTheme, setThemeSelection, THEME_550A } from ${JSON.stringify(themeEntry)}

    const params = new URLSearchParams(location.search)
    const requestedTheme = params.get('theme') || 'foxwarm.default'
    const mode = params.get('mode') === 'dark' ? 'dark' : 'light'
    initializeThemeRuntime()
    let themeId = requestedTheme
    if (requestedTheme === 'imported-console') {
      const withDistinctSemantics = (variant) => ({
        ...variant,
        colors: {
          ...variant.colors,
          input: '#09131d',
          border: '#31506a',
          text: '#aaccee',
          success: '#66cc77',
          successSurface: '#0c2a14',
          successSurfaceStrong: '#18452a',
          successBorder: '#2e6b42',
          danger: '#dd8855',
          dangerSurface: '#422014',
          dangerSurfaceStrong: '#69351f',
          dangerBorder: '#8a4e32',
          systemAccent: '#77ccee',
          systemBorder: '#315b72',
          reasoningSurface: '#10243a',
          reasoningSurfaceStrong: '#274f73',
        },
      })
      const clone = {
        ...THEME_550A,
        id: 'fixture.console-clone',
        name: 'Fixture console clone',
        variants: {
          light: withDistinctSemantics(THEME_550A.variants.light),
          dark: withDistinctSemantics(THEME_550A.variants.dark),
        },
      }
      const installed = installTheme(JSON.stringify(clone), { replace: true })
      if (!installed.ok) throw new Error(installed.error)
      themeId = clone.id
    } else if (requestedTheme === 'imported-standard') {
      const withDistinctSystemTagSemantics = (variant, dark) => ({
        ...variant,
        colors: {
          ...variant.colors,
          info: dark ? '#bfdbfe' : '#1d4ed8',
          infoBorder: dark ? '#60a5fa' : '#93c5fd',
          systemText: dark ? '#e0f2fe' : '#172554',
          systemAccent: '#f97316',
          systemBorder: '#22c55e',
        },
      })
      const clone = {
        ...DEFAULT_THEME,
        id: 'fixture.standard-clone',
        name: 'Fixture standard clone',
        variants: {
          light: withDistinctSystemTagSemantics(DEFAULT_THEME.variants.light, false),
          dark: withDistinctSystemTagSemantics(DEFAULT_THEME.variants.dark, true),
        },
      }
      const installed = installTheme(JSON.stringify(clone), { replace: true })
      if (!installed.ok) throw new Error(installed.error)
      themeId = clone.id
    }
    setThemeSelection({ themeId, colorMode: mode })

    const neutralCall = { role: 'model', parts: [{ functionCall: { id: 'neutral', name: 'read', args: { filePath: '/workspace/file.ts' } } }] }
    const successCall = { role: 'model', parts: [{ functionCall: { id: 'success', name: 'exec', args: { command: 'true' } } }] }
    const successResponse = { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'success', name: 'exec', response: { output: 'ok' } } }] }
    const errorCall = { role: 'model', parts: [{ functionCall: { id: 'error', name: 'exec', args: { command: 'false' } } }] }
    const errorResponse = { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'error', name: 'exec', response: { error: 'failed' } } }] }

    createRoot(document.getElementById('tool-neutral')).render(React.createElement(ToolCallsBlock, { msg: neutralCall }))
    createRoot(document.getElementById('tool-success')).render(React.createElement(InterleavedToolGroup, { msg: successCall, nextMsg: successResponse, messageKeyPrefix: 'success' }))
    createRoot(document.getElementById('tool-error')).render(React.createElement(InterleavedToolGroup, { msg: errorCall, nextMsg: errorResponse, messageKeyPrefix: 'error' }))
    createRoot(document.getElementById('tool-group')).render(React.createElement(ToolGroupSummaryCard, { items: [
      { name: 'read', label: 'neutral', tone: 'neutral' },
      { name: 'exec', label: 'success', tone: 'success' },
      { name: 'exec', label: 'error', tone: 'error' },
      { name: 'system', label: 'system', tone: 'system' },
    ], onExpand: () => {} }))
    createRoot(document.getElementById('reasoning-message')).render(React.createElement(ReasoningCard, { thinking: 'completed reasoning', tone: 'message', defaultExpanded: false }))
    createRoot(document.getElementById('reasoning-processing')).render(React.createElement(ReasoningCard, { thinking: 'active reasoning', tone: 'processing', defaultExpanded: false }))
    createRoot(document.getElementById('web-search')).render(React.createElement(WebSearchCard, { action: { type: 'search', query: 'surface query', queries: ['surface query'] } }))
    createRoot(document.getElementById('system')).render(React.createElement(ChatTimeline, { sessionId: 'fixture/main', messages: [{ role: 'user', parts: [{ text: '<foxwarm-system kind="event" type="wait-timeout">\\nsystem body\\n</foxwarm-system>' }] }], isMobile: false, groupTools: false, showUsageBadge: false }))
    createRoot(document.getElementById('context')).render(React.createElement(ContextBlockCard, { sessionId: 'fixture/main', messageKey: 'context', block: { id: 1, level: 1, rawStartSeq: 1, rawEndSeq: 2 }, text: 'context summary', nestedDepth: 0, renderNestedMessages: () => null }))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'thread-card-surfaces-fixture.tsx' },
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

async function readSurfaces() {
  return page.evaluate(() => {
    const normalizeBackground = (value) => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = value
      document.body.appendChild(probe)
      const normalized = getComputedStyle(probe).backgroundColor
      probe.remove()
      return normalized
    }
    const cssVar = (name) => normalizeBackground(`var(${name})`)
    const opacity = (name, percentage) => normalizeBackground(`color-mix(in srgb, var(${name}) ${percentage}%, transparent)`)
    const parseColor = (value) => {
      const probe = document.createElement('div')
      probe.style.color = value
      document.body.appendChild(probe)
      const normalized = getComputedStyle(probe).color
      probe.remove()
      const match = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)
      if (match) return { rgb: match.slice(1, 4).map(Number), alpha: match[4] === undefined ? 1 : Number(match[4]) }
      const srgb = normalized.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/)
      if (srgb) return { rgb: srgb.slice(1, 4).map(channel => Math.round(Number(channel) * 255)), alpha: srgb[4] === undefined ? 1 : Number(srgb[4]) }
      throw new Error(`Unsupported computed color: ${normalized}`)
    }
    const composite = (foreground, background) => ({
      rgb: foreground.rgb.map((channel, index) => Math.round(channel * foreground.alpha + background.rgb[index] * (1 - foreground.alpha))),
      alpha: 1,
    })
    const visibleBackground = (element) => {
      const layers = []
      let current = element
      while (current) {
        layers.push(parseColor(getComputedStyle(current).backgroundColor))
        current = current.parentElement
      }
      let result = { rgb: [255, 255, 255], alpha: 1 }
      for (let index = layers.length - 1; index >= 0; index -= 1) result = composite(layers[index], result)
      return result.rgb
    }
    const pair = (rootSelector, headerSelector) => {
      const root = document.querySelector(rootSelector)
      const header = root.querySelector(headerSelector)
      return {
        body: getComputedStyle(root).backgroundColor,
        header: getComputedStyle(header).backgroundColor,
        visibleBody: visibleBackground(root),
        visibleHeader: visibleBackground(header),
      }
    }
    const consoleTreatment = document.documentElement.dataset.foxwarmComponentTreatment === 'console'
    const dark = document.documentElement.classList.contains('dark')
    const standardNeutral = {
      body: dark ? opacity('--foxwarm-color-surface', 20) : opacity('--foxwarm-color-neutral-surface', 45),
      header: dark ? opacity('--foxwarm-color-surface-raised', 25) : opacity('--foxwarm-color-neutral-border', 80),
    }
    const expectedRaw = consoleTreatment ? {
      toolNeutral: { body: cssVar('--foxwarm-color-surface'), header: cssVar('--foxwarm-color-hover') },
      toolSuccess: { body: cssVar('--foxwarm-color-success-surface'), header: cssVar('--foxwarm-color-success-surface-strong') },
      toolError: { body: cssVar('--foxwarm-color-danger-surface'), header: cssVar('--foxwarm-color-danger-surface-strong') },
      context: { body: cssVar('--foxwarm-color-surface'), header: cssVar('--foxwarm-color-hover') },
      reasoningMessage: { body: cssVar('--foxwarm-color-reasoning-surface'), header: cssVar('--foxwarm-color-reasoning-surface-strong') },
      reasoningProcessing: { body: cssVar('--foxwarm-color-reasoning-surface'), header: cssVar('--foxwarm-color-reasoning-surface-strong') },
      webSearch: { body: cssVar('--foxwarm-color-reasoning-surface'), header: cssVar('--foxwarm-color-reasoning-surface-strong') },
      system: { body: cssVar('--foxwarm-color-system-surface'), header: cssVar('--foxwarm-color-system-surface-strong') },
    } : {
      toolNeutral: standardNeutral,
      toolSuccess: {
        body: opacity('--foxwarm-color-success-surface', dark ? 10 : 55),
        header: opacity('--foxwarm-color-success-surface', dark ? 20 : 80),
      },
      toolError: {
        body: opacity(dark ? '--foxwarm-color-danger-surface-strong' : '--foxwarm-color-danger-surface', dark ? 10 : 55),
        header: opacity(dark ? '--foxwarm-color-danger-surface-strong' : '--foxwarm-color-danger-surface', dark ? 20 : 85),
      },
      context: standardNeutral,
      reasoningMessage: {
        body: opacity('--foxwarm-color-reasoning-surface', dark ? 20 : 45),
        header: opacity('--foxwarm-color-reasoning-surface-strong', dark ? 25 : 80),
      },
      reasoningProcessing: {
        body: opacity('--foxwarm-color-system-surface', dark ? 10 : 55),
        header: opacity('--foxwarm-color-system-surface-strong', dark ? 20 : 80),
      },
      webSearch: {
        body: opacity('--foxwarm-color-reasoning-surface', dark ? 20 : 45),
        header: opacity('--foxwarm-color-reasoning-surface-strong', dark ? 25 : 80),
      },
      system: {
        body: opacity('--foxwarm-color-system-surface', dark ? 10 : 55),
        header: opacity('--foxwarm-color-system-surface-strong', dark ? 20 : 80),
      },
    }
    return {
      treatment: document.documentElement.dataset.foxwarmComponentTreatment,
      semantic: {
        surface: cssVar('--foxwarm-color-surface'),
        hover: cssVar('--foxwarm-color-hover'),
        reasoningSurface: cssVar('--foxwarm-color-reasoning-surface'),
        reasoningSurfaceStrong: cssVar('--foxwarm-color-reasoning-surface-strong'),
      },
      pairs: {
        toolNeutral: pair('#tool-neutral .foxwarm-tool-card', '.foxwarm-tool-header'),
        toolSuccess: pair('#tool-success .foxwarm-tool-card', '.foxwarm-tool-header'),
        toolError: pair('#tool-error .foxwarm-tool-card', '.foxwarm-tool-header'),
        context: pair('#context .foxwarm-context-block-card', '.foxwarm-context-block-header'),
        reasoningMessage: pair('#reasoning-message [data-model-thread-card]', '.foxwarm-reasoning-header'),
        reasoningProcessing: pair('#reasoning-processing [data-model-thread-card]', '.foxwarm-reasoning-header'),
        webSearch: pair('#web-search [data-model-thread-card]', '.foxwarm-web-search-header'),
        system: pair('#system .foxwarm-system-message-card', '.foxwarm-system-message-header'),
      },
      expectedRaw,
    }
  })
}

async function readTags() {
  return page.evaluate(() => {
    const normalize = (value, property) => {
      const probe = document.createElement('div')
      probe.style.setProperty(property, value)
      document.body.appendChild(probe)
      const result = getComputedStyle(probe).getPropertyValue(property)
      probe.remove()
      return result
    }
    const colorVar = (name) => normalize(`var(${name})`, 'color')
    const backgroundVar = (name) => normalize(`var(${name})`, 'background-color')
    const borderVar = (name) => normalize(`var(${name})`, 'border-color')
    const opacity = (name, percentage) => normalize(`color-mix(in srgb, var(${name}) ${percentage}%, transparent)`, 'background-color')
    const standardSystemForeground = normalize('color-mix(in srgb, var(--foxwarm-color-info) 30%, var(--foxwarm-color-system-text))', 'color')
    const parseColor = (value) => {
      const normalized = normalize(value, 'color')
      const rgb = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)
      if (rgb) return { rgb: rgb.slice(1, 4).map(Number), alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) }
      const srgb = normalized.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/)
      if (srgb) return { rgb: srgb.slice(1, 4).map(channel => Math.round(Number(channel) * 255)), alpha: srgb[4] === undefined ? 1 : Number(srgb[4]) }
      throw new Error(`Unsupported computed color: ${normalized}`)
    }
    const composite = (foreground, background) => ({
      rgb: foreground.rgb.map((channel, index) => Math.round(channel * foreground.alpha + background.rgb[index] * (1 - foreground.alpha))),
      alpha: 1,
    })
    const visibleBackground = (element) => {
      const layers = []
      let current = element
      while (current) {
        layers.push(parseColor(getComputedStyle(current).backgroundColor))
        current = current.parentElement
      }
      let result = { rgb: [255, 255, 255], alpha: 1 }
      for (let index = layers.length - 1; index >= 0; index -= 1) result = composite(layers[index], result)
      return result.rgb
    }
    const luminance = (rgb) => rgb.map(channel => {
      const normalized = channel / 255
      return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
    const contrast = (foreground, background) => {
      const visibleForeground = composite(parseColor(foreground), { rgb: background, alpha: 1 }).rgb
      const foregroundLuminance = luminance(visibleForeground)
      const backgroundLuminance = luminance(background)
      return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
    }
    const sample = (selector) => {
      const tag = document.querySelector(selector)
      const style = getComputedStyle(tag)
      return {
        background: style.backgroundColor,
        border: style.borderColor,
        color: style.color,
        visible: visibleBackground(tag),
        parentVisible: visibleBackground(tag.parentElement),
        contrast: contrast(style.color, visibleBackground(tag)),
      }
    }
    const consoleTreatment = document.documentElement.dataset.foxwarmComponentTreatment === 'console'
    const dark = document.documentElement.classList.contains('dark')
    const expected = consoleTreatment ? {
      neutral: { background: backgroundVar('--foxwarm-color-input'), border: borderVar('--foxwarm-color-border'), color: colorVar('--foxwarm-color-text') },
      success: { background: backgroundVar('--foxwarm-color-success-surface'), border: borderVar('--foxwarm-color-success-border'), color: colorVar('--foxwarm-color-success') },
      error: { background: backgroundVar('--foxwarm-color-danger-surface'), border: borderVar('--foxwarm-color-danger-border'), color: colorVar('--foxwarm-color-danger') },
      system: { background: backgroundVar('--foxwarm-color-input'), border: borderVar('--foxwarm-color-system-border'), color: colorVar('--foxwarm-color-system-accent') },
    } : {
      neutral: { background: dark ? opacity('--foxwarm-color-canvas', 60) : backgroundVar('--foxwarm-color-neutral-surface'), border: borderVar('--foxwarm-color-border-strong'), color: colorVar('--foxwarm-color-text') },
      success: { background: dark ? opacity('--foxwarm-color-success-surface-strong', 20) : backgroundVar('--foxwarm-color-success-surface'), border: borderVar('--foxwarm-color-success-border'), color: colorVar('--foxwarm-color-success') },
      error: { background: dark ? opacity('--foxwarm-color-danger-surface-strong', 20) : backgroundVar('--foxwarm-color-danger-surface'), border: borderVar('--foxwarm-color-danger-border'), color: colorVar('--foxwarm-color-danger') },
      system: { background: dark ? opacity('--foxwarm-color-system-surface', 20) : backgroundVar('--foxwarm-color-system-surface-strong'), border: borderVar('--foxwarm-color-info-border'), color: standardSystemForeground },
    }
    return {
      expected,
      systemSemantics: {
        accent: colorVar('--foxwarm-color-system-accent'),
        border: borderVar('--foxwarm-color-system-border'),
        infoBorder: borderVar('--foxwarm-color-info-border'),
        derivedForeground: standardSystemForeground,
      },
      lowAlphaContrastProbe: contrast('rgba(0, 0, 0, 0.05)', [255, 255, 255]),
      real: {
        neutral: sample('#tool-neutral .foxwarm-tool-tag'),
        success: sample('#tool-success .foxwarm-tool-tag'),
        error: sample('#tool-error .foxwarm-tool-tag'),
        context: sample('#context .foxwarm-context-block-tag'),
        reasoning: sample('#reasoning-message .foxwarm-reasoning-tag'),
        webSearch: sample('#web-search .foxwarm-web-search-tag'),
        system: sample('#system .foxwarm-system-message-tag'),
      },
      group: Object.fromEntries([...document.querySelectorAll('#tool-group [data-tool-tag-tone]')].map(tag => [tag.dataset.toolTagTone, sample(`#tool-group [data-tool-tag-tone="${tag.dataset.toolTagTone}"]`)])),
      groupHasToolSpecificClass: !!document.querySelector('#tool-group .foxwarm-tool-tag'),
    }
  })
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the thread-card surface browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>html,body{margin:0}main{padding:16px}.fixture{width:760px;max-width:100%;margin-bottom:8px}</style></head><body><main>${['tool-neutral', 'tool-success', 'tool-error', 'tool-group', 'reasoning-message', 'reasoning-processing', 'web-search', 'system', 'context'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
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

const fixtures = [
  { theme: 'foxwarm.default', mode: 'light' },
  { theme: 'foxwarm.default', mode: 'dark' },
  { theme: 'foxwarm.550a', mode: 'light' },
  { theme: 'foxwarm.550a', mode: 'dark' },
]

test('standard cards retain component opacity while console cards consume final named surfaces', async () => {
  for (const fixture of fixtures) {
    await page.goto(`${fixtureUrl}?theme=${encodeURIComponent(fixture.theme)}&mode=${fixture.mode}`, { waitUntil: 'load' })
    await page.waitForSelector('#context .foxwarm-context-block-card')
    const result = await readSurfaces()
    for (const [family, pair] of Object.entries(result.pairs)) {
      assert.deepEqual(
        { body: pair.body, header: pair.header },
        result.expectedRaw[family],
        `${JSON.stringify(fixture)} ${family} follows its treatment-specific raw surface allocation`,
      )
      const visibleDelta = Math.max(...pair.visibleBody.map((channel, index) => Math.abs(channel - pair.visibleHeader[index])))
      assert.ok(visibleDelta >= 3, `${JSON.stringify(fixture)} ${family} keeps a visible composed body/header boundary (delta ${visibleDelta})`)
    }
    if (fixture.theme === 'foxwarm.550a' && fixture.mode === 'dark') {
      assert.equal(result.pairs.toolSuccess.body, 'rgb(10, 31, 10)')
      assert.equal(result.pairs.toolSuccess.header, 'rgb(18, 50, 18)')
    }

    const tags = await readTags()
    assert.ok(tags.lowAlphaContrastProbe > 1 && tags.lowAlphaContrastProbe < 1.2, `contrast helper composites low-alpha foregrounds instead of treating them as opaque (${tags.lowAlphaContrastProbe.toFixed(2)}:1)`)
    const expectedTone = {
      neutral: 'neutral',
      success: 'success',
      error: 'error',
      context: 'neutral',
      reasoning: 'neutral',
      webSearch: 'neutral',
      system: 'system',
    }
    for (const [name, tag] of Object.entries(tags.real)) {
      const expected = tags.expected[expectedTone[name]]
      assert.deepEqual(
        { background: tag.background, border: tag.border, color: tag.color },
        expected,
        `${JSON.stringify(fixture)} ${name} tag keeps its treatment-specific declaration`,
      )
      assert.equal(tag.visible.length, 3)
      if (fixture.theme === 'foxwarm.550a') {
        const visibleDelta = Math.max(...tag.visible.map((channel, index) => Math.abs(channel - tag.parentVisible[index])))
        assert.ok(visibleDelta >= 3, `${JSON.stringify(fixture)} ${name} tag remains visibly distinct after alpha composition (delta ${visibleDelta})`)
      }
    }
    assert.equal(tags.groupHasToolSpecificClass, false, 'Tool Group tags exercise the shared tone hook without foxwarm-tool-tag')
    for (const [tone, tag] of Object.entries(tags.group)) {
      assert.deepEqual(
        { background: tag.background, border: tag.border, color: tag.color },
        tags.expected[tone],
        `${JSON.stringify(fixture)} Tool Group ${tone} tag uses the shared tone rule`,
      )
    }
    if (fixture.theme === 'foxwarm.default') {
      assert.notEqual(tags.real.system.color, tags.systemSemantics.accent, 'standard System tag no longer reuses the low-emphasis thread-line accent')
      assert.equal(tags.real.system.border, tags.systemSemantics.infoBorder)
      assert.ok(tags.real.system.contrast >= 4.5, `${JSON.stringify(fixture)} System Event tag text contrast is readable (${tags.real.system.contrast.toFixed(2)}:1)`)
      assert.ok(tags.group.system.contrast >= 4.5, `${JSON.stringify(fixture)} Tool Group system tag text contrast is readable (${tags.group.system.contrast.toFixed(2)}:1)`)
      if (fixture.mode === 'light') assert.equal(tags.real.system.background, 'rgb(219, 234, 254)', 'Default light keeps the old System tag background')
    }
  }
})

test('an imported console theme honors distinct named reasoning surfaces', async () => {
  await page.goto(`${fixtureUrl}?theme=imported-console&mode=dark`, { waitUntil: 'load' })
  await page.waitForSelector('#context .foxwarm-context-block-card')
  const imported = await readSurfaces()
  assert.equal(imported.treatment, 'console')
  assert.notEqual(imported.semantic.reasoningSurface, imported.semantic.surface)
  assert.notEqual(imported.semantic.reasoningSurfaceStrong, imported.semantic.hover)
  for (const family of ['reasoningMessage', 'reasoningProcessing', 'webSearch']) {
    assert.equal(imported.pairs[family].body, imported.semantic.reasoningSurface)
    assert.equal(imported.pairs[family].header, imported.semantic.reasoningSurfaceStrong)
  }
  const tags = await readTags()
  for (const [tone, tag] of Object.entries(tags.group)) {
    assert.deepEqual(
      { background: tag.background, border: tag.border, color: tag.color },
      tags.expected[tone],
      `imported console Tool Group ${tone} tag uses final semantic/input colors`,
    )
  }
})

test('an imported standard theme derives System tag chrome from its own semantic tokens', async () => {
  for (const mode of ['light', 'dark']) {
    await page.goto(`${fixtureUrl}?theme=imported-standard&mode=${mode}`, { waitUntil: 'load' })
    await page.waitForSelector('#system .foxwarm-system-message-tag')
    const tags = await readTags()
    assert.notEqual(tags.systemSemantics.derivedForeground, tags.systemSemantics.accent)
    assert.notEqual(tags.systemSemantics.infoBorder, tags.systemSemantics.border)
    for (const tag of [tags.real.system, tags.group.system]) {
      assert.deepEqual(
        { background: tag.background, border: tag.border, color: tag.color },
        tags.expected.system,
        `imported standard ${mode} System tag derives from info/system semantics`,
      )
    }
    assert.deepEqual(
      { background: tags.real.reasoning.background, border: tags.real.reasoning.border, color: tags.real.reasoning.color },
      tags.expected.neutral,
      `imported standard ${mode} Reasoning remains neutral`,
    )
  }
})
