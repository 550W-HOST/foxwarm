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
    import { ToolCallsBlock } from ${JSON.stringify(toolEntry)}

    const longPath = '/workspace/' + 'deep-directory-segment/'.repeat(20) + 'target-file.tsx'
    const calls = {
      exec: { id: 'exec-call', name: 'exec', args: { command: 'printf ' + 'very-long-command-argument '.repeat(40) } },
      wait: { id: 'wait-call', name: 'wait', args: { reason: 'very-long-wait-reason '.repeat(50), timeoutSeconds: 0, waitAllSessions: [], waitExecIds: [] } },
      read: { id: 'read-call', name: 'read', args: { filePath: longPath, startLine: 7, endLine: 13 } },
      write: { id: 'write-call', name: 'write', args: { filePath: longPath, content: 'updated content' } },
      edit: { id: 'edit-call', name: 'edit', args: { filePath: longPath, oldText: 'before', newText: 'after' } },
      apply: { id: 'apply-call', name: 'apply_patch', args: { input: ['*** Begin Patch', '*** Update File: ' + longPath, '@@', '-before', '+after', '*** End Patch'].join('\\n') } },
    }

    window.openedCodePaths = []
    const onOpenCodeFile = (filePath, lines) => window.openedCodePaths.push({ filePath, lines })
    for (const name of ['exec', 'wait', 'read', 'write', 'edit', 'apply']) {
      const msg = { role: 'model', parts: [{ functionCall: calls[name] }], __meta: { timestamp: Date.now() } }
      createRoot(document.getElementById(name)).render(React.createElement(ToolCallsBlock, { msg, onOpenCodeFile }))
    }
    const noCodeMsg = { role: 'model', parts: [{ functionCall: calls.write }], __meta: { timestamp: Date.now() } }
    createRoot(document.getElementById('write-no-code')).render(React.createElement(ToolCallsBlock, { msg: noCodeMsg }))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'tool-collapsed-overflow-fixture.tsx' },
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
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-tool-card').length === 7)
}

async function readCollapsedLayout(name) {
  return page.$eval(`#${name}`, (root) => {
    const card = root.querySelector('.foxwarm-tool-card')
    const header = root.querySelector('.foxwarm-tool-header')
    const summary = root.querySelector('.foxwarm-tool-call-summary') || header?.lastElementChild
    const style = summary ? getComputedStyle(summary) : null
    const clippedElements = summary ? [summary, ...summary.querySelectorAll('*')] : []
    const hasEllipsizedOverflow = clippedElements.some((element) => {
      const elementStyle = getComputedStyle(element)
      return element.scrollWidth > element.clientWidth + 1 && elementStyle.overflowX === 'hidden' && elementStyle.textOverflow === 'ellipsis' && elementStyle.whiteSpace === 'nowrap'
    })
    const cardRect = card?.getBoundingClientRect()
    const headerRect = header?.getBoundingClientRect()
    return {
      cardWidth: cardRect?.width || 0,
      headerHeight: headerRect?.height || 0,
      summaryHeight: summary?.getBoundingClientRect().height || 0,
      summaryLineHeight: style ? Number.parseFloat(style.lineHeight) : 0,
      summaryWhiteSpace: style?.whiteSpace || '',
      summaryOverflow: style?.overflowX || '',
      summaryTextOverflow: style?.textOverflow || '',
      summaryScrollWidth: summary?.scrollWidth || 0,
      summaryClientWidth: summary?.clientWidth || 0,
      hasEllipsizedOverflow,
      rootScrollWidth: root.scrollWidth,
      rootClientWidth: root.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    }
  })
}

function assertOneLineEllipsis(layout, label) {
  assert.equal(layout.summaryWhiteSpace, 'nowrap', `${label} summary must not wrap`)
  assert.equal(layout.summaryOverflow, 'hidden', `${label} summary must hide overflow`)
  assert.equal(layout.summaryTextOverflow, 'ellipsis', `${label} summary must show an ellipsis`)
  assert.ok(layout.hasEllipsizedOverflow, `${label} fixture must exercise ellipsized truncation`)
  assert.ok(layout.summaryHeight <= layout.summaryLineHeight + 2, `${label} summary must remain one line`)
  assert.ok(layout.rootScrollWidth <= layout.rootClientWidth + 1, `${label} tool root must not overflow`)
  assert.ok(layout.documentScrollWidth <= layout.documentClientWidth + 1, `${label} must not widen the document`)
}

async function assertCollapsedTools() {
  for (const name of ['exec', 'wait', 'edit']) {
    assertOneLineEllipsis(await readCollapsedLayout(name), name)
  }
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the collapsed tool overflow browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()

  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><style>${css}</style><style>html,body{margin:0;width:100%;overflow-x:hidden}main{width:100%;padding:12px}.fixture{width:100%;min-width:0}</style></head><body><main>${['exec', 'wait', 'read', 'write', 'edit', 'apply', 'write-no-code'].map(id => `<div id="${id}" class="fixture"></div>`).join('')}</main><script>${bundle}</script></body></html>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  fixtureUrl = `http://127.0.0.1:${address.port}`

  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  await new Promise((resolve) => server?.close(resolve))
})

