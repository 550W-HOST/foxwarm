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
  import { useLayoutEffect, useRef, useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import ChatComposer from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatComposer.tsx'))}
  import InlineComposerEditor from ${JSON.stringify(path.join(webuiRoot, 'src/components/InlineComposerEditor.tsx'))}
  import { makePlainComposerDraft } from ${JSON.stringify(path.join(webuiRoot, 'src/composerDraft.ts'))}
  window.fetch = async () => ({ ok: true, json: async () => ({ commands: [{ name: '/help', description: 'Help' }] }) })
  const noop = async () => {}
  function Fixture() {
    const [sessionId, setSessionId] = useState('fixture/main')
    const [loading, setLoading] = useState(false)
    const [sendKeyMode, setSendKeyMode] = useState('modEnter')
    const [, redraw] = useState(0)
    window.fixtureCurrentSession = sessionId
    window.fixtureSetSession = setSessionId
    window.fixtureSetLoading = setLoading
    window.fixtureSetSendKeyMode = setSendKeyMode
    window.fixtureRedraw = () => redraw(value => value + 1)
    const props = {
      sessionId, sessionMissing: false, loading, sendKeyMode, asrAvailable: false,
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
  function StaleSameSessionPropFixture() {
    const editorRef = useRef(null)
    const [disabled, setDisabled] = useState(false)
    const staleValue = useRef(makePlainComposerDraft('submitted value')).current
    window.fixtureTriggerImperativeClearWithStaleProp = () => setDisabled(true)
    useLayoutEffect(() => {
      if (disabled) editorRef.current?.replaceDraft(makePlainComposerDraft())
    }, [disabled])
    return <InlineComposerEditor
      ref={editorRef}
      draftId="fixture/stale-same-session"
      value={staleValue}
      disabled={disabled}
      placeholder="Message"
      onChange={() => {}}
      onBlur={() => {}}
      onAttachFiles={() => []}
      resolveAttachmentFile={() => null}
      onReattachFile={() => {}}
      onCommandKeyDown={() => false}
    />
  }
  window.fixtureSends = []
  window.fixtureAccept = false
  window.fixtureHoldTranscription = false
  const fixtureRoot = createRoot(document.getElementById('root'))
  window.fixtureRenderStaleSameSessionProp = () => fixtureRoot.render(<StaleSameSessionPropFixture />)
  fixtureRoot.render(<Fixture />)
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
    await page.waitForFunction(() => document.activeElement?.closest('.foxwarm-composer-pasted-text-chip'))

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

test('Chromium does not replay a stale same-Session prop over an imperative replacement', async () => withBrowser(browsers[0], async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.evaluate(() => window.fixtureRenderStaleSameSessionProp())
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent === 'submitted value', {}, editor)
  await page.evaluate(() => window.fixtureTriggerImperativeClearWithStaleProp())
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-disabled') === 'true', {}, editor)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.$eval(editor, node => node.textContent), '')
  assert.equal(await page.$eval(editor, node => node.dataset.empty), 'true')
}))

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
  test(`${spec.name} renders the first authored newline and preserves newline/send key modes`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
    const reset = async sessionId => {
      await page.evaluate(id => window.fixtureSetSession(id), sessionId)
      await page.waitForFunction(id => window.fixtureCurrentSession === id, {}, sessionId)
      await new Promise(resolve => setTimeout(resolve, 50))
      await page.waitForFunction(() => window.fixtureEditor()?.childNodes.length === 0)
    }
    const copyAll = () => page.evaluate(() => {
      window.fixtureSelectAll()
      const data = new DataTransfer()
      const event = new Event('copy', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: data })
      window.fixtureEditor().dispatchEvent(event)
      return data.getData('text/plain')
    })
    const selectedTextTop = () => page.evaluate(() => {
      const editorNode = window.fixtureEditor()
      const walker = document.createTreeWalker(editorNode, NodeFilter.SHOW_TEXT)
      let text = walker.nextNode()
      while (text && !(text.nodeValue || '').includes('x')) text = walker.nextNode()
      const index = text.nodeValue.lastIndexOf('x')
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1)
      return { top: range.getBoundingClientRect().top, editorTop: editorNode.getBoundingClientRect().top, lineHeight: parseFloat(getComputedStyle(editorNode).lineHeight) }
    })

    const emptySession = 'fixture/main'
    const emptyStorageKey = `composer_draft_v1_${emptySession}`
    await reset(emptySession)
    await page.click(editor)
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n')
    assert.deepEqual(await page.$eval(editor, node => ({
      empty: node.dataset.empty,
      scaffold: node.querySelectorAll('[data-composer-trailing-newline]').length,
      placeholder: getComputedStyle(node, '::before').content,
    })), { empty: 'false', scaffold: 1, placeholder: 'none' })
    assert.notEqual(await page.evaluate(key => localStorage.getItem(key), emptyStorageKey), null)
    await page.keyboard.type('x')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\nx')
    const firstLine = await selectedTextTop()
    assert.equal(firstLine.top >= firstLine.editorTop + firstLine.lineHeight * 0.75, true)
    assert.equal(await copyAll(), '\nx')
    await page.evaluate(() => {
      const node = [...window.fixtureEditor().childNodes].find(child => child.nodeType === Node.TEXT_NODE)
      window.fixtureSelectText(node.nodeValue.length, node.nodeValue.length)
    })
    await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-trailing-newline]').length), 1)
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => window.fixtureDraft === '' && window.fixtureEditor()?.dataset.empty === 'true')
    assert.equal(await page.evaluate(key => localStorage.getItem(key), emptyStorageKey), null)

    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n\n')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-trailing-newline]').length), 1)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector(editor)
    await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-trailing-newline]').length), 1)
    await page.evaluate(() => {
      const editorNode = window.fixtureEditor(); const walker = document.createTreeWalker(editorNode, NodeFilter.SHOW_TEXT); const text = walker.nextNode()
      editorNode.focus()
      const range = document.createRange(); range.setStart(text, text.nodeValue.length); range.collapse(true)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.keyboard.type('x')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n\nx')
    assert.equal(await copyAll(), '\n\nx')

    await reset(`fixture/newline-text-${spec.name}`)
    await page.click(editor)
    await page.keyboard.type('a')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'a\n')
    await page.keyboard.type('x')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'a\nx')
    const ordinaryLine = await selectedTextTop()
    assert.equal(ordinaryLine.top >= ordinaryLine.editorTop + ordinaryLine.lineHeight * 0.75, true)

    await reset(`fixture/newline-block-${spec.name}`)
    await page.click(editor)
    const blockText = 'B'.repeat(2000)
    const block = `<pasted-text>${blockText}</pasted-text>`
    await page.evaluate(text => window.fixturePaste(text), blockText)
    const anchors = await page.$$('.foxwarm-composer-caret-anchor')
    await anchors.at(-1).click()
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${block}\n`)
    await page.keyboard.type('x')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${block}\nx`)
    assert.equal(await copyAll(), `${block}\nx`)

    await reset(`fixture/newline-block-shift-${spec.name}`)
    await page.click(editor)
    await page.evaluate(text => window.fixturePaste(text), blockText)
    const shiftAnchors = await page.$$('.foxwarm-composer-caret-anchor')
    await shiftAnchors.at(-1).click()
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${block}\n`)

    await reset(`fixture/newline-send-${spec.name}`)
    await page.evaluate(() => { window.fixtureSetSendKeyMode('enter'); window.fixtureSends = []; window.fixtureAccept = false })
    await page.click(editor)
    await page.keyboard.type('send')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.fixtureSends.length === 1)
    assert.equal(await page.evaluate(() => window.fixtureSends[0].text), 'send')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'send')
    await page.evaluate(() => window.fixtureSelectAll())
    await page.keyboard.press('Backspace')
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n')
  }))
}

for (const spec of browsers) {
  test(`${spec.name} keeps custom newline carets visible without scrolling ancestors`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const sessionId = `fixture/newline-scroll-${spec.name}`
    await page.evaluate(id => window.fixtureSetSession(id), sessionId)
    await page.waitForFunction(id => window.fixtureCurrentSession === id && window.fixtureEditor()?.childNodes.length === 0, {}, sessionId)
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
    await page.type(editor, Array.from({ length: 14 }, (_, index) => `line-${index}`).join('\n'))
    await page.focus(editor)
    await page.keyboard.press('End')
    const enterAtEnd = async () => {
      const before = await page.$eval(editor, node => ({ scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, pageTop: document.scrollingElement.scrollTop }))
      await page.keyboard.press('Enter')
      const after = await page.$eval(editor, node => {
        const scaffold = node.querySelector('[data-composer-trailing-newline]').getBoundingClientRect()
        const box = node.getBoundingClientRect()
        return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, pageTop: document.scrollingElement.scrollTop, scaffoldBottom: scaffold.bottom, visibleBottom: box.top + node.clientTop + node.clientHeight }
      })
      assert.equal(after.scrollHeight >= before.scrollHeight && after.scrollTop >= before.scrollTop, true, JSON.stringify({ before, after }))
      assert.equal(after.scaffoldBottom <= after.visibleBottom + 1.5, true, JSON.stringify({ before, after }))
      assert.equal(after.pageTop, before.pageTop)
    }
    await enterAtEnd()
    await enterAtEnd()

    const mid = await page.$eval(editor, node => {
      const text = [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE)
      const offset = text.nodeValue.indexOf('line-7') + 3
      const range = document.createRange(); range.setStart(text, offset); range.collapse(true)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
      node.scrollTop = Math.max(0, Math.floor(node.scrollHeight / 2 - node.clientHeight / 2))
      return { scrollTop: node.scrollTop, pageTop: document.scrollingElement.scrollTop }
    })
    await page.keyboard.press('Enter')
    assert.deepEqual(await page.$eval(editor, node => ({ scrollTop: node.scrollTop, pageTop: document.scrollingElement.scrollTop })), mid)

    if (spec.name === 'Chromium') {
      await page.focus(editor)
      await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control')
      const beforeInputTop = await page.$eval(editor, node => node.scrollTop)
      await page.$eval(editor, node => node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph' })))
      assert.equal(await page.$eval(editor, (node, beforeInputTop) => {
        const scaffold = node.querySelector('[data-composer-trailing-newline]').getBoundingClientRect()
        const box = node.getBoundingClientRect()
        return node.scrollTop > 0 && node.scrollTop >= beforeInputTop && scaffold.bottom <= box.top + node.clientTop + node.clientHeight + 0.5
      }, beforeInputTop), true)
    }
  }))
}

for (const spec of browsers) {
  test(`${spec.name} gives atomic blocks one keyboard step and later hard-line caret boundary`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const sessionId = `fixture/anchor-navigation-${spec.name}`
    await page.evaluate(id => window.fixtureSetSession(id), sessionId)
    await page.waitForFunction(id => window.fixtureCurrentSession === id && window.fixtureEditor()?.childNodes.length === 0, {}, sessionId)
    await new Promise(resolve => setTimeout(resolve, 50))
    const first = 'f'.repeat(2000)
    const second = 's'.repeat(2000)
    await page.click(editor)
    await page.evaluate(text => window.fixturePaste(text), first)
    await page.waitForSelector('.foxwarm-composer-caret-anchor:last-child')
    await page.click('.foxwarm-composer-caret-anchor:last-child')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('after ')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `<pasted-text>${first}</pasted-text>after `)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    await page.click('.foxwarm-composer-caret-anchor:first-child')
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift')
    if (spec.name === 'Chromium') {
      const selected = await page.$eval(editor, node => {
        const data = new DataTransfer()
        node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
        return data.getData('text/plain')
      })
      assert.equal(selected, `<pasted-text>${first}</pasted-text>`)
      await page.keyboard.press('ArrowLeft')
      await page.click('.foxwarm-composer-caret-anchor:last-child')
      await page.keyboard.down('Shift'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift')
      const reverseSelected = await page.$eval(editor, node => {
        const data = new DataTransfer()
        node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
        return data.getData('text/plain')
      })
      assert.equal(reverseSelected, `<pasted-text>${first}</pasted-text>`)
    }
    await page.keyboard.press('ArrowLeft')
    await page.click('.foxwarm-composer-caret-anchor:last-child')
    await page.keyboard.press('Enter')
    await page.evaluate(text => window.fixturePaste(text), second)
    const exact = `<pasted-text>${first}</pasted-text>\n<pasted-text>${second}</pasted-text>`
    assert.equal(await page.evaluate(() => window.fixtureDraft), exact)
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-caret-anchor]').length), 3)

    const hardLineAnchor = await page.$eval(editor, node => {
      const chips = node.querySelectorAll('[data-composer-pasted-text-id]')
      const anchor = chips[1].previousSibling
      const rect = anchor.getBoundingClientRect()
      return { x: rect.left + Math.max(0.5, rect.width / 2), y: rect.top + Math.max(1, rect.height / 2) }
    })
    await page.mouse.click(hardLineAnchor.x, hardLineAnchor.y)
    await page.keyboard.type('mouse ')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `<pasted-text>${first}</pasted-text>\nmouse <pasted-text>${second}</pasted-text>`)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    await page.mouse.click(hardLineAnchor.x, hardLineAnchor.y)
    await page.keyboard.press('Home')
    await page.keyboard.type('home ')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `<pasted-text>${first}</pasted-text>\nhome <pasted-text>${second}</pasted-text>`)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    await page.mouse.click(hardLineAnchor.x, hardLineAnchor.y)
    await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `<pasted-text>${first}</pasted-text><pasted-text>${second}</pasted-text>`)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    await page.mouse.click(hardLineAnchor.x, hardLineAnchor.y)
    await page.keyboard.press('Delete')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `<pasted-text>${first}</pasted-text>\n`)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    await page.mouse.click(hardLineAnchor.x, hardLineAnchor.y)
    await page.keyboard.down('Control'); await page.keyboard.press('Home'); await page.keyboard.up('Control')
    await page.keyboard.type('document ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('document <pasted-text>')), true)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')

    await page.evaluate(() => window.fixtureSelectAll())
    await page.keyboard.press('Backspace')
    await page.type(editor, 'w'.repeat(120))
    await page.evaluate(text => window.fixturePaste(text), first)
    assert.equal(await page.$eval(editor, node => {
      const chip = node.querySelector('[data-composer-pasted-text-id]')
      return chip.previousSibling?.nodeType === Node.TEXT_NODE && !chip.previousSibling.nodeValue.endsWith('\n')
    }), true)
  }))
}

for (const spec of browsers) {
  test(`${spec.name} exits atomic boundaries into ordinary text and collapses native selections`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const block = 'q'.repeat(2000)
    const reset = async suffix => {
      const sessionId = `fixture/mixed-boundary-${spec.name}-${suffix}`
      await page.evaluate(id => window.fixtureSetSession(id), sessionId)
      await page.waitForFunction(id => window.fixtureCurrentSession === id && window.fixtureEditor()?.childNodes.length === 0, {}, sessionId)
      await new Promise(resolve => setTimeout(resolve, 50))
      await page.type(editor, 'a😀z')
      await page.evaluate(() => window.fixtureSelectText(1, 1))
      await page.evaluate(text => window.fixturePaste(text), block)
      await page.waitForSelector('[data-composer-pasted-text-id]')
      return `<pasted-text>${block}</pasted-text>`
    }

    const wrapper = await reset('forward')
    await page.evaluate(() => window.fixtureSelectText(1, 1))
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `a${wrapper}😀Xz`)

    await reset('reverse')
    await page.evaluate(() => {
      const editorNode = window.fixtureEditor()
      const text = [...editorNode.childNodes].findLast(node => node.nodeType === Node.TEXT_NODE)
      const range = document.createRange(); range.setStart(text, '😀'.length); range.collapse(true)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `aX${wrapper}😀z`)

    await reset('collapse-right')
    await page.evaluate(() => {
      const editorNode = window.fixtureEditor(); const chip = editorNode.querySelector('[data-composer-pasted-text-id]')
      const range = document.createRange(); range.selectNode(chip)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `a${wrapper}X😀z`)

    await reset('collapse-left')
    await page.evaluate(() => {
      const editorNode = window.fixtureEditor(); const chip = editorNode.querySelector('[data-composer-pasted-text-id]')
      const range = document.createRange(); range.selectNode(chip)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `aX${wrapper}😀z`)

    await reset('shift-text')
    await page.evaluate(() => window.fixtureSelectText(1, 1))
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift')
    await page.keyboard.press('Delete')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'az')
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `a${wrapper}😀z`)

    const hardSession = `fixture/mixed-hard-${spec.name}`
    await page.evaluate(id => window.fixtureSetSession(id), hardSession)
    await page.waitForFunction(id => window.fixtureCurrentSession === id && window.fixtureEditor()?.childNodes.length === 0, {}, hardSession)
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.type(editor, 'before')
    await page.keyboard.press('Enter')
    await page.evaluate(text => window.fixturePaste(text), block)
    await page.keyboard.type('after')
    const hardAnchor = await page.$eval('[data-composer-pasted-text-id]', chip => {
      const rect = chip.previousSibling.getBoundingClientRect()
      return { x: rect.left + Math.max(0.5, rect.width / 2), y: rect.top + Math.max(1, rect.height / 2) }
    })
    await page.mouse.click(hardAnchor.x, hardAnchor.y)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before\n${wrapper}aXfter`)
  }))
}

