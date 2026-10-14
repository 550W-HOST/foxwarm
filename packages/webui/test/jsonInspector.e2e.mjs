import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { createEditorFixtureServer } from './editorFixtureServer.mjs'

let server
let browser
let url
const source = `
  import React from 'react'
  import { createRoot } from 'react-dom/client'
  import ChatTimeline from '/src/components/ChatTimeline.tsx'
  import JsonInspectorDialog from '/src/components/JsonInspectorDialog.tsx'
  import { initializeThemeRuntime, setThemeSelection, DEFAULT_THEME } from '/src/theme/index.ts'
  initializeThemeRuntime()
  window.changeTheme = () => setThemeSelection({ themeId: DEFAULT_THEME.id, colorMode: 'dark' })
  const originalStringify = JSON.stringify
  window.fixtureCaptures = 0
  JSON.stringify = (value, ...args) => {
    if (value?.fixtureMessage || value?.modelMessage?.fixtureMessage) window.fixtureCaptures++
    return originalStringify(value, ...args)
  }
  window.copiedText = null
  Object.defineProperty(Navigator.prototype, 'clipboard', { configurable: true, get: () => ({ writeText: async text => { window.copiedText = text } }) })
  window.chatFindCount = 0
  window.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'f') window.chatFindCount++ })
  const message = { role:'model', fixtureMessage:true, parts:[{text:'## Original reply\\n\\nRaw **source** stays here.'}], extra:{first:{second:{value:'DEEP_COMPLETE_VALUE'}}}, __meta:{seq:1} }
  const toolMessage = { role:'model', fixtureMessage:true, parts:[{functionCall:{id:'call-a',name:'exec',args:{command:'echo result',nested:{complete:'FULL_TOOL_ARGS'}}}}], __meta:{seq:2} }
  const response = { role:'tool', parts:[{functionResponse:{tool_use_id:'call-a',name:'exec',response:{output:'Result body',nested:{complete:'FULL_RESPONSE_DATA'}}}}, {inlineData:{mimeType:'image/png',data:'AA=='},toolUseId:'call-a'}], __meta:{seq:3} }
  function Fixture() {
    const [messages, setMessages] = React.useState([message, toolMessage, response])
    const [secondOpen, setSecondOpen] = React.useState(false)
    window.updateFixture = () => setMessages(current => current.map(item => item === message ? {...item,parts:[{text:'Updated stream text'}]} : item))
    window.openSecondInspector = () => setSecondOpen(true)
    return <><section data-fixture-pane className="relative z-30 h-full overflow-auto p-6"><div style={{height:500}}/><ChatTimeline sessionId="fixture/main" messages={messages} isMobile={false} timelineView="detailed" showUsageBadge={false}/><div style={{height:1000}}/></section>{secondOpen && <JsonInspectorDialog text={'{\\n  "secondPane": {\\n    "nested": {\\n      "value": true\\n    }\\n  }\\n}'} onClose={() => setSecondOpen(false)}/>}</>
  }
  createRoot(document.getElementById('root')).render(<Fixture />)
`

before(async () => {
  server = await createEditorFixtureServer(source, 'json-inspector')
  url = server.resolvedUrls.local[0]
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})
after(async () => { await browser?.close(); await server?.close() })