test('desktop collapsed exec/wait/edit summaries stay one-line ellipsized and direct file paths use icon-only Code actions', async () => {
  await mountFixture({ width: 900, height: 700 })
  await assertCollapsedTools()

  for (const id of ['read', 'write', 'edit', 'apply']) {
    const pathAction = await page.$eval(`#${id} .foxwarm-tool-code-open`, (button) => ({
      tagName: button.tagName,
      tabIndex: button.tabIndex,
      pathTagName: button.nextElementSibling?.tagName,
      pathRole: button.nextElementSibling?.getAttribute('role'),
      pathTabIndex: button.nextElementSibling?.getAttribute('tabindex'),
    }))
    assert.deepEqual(pathAction, { tagName: 'BUTTON', tabIndex: 0, pathTagName: 'SPAN', pathRole: null, pathTabIndex: null })
    await page.click(`#${id} .foxwarm-tool-code-open`)
  }
  assert.deepEqual(await page.evaluate(() => window.openedCodePaths), [
    { filePath: '/workspace/' + 'deep-directory-segment/'.repeat(20) + 'target-file.tsx', lines: { startLine: 7, endLine: 13 } },
    { filePath: '/workspace/' + 'deep-directory-segment/'.repeat(20) + 'target-file.tsx' },
    { filePath: '/workspace/' + 'deep-directory-segment/'.repeat(20) + 'target-file.tsx' },
    { filePath: '/workspace/' + 'deep-directory-segment/'.repeat(20) + 'target-file.tsx' },
  ], 'icon actions retain direct-path and read-range bridge requests')
  assert.equal(await page.$eval('#edit .foxwarm-tool-card', (card) => card.querySelectorAll('.foxwarm-diff-preview').length), 0, 'Code click must not expand the card')
  assert.equal(await page.$('#write-no-code .foxwarm-tool-code-open'), null, 'paths without the current Code handler have no action icon')

  await page.focus('#write .foxwarm-tool-code-open')
  await page.keyboard.press('Enter')
  assert.equal((await page.evaluate(() => window.openedCodePaths.length)), 5, 'the icon keeps native keyboard activation')

  await page.click('#edit .foxwarm-tool-code-path')
  await page.waitForSelector('#edit .foxwarm-tool-call-args')
  assert.equal((await page.evaluate(() => window.openedCodePaths.length)), 5, 'plain path text follows the header collapse action instead of opening Code')

  await page.waitForSelector('#edit .foxwarm-diff-preview')
  const expandedPath = await page.$eval('#edit .foxwarm-tool-code-path', (path) => {
    const style = getComputedStyle(path)
    return {
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      height: path.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      rootOverflow: path.closest('.fixture').scrollWidth - path.closest('.fixture').clientWidth,
    }
  })
  assert.notEqual(expandedPath.whiteSpace, 'nowrap', 'expanded Code path keeps wrapping behavior')
  assert.ok(['anywhere', 'break-word'].includes(expandedPath.overflowWrap))
  assert.ok(expandedPath.height > expandedPath.lineHeight * 1.5, 'expanded long path wraps onto multiple lines')
  assert.ok(expandedPath.rootOverflow <= 1)

  await page.click('#exec .foxwarm-tool-tag')
  const expandedExec = await page.$eval('#exec .foxwarm-tool-call-args .whitespace-pre-wrap', (content) => {
    const style = getComputedStyle(content)
    return {
      whiteSpace: style.whiteSpace,
      height: content.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      rootOverflow: content.closest('.fixture').scrollWidth - content.closest('.fixture').clientWidth,
    }
  })
  assert.equal(expandedExec.whiteSpace, 'pre-wrap')
  assert.ok(expandedExec.height > expandedExec.lineHeight * 1.5, 'expanded exec args remain wrappable')
  assert.ok(expandedExec.rootOverflow <= 1)
})

test('mobile 550A collapsed exec/wait/edit summaries retain the same one-line boundary', async () => {
  await mountFixture({ width: 390, height: 760, style: '550a', dark: true })
  await assertCollapsedTools()

  await page.click('#wait .foxwarm-tool-tag')
  const expandedWait = await page.$eval('#wait .foxwarm-tool-call-args .whitespace-pre-wrap', (content) => {
    const style = getComputedStyle(content)
    return {
      whiteSpace: style.whiteSpace,
      height: content.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      rootOverflow: content.closest('.fixture').scrollWidth - content.closest('.fixture').clientWidth,
    }
  })
  assert.equal(expandedWait.whiteSpace, 'pre-wrap')
  assert.ok(expandedWait.height > expandedWait.lineHeight * 1.5, 'expanded wait args remain wrappable')
  assert.ok(expandedWait.rootOverflow <= 1)
})