test('Chromium hides the empty placeholder during trusted composition without persisting interim text', async () => withBrowser(browsers[0], async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  const client = await page.createCDPSession()
  await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
  await page.click(editor)
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await page.waitForFunction(() => window.fixtureEditor()?.dataset.compositionVisible === 'true')
  assert.deepEqual(await page.$eval(editor, node => ({
    empty: node.dataset.empty,
    placeholder: getComputedStyle(node, '::before').content,
  })), { empty: 'true', placeholder: 'none' })
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)

  await client.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await client.send('Input.insertText', { text: '' })
  await page.waitForFunction(() => window.fixtureEditor()?.dataset.empty === 'true' && window.fixtureEditor()?.dataset.compositionVisible !== 'true')
  assert.notEqual(await page.$eval(editor, node => getComputedStyle(node, '::before').content), 'none')
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')

  await page.click(editor)
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await client.send('Input.insertText', { text: '你' })
  await page.waitForFunction(() => window.fixtureDraft === '你')
  assert.deepEqual(await page.$eval(editor, node => ({
    empty: node.dataset.empty,
    compositionVisible: node.dataset.compositionVisible,
    placeholder: getComputedStyle(node, '::before').content,
  })), { empty: 'false', compositionVisible: 'false', placeholder: 'none' })
  await client.detach()
}))