async function editorState(page, action) {
  return page.evaluate(async action => {
    const { loadYamlMonacoSupport } = await import('/src/yamlMonacoSupport.ts')
    const { monaco } = await loadYamlMonacoSupport()
    const editor = monaco.editor.getEditors().at(-1)
    if (action) await editor.getAction(action).run()
    return {
      text: editor?.getValue(),
      readOnly: editor?.getOption(monaco.editor.EditorOption.readOnly),
      visible: editor?.getVisibleRanges().map(range => [range.startLineNumber, range.endLineNumber]),
      editors: monaco.editor.getEditors().length,
      models: monaco.editor.getModels().length,
      uris: monaco.editor.getModels().map(model => model.uri.toString()),
    }
  }, action)
}
async function openJson(page, card) {
  await page.hover(card)
  await page.click(`${card} [title="JSON"]`)
  await page.waitForSelector('[data-json-inspector-dialog] [data-editor-ready="true"]')
}
async function closeJson(page) {
  const buttons = await page.$$('[data-json-inspector-dialog] [aria-label="Close"]')
  await buttons.at(-1).click()
}
async function screenshot(page, name) {
  if (!process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR) return
  await mkdir(process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({ path: `${process.env.FOXWARM_PREVIEW_SCREENSHOT_DIR}/${name}.png` })
}

test('assistant JSON is a lazy, folded read-only snapshot and closing preserves Raw, scroll and editor choices', async () => {
  const page = await browser.newPage()
  await page.setViewport({ width: 1180, height: 820 })
  const editorRequests = []
  page.on('request', request => { if (request.url().includes('monaco-editor')) editorRequests.push(request.url()) })
  await page.goto(url)
  await page.waitForSelector('.foxwarm-assistant-message-card')
  await page.$eval('[data-fixture-pane]', pane => { pane.scrollTop = 420 })
  await page.$eval('.foxwarm-assistant-message-card [title="Raw Text"]', button => button.click())
  await page.evaluate(() => { window.originalCard = document.querySelector('.foxwarm-assistant-message-card'); window.originalScroll = document.querySelector('[data-fixture-pane]').scrollTop })
  assert.equal(await page.evaluate(() => window.fixtureCaptures), 0)
  assert.equal(editorRequests.length, 0)
  await openJson(page, '.foxwarm-assistant-message-card')
  const initial = await editorState(page)
  assert.equal(initial.readOnly, true)
  assert.match(initial.text, /DEEP_COMPLETE_VALUE/)
  const lines = initial.text.split('\n')
  const isVisible = (ranges, index) => ranges.some(([start, end]) => index + 1 >= start && index + 1 <= end)
  assert.equal(isVisible(initial.visible, 0), true)
  assert.equal(isVisible(initial.visible, lines.findIndex(line => line.includes('"fixtureMessage"'))), true)
  assert.equal(isVisible(initial.visible, lines.findIndex(line => line.includes('DEEP_COMPLETE_VALUE'))), false)
  assert.equal(await page.evaluate(() => window.originalCard === document.querySelector('.foxwarm-assistant-message-card') && window.originalScroll === document.querySelector('[data-fixture-pane]').scrollTop), true)
  assert.equal(await page.evaluate(() => document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest('[data-json-inspector-dialog]') !== null), true)
  await screenshot(page, 'json-assistant-wide')
  await page.click('[data-json-inspector-dialog] .view-lines')
  await page.keyboard.type('should not edit')
  assert.equal((await editorState(page)).text, initial.text)
  const unfolded = await editorState(page, 'editor.unfoldAll')
  assert.equal(isVisible(unfolded.visible, lines.findIndex(line => line.includes('DEEP_COMPLETE_VALUE'))), true)
  await page.evaluate(() => { window.updateFixture(); window.changeTheme() })
  await page.waitForFunction(() => document.querySelector('.foxwarm-assistant-message-raw')?.textContent === 'Updated stream text')
  const afterUpdate = await editorState(page)
  assert.equal(afterUpdate.text, initial.text)
  assert.deepEqual(afterUpdate.visible, unfolded.visible)
  assert.equal(await page.evaluate(() => window.fixtureCaptures), 1)
  await page.click('[data-json-inspector-dialog] .view-lines')
  await page.keyboard.down('Control'); await page.keyboard.press('f'); await page.keyboard.up('Control')
  await page.waitForSelector('[data-json-inspector-dialog] .find-widget.visible')
  assert.equal(await page.evaluate(() => window.chatFindCount), 0)
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-json-inspector-dialog] .find-widget .codicon-widget-close')
    const rect = button.getBoundingClientRect()
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })
  await page.click('[data-json-inspector-dialog] .find-widget .codicon-widget-close')
  await page.$$eval('[data-json-inspector-dialog] button', buttons => buttons.find(button => button.textContent.trim() === 'Copy').click())
  await page.waitForFunction(() => window.copiedText !== null)
  assert.equal(await page.evaluate(() => window.copiedText), initial.text)
  await closeJson(page)
  assert.equal(await page.$('[data-json-inspector-dialog]'), null)
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('title')), 'JSON')
  const disposed = await editorState(page)
  assert.equal(disposed.editors, 0)
  assert.equal(disposed.models, 0)
  assert.equal(await page.$eval('.foxwarm-assistant-message-raw', element => element.textContent), 'Updated stream text')
  await page.close()
})

