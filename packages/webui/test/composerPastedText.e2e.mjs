import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import puppeteer from 'puppeteer-core'
import { webuiReactAliases } from './reactRendererAliases.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-composer-paste-'))
const entryPath = path.join(tempDir, 'fixture.tsx')
const outputDirectory = path.join(tempDir, 'dist')
const assetsDirectory = path.join(webuiRoot, 'dist/assets')
let server
let fixtureUrl

await writeFile(entryPath, `
  import { useEffect, useLayoutEffect, useRef, useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { initializeThemeRuntime } from ${JSON.stringify(path.join(webuiRoot, 'src/theme/runtime.ts'))}
  window.fixtureInitializeTheme = initializeThemeRuntime
  import ChatComposer from ${JSON.stringify(path.join(webuiRoot, 'src/components/ChatComposer.tsx'))}
  import InlineComposerEditor from ${JSON.stringify(path.join(webuiRoot, 'src/components/InlineComposerEditor.tsx'))}
  import { loadComposerDraft, makePlainComposerDraft, serializeComposerDraft } from ${JSON.stringify(path.join(webuiRoot, 'src/composerDraft.ts'))}
  import { getComposerChips } from ${JSON.stringify(path.join(webuiRoot, 'src/composerEditorModel.ts'))}
  import { EditorSelection } from '@codemirror/state'
  import { EditorView } from '@codemirror/view'
  window.fetch = async () => ({ ok: true, json: async () => ({ commands: [{ name: '/help', description: 'Help' }] }) })
  window.fixtureMicMode = 'ok'
  window.fixtureStreamMode = 'ok'
  window.fixtureResumeMode = 'ok'
  window.fixtureClosedContexts = 0
  window.fixtureStoppedTracks = 0
  window.fixtureStreamSessions = []
  window.fixtureGetUserMedia = async () => {
    if (window.fixtureMicMode === 'reject') throw new Error('Microphone access denied')
    if (window.fixtureMicMode === 'hold') await new Promise(resolve => { window.fixtureReleaseMicrophone = resolve })
    return { getTracks: () => [{ stop() { window.fixtureStoppedTracks += 1 } }] }
  }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: (...args) => window.fixtureGetUserMedia(...args) } })
  window.AudioContext = class {
    sampleRate = 16000
    destination = {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null } }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} } }
    resume() { return window.fixtureResumeMode === 'hold' ? new Promise(resolve => { window.fixtureReleaseResume = resolve }) : Promise.resolve() }
    close() { window.fixtureClosedContexts += 1; window.fixtureReleaseResume?.(); return Promise.resolve() }
  }
  const noop = async () => {}
  const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window)
  const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window)
  const heldDraftRestoreFrameId = -7001
  let heldDraftRestoreFrame = null
  window.fixtureHoldDraftRestoreFrame = false
  window.requestAnimationFrame = callback => {
    if (window.fixtureHoldDraftRestoreFrame && String(callback).includes('editorRef.current?.replaceDraft(savedDraft)')) {
      window.fixtureHoldDraftRestoreFrame = false
      heldDraftRestoreFrame = callback
      return heldDraftRestoreFrameId
    }
    return nativeRequestAnimationFrame(callback)
  }
  window.cancelAnimationFrame = frameId => {
    if (frameId === heldDraftRestoreFrameId) { heldDraftRestoreFrame = null; return }
    nativeCancelAnimationFrame(frameId)
  }
  window.fixtureHasHeldDraftRestoreFrame = () => heldDraftRestoreFrame !== null
  window.fixtureReleaseDraftRestoreFrame = () => {
    const callback = heldDraftRestoreFrame
    heldDraftRestoreFrame = null
    callback?.(performance.now())
  }
  function Fixture() {
    useEffect(() => {
      // Let the composer's mount-time draft restoration finish before input.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { window.fixtureReady = true })
      })
      return () => cancelAnimationFrame(frame)
    }, [])
    const [sessionId, setSessionId] = useState('fixture/main')
    const [loading, setLoading] = useState(false)
    const [runtime, setRuntime] = useState('foxwarm')
    window.fixtureSetRuntime = setRuntime
    const [sendKeyMode, setSendKeyMode] = useState('modEnter')
    const [, redraw] = useState(0)
    window.fixtureCurrentSession = sessionId
    window.fixtureSetSession = setSessionId
    window.fixtureSetLoading = setLoading
    window.fixtureSetSendKeyMode = setSendKeyMode
    window.fixtureSendKeyMode = sendKeyMode
    window.fixtureRedraw = () => redraw(value => value + 1)
    const props = {
      sessionId, sessionMissing: false, loading, sendKeyMode, asrAvailable: true, sessionRuntime: runtime, externalCostEstimate: 1.25,
      modelOptions: [], currentModelKey: runtime === 'claude-code' ? 'cli-observed-model' : 'model/current', sessionModel: 'model/current', defaultModelKey: 'model/current',
      childModelDefault: 'model/current', effectiveChildModelKey: 'model/current', effectiveEffort: 'medium', effectiveChildEffort: 'medium',
      onChangeModel: noop, onChangeChildModel: noop, onChangeEffort: noop, onChangeChildEffort: noop,
      onRefreshModels: noop, onOpenModelSettings: () => {},
      onSend: async value => {
        window.fixtureSendActiveElement = document.activeElement?.getAttribute('aria-label')
        window.fixtureSends.push(value)
        if (window.fixtureHoldSend) {
          setLoading(true)
          await new Promise(resolve => { window.fixtureReleaseSend = resolve })
          setLoading(false)
        }
        return window.fixtureAccept
      },
      onCreateStreamingTranscriber: async callbacks => {
        if (window.fixtureStreamMode === 'reject') throw new Error('Streaming setup unavailable')
        const session = { callbacks, sent: [], stopped: false, cancelled: false,
          sendAudioChunk(chunk) { this.sent.push(chunk) }, stop() { this.stopped = true }, cancel() { this.cancelled = true } }
        window.fixtureStreamSessions.push(session)
        return session
      },
    }
    return <><div id="host"><ChatComposer {...props} /></div>
      <input aria-label="Other pane input" />
      <div id="other-pane" style={{ height: 40 }}>Other pane</div>
      <button aria-label="Switch fixture Session" onClick={() => setSessionId('fixture/other')}>Switch session</button>
    </>
  }
  // Observe the canonical persisted draft rather than a production edit callback.
  Object.defineProperty(window, 'fixtureDraft', {
    get: () => serializeComposerDraft(loadComposerDraft(window.fixtureCurrentSession || 'fixture/main')),
  })
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
  const fixtureRoot = createRoot(document.getElementById('root'))
  window.fixtureRenderStaleSameSessionProp = () => fixtureRoot.render(<StaleSameSessionPropFixture />)
  fixtureRoot.render(<Fixture />)
  // The editor is a CodeMirror view; positions below are canonical draft
  // offsets (the document text is the serialized draft).
  window.fixtureEditor = () => document.querySelector('[role="textbox"][aria-label="Message"]')
  window.fixtureView = () => {
    const root = document.querySelector('.foxwarm-inline-composer-editor')
    return root ? EditorView.findFromDOM(root) : null
  }
  window.fixtureText = () => window.fixtureView()?.state.doc.toString() ?? null
  window.fixtureChips = () => getComposerChips(window.fixtureView().state).map(chip => ({ from: chip.from, to: chip.to, type: chip.segment.type }))
  window.fixtureSelect = (anchor, head = anchor) => {
    const view = window.fixtureView()
    view.focus()
    view.dispatch({ selection: EditorSelection.single(anchor, head), userEvent: 'select' })
  }
  window.fixtureSelectText = (start, end) => window.fixtureSelect(start, end)
  window.fixtureSelectAll = () => window.fixtureSelect(0, window.fixtureView().state.doc.length)
  window.fixtureCaretRect = () => {
    const view = window.fixtureView()
    const rect = view.coordsAtPos(view.state.selection.main.head)
    return rect && { top: rect.top, bottom: rect.bottom, left: rect.left }
  }
  window.fixturePaste = text => {
    const data = new DataTransfer(); data.setData('text/plain', text); data.setData('text/html', '<b>different html</b>')
    const event = new Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: data })
    window.fixtureEditor().dispatchEvent(event)
  }
  window.fixturePasteFiles = files => {
    const data = new DataTransfer()
    for (const file of files) data.items.add(file)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    window.fixtureEditor().dispatchEvent(event)
  }
`)

