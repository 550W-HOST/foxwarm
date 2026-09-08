import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-composer-paste-'))
const entryPath = path.join(tempDir, 'fixture.tsx')
const outputDirectory = path.join(tempDir, 'dist')
const assetsDirectory = path.join(webuiRoot, 'dist/assets')
const preactCompatPath = fileURLToPath(import.meta.resolve('preact/compat'))
const preactCompatClientPath = fileURLToPath(import.meta.resolve('preact/compat/client'))
const preactJsxRuntimePath = fileURLToPath(import.meta.resolve('preact/jsx-runtime'))
let server
let fixtureUrl

await writeFile(entryPath, `
  import { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import ChatComposer from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatComposer.tsx'))}
  window.fetch = async () => ({ ok: true, json: async () => ({ commands: [{ name: '/help', description: 'Help' }] }) })
  const noop = async () => {}
  function Fixture() {
    const [sessionId, setSessionId] = useState('fixture/main')
    const [loading, setLoading] = useState(false)
    const [, redraw] = useState(0)
    window.fixtureCurrentSession = sessionId
    window.fixtureSetSession = setSessionId
    window.fixtureSetLoading = setLoading
    window.fixtureRedraw = () => redraw(value => value + 1)
    const props = {
      sessionId, sessionMissing: false, loading, asrAvailable: false,
      modelOptions: [], currentModelKey: 'model/current', sessionModel: 'model/current', defaultModelKey: 'model/current',
      childModelDefault: 'model/current', effectiveChildModelKey: 'model/current', effectiveEffort: 'medium', effectiveChildEffort: 'medium',
      onChangeModel: noop, onChangeChildModel: noop, onChangeEffort: noop, onChangeChildEffort: noop,
      onRefreshModels: noop, onOpenModelSettings: () => {},
      onSend: async value => { window.fixtureSends.push(value); return window.fixtureAccept },
      onTranscribeAudio: async () => {
        if (window.fixtureHoldTranscription) await new Promise(resolve => { window.fixtureReleaseTranscription = resolve })
        return { text: 'transcript', status: 200, rawLength: 0, textLength: 10, responsePreview: '' }
      },
      onCreateStreamingTranscriber: async () => ({ sendAudioChunk() {}, stop() {}, cancel() {} }),
      onDraftEdited: text => { window.fixtureDraft = text },
    }
    return <div id="host"><ChatComposer {...props} /></div>
  }
  window.fixtureSends = []
  window.fixtureAccept = false
  window.fixtureHoldTranscription = false
  createRoot(document.getElementById('root')).render(<Fixture />)
  window.fixtureEditor = () => document.querySelector('[role="textbox"][aria-label="Message"]')
  window.fixtureSelectText = (start, end) => {
    const editor = window.fixtureEditor()
    editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    editor.focus()
    editor.normalize()
    const node = [...editor.childNodes].find(child => child.nodeType === Node.TEXT_NODE)
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  }
  window.fixturePaste = text => {
    const data = new DataTransfer(); data.setData('text/plain', text); data.setData('text/html', '<b>different html</b>')
    const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: data })
    window.fixtureEditor().dispatchEvent(event)
  }
  window.fixtureCaretAtRootOffset = offset => {
    const editor = window.fixtureEditor(); editor.focus(); const range = document.createRange(); range.setStart(editor, offset); range.collapse(true)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  }
  window.fixtureSelectAll = () => {
    const editor = window.fixtureEditor(); editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); editor.focus(); const range = document.createRange(); range.selectNodeContents(editor)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  }
  window.fixtureSelectAcrossChip = (start, end, backward = false) => {
    const editor = window.fixtureEditor(); editor.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); editor.focus(); editor.normalize(); const range = document.createRange()
    range.setStart(editor.firstChild, start); range.setEnd(editor.lastChild, end)
    const selection = getSelection(); selection.removeAllRanges()
    if (backward) selection.setBaseAndExtent(editor.lastChild, end, editor.firstChild, start)
    else selection.addRange(range)
  }
`)