test('Firefox hides and restores the empty placeholder around synthetic composition', async () => withBrowser(browsers[1], async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
  await page.click(editor)
  await page.evaluate(() => {
    const editorNode = window.fixtureEditor()
    editorNode.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    const selection = getSelection(); const range = selection.getRangeAt(0); const node = document.createTextNode('に'); range.insertNode(node)
    range.setStart(node, 1); range.collapse(true); selection.removeAllRanges(); selection.addRange(range)
    editorNode.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'に', isComposing: true }))
  })
  await page.waitForFunction(() => window.fixtureEditor()?.dataset.compositionVisible === 'true')
  assert.deepEqual(await page.$eval(editor, node => ({
    empty: node.dataset.empty,
    placeholder: getComputedStyle(node, '::before').content,
  })), { empty: 'true', placeholder: 'none' })
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)

  await page.evaluate(() => {
    const editorNode = window.fixtureEditor()
    editorNode.replaceChildren()
    editorNode.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '', isComposing: true }))
    editorNode.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
  })
  await page.waitForFunction(() => window.fixtureEditor()?.dataset.empty === 'true' && window.fixtureEditor()?.dataset.compositionVisible !== 'true')
  assert.notEqual(await page.$eval(editor, node => getComputedStyle(node, '::before').content), 'none')
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')
}))