before(async () => {
  await esbuild.build({
    entryPoints: [entryPath], outdir: outputDirectory, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', jsx: 'automatic',
    alias: webuiReactAliases, nodePaths: [path.join(webuiRoot, 'node_modules')],
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
    await page.waitForFunction(() => window.fixtureReady && window.fixtureEditor()?.hasAttribute('data-empty') && window.fixtureView())
    await run(page)
  } finally {
    await browser.close()
  }
}

async function setModalText(page, value) {
  await page.$eval('textarea[aria-label="Full pasted text"]', (node, nextValue) => {
    // The native setter mirrors browser input; assigning node.value directly
    // updates React's value tracker before the input event reaches onChange.
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!setValue) throw new Error('Native textarea value setter is unavailable')
    setValue.call(node, nextValue)
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  }, value)
}

const selectedBrowser = process.env.FOXWARM_E2E_BROWSER || 'chromium'
const browsers = [
  { name: 'Chromium', path: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  { name: 'Firefox', browser: 'firefox', path: process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox' },
].filter(browser => selectedBrowser === 'all' || browser.name.toLowerCase() === selectedBrowser)
// Tests that drive Chromium-only CDP input or check Chromium-specific behavior.
const chromiumSpec = browsers.find(browser => browser.name === 'Chromium')
const firefoxSpec = browsers.find(browser => browser.name === 'Firefox')

async function settleSend(page) {
  await page.waitForFunction(() => window.fixtureEditor().contentEditable === 'true')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function pressWithControl(page, key) {
  await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control')
}
const undo = page => pressWithControl(page, 'z')
const redo = page => pressWithControl(page, 'y')

async function openSession(page, sessionId) {
  await page.evaluate(id => window.fixtureSetSession(id), sessionId)
  await page.waitForFunction(id => window.fixtureCurrentSession === id && window.fixtureText() === '', {}, sessionId)
  // Let the composer's same-frame draft restoration finish before input.
  await new Promise(resolve => setTimeout(resolve, 50))
}

// Clicks the empty line area just before or after a chip, as a user places the
// caret next to a block with a pointer.
async function clickBesideChip(page, index, side) {
  const point = await page.evaluate((index, side) => {
    const chip = window.fixtureEditor().querySelectorAll('[data-composer-pasted-text-id], [data-composer-attachment-ref]')[index]
    const rect = chip.getBoundingClientRect()
    return { x: side === 'before' ? rect.left - 3 : rect.right + 3, y: rect.top + rect.height / 2 }
  }, index, side)
  await page.mouse.click(point.x, point.y)
}

async function copySelection(page) {
  return page.evaluate(() => {
    const data = new DataTransfer()
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    window.fixtureEditor().dispatchEvent(event)
    return data.getData('text/plain')
  })
}

for (const spec of browsers) {
  test(`${spec.name} accepted sends return focus only after the editor is editable`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await page.evaluate(() => {
      window.fixtureAccept = true
      window.fixtureHoldSend = true
      window.fixtureOriginalEditor = window.fixtureEditor()
    })
    // A real Send pointer click blurs the editor before onSend disables both controls.
    await page.click(editor)
    await page.keyboard.type('pointer send')
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(() => window.fixtureEditor().contentEditable === 'false')
    // Chromium can retain focus on the disabled Send control; the editor must not take it while noneditable.
    assert.equal(await page.evaluate(() => {
      const active = document.activeElement
      return active === document.body || active instanceof HTMLButtonElement && active.disabled && active.getAttribute('aria-label') === 'Send message'
    }), true)
    await page.evaluate(() => window.fixtureReleaseSend())
    await settleSend(page)
    assert.equal(await page.evaluate(() => window.fixtureEditor() === window.fixtureOriginalEditor), true)
    assert.equal(await page.evaluate(() => document.activeElement === window.fixtureEditor()), true)
    await page.keyboard.type('next without refocusing')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'next without refocusing')

    // Exercise both configured keyboard send paths, including an immediate acceptance.
    for (const [mode, held] of [['enter', false], ['modEnter', true]]) {
      await page.evaluate((mode, held) => {
        window.fixtureSetSendKeyMode(mode)
        window.fixtureHoldSend = held
      }, mode, held)
      await page.waitForFunction(mode => window.fixtureSendKeyMode === mode, {}, mode)
      const count = await page.evaluate(() => window.fixtureSends.length)
      if (mode === 'modEnter') await page.keyboard.down('Control')
      await page.keyboard.press('Enter')
      if (mode === 'modEnter') await page.keyboard.up('Control')
      await page.waitForFunction(count => window.fixtureSends.length === count + 1, { timeout: 3000 }, count)
      if (held) {
        await page.waitForFunction(() => window.fixtureEditor().contentEditable === 'false')
        await page.evaluate(() => window.fixtureReleaseSend())
      }
      await settleSend(page)
      assert.equal(await page.evaluate(() => document.activeElement === window.fixtureEditor()), true)
      assert.equal(await page.evaluate(() => window.fixtureDraft), '')
      await page.keyboard.type('continued ' + mode)
      assert.equal(await page.evaluate(() => window.fixtureDraft), 'continued ' + mode)
    }
  }))

  test(`${spec.name} delayed sends do not reclaim an abandoned focus or a different Session`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const begin = async text => {
      await page.evaluate(() => { window.fixtureAccept = true; window.fixtureHoldSend = true })
      await page.click(editor)
      await page.keyboard.type(text)
      await page.click('button[aria-label="Send message"]')
      await page.waitForFunction(() => window.fixtureEditor().contentEditable === 'false')
    }
    await begin('focus elsewhere')
    await page.click('input[aria-label="Other pane input"]')
    await page.keyboard.type('other')
    await page.evaluate(() => window.fixtureReleaseSend())
    await settleSend(page)
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Other pane input')
    await page.keyboard.type(' pane')
    assert.equal(await page.$eval('input[aria-label="Other pane input"]', node => node.value), 'other pane')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '')

    // A pointer on a nonfocusable pane is still an intentional departure from Send.
    await begin('nonfocusable pane')
    await page.click('#other-pane')
    await page.evaluate(() => window.fixtureReleaseSend())
    await settleSend(page)
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY')
    await page.keyboard.type('must not enter composer')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '')

    await begin('old Session')
    await page.click('button[aria-label="Switch fixture Session"]')
    await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/other')
    await page.evaluate(() => { window.fixtureSetLoading(false); window.fixtureSetSession('fixture/main') })
    await settleSend(page)
    await page.click('input[aria-label="Other pane input"]')
    await page.evaluate(() => window.fixtureReleaseSend())
    await settleSend(page)
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Other pane input')
  }))

  test(`${spec.name} rejected sends retain the draft without moving focus`, async () => withBrowser(spec, async page => {
    await page.evaluate(() => { window.fixtureAccept = false; window.fixtureHoldSend = true })
    await page.click('[role="textbox"][aria-label="Message"]')
    await page.keyboard.type('keep my draft')
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(() => window.fixtureEditor().contentEditable === 'false')
    await page.click('input[aria-label="Other pane input"]')
    await page.evaluate(() => window.fixtureReleaseSend())
    await settleSend(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'keep my draft')
    assert.equal(await page.evaluate(() => window.fixtureText()), 'keep my draft')
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Other pane input')
  }))
}

for (const spec of browsers) {
  test(`${spec.name} converts each paste at 1,000 code points or ten lines and prioritizes clipboard files`, async () => withBrowser(spec, async page => {
    const chipCount = () => page.$eval('[role="textbox"][aria-label="Message"]', node => node.querySelectorAll('[data-composer-pasted-text-id]').length)
    await page.click('[role="textbox"][aria-label="Message"]')
    const first = '😀'.repeat(999)
    await page.evaluate(text => window.fixturePaste(text), first)
    await page.evaluate(() => window.fixturePaste('x'))
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${first}x`)
    assert.equal(await chipCount(), 0, 'separate small pastes remain ordinary even when the total reaches 1,000 code points')

    const characters = '😀'.repeat(1000)
    await page.evaluate(text => { window.fixtureSelectAll(); window.fixturePaste(text) }, characters)
    assert.equal(await chipCount(), 1)
    assert.equal(await page.evaluate(() => window.fixtureDraft), `<pasted-text>${characters}</pasted-text>`)

    for (const [text, converts] of [[Array(9).fill('line').join('\n'), false], ['\n'.repeat(9), true]]) {
      await page.evaluate(text => { window.fixtureSelectAll(); window.fixturePaste(text) }, text)
      assert.equal(await chipCount(), converts ? 1 : 0)
      assert.equal(await page.evaluate(() => window.fixtureDraft), converts ? `<pasted-text>${text}</pasted-text>` : text)
    }

    await page.evaluate(() => {
      window.fixtureSelectAll()
      const data = new DataTransfer()
      data.setData('text/plain', 'x'.repeat(1000))
      data.items.add(new File(['image'], 'photo.png', { type: 'image/png' }))
      data.items.add(new File(['file'], 'notes.txt', { type: 'text/plain' }))
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: data })
      window.fixtureEditor().dispatchEvent(event)
    })
    assert.equal(await chipCount(), 0)
    assert.equal(await page.evaluate(() => window.fixtureDraft), '<attachment-ref ref="attachment1" /><attachment-ref ref="attachment2" />')
  }))

  test(`${spec.name} edits pasted-text blocks without resetting native text flow`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const chipCount = () => page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length)
    await page.type(editor, 'before')
    await page.evaluate(() => { window.fixtureEditor().querySelector('.cm-line').firstChild.fixtureIdentity = 42 })
    await page.type(editor, ' after')
    assert.equal(await page.$eval(editor, node => node.querySelector('.cm-line').firstChild.fixtureIdentity), 42)
    await page.evaluate(() => window.fixtureSelectText(6, 7))
    const pasted = `${'😀'.repeat(2000)}\n\n  exact tail`
    await page.evaluate(text => window.fixturePaste(text), pasted)
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before<pasted-text>${pasted}</pasted-text>after`)
    assert.equal(await page.$eval('.foxwarm-composer-pasted-text-chip', node => node.contentEditable), 'false')
    assert.equal(await chipCount(), 1)

    await page.evaluate(() => window.fixtureSelect(6))
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
    await setModalText(page, 'edited\n\n  block')
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel').click())
    assert.equal(await page.evaluate(text => window.fixtureDraft.includes(`${text}</pasted-text>`), pasted), true)
    await page.click('.foxwarm-composer-pasted-text-chip')
    await setModalText(page, 'edited\n\n  block')
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save').click())
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'before<pasted-text>edited\n\n  block</pasted-text>X\nYafter')
    await page.waitForFunction(() => document.activeElement?.closest('.foxwarm-composer-pasted-text-chip'))

    // Backspace after the block removes it whole; undo and redo restore and remove it as a block.
    await page.evaluate(() => window.fixtureSelect(window.fixtureChips()[0].to))
    await page.keyboard.press('Backspace')
    assert.equal(await chipCount(), 0)
    await undo(page)
    assert.equal(await chipCount(), 1)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'before<pasted-text>edited\n\n  block</pasted-text>X\nYafter')
    await redo(page)
    assert.equal(await chipCount(), 0)

    await openSession(page, 'fixture/literal')
    await page.type(editor, 'abc')
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureText()), '')
    await redo(page)
    assert.equal(await page.evaluate(() => window.fixtureText()), 'abc')
    await page.evaluate(() => window.fixtureSelectAll())
    await page.type(editor, 'typed <pasted-text>literal</pasted-text>')
    assert.equal(await chipCount(), 0)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'typed <pasted-text>literal</pasted-text>')
    await page.evaluate(() => { window.fixtureSelectAll(); window.fixturePaste(`${'a'.repeat(1000)}</pasted-text>`) })
    assert.equal(await chipCount(), 0)
    await page.evaluate(() => { window.fixtureSelectAll(); window.fixturePaste('b'.repeat(2000)) })
    await page.click('.foxwarm-composer-pasted-text-chip')
    await setModalText(page, 'ordinary </pasted-text> text')
    assert.equal(await page.$eval('button', () => !![...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Save')?.disabled), true)
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Restore to text').click())
    assert.equal(await chipCount(), 0)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'ordinary </pasted-text> text')
  }))
}

if (chromiumSpec) test('Chromium does not replay a stale same-Session prop over an imperative replacement', async () => withBrowser(chromiumSpec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.evaluate(() => window.fixtureRenderStaleSameSessionProp())
  await page.waitForFunction(() => window.fixtureText() === 'submitted value')
  await page.evaluate(() => window.fixtureTriggerImperativeClearWithStaleProp())
  await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-disabled') === 'true', {}, editor)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.evaluate(() => window.fixtureText()), '')
  assert.equal(await page.$eval(editor, node => node.dataset.empty), 'true')
}))