test('tool JSON leaves collapsed and expanded bodies untouched, retains the whole inspection object and releases two models', async () => {
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 760 })
  await page.goto(url)
  await page.waitForSelector('.foxwarm-tool-card')
  await page.$eval('[data-fixture-pane]', pane => { pane.scrollTop = 450 })
  const card = '.foxwarm-tool-card'
  assert.equal(await page.$(`${card} [title="Default"]`), null)
  const before = await page.$eval(card, element => ({ text:element.textContent, height:element.getBoundingClientRect().height, expanded:!!element.querySelector('.foxwarm-tool-expanded-content') }))
  await openJson(page, card)
  const first = await editorState(page)
  const data = JSON.parse(first.text)
  assert.deepEqual(Object.keys(data), ['modelMessage', 'call', 'responses', 'imageParts'])
  assert.equal(data.call.args.nested.complete, 'FULL_TOOL_ARGS')
  assert.equal(data.responses[0].response.nested.complete, 'FULL_RESPONSE_DATA')
  assert.equal(data.imageParts.length, 1)
  assert.deepEqual(await page.$eval(card, element => ({ text:element.textContent, height:element.getBoundingClientRect().height, expanded:!!element.querySelector('.foxwarm-tool-expanded-content') })), before)
  await screenshot(page, 'json-tool-narrow')
  await page.evaluate(() => window.openSecondInspector())
  await page.waitForFunction(() => document.querySelectorAll('[data-json-inspector-dialog] [data-editor-ready="true"]').length === 2)
  const two = await editorState(page)
  assert.equal(two.models, 2)
  assert.equal(new Set(two.uris).size, 2)
  await closeJson(page)
  assert.equal((await editorState(page)).models, 1)
  await closeJson(page)
  assert.equal((await editorState(page)).models, 0)
  await page.$eval(`${card} .foxwarm-tool-header-toggle`, element => element.click())
  await page.waitForSelector('.foxwarm-tool-expanded-content')
  await page.waitForFunction(() => !document.querySelector('.foxwarm-tool-card').style.height)
  const expanded = await page.$eval(card, element => element.textContent)
  await openJson(page, card)
  await closeJson(page)
  assert.equal(await page.$eval(card, element => element.textContent), expanded)
  assert.ok(await page.$('.foxwarm-tool-expanded-content'))
  await page.close()
})

test('Firefox opens Monaco JSON from Raw and closes without changing the underlying card', { skip: !existsSync(process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox-esr') }, async () => {
  const firefox = await puppeteer.launch({ browser:'firefox', executablePath:process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox-esr', headless:true })
  try {
    const page = await firefox.newPage()
    await page.goto(url)
    await page.waitForSelector('.foxwarm-assistant-message-card')
    await page.$eval('.foxwarm-assistant-message-card [title="Raw Text"]', button => button.click())
    await openJson(page, '.foxwarm-assistant-message-card')
    const state = await editorState(page)
    assert.equal(state.readOnly, true)
    assert.match(state.text, /DEEP_COMPLETE_VALUE/)
    await page.click('[data-json-inspector-dialog] .view-lines')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-json-inspector-dialog]'))
    assert.match(await page.$eval('.foxwarm-assistant-message-raw', element => element.textContent), /Raw \*\*source\*\*/)
    assert.equal((await editorState(page)).models, 0)
  } finally { await firefox.close() }
})