for (const spec of [browsers[0]]) {
  test(`${spec.name} inserts inline file attachments at the caret and preserves atomic undo`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await page.type(editor, 'before after')
    await page.evaluate(() => window.fixtureSelectText(7, 7))
    await page.$eval(editor, editorNode => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['one'], 'duplicate.txt', { type: 'text/plain' }))
      transfer.items.add(new File(['two'], 'duplicate.txt', { type: 'text/plain' }))
      editorNode.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    })
    await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2)
    const refs = await page.$$eval('.foxwarm-composer-attachment-chip', chips => chips.map(chip => chip.dataset.composerAttachmentRef))
    assert.notEqual(refs[0], refs[1])
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before <attachment-ref ref="${refs[0]}" /><attachment-ref ref="${refs[1]}" />after`)
    await page.keyboard.type('x')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before <attachment-ref ref="${refs[0]}" /><attachment-ref ref="${refs[1]}" />xafter`)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before <attachment-ref ref="${refs[0]}" />after`)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before <attachment-ref ref="${refs[0]}" /><attachment-ref ref="${refs[1]}" />after`)

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector(editor)
    await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2)
    assert.deepEqual(await page.$$eval('.foxwarm-composer-attachment-chip', chips => chips.map(chip => chip.textContent.includes('Reattach required'))), [true, true])
    await page.locator('.foxwarm-composer-caret-anchor').click()
    await page.waitForFunction(() => document.querySelector('.foxwarm-composer-caret-anchor')?.contains(getSelection()?.anchorNode))
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('between ')
    await page.waitForFunction(expected => window.fixtureDraft === expected, {}, `before <attachment-ref ref="${refs[0]}" />between <attachment-ref ref="${refs[1]}" />after`)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    await page.click('button[aria-label="Send message"]')
    await page.waitForSelector('[role="alert"]')
    assert.match(await page.$eval('[role="alert"]', node => node.textContent), /reattached or removed/i)
    assert.equal(await page.evaluate(() => window.fixtureSends.length), 0)
    await page.click('.foxwarm-composer-attachment-chip')
    await page.waitForSelector('[role="dialog"][aria-label="Attachment information"] input[type="file"]')
    await page.$eval('[role="dialog"][aria-label="Attachment information"] input[type="file"]', input => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['replacement'], 'replacement.txt', { type: 'text/plain' }))
      Object.defineProperty(input, 'files', { configurable: true, value: transfer.files })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForFunction(() => !document.querySelector('.foxwarm-composer-attachment-chip')?.textContent.includes('Reattach required'))
    assert.deepEqual(await page.$$eval('.foxwarm-composer-attachment-chip', chips => chips.map(chip => chip.dataset.composerAttachmentRef)), refs)
    await page.$$eval('.foxwarm-composer-attachment-chip', chips => chips[1].click())
    await page.waitForSelector('[role="dialog"][aria-label="Attachment information"]')
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Remove')?.click())
    await page.evaluate(() => { window.fixtureAccept = true })
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(() => window.fixtureSends.length === 1)
    assert.deepEqual(await page.evaluate(() => window.fixtureSends[0].attachments.map(item => ({ ref: item.ref, name: item.file.name }))), [{ ref: refs[0], name: 'replacement.txt' }])

    const hardLineSession = 'fixture/hardline-attachments'
    await page.evaluate(id => window.fixtureSetSession(id), hardLineSession)
    await page.waitForFunction(id => window.fixtureCurrentSession === id && window.fixtureEditor()?.childNodes.length === 0, {}, hardLineSession)
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.type(editor, 'line')
    await page.keyboard.press('Enter')
    await page.$eval(editor, editorNode => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['image'], 'photo.png', { type: 'image/png' }))
      transfer.items.add(new File(['file'], 'notes.txt', { type: 'text/plain' }))
      editorNode.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    })
    await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2)
    const beforeAttachment = await page.$eval(editor, node => {
      const chip = node.querySelector('.foxwarm-composer-attachment-chip')
      const anchor = chip.previousSibling
      const rect = anchor.getBoundingClientRect()
      return { isAnchor: anchor.dataset.composerCaretAnchor === 'true', x: rect.left + Math.max(0.5, rect.width / 2), y: rect.top + Math.max(1, rect.height / 2) }
    })
    assert.equal(beforeAttachment.isAnchor, true)
    await page.mouse.click(beforeAttachment.x, beforeAttachment.y)
    await page.keyboard.type('before ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('line\nbefore <attachment-ref')), true)
  }))
}