for (const spec of browsers) {
  test(`${spec.name} restores real empty state and enters text around leading blocks`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console')
      document.documentElement.classList.add('dark')
    })
    const placeholder = await page.$eval(editor, node => ({
      empty: node.dataset.empty,
      text: node.textContent,
      position: getComputedStyle(node, '::before').position,
      pointerEvents: getComputedStyle(node, '::before').pointerEvents,
      content: getComputedStyle(node, '::before').content,
    }))
    assert.deepEqual({ ...placeholder, content: undefined }, { empty: 'true', text: '', position: 'absolute', pointerEvents: 'none', content: undefined })
    assert.notEqual(placeholder.content, 'none')

    await page.click(editor, { offset: { x: 180, y: 12 } })
    assert.equal(await page.evaluate(() => document.activeElement === window.fixtureEditor() && window.fixtureView().state.selection.main.head === 0), true)
    await page.keyboard.type('visible')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'visible')
    await pressWithControl(page, 'a')
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => window.fixtureDraft === '' && window.fixtureEditor()?.dataset.empty === 'true' && window.fixtureText() === '')
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
    await page.waitForFunction(() => window.fixtureReady && window.fixtureEditor()?.dataset.empty === 'true' && window.fixtureText() === '')

    await page.click(editor)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n\n')
    assert.notEqual(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)
    await page.evaluate(() => window.fixtureSelectAll())
    await page.keyboard.press('Delete')
    await page.waitForFunction(() => window.fixtureDraft === '' && window.fixtureEditor()?.dataset.empty === 'true')

    const first = 'f'.repeat(2000)
    const second = 's'.repeat(2000)
    await page.evaluate(text => window.fixturePaste(text), first)
    await page.evaluate(text => window.fixturePaste(text), second)
    const exactBlocks = `<pasted-text>${first}</pasted-text><pasted-text>${second}</pasted-text>`
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)
    assert.equal(await page.evaluate(() => window.fixtureText()), exactBlocks, 'the document holds no editor-only characters')

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
      await page.waitForFunction(() => document.activeElement?.closest('.foxwarm-composer-pasted-text-chip'))
    }

    // Literal clipboard text at the start, before a leading block, is kept exactly.
    await page.focus(editor)
    await pressWithControl(page, 'Home')
    await page.evaluate(() => window.fixturePaste('\u200B'))
    assert.equal(await page.evaluate(() => window.fixtureDraft), `\u200B${exactBlocks}`)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)

    // Home from the end of a line that starts with a block reaches the line start.
    // The two blocks wrap onto two visual rows; the first Home stops at the row start.
    await pressWithControl(page, 'End')
    await page.keyboard.press('Home')
    await page.keyboard.press('Home')
    await page.keyboard.type('home ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('home <pasted-text>')), true)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)

    // ArrowLeft steps over each block once.
    await pressWithControl(page, 'End')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('arrow ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('arrow <pasted-text>')), true)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)

    await clickBesideChip(page, 0, 'before')
    await page.keyboard.type('mouse ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('mouse <pasted-text>')), true)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exactBlocks)

    await page.evaluate(() => window.fixtureSelectAll())
    await pressWithControl(page, 'c')
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exactBlocks)

    await clickBesideChip(page, 1, 'after')
    await page.keyboard.press('Backspace')
    assert.equal(await page.$eval(editor, node => node.querySelectorAll('[data-composer-pasted-text-id]').length), 1)
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => window.fixtureDraft === '' && window.fixtureText() === '')
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
    const reset = sessionId => openSession(page, sessionId)
    const copyAll = async () => {
      await page.evaluate(() => window.fixtureSelectAll())
      return copySelection(page)
    }
    const lineCount = () => page.$eval(editor, node => node.querySelectorAll('.cm-line').length)
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
    await page.click(editor)
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n')
    assert.deepEqual(await page.$eval(editor, node => ({
      empty: node.dataset.empty,
      lines: node.querySelectorAll('.cm-line').length,
      placeholder: getComputedStyle(node, '::before').content,
    })), { empty: 'false', lines: 2, placeholder: 'none' })
    assert.notEqual(await page.evaluate(key => localStorage.getItem(key), emptyStorageKey), null)
    await page.keyboard.type('x')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\nx')
    const firstLine = await selectedTextTop()
    assert.equal(firstLine.top >= firstLine.editorTop + firstLine.lineHeight * 0.75, true)
    assert.equal(await copyAll(), '\nx')
    await page.evaluate(() => window.fixtureSelect(2))
    await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n')
    assert.equal(await lineCount(), 2)
    await page.keyboard.press('Backspace')
    await page.waitForFunction(() => window.fixtureDraft === '' && window.fixtureEditor()?.dataset.empty === 'true')
    assert.equal(await page.evaluate(key => localStorage.getItem(key), emptyStorageKey), null)

    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\n\n')
    assert.equal(await lineCount(), 3)
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector(editor)
    await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
    await page.waitForFunction(() => window.fixtureReady && window.fixtureText() === '\n\n')
    assert.equal(await lineCount(), 3)
    // A pointer on the restored last (empty) line places the caret at the draft end.
    const lastLine = await page.$$eval('.cm-line', lines => { const box = lines.at(-1).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 } })
    await page.mouse.click(lastLine.x, lastLine.y)
    assert.equal(await page.evaluate(() => window.fixtureView().state.selection.main.head), 2)
    await page.keyboard.type('x')
    await page.waitForFunction(() => window.fixtureDraft === '\n\nx')
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
    await clickBesideChip(page, 0, 'after')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${block}\n`)
    await page.keyboard.type('x')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${block}\nx`)
    assert.equal(await copyAll(), `${block}\nx`)

    await reset(`fixture/newline-block-shift-${spec.name}`)
    await page.click(editor)
    await page.evaluate(text => window.fixturePaste(text), blockText)
    await clickBesideChip(page, 0, 'after')
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${block}\n`)

    // Enter in the middle of a line leaves the caret at the start of the new line.
    await reset(`fixture/newline-middle-${spec.name}`)
    await page.click(editor)
    await page.keyboard.type('abcdef')
    await page.evaluate(() => window.fixtureSelect(3))
    await page.keyboard.press('Enter')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'abc\nXdef')
    await page.evaluate(() => window.fixtureSelect(1))
    await page.evaluate(() => window.fixturePaste('YZ'))
    await page.keyboard.type('Q')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'aYZQbc\nXdef')

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
  test(`${spec.name} keeps newline carets visible without scrolling ancestors`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await openSession(page, `fixture/newline-scroll-${spec.name}`)
    await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
    await page.type(editor, Array.from({ length: 14 }, (_, index) => `line-${index}`).join('\n'))
    await page.focus(editor)
    await page.keyboard.press('End')
    const scrollState = () => page.evaluate(() => {
      const scroller = window.fixtureEditor().closest('.cm-scroller')
      const box = scroller.getBoundingClientRect()
      return { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, pageTop: document.scrollingElement.scrollTop, caret: window.fixtureCaretRect(), visibleTop: box.top, visibleBottom: box.top + scroller.clientHeight }
    })
    const enterAtEnd = async () => {
      const before = await scrollState()
      await page.keyboard.press('Enter')
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const after = await scrollState()
      assert.equal(after.scrollHeight > before.scrollHeight && after.scrollTop > before.scrollTop, true, JSON.stringify({ before, after }))
      assert.equal(after.caret.bottom <= after.visibleBottom + 0.5, true, JSON.stringify({ before, after }))
      assert.equal(after.pageTop, before.pageTop)
    }
    await enterAtEnd()
    await enterAtEnd()

    const mid = await page.evaluate(() => {
      const view = window.fixtureView()
      window.fixtureSelect(view.state.doc.toString().indexOf('line-7') + 3)
      const scroller = view.scrollDOM
      scroller.scrollTop = Math.max(0, Math.floor(scroller.scrollHeight / 2 - scroller.clientHeight / 2))
      return { scrollTop: scroller.scrollTop, pageTop: document.scrollingElement.scrollTop }
    })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await page.keyboard.press('Enter')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await page.evaluate(() => ({ scrollTop: window.fixtureView().scrollDOM.scrollTop, pageTop: document.scrollingElement.scrollTop })), mid)
  }))
}

for (const spec of browsers) {
  test(`${spec.name} gives atomic blocks one keyboard step and hard-line caret boundaries`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await openSession(page, `fixture/block-navigation-${spec.name}`)
    const first = 'f'.repeat(2000)
    const second = 's'.repeat(2000)
    const firstBlock = `<pasted-text>${first}</pasted-text>`
    const secondBlock = `<pasted-text>${second}</pasted-text>`
    await page.click(editor)
    await page.evaluate(text => window.fixturePaste(text), first)
    await page.waitForSelector('[data-composer-pasted-text-id]')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('after ')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${firstBlock}after `)
    await undo(page)
    await pressWithControl(page, 'Home')
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift')
    assert.equal(await copySelection(page), firstBlock)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowLeft'); await page.keyboard.up('Shift')
    assert.equal(await copySelection(page), firstBlock)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await page.evaluate(text => window.fixturePaste(text), second)
    const exact = `${firstBlock}\n${secondBlock}`
    assert.equal(await page.evaluate(() => window.fixtureDraft), exact)

    await clickBesideChip(page, 1, 'before')
    await page.keyboard.type('mouse ')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${firstBlock}\nmouse ${secondBlock}`)
    await undo(page)
    await pressWithControl(page, 'End')
    await page.keyboard.press('Home')
    await page.keyboard.type('home ')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${firstBlock}\nhome ${secondBlock}`)
    await undo(page)
    // End from the start of a block-led line reaches the line end.
    await clickBesideChip(page, 1, 'before')
    await page.keyboard.press('End')
    await page.keyboard.type(' end')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${exact} end`)
    await undo(page)
    await clickBesideChip(page, 1, 'before')
    await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${firstBlock}${secondBlock}`)
    await undo(page)
    await clickBesideChip(page, 1, 'before')
    await page.keyboard.press('Delete')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${firstBlock}\n`)
    await undo(page)
    // ArrowDown from the first line start lands before the block on the next line.
    await pressWithControl(page, 'Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${firstBlock}${secondBlock}`)
    await undo(page)
    await clickBesideChip(page, 1, 'before')
    await pressWithControl(page, 'Home')
    await page.keyboard.type('document ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('document <pasted-text>')), true)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exact)

    await page.evaluate(() => window.fixtureSelectAll())
    await page.keyboard.press('Backspace')
    await page.type(editor, 'w'.repeat(120))
    await page.evaluate(text => window.fixturePaste(text), first)
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${'w'.repeat(120)}${firstBlock}`)
  }))
}

for (const spec of browsers) {
  test(`${spec.name} exits atomic boundaries into ordinary text and collapses selections`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const block = 'q'.repeat(2000)
    const reset = async suffix => {
      await openSession(page, `fixture/mixed-boundary-${spec.name}-${suffix}`)
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
    await page.evaluate(() => window.fixtureSelect(window.fixtureChips()[0].to + '😀'.length))
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `aX${wrapper}😀z`)

    await reset('collapse-right')
    await page.evaluate(() => { const chip = window.fixtureChips()[0]; window.fixtureSelect(chip.from, chip.to) })
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `a${wrapper}X😀z`)

    await reset('collapse-left')
    await page.evaluate(() => { const chip = window.fixtureChips()[0]; window.fixtureSelect(chip.from, chip.to) })
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `aX${wrapper}😀z`)

    await reset('shift-text')
    await page.evaluate(() => window.fixtureSelectText(1, 1))
    await page.keyboard.down('Shift'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift')
    await page.keyboard.press('Delete')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'az')
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), `a${wrapper}😀z`)

    await openSession(page, `fixture/mixed-hard-${spec.name}`)
    await page.type(editor, 'before')
    await page.keyboard.press('Enter')
    await page.evaluate(text => window.fixturePaste(text), block)
    await page.keyboard.type('after')
    await clickBesideChip(page, 0, 'before')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.type('X')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before\n${wrapper}aXfter`)
  }))
}