before(async () => {
  await esbuild.build({
    entryPoints: [entryPath], outdir: outputDirectory, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    alias: { react: preactCompatPath, 'react-dom': preactCompatPath, 'react-dom/client': preactCompatClientPath, 'react/jsx-runtime': preactJsxRuntimePath },
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' }, logLevel: 'silent',
  })
  const cssAsset = (await readdir(assetsDirectory)).find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running composer pasted-text browser tests')
  const css = await readFile(path.join(assetsDirectory, cssAsset), 'utf8')
  server = createServer(async (request, response) => {
    if (request.url === '/fixture.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(await readFile(path.join(outputDirectory, 'fixture.js'))); return }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>body{margin:0}#host{max-width:760px;margin:auto}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server?.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

async function withBrowser(spec, run) {
  const browser = await puppeteer.launch({ ...(spec.browser ? { browser: spec.browser } : {}), executablePath: spec.path, headless: true, args: spec.args || [] })
  try {
    if (!spec.browser) await browser.defaultBrowserContext().overridePermissions(fixtureUrl, ['clipboard-read', 'clipboard-write'])
    const page = await browser.newPage()
    page.setDefaultTimeout(60_000)
    if (!spec.browser) await page.setViewport({ width: 900, height: 760 })
    await page.goto(fixtureUrl, { waitUntil: 'load' })
    await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    await run(page)
  } finally {
    await browser.close()
  }
}

const browsers = [
  { name: 'Chromium', path: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  { name: 'Firefox', browser: 'firefox', path: process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox' },
]

for (const spec of browsers) {
  test(`${spec.name} edits pasted-text blocks without resetting native text flow`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await page.type(editor, 'before')
    await page.evaluate(() => { const node = window.fixtureEditor().firstChild; node.fixtureIdentity = 42 })
    await page.type(editor, ' after')
    assert.equal(await page.$eval(editor, node => node.firstChild.fixtureIdentity), 42)
    await page.evaluate(() => window.fixtureSelectText(6, 7))
    const pasted = `${'😀'.repeat(2000)}\n\n  exact tail`
    await page.evaluate(text => window.fixturePaste(text), pasted)
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before<pasted-text>${pasted}</pasted-text>after`)
    assert.equal(await page.$eval('.foxwarm-composer-pasted-text-chip', node => node.contentEditable), 'false')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 1)

    await page.evaluate(() => window.fixtureCaretAtRootOffset(1))
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift')
    await page.keyboard.type('Y')
    assert.equal(await page.evaluate(() => window.fixtureDraft.endsWith('</pasted-text>X\nYafter')), true)

    await page.click('.foxwarm-composer-pasted-text-chip')
    assert.equal(await page.$eval('textarea[aria-label="Full pasted text"]', node => node.readOnly), false)
    const modalGeometry = await page.$eval('[role="dialog"]', dialog => {
      const box = dialog.getBoundingClientRect()
      const textarea = dialog.querySelector('textarea').getBoundingClientRect()
      return { width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, textareaHeight: textarea.height }
    })
    assert.equal(modalGeometry.width >= modalGeometry.viewportWidth * 0.75 && modalGeometry.width <= modalGeometry.viewportWidth * 0.81, true)
    assert.equal(modalGeometry.height >= modalGeometry.viewportHeight * 0.75 && modalGeometry.height <= modalGeometry.viewportHeight * 0.81, true)
    assert.equal(modalGeometry.textareaHeight > modalGeometry.height * 0.5, true)
    await page.$eval('textarea[aria-label="Full pasted text"]', node => { node.value = 'edited\n\n  block'; node.dispatchEvent(new InputEvent('input', { bubbles: true })) })
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel').click())
    assert.equal(await page.evaluate(text => window.fixtureDraft.includes(`${text}</pasted-text>`), pasted), true)
    await page.click('.foxwarm-composer-pasted-text-chip')
    await page.$eval('textarea[aria-label="Full pasted text"]', node => { node.value = 'edited\n\n  block'; node.dispatchEvent(new InputEvent('input', { bubbles: true })) })
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save').click())
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'before<pasted-text>edited\n\n  block</pasted-text>X\nYafter')
    await page.waitForFunction(() => document.activeElement?.classList.contains('foxwarm-composer-pasted-text-chip'))

    await page.evaluate(() => window.fixtureCaretAtRootOffset(2))
    await page.keyboard.press('Backspace')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 0)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 1)
    await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 0)

    await page.evaluate(() => window.fixtureSetSession('fixture/literal'))
    await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.type(editor, 'abc')
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.$eval(editor, node => node.textContent), '')
    await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control')
    assert.equal(await page.$eval(editor, node => node.textContent), 'abc')
    await page.evaluate(() => window.fixtureSelectAll())
    await page.type(editor, 'typed <pasted-text>literal</pasted-text>')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 0)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'typed <pasted-text>literal</pasted-text>')
    await page.evaluate(() => { window.fixtureSelectAll(); window.fixturePaste(`${'a'.repeat(2000)}</pasted-text>`) })
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 0)
    await page.evaluate(() => { window.fixtureSelectAll(); window.fixturePaste('b'.repeat(2000)) })
    await page.click('.foxwarm-composer-pasted-text-chip')
    await page.$eval('textarea[aria-label="Full pasted text"]', node => { node.value = 'ordinary </pasted-text> text'; node.dispatchEvent(new InputEvent('input', { bubbles: true })) })
    assert.equal(await page.$eval('button', () => !![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save')?.disabled), true)
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Restore to text').click())
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 0)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'ordinary </pasted-text> text')
  }))
}

for (const spec of browsers) {
  test(`${spec.name} restores real empty state and permits physical caret entry around leading blocks`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console')
      document.documentElement.classList.add('dark')
    })
    const placeholder = await page.$eval(editor, node => ({
      empty: node.dataset.empty,
      children: node.childNodes.length,
      position: getComputedStyle(node, '::before').position,
      pointerEvents: getComputedStyle(node, '::before').pointerEvents,
      content: getComputedStyle(node, '::before').content,
    }))
    assert.equal(placeholder.empty, 'true')
    assert.equal(placeholder.children, 0)
    assert.equal(placeholder.position, 'absolute')
    assert.equal(placeholder.pointerEvents, 'none')
    assert.notEqual(placeholder.content, 'none')

    await page.click(editor, { offset: { x: 180, y: 12 } })
    assert.equal(await page.evaluate(() => {
      const selection = getSelection(); const editorNode = window.fixtureEditor()
      return selection?.isCollapsed && (selection.anchorNode === editorNode || editorNode.contains(selection.anchorNode)) && selection.anchorOffset === 0
    }), true)
    await page.keyboard.type('visible')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'visible')
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => window.fixtureDraft === '' && window.fixtureEditor()?.dataset.empty === 'true' && window.fixtureEditor()?.childNodes.length === 0)
    assert.deepEqual(await page.evaluate(() => ({
      structured: localStorage.getItem('composer_draft_v1_fixture/main'),
      legacy: localStorage.getItem('draft_fixture/main'),
    })), { structured: null, legacy: null })

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector(editor)
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console')
      document.documentElement.classList.remove('dark')
    })
    assert.deepEqual(await page.$eval(editor, node => ({ empty: node.dataset.empty, children: node.childNodes.length })), { empty: 'true', children: 0 })

    await page.click(editor)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n\n')
    assert.notEqual(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)
    await page.evaluate(() => window.fixtureSelectAll())
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => window.fixtureDraft === '' && window.fixtureEditor()?.childNodes.length === 0)

    const first = 'f'.repeat(2000)
    const second = 's'.repeat(2000)
    await page.evaluate(text => window.fixturePaste(text), first)
    await page.evaluate(text => window.fixturePaste(text), second)
    const exactBlocks = `<pasted-text>${first}</pasted-text><pasted-text>${second}</pasted-text>`
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-caret-anchor]').length), 3)

    for (const dark of [false, true]) {
      await page.evaluate(enabled => document.documentElement.classList.toggle('dark', enabled), dark)
      await page.click('.foxwarm-composer-pasted-text-chip')
      const modal = await page.$eval('[role="dialog"]', dialog => {
        const box = dialog.getBoundingClientRect()
        const textarea = dialog.querySelector('textarea').getBoundingClientRect()
        return { width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight, textareaHeight: textarea.height }
      })
      assert.equal(modal.width >= modal.viewportWidth * 0.75 && modal.width <= modal.viewportWidth * 0.81, true)
      assert.equal(modal.height >= modal.viewportHeight * 0.75 && modal.height <= modal.viewportHeight * 0.81, true)
      assert.equal(modal.textareaHeight > modal.height * 0.5, true)
      await page.click('button[aria-label="Close pasted text"]')
    }

    await page.click('.foxwarm-composer-caret-anchor')
    await page.evaluate(() => window.fixturePaste('\u200B'))
    assert.equal(await page.evaluate(() => window.fixtureDraft), `\u200B${exactBlocks}`)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)

    const initialAnchors = await page.$$('.foxwarm-composer-caret-anchor')
    await initialAnchors.at(-1).click()
    await page.keyboard.press('Home')
    await page.keyboard.type('home ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('home <pasted-text>')), true)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)

    await page.focus('.foxwarm-composer-pasted-text-chip')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('arrow ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('arrow <pasted-text>')), true)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)

    await page.click('.foxwarm-composer-caret-anchor')
    await page.keyboard.type('mouse ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('mouse <pasted-text>')), true)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)

    await page.evaluate(() => window.fixtureSelectAll())
    await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exactBlocks)
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).includes('\u200B'), false)

    const anchors = await page.$$('.foxwarm-composer-caret-anchor')
    await anchors.at(-1).click()
    await page.keyboard.press('Backspace')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 1)
    const remainingAnchors = await page.$$('.foxwarm-composer-caret-anchor')
    await remainingAnchors.at(-1).click()
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => window.fixtureDraft === '' && window.fixtureEditor()?.childNodes.length === 0)
    assert.deepEqual(await page.evaluate(() => ({
      structured: localStorage.getItem('composer_draft_v1_fixture/main'),
      legacy: localStorage.getItem('draft_fixture/main'),
    })), { structured: null, legacy: null })

    if (spec.name === 'Chromium') {
      await page.setViewport({ width: 390, height: 640 })
      await page.evaluate(text => window.fixturePaste(text), first)
      await page.click('.foxwarm-composer-pasted-text-chip')
      await page.setViewport({ width: 390, height: 420 })
      await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getBoundingClientRect().height <= 340)
      const mobileModal = await page.$eval('[role="dialog"]', dialog => {
        const box = dialog.getBoundingClientRect()
        const textarea = dialog.querySelector('textarea').getBoundingClientRect()
        const footerButton = [...dialog.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save').getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height, textareaHeight: textarea.height, footerBottom: footerButton.bottom }
      })
      assert.equal(mobileModal.left >= 15 && mobileModal.right <= 375 && mobileModal.top >= 15 && mobileModal.bottom <= 405, true)
      assert.equal(mobileModal.textareaHeight > 100 && mobileModal.footerBottom <= 405, true)
    }
  }))
}

for (const spec of browsers) {
test(`${spec.name} restores caret and selected ranges through custom undo and redo`, async () => withBrowser(spec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.evaluate(() => window.fixtureSetSession('fixture/history-selection'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/history-selection')
  await new Promise(resolve => setTimeout(resolve, 50))
  await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
  await page.type(editor, 'ac')
  await page.evaluate(() => window.fixtureSelectText(1, 1))
  await page.keyboard.type('b')
  assert.equal(await page.$eval(editor, node => node.textContent), 'abc')
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.$eval(editor, node => node.textContent), 'ac')
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control')
  assert.equal(await page.$eval(editor, node => node.textContent), 'abc')
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  await page.keyboard.type('X')
  assert.equal(await page.$eval(editor, node => node.textContent), 'aXc')

  await page.evaluate(() => window.fixtureSetSession('fixture/history-range'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/history-range')
  await new Promise(resolve => setTimeout(resolve, 50))
  await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
  await page.type(editor, 'left right')
  await page.evaluate(() => { window.fixtureSelectText(4, 5); window.fixturePaste('p'.repeat(2000)) })
  const segmented = await page.evaluate(() => window.fixtureDraft)
  await page.evaluate(() => window.fixtureSelectAcrossChip(2, 3, true))
  await page.keyboard.type('Z')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'leZht')
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), segmented)
  await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'leZht')
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  await page.keyboard.type('Q')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'leQht')
}))
}

test('Chromium blocks custom and native draft mutations throughout disabled transitions', async () => withBrowser(browsers[0], async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.evaluate(() => window.fixtureSetSession('fixture/disabled'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/disabled')
  await new Promise(resolve => setTimeout(resolve, 50))
  await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
  await page.type(editor, 'start end')
  await page.evaluate(() => { window.fixtureSelectText(5, 6); window.fixturePaste('d'.repeat(2000)) })
  const expected = await page.evaluate(() => window.fixtureDraft)
  await page.click('.foxwarm-composer-pasted-text-chip')
  await page.$eval('textarea[aria-label="Full pasted text"]', node => { node.value = 'stale modal edit'; node.dispatchEvent(new InputEvent('input', { bubbles: true })) })
  await page.evaluate(() => {
    window.fixtureStaleSave = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save')
    window.fixtureStaleRestore = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Restore to text')
    window.fixtureSetLoading(true)
  })
  await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'false'
    && document.querySelector('.foxwarm-composer-pasted-text-chip')?.getAttribute('aria-disabled') === 'true'
    && !document.querySelector('textarea[aria-label="Full pasted text"]'))
  assert.deepEqual(await page.$eval('.foxwarm-composer-pasted-text-chip', node => ({ tabIndex: node.tabIndex, disabled: node.getAttribute('aria-disabled') })), { tabIndex: -1, disabled: 'true' })
  await page.evaluate(() => { window.fixtureStaleSave.click(); window.fixtureStaleRestore.click() })
  assert.equal(await page.evaluate(() => window.fixtureDraft), expected)

  await page.evaluate(() => {
    window.fixtureSelectAll()
    window.fixturePaste('x'.repeat(2000))
    const data = new DataTransfer()
    const cut = new Event('cut', { bubbles: true, cancelable: true })
    Object.defineProperty(cut, 'clipboardData', { value: data })
    window.fixtureEditor().dispatchEvent(cut)
    window.fixtureEditor().textContent = 'forced native mutation'
    window.fixtureEditor().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'forced native mutation' }))
  })
  assert.equal(await page.evaluate(() => window.fixtureDraft), expected)
  assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 1)
  await page.click('.foxwarm-composer-pasted-text-chip')
  assert.equal(await page.$('textarea[aria-label="Full pasted text"]'), null)

  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['audio'], 'busy.wav', { type: 'audio/wav' }))
    const input = document.querySelector('#audio-upload')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForFunction(previous => window.fixtureDraft === `${previous}\n\ntranscript`, {}, expected)
  await page.evaluate(() => window.fixtureSetLoading(false))
  await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'true'
    && document.querySelector('.foxwarm-composer-pasted-text-chip')?.getAttribute('aria-disabled') === 'false')
  assert.deepEqual(await page.$eval('.foxwarm-composer-pasted-text-chip', node => ({ tabIndex: node.tabIndex, disabled: node.getAttribute('aria-disabled') })), { tabIndex: 0, disabled: 'false' })
}))

test('Chromium preserves storage, send, copy, selection, composition, slash, and mobile contracts', async () => withBrowser(browsers[0], async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'session A')
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).version), 1)
  await page.evaluate(() => window.fixtureSetSession('fixture/other'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/other')
  await new Promise(resolve => setTimeout(resolve, 50))
  await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
  await page.type(editor, 'session B')
  await page.evaluate(() => window.fixtureSetSession('fixture/main'))
  await page.waitForFunction(() => window.fixtureEditor()?.textContent === 'session A')
  await page.evaluate(() => {
    window.fixtureHoldTranscription = true
    const transfer = new DataTransfer()
    transfer.items.add(new File(['audio'], 'sample.wav', { type: 'audio/wav' }))
    const input = document.querySelector('#audio-upload')
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.evaluate(() => window.fixtureSetSession('fixture/other'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/other')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await page.$eval(editor, node => node.textContent), 'session B')
  await page.evaluate(() => window.fixtureReleaseTranscription())
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).segments.some(segment => segment.type === 'text' && segment.text.includes('transcript')))
  assert.equal(await page.$eval(editor, node => node.textContent), 'session B')
  await page.evaluate(() => window.fixtureSetSession('fixture/main'))
  await page.waitForFunction(() => window.fixtureEditor()?.textContent === 'session A\n\ntranscript')

  await page.evaluate(() => { window.fixtureSelectAll(); window.fixturePaste(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')) })
  const exact = await page.evaluate(() => window.fixtureDraft)
  const copied = await page.evaluate(() => {
    window.fixtureSelectAll()
    const data = new DataTransfer()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    window.fixtureEditor().dispatchEvent(event)
    return data.getData('text/plain')
  })
  assert.equal(copied, exact)
  await page.evaluate(() => window.fixtureSelectAll())
  await page.keyboard.down('Control'); await page.keyboard.press('x'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), '')
  await page.evaluate(() => window.fixtureEditor().dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'historyUndo' })))
  assert.equal(await page.evaluate(() => window.fixtureDraft), exact)

  await page.evaluate(() => { window.fixtureAccept = false })
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control')
  await page.waitForFunction(() => window.fixtureSends.length === 1)
  assert.equal(await page.$eval(editor, node => node.textContent.length > 0), true)
  await page.evaluate(() => { window.fixtureAccept = true })
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control')
  await page.waitForFunction(() => window.fixtureSends.length === 2)
  await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)
  assert.equal(await page.evaluate(() => window.fixtureSends[1].text), exact)

  await page.type(editor, '/he')
  await page.waitForSelector('[data-slash-command-overlay="true"]')
  await page.keyboard.press('Enter')
  assert.equal(await page.$eval(editor, node => node.textContent), '/help ')

  await page.evaluate(() => {
    window.fixtureSelectAll()
    const editorNode = window.fixtureEditor()
    editorNode.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const selection = getSelection(); const range = selection.getRangeAt(0); range.deleteContents(); const node = document.createTextNode('中文'); range.insertNode(node)
    editorNode.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '中文' }))
    editorNode.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }))
    editorNode.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
  })
  assert.equal(await page.evaluate(() => window.fixtureDraft), '中文')
  assert.equal(await page.evaluate(() => window.fixtureSends.length), 2)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.$eval(editor, node => node.textContent), '/help ')

  await page.setViewport({ width: 360, height: 700 })
  await page.evaluate(() => { window.fixtureSelectAll(); window.fixturePaste('x'.repeat(2000)) })
  const geometry = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, chip: document.querySelector('.foxwarm-composer-pasted-text-chip').getBoundingClientRect().width }))
  assert.ok(geometry.doc <= geometry.viewport, JSON.stringify(geometry))
  assert.ok(geometry.chip < geometry.viewport, JSON.stringify(geometry))

  await page.evaluate(() => {
    window.fixtureSetSession('fixture/quota')
    window.fixtureRealSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('composer_draft_v1_')) throw new DOMException('quota', 'QuotaExceededError')
      return window.fixtureRealSetItem.call(this, key, value)
    }
  })
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/quota')
  await new Promise(resolve => setTimeout(resolve, 50))
  await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
  await page.type(editor, 'unsaved but visible')
  await page.waitForFunction(() => document.body.textContent.includes('Draft could not be saved in this browser'))
  assert.equal(await page.$eval(editor, node => node.textContent), 'unsaved but visible')
  await page.evaluate(() => { Storage.prototype.setItem = window.fixtureRealSetItem })
}))