for (const spec of browsers) {
  test(`${spec.name} removes composer blocks with their visible controls and restores them with undo`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const sessionId = `fixture/remove-${spec.name}`
    await page.evaluate(sessionId => window.fixtureSetSession(sessionId), sessionId)
    await page.waitForFunction(sessionId => window.fixtureCurrentSession === sessionId && window.fixtureEditor()?.textContent === '', {}, sessionId)
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.type(editor, 'A  B')
    await page.evaluate(() => window.fixtureSelectText(2, 2))
    await page.evaluate(() => window.fixturePaste('p'.repeat(2000)))
    await page.waitForSelector('.foxwarm-composer-pasted-text-chip')
    await page.waitForSelector('button[aria-label="Remove pasted text block"]')
    const pastedDraft = await page.evaluate(() => window.fixtureDraft)
    await page.click('button[aria-label="Remove pasted text block"]')
    assert.equal(await page.evaluate(() => window.fixtureDraft), pastedDraft.replace(/<pasted-text>[\s\S]*<\/pasted-text>/, ''))
    assert.equal(await page.$('[role="dialog"]'), null)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), pastedDraft)
    await page.focus('button[aria-label="Remove pasted text block"]')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), pastedDraft.replace(/<pasted-text>[\s\S]*<\/pasted-text>/, ''))
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), pastedDraft)
    await page.focus('button[aria-label="Remove pasted text block"]')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), pastedDraft.replace(/<pasted-text>[\s\S]*<\/pasted-text>/, ''))
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), pastedDraft)

    await page.evaluate(() => window.fixtureSetLoading(true))
    await page.waitForFunction(() => document.querySelector('button[aria-label="Remove pasted text block"]')?.disabled === true)
    await page.click('button[aria-label="Remove pasted text block"]')
    assert.equal(await page.evaluate(() => window.fixtureDraft), pastedDraft)
  }))
}