// Width of the rendered composition text, to catch clipped or hidden IME text.
async function composedTextWidth(page, text) {
  return page.evaluate(text => {
    const walker = document.createTreeWalker(window.fixtureEditor(), NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.nodeValue.indexOf(text)
      if (index < 0 || node.parentElement.closest('[contenteditable="false"]')) continue
      const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + text.length)
      const rect = range.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit && window.fixtureEditor().contains(hit) ? rect.width : 0
    }
    return 0
  }, text)
}

// Firefox has no automation IME. This replays the DOM effects of an input
// method: composition events around native text insertion and replacement.
async function syntheticComposition(page, interim, committed) {
  await page.evaluate(interim => {
    const node = window.fixtureEditor()
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    node.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: interim }))
    document.execCommand('insertText', false, interim)
  }, interim)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const during = { draft: await page.evaluate(() => window.fixtureDraft || ''), width: await composedTextWidth(page, interim) }
  await page.evaluate((interim, committed) => {
    const node = window.fixtureEditor()
    for (let index = 0; index < interim.length; index += 1) getSelection().modify('extend', 'backward', 'character')
    node.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: committed }))
    if (committed) document.execCommand('insertText', false, committed)
    else document.execCommand('delete')
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: committed }))
  }, interim, committed)
  return during
}

if (chromiumSpec) test('Chromium hides the empty placeholder during trusted composition without persisting interim text', async () => withBrowser(chromiumSpec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  const client = await page.createCDPSession()
  await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
  await page.click(editor)
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await page.waitForFunction(() => window.fixtureEditor()?.dataset.empty === 'false')
  assert.equal(await page.$eval(editor, node => getComputedStyle(node, '::before').content), 'none')
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)

  await client.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await client.send('Input.insertText', { text: '' })
  await page.waitForFunction(() => window.fixtureEditor()?.dataset.empty === 'true')
  assert.notEqual(await page.$eval(editor, node => getComputedStyle(node, '::before').content), 'none')
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')

  await page.click(editor)
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await client.send('Input.insertText', { text: '你' })
  await page.waitForFunction(() => window.fixtureDraft === '你')
  assert.deepEqual(await page.$eval(editor, node => ({
    empty: node.dataset.empty,
    placeholder: getComputedStyle(node, '::before').content,
  })), { empty: 'false', placeholder: 'none' })
  await client.detach()
}))

if (firefoxSpec) test('Firefox hides and restores the empty placeholder around synthetic composition', async () => withBrowser(firefoxSpec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.evaluate(() => document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console'))
  await page.click(editor)
  await page.evaluate(() => {
    window.fixtureEditor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    document.execCommand('insertText', false, 'に')
  })
  await page.waitForFunction(() => window.fixtureEditor()?.dataset.empty === 'false')
  assert.equal(await page.$eval(editor, node => getComputedStyle(node, '::before').content), 'none')
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)

  await page.evaluate(() => {
    getSelection().modify('extend', 'backward', 'character')
    document.execCommand('delete')
    window.fixtureEditor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
  })
  await page.waitForFunction(() => window.fixtureEditor()?.dataset.empty === 'true')
  assert.notEqual(await page.$eval(editor, node => getComputedStyle(node, '::before').content), 'none')
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')
}))

if (firefoxSpec) test('Firefox Send pointer click submits composition committed on blur', async () => withBrowser(firefoxSpec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  const blockText = 'S'.repeat(2000)
  const block = `<pasted-text>${blockText}</pasted-text>`
  const cases = [
    ['ordinary', async () => page.keyboard.type('prefix '), 'prefix ', 'prefix 你'],
    ['leading', async () => { await page.evaluate(text => window.fixturePaste(text), blockText); await page.evaluate(() => window.fixtureSelect(0)) }, block, `你${block}`],
  ]
  for (const [name, prepare, base, expected] of cases) {
    await openSession(page, `fixture/firefox-ime-send-${name}`)
    await page.evaluate(() => { window.fixtureSends = []; window.fixtureAccept = false })
    await page.click(editor)
    await prepare()
    // Firefox commits an active composition when the editor loses focus; replay
    // that commit from the blur a Send pointer click causes.
    await page.evaluate(() => {
      const node = window.fixtureEditor()
      node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
      document.execCommand('insertText', false, '你')
      node.addEventListener('blur', () => node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你' })), { once: true, capture: true })
    })
    assert.equal(await page.evaluate(() => window.fixtureDraft || ''), base, `${name}: interim text is not emitted`)
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(() => window.fixtureSends.length === 1)
    assert.equal(await page.evaluate(() => window.fixtureSends[0].text), expected, name)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Send message', name)
    await page.waitForFunction(value => window.fixtureDraft === value, {}, expected)
    await page.focus(editor)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), base, `${name}: one undo step`)
  }
}))

if (firefoxSpec) test('Firefox commits synthetic composition next to blocks as one visible, undoable edit', async () => withBrowser(firefoxSpec, async page => {
  const first = 'L'.repeat(2000)
  const second = 'R'.repeat(2000)
  const firstBlock = `<pasted-text>${first}</pasted-text>`
  const secondBlock = `<pasted-text>${second}</pasted-text>`
  const cases = [
    ['leading', [first], () => window.fixtureSelect(0), `你${firstBlock}`],
    ['trailing', [first], () => window.fixtureSelect(window.fixtureView().state.doc.length), `${firstBlock}你`],
    ['between', [first, second], () => window.fixtureSelect(window.fixtureChips()[0].to), `${firstBlock}你${secondBlock}`],
  ]
  for (const [name, blocks, place, expected] of cases) {
    await openSession(page, `fixture/firefox-ime-${name}`)
    await page.click('[role="textbox"][aria-label="Message"]')
    for (const block of blocks) await page.evaluate(text => window.fixturePaste(text), block)
    const base = await page.evaluate(() => window.fixtureDraft)
    await page.evaluate(place)
    const during = await syntheticComposition(page, 'ni', '你')
    assert.equal(during.draft, base, `${name}: interim text is not emitted`)
    assert.ok(during.width > 8, `${name}: interim text is visible (${during.width}px)`)
    await page.waitForFunction(value => window.fixtureDraft === value, {}, expected)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), base, `${name}: one undo step`)
  }
}))

for (const spec of browsers.filter(browser => browser === chromiumSpec)) {
  test(`${spec.name} inserts inline file attachments at the caret and preserves atomic undo`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await page.type(editor, 'before after')
    await page.evaluate(() => window.fixtureSelectText(7, 7))
    await page.evaluate(() => {
      window.fixturePasteFiles([new File(['one'], 'duplicate.txt', { type: 'text/plain' }), new File(['two'], 'duplicate.txt', { type: 'text/plain' })])
    })
    await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2)
    const refs = await page.$$eval('.foxwarm-composer-attachment-chip', chips => chips.map(chip => chip.dataset.composerAttachmentRef))
    assert.notEqual(refs[0], refs[1])
    assert.deepEqual(await page.$$eval('.foxwarm-composer-attachment-chip button', buttons => buttons.map(button => button.textContent)), ['FILE 1', 'FILE 2'])
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before <attachment-ref ref="${refs[0]}" /><attachment-ref ref="${refs[1]}" />after`)
    await page.keyboard.type('x')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before <attachment-ref ref="${refs[0]}" /><attachment-ref ref="${refs[1]}" />xafter`)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before <attachment-ref ref="${refs[0]}" />after`)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), `before <attachment-ref ref="${refs[0]}" /><attachment-ref ref="${refs[1]}" />after`)

    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector(editor)
    await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2)
    assert.deepEqual(await page.$$eval('.foxwarm-composer-attachment-chip', chips => chips.map(chip => chip.dataset.attachmentMissing === 'true')), [true, true])
    // Between two adjacent blocks, the pointer and one step each way keep the caret between them.
    await page.evaluate(() => {
      const [first, second] = document.querySelectorAll('.foxwarm-composer-attachment-chip')
      const a = first.getBoundingClientRect(); const b = second.getBoundingClientRect()
      window.fixtureBetween = { x: (a.right + b.left) / 2, y: a.top + a.height / 2 }
    })
    await page.mouse.click(...await page.evaluate(() => [window.fixtureBetween.x, window.fixtureBetween.y]))
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('between ')
    await page.waitForFunction(expected => window.fixtureDraft === expected, {}, `before <attachment-ref ref="${refs[0]}" />between <attachment-ref ref="${refs[1]}" />after`)
    await undo(page)
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
    await page.waitForFunction(() => document.querySelector('.foxwarm-composer-attachment-chip')?.dataset.attachmentMissing === 'false')
    assert.deepEqual(await page.$$eval('.foxwarm-composer-attachment-chip', chips => chips.map(chip => chip.dataset.composerAttachmentRef)), refs)
    await page.$$eval('.foxwarm-composer-attachment-chip button', buttons => buttons[1].click())
    await page.waitForSelector('[role="dialog"][aria-label="Attachment information"]')
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Remove')?.click())
    await page.evaluate(() => { window.fixtureAccept = true })
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(() => window.fixtureSends.length === 1)
    assert.deepEqual(await page.evaluate(() => window.fixtureSends[0].attachments.map(item => ({ ref: item.ref, name: item.file.name }))), [{ ref: refs[0], name: 'replacement.txt' }])

    await openSession(page, 'fixture/hardline-attachments')
    await page.type(editor, 'line')
    await page.keyboard.press('Enter')
    await page.evaluate(() => {
      window.fixturePasteFiles([new File(['image'], 'photo.png', { type: 'image/png' }), new File(['file'], 'notes.txt', { type: 'text/plain' })])
    })
    await page.waitForFunction(() => document.querySelectorAll('.foxwarm-composer-attachment-chip').length === 2)
    await clickBesideChip(page, 0, 'before')
    await page.keyboard.type('before ')
    assert.equal(await page.evaluate(() => window.fixtureDraft.startsWith('line\nbefore <attachment-ref')), true)
  }))
}

for (const spec of browsers) {
  test(`${spec.name} removes composer blocks with their visible controls and restores them with undo`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    await openSession(page, `fixture/remove-${spec.name}`)
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
    await openSession(page, `fixture/block-selection-${spec.name}`)
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
    await page.evaluate(() => window.fixtureSelect(0))
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)
    const points = await page.$eval(editor, node => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      const texts = []
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (text.nodeValue.length > 0 && !text.parentElement.closest('[contenteditable="false"]')) texts.push(text)
      }
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
      const remove = chip.querySelector('[data-composer-block-remove]') || (chip.dataset.composerAttachmentRef && document.querySelector(`[data-attachment-preview-ref="${chip.dataset.composerAttachmentRef}"] .composer-attachment-remove`))
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
    await page.mouse.click(points.start.x, points.start.y)
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)

    // A selection that ends at a block boundary, or a caret there, does not cover the block.
    await page.evaluate(() => window.fixtureSelect(0, window.fixtureChips()[0].from))
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)
    await page.evaluate(() => window.fixtureSelect(window.fixtureChips()[0].from))
    await page.waitForFunction(() => document.querySelectorAll('[data-composer-block-selected]').length === 0)

    await page.focus(editor)
    await pressWithControl(page, 'a')
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
        return { shadow: style.boxShadow, color: style.color, remove: !!(chip.querySelector('[data-composer-block-remove]') || (chip.dataset.composerAttachmentRef && document.querySelector(`[data-attachment-preview-ref="${chip.dataset.composerAttachmentRef}"] .composer-attachment-remove`))) }
      }))
      assert.equal(consoleStyles.every(style => style.shadow !== 'none' && style.remove && style.color !== 'rgba(0, 0, 0, 0)'), true, JSON.stringify(consoleStyles))
    }
    await page.focus(editor)
    await page.keyboard.press('ArrowRight')
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

if (chromiumSpec) test('Chromium removes image, file, and missing-file blocks without opening their modal', async () => withBrowser(chromiumSpec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const sessionId = 'fixture/remove-attachments'
    await openSession(page, sessionId)
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
    assert.equal(await page.evaluate(() => window.fixtureText().startsWith('A') && window.fixtureText().endsWith('B')), true)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.evaluate(() => window.fixtureDraft), attachmentDraft)
    assert.equal(await page.evaluate(() => window.fixtureSends.at(-1)?.attachments?.length || 0), 0)
    await page.$eval(editor, node => node.blur())
    await page.waitForFunction((sessionId, refs) => refs.every(ref => localStorage.getItem(`composer_draft_v1_${sessionId}`)?.includes(ref)), {}, sessionId, await page.evaluate(() => [...document.querySelectorAll('.foxwarm-composer-attachment-chip')].map(chip => chip.dataset.composerAttachmentRef)))

    await page.reload({ waitUntil: 'load' })
    await page.evaluate(sessionId => window.fixtureSetSession(sessionId), sessionId)
    await page.waitForFunction((sessionId) => window.fixtureCurrentSession === sessionId
      && document.querySelector('button[aria-label="Remove attachment notes.txt"]')
      && [...document.querySelectorAll('.foxwarm-composer-attachment-chip')].every(node => node.dataset.attachmentMissing === 'true'), {}, sessionId)
    assert.equal(await page.$eval('.foxwarm-composer-attachment-chip', node => node.dataset.attachmentMissing === 'true'), true)
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

if (chromiumSpec) test('Chromium preserves trusted CDP IME replacement at every block boundary and keeps it visible', async () => withBrowser(chromiumSpec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  const client = await page.createCDPSession()
  const commitIme = async (base, expected) => {
    const sendCount = await page.evaluate(() => window.fixtureSends.length)
    await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
    assert.equal(await page.evaluate(() => window.fixtureDraft || ''), base)
    assert.equal(await page.evaluate(() => window.fixtureSends.length), sendCount)
    await client.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(() => window.fixtureDraft || ''), base)
    assert.equal(await page.evaluate(() => window.fixtureSends.length), sendCount)
    const width = await composedTextWidth(page, 'ni')
    assert.ok(width > 8, `composition text is visible (${width}px)`)
    await client.send('Input.insertText', { text: '你' })
    await page.waitForFunction(value => window.fixtureDraft === value, {}, expected)
    assert.equal((await page.evaluate(() => window.fixtureDraft)).includes('n你'), false)
  }

  await openSession(page, 'fixture/ime-plain')
  await page.click(editor)
  await commitIme('', '你')
  await undo(page)
  assert.equal(await page.evaluate(() => window.fixtureDraft), '')

  const first = 'L'.repeat(2000)
  const second = 'R'.repeat(2000)
  const firstBlock = `<pasted-text>${first}</pasted-text>`
  const secondBlock = `<pasted-text>${second}</pasted-text>`

  await openSession(page, 'fixture/ime-leading')
  await page.click(editor)
  await page.evaluate(text => window.fixturePaste(text), first)
  await pressWithControl(page, 'Home')
  await commitIme(firstBlock, `你${firstBlock}`)
  await page.evaluate(() => window.fixtureSelectAll())
  assert.equal(await copySelection(page), `你${firstBlock}`)
  await page.focus(editor)
  await pressWithControl(page, 'Enter')
  await page.waitForFunction(() => window.fixtureSends.length === 1)
  assert.equal(await page.evaluate(() => window.fixtureSends[0].text), `你${firstBlock}`)
  await undo(page)
  assert.equal(await page.evaluate(() => window.fixtureDraft), firstBlock)

  await openSession(page, 'fixture/ime-trailing')
  await page.click(editor)
  await page.evaluate(text => window.fixturePaste(text), first)
  await clickBesideChip(page, 0, 'after')
  await commitIme(firstBlock, `${firstBlock}你`)
  await undo(page)
  assert.equal(await page.evaluate(() => window.fixtureDraft), firstBlock)

  await openSession(page, 'fixture/ime-between')
  await page.click(editor)
  await page.evaluate(text => window.fixturePaste(text), first)
  await page.evaluate(text => window.fixturePaste(text), second)
  const betweenBase = `${firstBlock}${secondBlock}`
  await page.evaluate(() => window.fixtureSelect(window.fixtureChips()[0].to))
  await commitIme(betweenBase, `${firstBlock}你${secondBlock}`)
  await undo(page)
  assert.equal(await page.evaluate(() => window.fixtureDraft), betweenBase)
  await client.detach()
}))

if (chromiumSpec) test('Chromium Send pointer click synchronously submits composition committed on blur', async () => withBrowser(chromiumSpec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  const sendButton = 'button[aria-label="Send message"]'
  const client = await page.createCDPSession()
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
  await openSession(page, 'fixture/ime-send-leading')
  await page.click(editor)
  await page.evaluate(text => window.fixturePaste(text), blockText)
  await observeOrder()
  await pressWithControl(page, 'Home')
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await client.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 })
  await page.click(sendButton)
  await page.waitForFunction(() => window.fixtureSends.length === 1)
  await assertBlurCommitOrder()
  assert.equal(await page.evaluate(() => window.fixtureSends[0].text), `你${block}`)
  assert.equal(await page.evaluate(() => window.fixtureDraft), `你${block}`)
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Send message')
  await page.focus(editor)
  await undo(page)
  assert.equal(await page.evaluate(() => window.fixtureDraft), block)

  await openSession(page, 'fixture/ime-send-ordinary')
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
  await undo(page)
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'prefix ')

  await openSession(page, 'fixture/ime-send-accepted')
  await page.evaluate(() => { window.fixtureSends = []; window.fixtureAccept = true; window.fixtureHoldSend = true })
  await page.click(editor)
  await page.keyboard.type('accepted ')
  await observeOrder()
  await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 })
  await client.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 })
  await page.click(sendButton)
  await page.waitForFunction(() => window.fixtureSends.length === 1 && window.fixtureEditor()?.contentEditable === 'false')
  assert.equal(await page.evaluate(() => window.fixtureSendActiveElement), 'Send message')
  await page.evaluate(() => window.fixtureReleaseSend())
  await settleSend(page)
  await assertBlurCommitOrder()
  assert.equal(await page.evaluate(() => window.fixtureSends[0].text), 'accepted 你')
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/ime-send-accepted')), null)
  assert.equal(await page.evaluate(() => document.activeElement === window.fixtureEditor()), true)
  await page.keyboard.type('after composition send')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'after composition send')
  await client.detach()
}))

for (const spec of browsers) {
test(`${spec.name} restores caret and selected ranges through undo and redo`, async () => withBrowser(spec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await openSession(page, 'fixture/history-selection')
  await page.type(editor, 'ac')
  await page.evaluate(() => window.fixtureSelectText(1, 1))
  await page.keyboard.type('b')
  assert.equal(await page.evaluate(() => window.fixtureText()), 'abc')
  await undo(page)
  assert.equal(await page.evaluate(() => window.fixtureText()), 'ac')
  await redo(page)
  assert.equal(await page.evaluate(() => window.fixtureText()), 'abc')
  await undo(page)
  await page.keyboard.type('X')
  assert.equal(await page.evaluate(() => window.fixtureText()), 'aXc')

  await openSession(page, 'fixture/history-range')
  await page.type(editor, 'left right')
  await page.evaluate(() => { window.fixtureSelectText(4, 5); window.fixturePaste('p'.repeat(2000)) })
  const segmented = await page.evaluate(() => window.fixtureDraft)
  // A backward selection from inside "right" to inside "left", across the block.
  await page.evaluate(() => window.fixtureSelect(window.fixtureChips()[0].to + 3, 2))
  await page.keyboard.type('Z')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'leZht')
  await undo(page)
  assert.equal(await page.evaluate(() => window.fixtureDraft), segmented)
  await redo(page)
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'leZht')
  await undo(page)
  await page.keyboard.type('Q')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'leQht')
}))
}

for (const spec of browsers) {
test(`${spec.name} inserts live transcription at the retained caret and keeps one undo step`, async () => withBrowser(spec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  const record = 'button[aria-label="Start recording"]'
  await page.type(editor, 'before after')
  await page.evaluate(() => window.fixtureSelectText(7, 7))
  await page.click(record)
  await page.waitForFunction(() => window.fixtureStreamSessions.length === 1 && window.fixtureEditor()?.contentEditable === 'false')
  assert.equal(await page.$(record), null)
  assert.equal(await page.$('#audio-upload'), null)
  assert.equal(await page.$('button[aria-label="Send message"]:disabled') !== null, true)
  assert.equal(await page.$('[aria-label="Attach files"]') !== null, true)
  assert.equal(await page.evaluate(() => document.body.textContent.includes('Live ASR preview') || document.body.textContent.includes('Rec')), false)
  await page.evaluate(() => window.fixtureStreamSessions[0].callbacks.onPartial('今'))
  await page.waitForFunction(() => window.fixtureDraft === 'before 今after')
  await page.evaluate(() => {
    const session = window.fixtureStreamSessions[0]
    session.callbacks.onPartial('今天')
    session.callbacks.onPartial('今天')
    session.callbacks.onPartial('今天天')
    session.callbacks.onPartial('今天')
  })
  await page.waitForFunction(() => window.fixtureDraft === 'before 今天after')
  await page.keyboard.type('blocked')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'before 今天after')
  await page.click('button[aria-label="Stop recording and transcribe"]')
  await page.waitForFunction(() => window.fixtureStreamSessions[0].stopped && !!document.querySelector('button[aria-label="Finalizing transcription"]'))
  await page.evaluate(() => window.fixtureStreamSessions[0].callbacks.onFinal('今天天气'))
  await page.waitForFunction(() => window.fixtureDraft === 'before 今天天气after' && window.fixtureEditor()?.contentEditable === 'true')
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'before after')
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), '')
}))

test(`${spec.name} inserts next to atomic blocks and appends when this Session has no caret`, async () => withBrowser(spec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'left right')
  await page.evaluate(() => { window.fixtureSelectText(5, 5); window.fixturePaste('p'.repeat(2000)) })
  await page.waitForSelector('.foxwarm-composer-pasted-text-chip')
  const before = await page.evaluate(() => window.fixtureDraft)
  await page.evaluate(() => {
    window.fixtureSelect(window.fixtureChips()[0].from)
  })
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureStreamSessions.length === 1)
  await page.evaluate(() => window.fixtureStreamSessions[0].callbacks.onPartial('语音'))
  await page.waitForFunction(() => window.fixtureDraft.includes('语音<pasted-text>'))
  await page.$eval('[data-composer-block-remove]', node => node.click())
  await page.evaluate(() => {
    window.fixturePaste('blocked')
    const transfer = new DataTransfer()
    transfer.items.add(new File(['one'], 'during.txt', { type: 'text/plain' }))
    const input = document.querySelector('#file-upload')
    Object.defineProperty(input, 'files', { configurable: true, value: transfer.files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: transfer })
    window.fixtureEditor().dispatchEvent(drop)
  })
  assert.equal(await page.evaluate(() => window.fixtureDraft), before.replace('<pasted-text>', '语音<pasted-text>'))
  await page.evaluate(() => window.fixtureStreamSessions[0].callbacks.onFinal('语音稿'))
  await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'true')
  assert.equal(await page.evaluate(() => window.fixtureDraft), before.replace('<pasted-text>', '语音稿<pasted-text>'))

  await page.evaluate(() => {
    localStorage.setItem('composer_draft_v1_fixture/no-caret', JSON.stringify({ version: 1, segments: [{ type: 'text', text: 'tail' }] }))
    getSelection()?.removeAllRanges()
    window.fixtureSetSession('fixture/no-caret')
  })
  await page.waitForFunction(() => window.fixtureText() === 'tail')
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureStreamSessions.length === 2)
  await page.evaluate(() => window.fixtureStreamSessions[1].callbacks.onFinal('after'))
  await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'true')
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'tailafter')
}))

test(`${spec.name} keeps partial text on error and ignores late callbacks across Sessions`, async () => withBrowser(spec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'old')
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureStreamSessions.length === 1)
  await page.evaluate(() => window.fixtureStreamSessions[0].callbacks.onPartial(' partial'))
  await page.waitForFunction(() => window.fixtureDraft === 'old partial')
  await page.evaluate(() => window.fixtureSetSession('fixture/new'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/new' && window.fixtureEditor()?.contentEditable === 'true')
  assert.equal(await page.evaluate(() => window.fixtureStreamSessions[0].cancelled), true)
  await page.evaluate(() => {
    const old = window.fixtureStreamSessions[0]
    old.callbacks.onPartial('late')
    old.callbacks.onFinal('late final')
  })
  assert.equal(await page.evaluate(() => window.fixtureDraft), '', 'late callbacks must not change the new Session draft')
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).segments[0].text), 'old partial')
  await page.type(editor, 'new')
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureStreamSessions.length === 2)
  await page.evaluate(() => {
    const current = window.fixtureStreamSessions[1]
    current.callbacks.onPartial(' live')
    current.callbacks.onError('ASR unavailable')
    current.callbacks.onFinal('should be ignored')
  })
  await page.waitForFunction(() => window.fixtureDraft === 'new live' && window.fixtureEditor()?.contentEditable === 'true')
  assert.equal(await page.$eval('[role="alert"]', node => node.textContent.includes('ASR unavailable')), true)
  await page.evaluate(() => window.fixtureStreamSessions[1].callbacks.onPartial('ignored'))
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'new live')
}))

test(`${spec.name} preserves selected text, committed composition, and partial text on empty final`, async () => withBrowser(spec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'ab')
  await page.evaluate(() => window.fixtureSelectText(0, 1))
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureStreamSessions.length === 1)
  await page.evaluate(() => {
    const session = window.fixtureStreamSessions[0]
    session.callbacks.onPartial('X')
    session.callbacks.onFinal('')
  })
  await page.waitForFunction(() => window.fixtureDraft === 'aXb' && window.fixtureEditor()?.contentEditable === 'true')
  await page.evaluate(() => {
    window.fixtureSelectText(3, 3)
    const node = window.fixtureEditor()
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    document.execCommand('insertText', false, '中')
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
  })
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureStreamSessions.length === 2)
  await page.evaluate(() => window.fixtureStreamSessions[1].callbacks.onFinal('文'))
  await page.waitForFunction(() => window.fixtureDraft === 'aXb中文' && window.fixtureEditor()?.contentEditable === 'true')
}))

test(`${spec.name} unlocks the draft on microphone rejection and retries`, async () => withBrowser(spec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.evaluate(() => { window.fixtureMicMode = 'reject' })
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'true' && document.querySelector('[role="alert"]')?.textContent.includes('Microphone access denied'))
  assert.equal(await page.evaluate(() => window.fixtureStreamSessions.length), 0)
  await page.type(editor, 'still editable')
  await page.evaluate(() => { window.fixtureMicMode = 'ok' })
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureStreamSessions.length === 1)
  await page.evaluate(() => window.fixtureStreamSessions[0].callbacks.onFinal(''))
  await page.waitForFunction(() => window.fixtureDraft === 'still editable' && window.fixtureEditor()?.contentEditable === 'true')
}))

test(`${spec.name} cancels microphone startup while audio-context resume is pending`, async () => withBrowser(spec, async page => {
  await page.type('[role="textbox"][aria-label="Message"]', 'retained draft')
  await page.evaluate(() => { window.fixtureResumeMode = 'hold' })
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => typeof window.fixtureReleaseResume === 'function')
  await page.click('button[aria-label="Stop recording and transcribe"]')
  await page.waitForFunction(() => window.fixtureClosedContexts > 0 && window.fixtureStoppedTracks > 0 && window.fixtureStreamSessions[0].cancelled && window.fixtureEditor()?.contentEditable === 'true')
  await page.evaluate(() => { window.fixtureStreamSessions[0].callbacks.onPartial('late'); window.fixtureStreamSessions[0].callbacks.onFinal('late final') })
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'retained draft')
}))

test(`${spec.name} discards pending microphone startup after a Session change or stream setup failure`, async () => withBrowser(spec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'old')
  await page.evaluate(() => { window.fixtureMicMode = 'hold' })
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'false' && !!window.fixtureReleaseMicrophone)
  await page.evaluate(() => window.fixtureSetSession('fixture/fresh'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/fresh' && window.fixtureEditor()?.contentEditable === 'true')
  await page.evaluate(() => window.fixtureReleaseMicrophone())
  await page.waitForFunction(() => window.fixtureStoppedTracks > 0)
  assert.equal(await page.evaluate(() => window.fixtureStreamSessions.length), 0)
  await page.type(editor, 'fresh')
  await page.evaluate(() => { window.fixtureMicMode = 'ok'; window.fixtureStreamMode = 'reject' })
  await page.click('button[aria-label="Start recording"]')
  await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'true' && document.querySelector('[role="alert"]')?.textContent.includes('Streaming setup unavailable'))
  assert.equal(await page.evaluate(() => window.fixtureDraft), 'fresh')
}))
}

if (chromiumSpec) test('Chromium blocks custom and native draft mutations throughout disabled transitions', async () => withBrowser(chromiumSpec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await openSession(page, 'fixture/disabled')
  await page.type(editor, 'start end')
  await page.evaluate(() => { window.fixtureSelectText(5, 6); window.fixturePaste('d'.repeat(2000)) })
  const expected = await page.evaluate(() => window.fixtureDraft)
  await page.click('.foxwarm-composer-pasted-text-chip')
  await setModalText(page, 'stale modal edit')
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

  await page.evaluate(() => window.fixtureSetLoading(false))
  await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'true'
    && document.querySelector('.foxwarm-composer-pasted-text-chip')?.getAttribute('aria-disabled') === 'false')
  assert.deepEqual(await page.$eval('.foxwarm-composer-pasted-text-chip', node => ({ tabIndex: node.tabIndex, disabled: node.getAttribute('aria-disabled'), buttonsEnabled: [...node.querySelectorAll('button')].every(button => !button.disabled && button.tabIndex === 0) })), { tabIndex: -1, disabled: 'false', buttonsEnabled: true })
}))

if (chromiumSpec) test('Chromium preserves storage, send, copy, selection, composition, slash, and mobile contracts', async () => withBrowser(chromiumSpec, async page => {
  const editor = '[role="textbox"][aria-label="Message"]'
  await page.type(editor, 'session A')
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).version), 1)
  await page.evaluate(() => window.fixtureSetSession('fixture/other'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/other')
  await new Promise(resolve => setTimeout(resolve, 50))
  await page.waitForFunction(() => window.fixtureText() === '')
  await page.type(editor, 'session B')
  await page.evaluate(() => window.fixtureSetSession('fixture/main'))
  await page.waitForFunction(() => window.fixtureText() === 'session A')
  await page.evaluate(() => window.fixtureSetSession('fixture/other'))
  await page.waitForFunction(() => window.fixtureCurrentSession === 'fixture/other')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await page.evaluate(() => window.fixtureText()), 'session B')
  await page.evaluate(() => { window.fixtureHoldDraftRestoreFrame = true; window.fixtureSetSession('fixture/main') })
  await page.waitForFunction(() => window.fixtureText() === 'session A')
  await page.waitForFunction(() => window.fixtureHasHeldDraftRestoreFrame())

  await page.evaluate(() => { window.fixtureSelectAll(); window.fixturePaste(Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')) })
  await page.waitForSelector('.foxwarm-composer-pasted-text-chip')
  const exact = await page.evaluate(() => window.fixtureDraft)
  await page.evaluate(() => window.fixtureReleaseDraftRestoreFrame())
  await page.waitForFunction((expected) => {
    const stored = JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main'))
    return window.fixtureDraft === expected
      && window.fixtureEditor()?.querySelector('.foxwarm-composer-pasted-text-chip')
      && stored.segments?.length === 1
      && stored.segments[0]?.type === 'pasted-text'
      && expected.includes(stored.segments[0]?.text)
  }, {}, exact)
  await page.evaluate(() => {
    window.fixtureCopiedText = null
    document.addEventListener('copy', event => {
      queueMicrotask(() => { window.fixtureCopiedText = event.clipboardData?.getData('text/plain') || '' })
    }, { once: true })
    window.fixtureSelectAll()
  })
  await page.keyboard.down('Control'); await page.keyboard.press('c'); await page.keyboard.up('Control')
  await page.waitForFunction(expected => window.fixtureCopiedText === expected, {}, exact)
  await page.evaluate(() => window.fixtureSelectAll())
  await page.keyboard.down('Control'); await page.keyboard.press('x'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), '')
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureDraft), exact)

  await page.evaluate(() => { window.fixtureAccept = false })
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control')
  await page.waitForFunction(() => window.fixtureSends.length === 1)
  assert.equal(await page.evaluate(() => window.fixtureText().length > 0), true)
  await page.evaluate(() => { window.fixtureAccept = true })
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control')
  await page.waitForFunction(() => window.fixtureSends.length === 2)
  await page.waitForFunction(() => window.fixtureText() === '')
  assert.equal(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), null)
  assert.equal(await page.evaluate(() => window.fixtureSends[1].text), exact)

  await page.type(editor, '/he')
  await page.waitForSelector('[data-slash-command-overlay="true"]')
  await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(() => window.fixtureText()), '/help ')

  await page.evaluate(() => {
    window.fixtureSelectAll()
    const editorNode = window.fixtureEditor()
    editorNode.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    document.execCommand('insertText', false, '中文')
    editorNode.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }))
    editorNode.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
  })
  await page.waitForFunction(() => window.fixtureDraft === '中文')
  assert.equal(await page.evaluate(() => window.fixtureSends.length), 2)
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
  assert.equal(await page.evaluate(() => window.fixtureText()), '/help ')

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
  await page.waitForFunction(() => window.fixtureText() === '')
  await page.type(editor, 'unsaved but visible')
  await page.waitForFunction(() => document.body.textContent.includes('Draft could not be saved in this browser'))
  assert.equal(await page.evaluate(() => window.fixtureText()), 'unsaved but visible')
  await page.evaluate(() => { Storage.prototype.setItem = window.fixtureRealSetItem })
}))

for (const spec of browsers) {
  test(`${spec.name} preserves sequential dropped attachments at the drop point`, async () => withBrowser(spec, async page => {
    const drop = async name => page.evaluate(name => {
      const editor = window.fixtureEditor()
      const box = editor.getBoundingClientRect()
      const transfer = new DataTransfer()
      transfer.items.add(new File(['pdf'], name, { type: 'application/pdf' }))
      editor.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: box.right - 12, clientY: box.top + 12 }))
    }, name)
    await drop('first.pdf')
    await page.waitForFunction(() => window.fixtureDraft?.includes('<attachment-ref'))
    await drop('second.pdf')
    const state = await page.evaluate(() => ({
      draft: window.fixtureDraft,
      segments: JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).segments,
      chips: window.fixtureEditor().querySelectorAll('[data-composer-attachment-ref]').length,
    }))
    assert.equal(state.chips, 2, JSON.stringify(state))
    assert.deepEqual(state.segments.map(segment => segment.type), ['attachment', 'attachment'])
    assert.doesNotMatch(state.draft, /application\/pdf|first\.pdf|second\.pdf|×/)
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control')
    assert.equal(await page.$$eval('[data-composer-attachment-ref]', chips => chips.length), 1)
    await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control')
    assert.equal(await page.$$eval('[data-composer-attachment-ref]', chips => chips.length), 2)
    await page.evaluate(() => { window.fixtureAccept = true })
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control')
    await page.waitForFunction(() => window.fixtureSends.length === 1)
    assert.deepEqual(await page.evaluate(() => window.fixtureSends[0].attachments.map(item => item.file.name)), ['first.pdf', 'second.pdf'])
    assert.equal(await page.evaluate(() => window.fixtureSends[0].text), state.draft)
  }))
}

for (const spec of browsers) {
  test(`${spec.name} preserves unselected attachments at pointer-selection boundaries`, async () => withBrowser(spec, async page => {
    const editor = '[role="textbox"][aria-label="Message"]'
    const insertFile = async name => page.evaluate(name => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['pdf'], name, { type: 'application/pdf' }))
      const input = document.querySelector('#file-upload')
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, name)
    const textBoxes = () => page.evaluate(() => {
      const editorNode = window.fixtureEditor()
      const walker = document.createTreeWalker(editorNode, NodeFilter.SHOW_TEXT)
      const texts = []
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.parentElement.closest('[contenteditable="false"]') && text.nodeValue) texts.push(text)
      }
      const textBox = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON() }
      return {
        left: textBox(texts.find(node => node.data === 'left')),
        right: textBox(texts.find(node => node.data === 'right')),
        label: editorNode.querySelector('[data-composer-block-open]').getBoundingClientRect().toJSON(),
      }
    })
    // A drag that ends on the near half of a block stops at the block boundary.
    const selectWithMouse = async direction => {
      const boxes = await textBoxes()
      const from = direction === 'forward'
        ? { x: boxes.left.x + 10, y: boxes.left.y + boxes.left.height / 2 }
        : { x: boxes.right.right - 2, y: boxes.right.y + boxes.right.height / 2 }
      const to = { x: boxes.label.x + boxes.label.width * (direction === 'forward' ? 0.25 : 0.75), y: boxes.label.y + boxes.label.height / 2 }
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 30 })
      await page.mouse.up()
      return page.evaluate(() => ({
        text: getSelection().toString(),
        attachmentSelected: !!window.fixtureEditor().querySelector('[data-composer-attachment-ref][data-composer-block-selected]'),
      }))
    }
    const prepareSession = async id => {
      await openSession(page, id)
      await page.type(editor, 'left')
      await insertFile('base.pdf')
      await page.type(editor, 'right')
    }
    const pasted = 'p'.repeat(2000)

    await prepareSession('fixture/native-forward-boundary')
    const forwardSelection = await selectWithMouse('forward')
    assert.ok(forwardSelection.text.length > 0)
    assert.equal('left'.endsWith(forwardSelection.text), true, JSON.stringify(forwardSelection))
    assert.equal(forwardSelection.attachmentSelected, false)
    await page.evaluate(text => window.fixturePaste(text), pasted)
    const forwardDraft = `${'left'.slice(0, -forwardSelection.text.length)}<pasted-text>${pasted}</pasted-text><attachment-ref ref="attachment1" />right`
    assert.equal(await page.evaluate(() => window.fixtureDraft), forwardDraft)
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'left<attachment-ref ref="attachment1" />right')
    await redo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), forwardDraft)
    await page.evaluate(() => { window.fixtureAccept = true })
    await pressWithControl(page, 'Enter')
    await page.waitForFunction(() => window.fixtureSends.length === 1)
    assert.equal(await page.evaluate(() => window.fixtureSends[0].text), forwardDraft)
    assert.deepEqual(await page.evaluate(() => window.fixtureSends[0].attachments.map(item => ({ ref: item.ref, name: item.file.name }))), [{ ref: 'attachment1', name: 'base.pdf' }])

    await prepareSession('fixture/native-backward-boundary')
    const backwardSelection = await selectWithMouse('backward')
    assert.ok(backwardSelection.text.length > 0)
    assert.equal('right'.startsWith(backwardSelection.text), true, JSON.stringify(backwardSelection))
    assert.equal(backwardSelection.attachmentSelected, false)
    await page.evaluate(text => window.fixturePaste(text), pasted)
    assert.equal(await page.evaluate(() => window.fixtureDraft), `left<attachment-ref ref="attachment1" /><pasted-text>${pasted}</pasted-text>${'right'.slice(backwardSelection.text.length)}`)

    await prepareSession('fixture/native-full-chip')
    const boxes = await textBoxes()
    await page.mouse.move(boxes.left.x + 10, boxes.left.y + boxes.left.height / 2)
    await page.mouse.down()
    await page.mouse.move(boxes.right.x + 20, boxes.right.y + boxes.right.height / 2, { steps: 30 })
    await page.mouse.up()
    assert.equal(await page.$eval('[data-composer-attachment-ref]', node => node.hasAttribute('data-composer-block-selected')), true)
    const covered = await page.evaluate(() => {
      const { from, to } = window.fixtureView().state.selection.main
      return { leftOffset: from, rightOffset: to - window.fixtureChips()[0].to }
    })
    await page.evaluate(text => window.fixturePaste(text), pasted)
    assert.equal(await page.evaluate(() => window.fixtureDraft), `${'left'.slice(0, covered.leftOffset)}<pasted-text>${pasted}</pasted-text>${'right'.slice(covered.rightOffset)}`)
    assert.equal(await page.$$eval('[data-composer-attachment-ref]', nodes => nodes.length), 0)
  }))
}

for (const spec of browsers) {
  test(`${spec.name} inserts structured blocks at block boundaries, never inside blocks`, async () => withBrowser(spec, async page => {
    const insertFile = async (name, method) => page.evaluate((name, method) => {
      const editor = window.fixtureEditor()
      const transfer = new DataTransfer()
      transfer.items.add(new File(['pdf'], name, { type: 'application/pdf' }))
      if (method === 'drop') {
        const label = editor.querySelector('[data-composer-block-open]')
        const box = label.getBoundingClientRect()
        label.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer,
          clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }))
      } else {
        const input = document.querySelector('#file-upload')
        input.files = transfer.files
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }, name, method)
    await insertFile('first.pdf', 'picker')
    await page.evaluate(() => window.fixtureSelect(0))
    await insertFile('leading.pdf', 'picker')
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).segments.map(segment => segment.name)), ['leading.pdf', 'first.pdf'])
    await page.evaluate(() => window.fixtureSelect(0))
    const pasted = 'large pasted text '.repeat(200)
    await page.evaluate(text => window.fixturePaste(text), pasted)
    assert.equal(await page.$$eval('[data-composer-pasted-text-id]', chips => chips.length), 1)
    await insertFile('over-chip.pdf', 'drop')
    const segments = await page.evaluate(() => JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).segments)
    assert.equal(segments.length, 4)
    assert.equal(segments.filter(segment => segment.type === 'pasted-text')[0].text, pasted)
    assert.deepEqual(segments.filter(segment => segment.type === 'attachment').map(segment => segment.name).sort(), ['first.pdf', 'leading.pdf', 'over-chip.pdf'])
    assert.equal(await page.$$eval('[data-composer-attachment-ref] [data-composer-attachment-ref], [data-composer-pasted-text-id] [data-composer-attachment-ref], [data-composer-attachment-ref] [data-composer-pasted-text-id]', nodes => nodes.length), 0)
    await page.evaluate(() => window.fixtureSetLoading(true))
    await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'false')
    await insertFile('blocked.pdf', 'picker')
    await page.evaluate(() => window.fixtureSetLoading(false))
    await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'true')
    await insertFile('allowed.pdf', 'picker')
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('composer_draft_v1_fixture/main')).segments.find(segment => segment.type === 'attachment' && segment.name === 'allowed.pdf')), {
      type: 'attachment', ref: 'attachment4', name: 'allowed.pdf', mimeType: 'application/pdf', size: 3,
    })
  }))
}

for (const spec of browsers) {
  test(`${spec.name} paints the caret in the theme text color, or the console accent`, async () => withBrowser(spec, async page => {
    // The editor library's own default caret is black regardless of theme.
    await page.evaluate(() => window.fixtureInitializeTheme())
    for (const [colorMode, console] of [['light', false], ['dark', false], ['dark', true], ['light', true]]) {
      const colors = await page.evaluate(({ colorMode, console }) => {
        document.documentElement.classList.toggle('dark', colorMode === 'dark')
        if (console) document.documentElement.setAttribute('data-foxwarm-component-treatment', 'console')
        else document.documentElement.removeAttribute('data-foxwarm-component-treatment')
        const editor = window.fixtureEditor()
        const probe = document.createElement('span')
        probe.style.color = 'var(--foxwarm-console-accent)'
        document.body.append(probe)
        const accent = getComputedStyle(probe).color
        probe.remove()
        return { caret: getComputedStyle(editor).caretColor, text: getComputedStyle(editor).color, accent }
      }, { colorMode, console })
      assert.equal(colors.caret, console ? colors.accent : colors.text, `${colorMode} ${console ? 'console' : 'standard'}: ${JSON.stringify(colors)}`)
    }
  }))
}

for (const spec of browsers) {
  test(`${spec.name} keeps pasted images aligned with atomic caret boundaries`, async () => withBrowser(spec, async page => {
    await page.evaluate(() => window.fixtureInitializeTheme())
    const editor = '[role="textbox"][aria-label="Message"]'
    const pasteImages = count => page.evaluate(count => {
      const canvas = document.createElement('canvas')
      canvas.width = 32; canvas.height = 32
      const context = canvas.getContext('2d')
      context.fillStyle = '#3978c6'; context.fillRect(0, 0, 32, 32)
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0))
      window.fixturePasteFiles(Array.from({ length: count }, (_, index) => new File([bytes], `image-${index + 1}.png`, { type: 'image/png' })))
    }, count)
    await page.click(editor)
    await pasteImages(1)
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('ordinary text')
    const geometry = await page.$eval(editor, node => {
      const [firstLine, secondLine] = node.querySelectorAll('.cm-line')
      const chip = node.querySelector('[data-composer-attachment-ref]')
      const text = secondLine.firstChild
      const range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 2)
      const firstRange = document.createRange(); firstRange.setStart(text, 0); firstRange.setEnd(text, 1)
      const toolbar = node.closest('form').querySelector('button[type="submit"]').parentElement
      return {
        contentLeft: firstLine.getBoundingClientRect().left + parseFloat(getComputedStyle(firstLine).paddingLeft),
        textLeft: firstRange.getBoundingClientRect().left,
        chipLeft: chip.getBoundingClientRect().left,
        chipMargin: parseFloat(getComputedStyle(chip).marginLeft),
        contentPadding: getComputedStyle(node).padding,
        linePadding: getComputedStyle(firstLine).padding,
        toolbarPadding: getComputedStyle(toolbar).padding,
      }
    })
    assert.equal(geometry.textLeft, geometry.contentLeft)
    assert.ok(Math.abs(geometry.chipLeft - geometry.contentLeft - geometry.chipMargin) < 0.5, JSON.stringify(geometry))
    assert.equal(geometry.contentPadding, '8px 16px')
    assert.equal(geometry.linePadding, '0px')
    assert.equal(geometry.toolbarPadding, '0px 8px 4px')
    const first = '<attachment-ref ref="attachment1" />'
    const original = first + '\nordinary text'
    assert.equal(await page.evaluate(() => window.fixtureDraft), original)
    if (process.env.FOXWARM_COMPOSER_SCREENSHOT_DIR) {
      console.log(spec.name, 'image geometry', JSON.stringify(geometry))
      await page.screenshot({ path: path.join(process.env.FOXWARM_COMPOSER_SCREENSHOT_DIR, `${spec.name}-image-after.png`) })
    }
    await clickBesideChip(page, 0, 'before')
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft')
    await page.keyboard.type('prefix ')
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'prefix ' + original)
    await undo(page)
    await clickBesideChip(page, 0, 'before')
    await page.keyboard.press('Delete')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\nordinary text')
    await undo(page)
    await clickBesideChip(page, 0, 'before')
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), '\nordinary text')
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), original)

    await page.evaluate(() => window.fixtureSelectAll())
    await pasteImages(2)
    const refs = await page.$$eval('[data-composer-attachment-ref]', chips => chips.map(chip => `<attachment-ref ref="${chip.dataset.composerAttachmentRef}" />`))
    const exact = refs.join('')
    const clickBetween = async () => {
      const point = await page.evaluate(() => {
        const [a, b] = [...document.querySelectorAll('[data-composer-attachment-ref]')].map(chip => chip.getBoundingClientRect())
        return { x: (a.right + b.left) / 2, y: a.top + a.height / 2 }
      })
      await page.mouse.click(point.x, point.y)
    }
    await clickBetween()
    await page.evaluate(() => window.fixturePaste(' '))
    assert.equal(await page.evaluate(() => window.fixtureDraft), refs.join(' '), 'literal clipboard spaces survive between adjacent images')
    await undo(page)
    await clickBetween()
    await page.keyboard.press('Backspace')
    assert.equal(await page.evaluate(() => window.fixtureDraft), refs[1])
    await undo(page)
    await clickBetween()
    await page.keyboard.press('Delete')
    assert.equal(await page.evaluate(() => window.fixtureDraft), refs[0])
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), exact)
    await clickBetween()
    await page.keyboard.press('Enter')
    await clickBesideChip(page, 1, 'after')
    await page.keyboard.press('Home')
    await page.keyboard.type('line ')
    assert.equal(await page.evaluate(() => window.fixtureDraft), refs[0] + '\nline ' + refs[1])
    await undo(page)
    assert.equal(await page.evaluate(() => window.fixtureDraft), refs[0] + '\n' + refs[1])
  }))
}

if (chromiumSpec) test('Chromium shows the CLI model and estimate without a Foxwarm current-model picker', async () => withBrowser(chromiumSpec, async page => {
  assert.equal(await page.$$('.foxwarm-model-selector-root').then(elements => elements.length), 1)
  await page.evaluate(() => window.fixtureSetRuntime('claude-code'))
  await page.waitForFunction(() => document.body.innerText.includes('cli-observed-model'))
  assert.equal(await page.$('.foxwarm-model-selector-root'), null)
  assert.ok(await page.evaluate(() => document.body.innerText.includes('$1.2500')))
  assert.equal(await page.$('[role="textbox"]') !== null, true)
}))

for (const spec of browsers) {
  test(`${spec.name} update reload flushes text and blocks storage failure, attachments and in-flight sends`, async () => withBrowser(spec, async page => {
    const prepare = () => page.evaluate(() => window.dispatchEvent(new Event('foxwarm-before-update-reload', { cancelable: true })))
    await page.type('[role="textbox"][aria-label="Message"]', 'Keep this draft')
    assert.equal(await prepare(), true)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'Keep this draft')
    await page.evaluate(() => {
      window.restoreDraftStorage = Storage.prototype.setItem
      Storage.prototype.setItem = () => { throw new Error('Storage unavailable') }
    })
    assert.equal(await prepare(), false)
    await page.evaluate(() => { Storage.prototype.setItem = window.restoreDraftStorage })
    assert.equal(await prepare(), true)

    await page.evaluate(() => { window.fixtureHoldSend = true; window.fixtureAccept = false })
    await page.click('button[aria-label="Send message"]')
    await page.waitForFunction(() => !!window.fixtureReleaseSend)
    assert.equal(await prepare(), false)
    await page.evaluate(() => window.fixtureReleaseSend())
    await settleSend(page)
    assert.equal(await prepare(), true)

    await page.$eval('#file-upload', input => {
      const data = new DataTransfer(); data.items.add(new File(['bytes'], 'keep.txt', { type: 'text/plain' }))
      Object.defineProperty(input, 'files', { configurable: true, value: data.files })
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForSelector('.foxwarm-composer-attachment-chip')
    assert.equal(await prepare(), false)
    assert.match(await page.evaluate(() => localStorage.getItem('composer_draft_v1_fixture/main')), /keep\.txt/)
  }))

  test(`${spec.name} update reload blocks microphone capture and final transcription`, async () => withBrowser(spec, async page => {
    const prepare = () => page.evaluate(() => window.dispatchEvent(new Event('foxwarm-before-update-reload', { cancelable: true })))
    await page.click('button[aria-label="Start recording"]')
    await page.waitForFunction(() => window.fixtureStreamSessions.length === 1)
    assert.equal(await prepare(), false)
    await page.click('button[aria-label="Stop recording and transcribe"]')
    await page.waitForFunction(() => window.fixtureStreamSessions[0].stopped)
    assert.equal(await prepare(), false)
    await page.evaluate(() => window.fixtureStreamSessions[0].callbacks.onFinal('Saved transcript'))
    await page.waitForFunction(() => window.fixtureEditor()?.contentEditable === 'true')
    assert.equal(await prepare(), true)
    assert.equal(await page.evaluate(() => window.fixtureDraft), 'Saved transcript')
  }))
}

if (chromiumSpec) test('Chromium update reload saves pending DOM composition before leaving', async () => withBrowser(chromiumSpec, async page => {
  const client = await page.createCDPSession()
  await page.click('[role="textbox"][aria-label="Message"]')
  await client.send('Input.imeSetComposition', { text: '保存', selectionStart: 2, selectionEnd: 2 })
  assert.equal(await page.evaluate(() => window.fixtureDraft || ''), '')
  assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('foxwarm-before-update-reload', { cancelable: true }))), true)
  assert.equal(await page.evaluate(() => window.fixtureDraft), '保存')
  await client.detach()
}))