for (const spec of browsers) {
  test(`${spec.name} highlights atomic composer blocks covered by native selection`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const sessionId = `fixture/block-selection-${spec.name}`
    await page.evaluate(sessionId => window.fixtureSetSession(sessionId), sessionId)
    await page.waitForFunction(sessionId => window.fixtureCurrentSession === sessionId && window.fixtureEditor()?.textContent === '', {}, sessionId)
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.type(editor, 'LEFTTEXT RIGHTTEXT')
    await page.evaluate(() => window.fixtureSelectText(9, 9))
    await page.evaluate(() => window.fixturePaste('p'.repeat(2000)))
    const expectedBlocks = spec.browser ? 1 : 3
    if (!spec.browser) {
      await page.$eval(editor, editorNode => {
        const transfer = new DataTransfer()
        transfer.items.add(new File(['image'], 'photo.png', { type: 'image/png' }))
        transfer.items.add(new File(['file'], 'notes.txt', { type: 'text/plain' }))
        editorNode.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
      })
    }
    await page.waitForFunction(expected => document.querySelectorAll('[data-composer-pasted-text-id], [data-composer-attachment-ref]').length === expected, {}, expectedBlocks)
    const exactDraft = await page.evaluate(() => window.fixtureDraft)
    await page.evaluate(() => window.fixtureSelectAll())
    await page.waitForFunction(expected => document.querySelectorAll('[data-composer-block-selected]').length === expected, {}, expectedBlocks)
    await page.evaluate(() => getSelection()?.removeAllRanges())
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)
    const points = await page.$eval(editor, node => {
      const texts = [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE && child.nodeValue.length > 0)
      const point = (text, offset) => {
        const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, Math.min(text.length, offset + 1))
        const rect = range.getBoundingClientRect()
        for (let y = rect.top + 2; y < rect.bottom - 1; y += 2) {
          for (let x = rect.left + 1; x < rect.right; x += 1) {
            const caret = document.caretPositionFromPoint?.(x, y)
            const legacy = document.caretRangeFromPoint?.(x, y)
            if ((caret?.offsetNode === text) || (legacy?.startContainer === text)) return { x, y }
          }
        }
        return { x: rect.left + Math.max(1, rect.width / 2), y: rect.top + rect.height / 2 }
      }
      return { start: point(texts[0], Math.min(2, texts[0].length - 1)), end: point(texts.at(-1), Math.min(2, texts.at(-1).length - 1)) }
    })
    assert.deepEqual(await page.evaluate(points => [document.elementFromPoint(points.start.x, points.start.y)?.closest('[role="textbox"]')?.getAttribute('aria-label'), document.elementFromPoint(points.end.x, points.end.y)?.closest('[role="textbox"]')?.getAttribute('aria-label')], points), ['Message', 'Message'])
    const drag = async (from, to) => {
      await page.focus(editor)
      await page.evaluate(() => getSelection()?.removeAllRanges())
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      for (let step = 1; step <= 12; step += 1) {
        await page.mouse.move(from.x + ((to.x - from.x) * step / 12), from.y + ((to.y - from.y) * step / 12))
        await new Promise(resolve => setTimeout(resolve, 12))
      }
      await page.mouse.up()
      await new Promise(resolve => setTimeout(resolve, 100))
      const diagnostic = await page.evaluate(() => ({
        selected: document.querySelectorAll('[data-composer-block-selected]').length,
        text: getSelection()?.toString(),
        anchor: getSelection()?.anchorNode?.parentElement?.className || getSelection()?.anchorNode?.nodeValue,
        focus: getSelection()?.focusNode?.parentElement?.className || getSelection()?.focusNode?.nodeValue,
        anchorOffset: getSelection()?.anchorOffset,
        focusOffset: getSelection()?.focusOffset,
      }))
      assert.equal(diagnostic.selected, expectedBlocks, JSON.stringify({ ...diagnostic, from, to }))
    }
    await drag(points.start, points.end)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactDraft)
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--foxwarm-color-accent-surface-strong', '#dbeafe')
      document.documentElement.style.setProperty('--foxwarm-color-accent-border', '#2563eb')
      document.documentElement.style.setProperty('--foxwarm-color-focus-ring-rgb', '37 99 235')
    })
    const selectedStyles = await page.$$eval('[data-composer-block-selected]', chips => chips.map(chip => {
      const style = getComputedStyle(chip)
      const remove = chip.querySelector('[data-composer-block-remove]')
      const image = chip.querySelector('img')
      const preview = chip.querySelector('.foxwarm-composer-pasted-text-preview')
      return {
        shadow: style.boxShadow,
        border: style.borderColor,
        removeVisibility: remove && getComputedStyle(remove).visibility,
        imageOpacity: image ? getComputedStyle(image).opacity : '1',
        previewVisibility: preview ? getComputedStyle(preview).visibility : 'visible',
      }
    }))
    assert.equal(selectedStyles.every(style => style.shadow !== 'none' && style.border !== 'rgba(0, 0, 0, 0)' && style.removeVisibility === 'visible' && style.imageOpacity !== '0' && style.previewVisibility === 'visible'), true, JSON.stringify(selectedStyles))
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    assert.equal(await page.$$eval('[data-composer-block-selected]', chips => chips.every(chip => getComputedStyle(chip).boxShadow !== 'none')), true)
    await page.evaluate(() => window.fixtureSelectAll())
    await page.waitForFunction(expected => document.querySelectorAll('[data-composer-block-selected]').length === expected, {}, expectedBlocks)
    if (!spec.browser) {
      const copied = await page.$eval(editor, node => {
        const data = new DataTransfer()
        node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
        return data.getData('text/plain')
      })
      assert.equal(copied, exactDraft)
    }

    await drag(points.end, points.start)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactDraft)
    await page.mouse.click(points.start.x, points.start.y)
    await page.keyboard.down('Shift'); await page.mouse.click(points.end.x, points.end.y); await page.keyboard.up('Shift')
    await page.waitForFunction(expected => document.querySelectorAll('[data-composer-block-selected]').length === expected, {}, expectedBlocks)
    await page.click(editor, { clickCount: 1 })
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)

    await page.evaluate(() => {
      const editorNode = window.fixtureEditor()
      const firstChip = editorNode.querySelector('[data-composer-pasted-text-id], [data-composer-attachment-ref]')
      const index = [...editorNode.childNodes].indexOf(firstChip)
      const text = [...editorNode.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.nodeValue.length > 0)
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(editorNode, index)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)
    await page.evaluate(() => {
      const editorNode = window.fixtureEditor()
      const chip = editorNode.querySelector('[data-composer-pasted-text-id], [data-composer-attachment-ref]')
      const index = [...editorNode.childNodes].indexOf(chip)
      const range = document.createRange(); range.setStart(editorNode, index); range.collapse(true)
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    })
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)

    await page.focus(editor)
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
    await page.waitForFunction(expected => document.querySelectorAll('[data-composer-block-selected]').length === expected, {}, expectedBlocks)
    if (!spec.browser) {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console')
        document.documentElement.style.setProperty('--foxwarm-console-text', '#d1fae5')
        document.documentElement.style.setProperty('--foxwarm-console-panel', '#052e16')
        document.documentElement.style.setProperty('--foxwarm-console-border-panel', '#16a34a')
        document.documentElement.style.setProperty('--foxwarm-color-accent', '#1d4ed8')
        document.documentElement.style.setProperty('--foxwarm-color-text-muted', '#475569')
      })
      const consoleStyles = await page.$$eval('[data-composer-block-selected]', chips => chips.map(chip => {
        const style = getComputedStyle(chip)
        return { shadow: style.boxShadow, color: style.color, remove: !!chip.querySelector('[data-composer-block-remove]') }
      }))
      assert.equal(consoleStyles.every(style => style.shadow !== 'none' && style.remove && style.color !== 'rgba(0, 0, 0, 0)'), true, JSON.stringify(consoleStyles))
    }
    await page.mouse.click(points.end.x, points.end.y)
    await page.focus('[data-composer-block-remove]')
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    if (!spec.browser) {
      await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 0)
      assert.equal(await page.$eval(editor, node => node.querySelectorAll('.foxwarm-composer-pasted-text-chip').length), 1)
    } else {
      await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-pasted-text-chip').length === 0)
    }
    await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control')
    await page.waitForFunction(expected => document.querySelectorAll('[data-composer-pasted-text-id], [data-composer-attachment-ref]').length === expected, {}, expectedBlocks)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactDraft)
  }))
}

test('Chromium removes image, file, and missing-file blocks without opening their modal', async () => withBrowser(browsers[0], async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const sessionId = 'fixture/remove-attachments'
    await page.evaluate(sessionId => window.fixtureSetSession(sessionId), sessionId)
    await page.waitForFunction(sessionId => window.fixtureCurrentSession === sessionId && window.fixtureEditor()?.textContent === '', {}, sessionId)
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.evaluate(() => window.fixtureSelectAll())
    await page.type(editor, 'A  B')
    await page.evaluate(() => window.fixtureSelectText(2, 2))
    await page.$eval(editor, editorNode => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['image'], 'photo.png', { type: 'image/png' }))
      transfer.items.add(new File(['file'], 'notes.txt', { type: 'text/plain' }))
      editorNode.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    })
    await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2)
    const attachmentDraft = await page.evaluate(() => window.fixtureDraft)
    const attachmentRefs = await page.$$eval('.foxwarm-composer-attachment-chip', chips => chips.map(chip => chip.dataset.composerAttachmentRef))
    await page.click('button[aria-label="Remove attachment photo.png"]')
    assert.equal(await page.evaluate(ref => window.fixtureDraft.includes(`<attachment-ref ref="${ref}" />`), attachmentRefs[0]), false)
    assert.equal(await page.$('[role="dialog"]'), null)
    assert.equal(await page.$eval(editor, node => node.textContent.startsWith('A') && node.textContent.endsWith('B')), true)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), attachmentDraft)
    assert.equal(await page.evaluate(() => window.fixtureSends.at(-1)?.attachments?.length || 0), 0)
    await page.$eval(editor, node => node.blur())
    await page.waitForFunction((sessionId, refs) => refs.every(ref => localStorage.getItem(`composer_draft_v1_${sessionId}`)?.includes(ref)), {}, sessionId, await page.evaluate(() => [...document.querySelectorAll('.foxwarm-composer-attachment-chip')].map(chip => chip.dataset.composerAttachmentRef)))

    await page.reload({ waitUntil: 'load' })
    await page.evaluate(sessionId => window.fixtureSetSession(sessionId), sessionId)
    await page.waitForFunction((sessionId) => window.fixtureCurrentSession === sessionId
      && document.querySelector('button[aria-label="Remove attachment notes.txt"]')
      && [...document.querySelectorAll('.foxwarm-composer-attachment-chip')].every(node => node.textContent.includes('Reattach required')), {}, sessionId)
    assert.equal(await page.$eval('.foxwarm-composer-attachment-chip', node => node.textContent.includes('Reattach required')), true)
    const missingDraft = attachmentDraft
    await page.locator('button[aria-label="Remove attachment notes.txt"]').click()
    assert.notEqual(await page.evaluate(() => window.fixtureDraft), missingDraft)
    assert.equal(await page.$('[role="dialog"]'), null)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), missingDraft)

    await page.evaluate(() => window.fixtureSetLoading(true))
    await page.waitForFunction(() => document.querySelector('button[aria-label="Remove attachment notes.txt"]')?.disabled === true)
    const disabledDraft = await page.evaluate(() => window.fixtureDraft)
    const disabledRemoveBox = await page.$eval('button[aria-label="Remove attachment notes.txt"]', button => {
      const rect = button.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })
    await page.mouse.click(disabledRemoveBox.x, disabledRemoveBox.y)
    assert.equal(await page.evaluate(() => window.fixtureDraft), disabledDraft)
}))

test('Chromium preserves trusted CDP IME replacement through every caret-anchor position', async () => withBrowser(browsers[0], async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  const client = await page.createCDPSession()
  const switchSession = async id => {
    await page.evaluate(sessionId => window.fixtureSetSession(sessionId), id)
    await page.waitForFunction(sessionId => window.fixtureCurrentSession === sessionId, {}, id)
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
  }
  const commitIme = async (base, expected) => {
    const sendCount = await page.evaluate(() => window.fixtureSends.length)
    await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
    assert.equal(await page.evaluate(() => window.fixtureDraft || ''), base)
    assert.equal(await page.evaluate(() => window.fixtureSends.length), sendCount)
    await client.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
    assert.equal(await page.evaluate(() => window.fixtureDraft || ''), base)
    assert.equal(await page.evaluate(() => window.fixtureSends.length), sendCount)
    await client.send('Input.insertText', { text: '你' })
    await page.waitForFunction(value => window.fixtureDraft === value, {}, expected)
    const actual = await page.evaluate(() => window.fixtureDraft)
    assert.equal(actual.includes('n你'), false)
    assert.equal(actual.includes('\u200B'), false)
  }

  await switchSession('fixture/ime-plain')
  await page.click(editor)
  await commitIme('', '你')
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), '')

  const first = 'L'.repeat(2000)
  const second = 'R'.repeat(2000)
  const firstBlock = `<pasted-text>${first}</pasted-text>`
  const secondBlock = `<pasted-text>${second}</pasted-text>`

  await switchSession('fixture/ime-leading')
  await page.evaluate(text => window.fixturePaste(text), first)
  await page.click('.foxwarm-composer-caret-anchor')
  await commitIme(firstBlock, `你${firstBlock}`)
  const copied = await page.evaluate(() => {
    window.fixtureSelectAll()
    const data = new DataTransfer()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    window.fixtureEditor().dispatchEvent(event)
    return data.getData('text/plain')
  })
  assert.equal(copied, `你${firstBlock}`)
  await page.focus(editor)
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control')
  await page.waitForFunction(() => window.fixtureSends.length === 1)
  assert.equal(await page.evaluate(() => window.fixtureSends[0].text), `你${firstBlock}`)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), firstBlock)

  await switchSession('fixture/ime-trailing')
  await page.evaluate(text => window.fixturePaste(text), first)
  const trailingAnchors = await page.$$('.foxwarm-composer-caret-anchor')
  await trailingAnchors.at(-1).click()
  await commitIme(firstBlock, `${firstBlock}你`)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), firstBlock)

  await switchSession('fixture/ime-between')
  await page.evaluate(text => window.fixturePaste(text), first)
  await page.evaluate(text => window.fixturePaste(text), second)
  const betweenBase = `${firstBlock}${secondBlock}`
  const betweenAnchors = await page.$$('.foxwarm-composer-caret-anchor')
  await betweenAnchors[1].click()
  await commitIme(betweenBase, `${firstBlock}你${secondBlock}`)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), betweenBase)
  await client.detach()
}))

test('Chromium Send pointer click synchronously submits composition committed on blur', async () => withBrowser(browsers[0], async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  const sendButton = 'button[aria-label="Send message"]'
  const client = await page.createCDPSession()
  const switchSession = async id => {
    await page.evaluate(sessionId => window.fixtureSetSession(sessionId), id)
    await page.waitForFunction(sessionId => window.fixtureCurrentSession === sessionId, {}, id)
    await new Promise(resolve => setTimeout(resolve, 50))
    await page.waitForFunction(() => window.fixtureEditor()?.textContent === '')
  }
  const observeOrder = () => page.evaluate(() => {
    window.fixtureOrder = []
    const editorNode = window.fixtureEditor()
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'blur', 'focusout']) {
      editorNode.addEventListener(type, event => window.fixtureOrder.push(`${type}:${event.inputType || event.data || ''}`), true)
    }
    const send = document.querySelector('button[aria-label="Send message"]')
    for (const type of ['pointerdown', 'mousedown', 'focus', 'click']) send.addEventListener(type, () => window.fixtureOrder.push(`send-${type}`), true)
  })
  const assertBlurCommitOrder = async () => {
    const order = await page.evaluate(() => window.fixtureOrder)
    const compositionEnd = order.findIndex(item => item.startsWith('compositionend:'))
    const sendClick = order.indexOf('send-click')
    assert.equal(compositionEnd >= 0 && sendClick > compositionEnd, true)
    assert.equal(order.slice(compositionEnd + 1, sendClick).some(item => item.startsWith('input:')), false)
  }

  const blockText = 'S'.repeat(2000)
  const block = `<pasted-text>${blockText}</pasted-text>`
  await switchSession('fixture/ime-send-leading')
  await page.click(editor)
  await page.evaluate(text => window.fixturePaste(text), blockText)
  await observeOrder()
  await page.click('.foxwarm-composer-caret-anchor')
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await client.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 })
  await page.click(sendButton)
  await page.waitForFunction(() => window.fixtureSends.length === 1)
  await assertBlurCommitOrder()
  assert.equal(await page.evaluate(() => window.fixtureSends[0].text), `你${block}`)
  assert.equal(await page.evaluate(() => window.fixtureDraft), `你${block}`)
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Send message')
  await page.focus(editor)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), block)

  await switchSession('fixture/ime-send-ordinary')
  await page.evaluate(() => { window.fixtureSends = [] })
  await page.click(editor)
  await page.keyboard.type('prefix ')
  await observeOrder()
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await client.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 })
  await page.click(sendButton)
  await page.waitForFunction(() => window.fixtureSends.length === 1)
  await assertBlurCommitOrder()
  assert.equal(await page.evaluate(() => window.fixtureSends[0].text), 'prefix 你')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'prefix 你')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Send message')
  await page.focus(editor)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'prefix ')

  await switchSession('fixture/ime-send-accepted')
  await page.evaluate(() => { window.fixtureSends = []; window.fixtureAccept = true })
  await page.click(editor)
  await page.keyboard.type('accepted ')
  await observeOrder()
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await client.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 })
  await page.click(sendButton)
  await page.waitForFunction(() => window.fixtureSends.length === 1 && window.fixtureEditor()?.textContent === '')
  await assertBlurCommitOrder()
  assert.equal(await page.evaluate(() => window.fixtureSends[0].text), 'accepted 你')
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/ime-send-accepted')), null)
  await client.detach()
}))

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
  assert.deepEqual(await page.$eval('.foxwarm-composer-pasted-text-chip', node => ({ tabIndex: node.tabIndex, disabled: node.getAttribute('aria-disabled'), buttonsDisabled: [...node.querySelectorAll('button')].every(button => button.disabled && button.tabIndex === -1) })), { tabIndex: -1, disabled: 'true', buttonsDisabled: true })
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
  assert.deepEqual(await page.$eval('.foxwarm-composer-pasted-text-chip', node => ({ tabIndex: node.tabIndex, disabled: node.getAttribute('aria-disabled'), buttonsEnabled: [...node.querySelectorAll('button')].every(button => !button.disabled && button.tabIndex === 0) })), { tabIndex: -1, disabled: 'false', buttonsEnabled: true })
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
  await page.waitForFunction(() => window.fixtureDraft === '中文')
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
