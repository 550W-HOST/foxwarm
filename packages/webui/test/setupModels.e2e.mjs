import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const port = 4176
const baseUrl = `http://127.0.0.1:${port}`
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'

let vite
let preview
let productionBaseUrl
let browser
let page
let savedRequest
let savedRequestPath
let saveError = null
const requestPaths = []
const modelUpdateRequests = []

const statusPayload = {
  oobe: false,
  models: {
    exists: true,
    path: 'state/models.yaml',
    templatePath: 'templates/models.example.yaml',
    providerCount: 3,
    defaultModel: 'route',
    rawYaml: 'default: 42\nproviders:\n  route:\n    providerType: failover\n    targets: [leaf/model-a]\n',
    providers: [
      {
        id: 'leaf',
        providerType: 'openai-completions',
        isVirtual: false,
        baseUrl: 'https://example.test/v1',
        apiKey: 'secret',
        models: 'model-a\nmodel-b',
        defaultModel: 'model-a',
        targets: [],
        failureThreshold: null,
        cooldownMs: null,
      },
      {
        id: 'sticky',
        providerType: 'session-hash',
        isVirtual: true,
        baseUrl: '',
        apiKey: '',
        models: '',
        defaultModel: '',
        targets: ['leaf/model-a'],
        failureThreshold: null,
        cooldownMs: null,
      },
      {
        id: 'route',
        providerType: 'failover',
        isVirtual: true,
        baseUrl: '',
        apiKey: '',
        models: '',
        defaultModel: '',
        targets: ['leaf/model-a', 'leaf/model-b'],
        failureThreshold: 5,
        cooldownMs: 600000,
      },
    ],
    hasPlaceholderSecrets: false,
    placeholderProviders: [],
  },
  config: {
    appConfigPath: 'state/config.yaml',
    rawYaml: '',
    channelsYaml: '',
    channelCount: 0,
  },
  channels: [],
}

async function waitForServer(targetBaseUrl = baseUrl) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(targetBaseUrl)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite dev server did not start')
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitForProcess(child, label) {
  const [code, signal] = await new Promise((resolve) => {
    child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]))
  })
  if (code !== 0) throw new Error(`${label} failed with code ${code ?? signal}`)
}

function respondJson(request, body, status = 200) {
  return request.respond({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function attachRequestMocks(targetPage, options = {}) {
  await targetPage.setRequestInterception(true)
  targetPage.on('request', (request) => {
    const url = new URL(request.url())
    requestPaths.push(url.pathname)
    if (options.blockEditorChunks && /(monaco-editor|monaco-yaml|yaml\.worker|editor\.worker)/.test(url.pathname)) {
      void request.abort('failed')
      return
    }
    if (!url.pathname.includes('/api/')) {
      void request.continue()
      return
    }
    if (url.pathname.endsWith('/api/setup/status')) {
      void respondJson(request, options.oobe
        ? { ...statusPayload, oobe: true, models: { ...statusPayload.models, exists: false, rawYaml: '' } }
        : statusPayload)
      return
    }
    if (url.pathname.endsWith('/api/models')) {
      void respondJson(request, {
        defaultKey: 'route',
        currentKey: 'route',
        models: [
          { key: 'leaf/model-a', label: 'leaf/model-a', isVirtual: false },
          { key: 'leaf/model-b', label: 'leaf/model-b', isVirtual: false },
          { key: 'sticky', label: 'sticky', isVirtual: true },
          { key: 'route', label: 'route', isVirtual: true },
        ],
      })
      return
    }
    if (url.pathname.endsWith('/api/setup/models') && request.method() === 'POST') {
      savedRequestPath = url.pathname
      savedRequest = JSON.parse(request.postData() || '{}')
      if (saveError) {
        void respondJson(request, { error: saveError }, 400)
      } else {
        void respondJson(request, { success: true, models: { ...statusPayload.models, rawYaml: savedRequest.yaml } })
      }
      return
    }
    if (/\/api\/sessions\/[^/]+\/model$/.test(url.pathname) && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      modelUpdateRequests.push({ path: url.pathname, body })
      void respondJson(request, {
        id: decodeURIComponent(url.pathname.split('/').at(-2) || ''),
        model: body.model || null,
        modelKey: body.model || 'route',
        defaultModelKey: 'route',
      })
      return
    }
    if (url.pathname.endsWith('/api/sessions')) {
      void respondJson(request, { sessions: [] })
      return
    }
    if (url.pathname.endsWith('/api/agents')) {
      void respondJson(request, { agents: [] })
      return
    }
    if (url.pathname.endsWith('/api/terminals')) {
      void respondJson(request, { terminals: [] })
      return
    }
    if (url.pathname.endsWith('/api/webui/settings')) {
      void respondJson(request, {})
      return
    }
    void respondJson(request, {})
  })
}

async function runMonacoEditorAction(targetPage, modelUri, action, payload = {}) {
  return targetPage.evaluate(async ({ targetModelUri, editorAction, actionPayload }) => {
    const monacoUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/node_modules\/\.vite\/deps\/monaco-editor\.js(?:\?|$)/.test(name))
    if (!monacoUrl) throw new Error('Monaco module URL was not loaded')
    const monaco = await import(monacoUrl)
    const editor = monaco.editor.getEditors().find((candidate) => candidate.getModel()?.uri.toString() === targetModelUri)
    if (!editor) throw new Error(`Monaco editor not found: ${targetModelUri}`)

    if (editorAction === 'replace-value') {
      editor.getModel().setValue(actionPayload.value)
    } else if (editorAction === 'select') {
      const { anchorLine, anchorColumn, activeLine, activeColumn } = actionPayload
      editor.setSelection(new monaco.Selection(anchorLine, anchorColumn, activeLine, activeColumn))
      editor.focus()
    } else if (editorAction === 'position') {
      editor.setPosition({ lineNumber: actionPayload.line, column: actionPayload.column })
      editor.focus()
    } else if (editorAction === 'focus') {
      editor.focus()
    } else if (editorAction === 'screen-position') {
      const visiblePosition = editor.getScrolledVisiblePosition({ lineNumber: actionPayload.line, column: actionPayload.column })
      const editorRect = editor.getDomNode()?.getBoundingClientRect()
      if (!visiblePosition || !editorRect) throw new Error('Editor position is not visible')
      return {
        x: editorRect.left + visiblePosition.left,
        y: editorRect.top + visiblePosition.top + visiblePosition.height / 2,
      }
    }

    const selection = editor.getSelection()
    return {
      value: editor.getValue(),
      direction: selection?.getDirection(),
      rtlDirection: monaco.SelectionDirection.RTL,
      ltrDirection: monaco.SelectionDirection.LTR,
      selection: selection ? {
        startLineNumber: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber,
        endColumn: selection.endColumn,
        positionLineNumber: selection.positionLineNumber,
        positionColumn: selection.positionColumn,
        selectionStartLineNumber: selection.selectionStartLineNumber,
        selectionStartColumn: selection.selectionStartColumn,
      } : null,
    }
  }, { targetModelUri: modelUri, editorAction: action, actionPayload: payload })
}

before(async () => {
  const viteBin = path.join(webuiRoot, 'node_modules/.bin/vite')
  await waitForProcess(spawn(viteBin, ['build'], {
    cwd: webuiRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  }), 'production WebUI build')

  const previewPort = await getFreePort()
  productionBaseUrl = `http://127.0.0.1:${previewPort}`
  preview = spawn(viteBin, ['preview', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'], {
    cwd: webuiRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await waitForServer(productionBaseUrl)

  vite = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port)], {
    cwd: webuiRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  await waitForServer()

  browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  page = await browser.newPage()
  await page.setBypassServiceWorker(true)
  await attachRequestMocks(page)

  await page.goto(`${baseUrl}/preview/#setup`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.textContent?.includes('Foxwarm Setup'), { timeout: 15_000 })
  await page.waitForSelector('[data-monaco-model-uri][data-editor-ready="true"]', { timeout: 15_000 })
})

after(async () => {
  await browser?.close()
  vite?.kill('SIGTERM')
  preview?.kill('SIGTERM')
})

test('Models setup is raw-only and associates distinct static schemas with both editors', async () => {
  const bodyText = await page.$eval('body', (body) => body.textContent || '')
  assert.equal(bodyText.includes('Test selected provider'), false)
  assert.equal(bodyText.includes('Provider 1'), false)
  assert.equal(await page.$('button::-p-text(Form)'), null)

  const editorUris = await page.$$eval('[data-monaco-model-uri]', (elements) => elements.map((element) => element.getAttribute('data-monaco-model-uri')))
  assert.deepEqual(editorUris.sort(), [
    'inmemory://foxwarm/setup/foxwarm-config.yaml',
    'inmemory://foxwarm/setup/foxwarm-models.yaml',
  ])
  assert.ok(requestPaths.includes('/preview/api/setup/status'))
})

test('both Setup editors use the responsive 600px/80vh height without mobile overflow', async () => {
  const measureEditors = (targetPage) => targetPage.$$eval('[data-monaco-model-uri]', (editors) => editors.map((editor) => {
    const rect = editor.getBoundingClientRect()
    return {
      authoredHeight: editor.style.height,
      computedHeight: Number.parseFloat(getComputedStyle(editor).height),
      width: rect.width,
      viewportWidth: window.innerWidth,
      expectedHeight: Math.min(600, window.innerHeight * 0.8),
      documentWidth: document.documentElement.scrollWidth,
    }
  }))

  const desktopEditors = await measureEditors(page)
  assert.equal(desktopEditors.length, 2)
  for (const editor of desktopEditors) {
    assert.ok(['calc(min(600px, 80vh))', 'min(600px, 80vh)'].includes(editor.authoredHeight))
    assert.ok(Math.abs(editor.computedHeight - editor.expectedHeight) < 1)
    assert.ok(editor.width <= editor.viewportWidth)
  }

  const mobilePage = await browser.newPage()
  await mobilePage.setViewport({ width: 390, height: 700 })
  await attachRequestMocks(mobilePage)
  try {
    await mobilePage.goto(`${baseUrl}/mobile/#setup`, { waitUntil: 'networkidle2' })
    await mobilePage.waitForSelector('[data-monaco-model-uri][data-editor-ready="true"]', { timeout: 15_000 })
    const mobileEditors = await measureEditors(mobilePage)
    assert.equal(mobileEditors.length, 2)
    for (const editor of mobileEditors) {
      assert.ok(Math.abs(editor.computedHeight - 560) < 1)
      assert.ok(editor.width <= editor.viewportWidth)
      assert.ok(editor.documentWidth <= editor.viewportWidth)
    }
  } finally {
    await mobilePage.close()
  }
})

test('both Setup Monaco editors replace forward and reverse selections on the first typed key', async () => {
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  const configUri = 'inmemory://foxwarm/setup/foxwarm-config.yaml'
  const modelsBaseline = 'alpha beta\nsecond line\nthird line\n'
  const configBaseline = 'alpha beta\nsecond line\nthird line\n'

  const originalModels = (await runMonacoEditorAction(page, modelsUri, 'snapshot')).value
  const originalConfig = (await runMonacoEditorAction(page, configUri, 'snapshot')).value
  const dragStart = await runMonacoEditorAction(page, modelsUri, 'screen-position', { line: 1, column: 12 })
  const dragEnd = await runMonacoEditorAction(page, modelsUri, 'screen-position', { line: 1, column: 10 })
  await page.mouse.move(dragStart.x, dragStart.y)
  await page.mouse.down()
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 })
  await page.mouse.up()
  let state = await runMonacoEditorAction(page, modelsUri, 'snapshot')
  assert.equal(state.direction, state.rtlDirection)
  await page.keyboard.press('x')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal((await runMonacoEditorAction(page, modelsUri, 'snapshot')).value, originalModels.replace('42', 'x'))

  await runMonacoEditorAction(page, modelsUri, 'replace-value', { value: modelsBaseline })
  await new Promise((resolve) => setTimeout(resolve, 100))
  state = await runMonacoEditorAction(page, modelsUri, 'select', {
    anchorLine: 1, anchorColumn: 1, activeLine: 1, activeColumn: 6,
  })
  assert.equal(state.direction, state.ltrDirection)
  await page.keyboard.type('F')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, modelsUri, 'snapshot')).value, 'F beta\nsecond line\nthird line\n')

  await runMonacoEditorAction(page, configUri, 'replace-value', { value: configBaseline })
  await new Promise((resolve) => setTimeout(resolve, 100))
  state = await runMonacoEditorAction(page, configUri, 'select', {
    anchorLine: 3, anchorColumn: 6, activeLine: 2, activeColumn: 1,
  })
  assert.equal(state.direction, state.rtlDirection)
  await page.keyboard.type('Y')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, configUri, 'snapshot')).value, 'alpha beta\nY line\n')

  await runMonacoEditorAction(page, configUri, 'replace-value', { value: 'abcd\n' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await runMonacoEditorAction(page, configUri, 'position', { line: 1, column: 4 })
  await page.keyboard.down('Shift')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.up('Shift')
  state = await runMonacoEditorAction(page, configUri, 'snapshot')
  assert.equal(state.direction, state.rtlDirection)
  await page.keyboard.type('Z')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, configUri, 'snapshot')).value, 'aZd\n')

  await runMonacoEditorAction(page, configUri, 'position', { line: 1, column: 4 })
  await page.keyboard.type('!')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, configUri, 'snapshot')).value, 'aZd!\n')

  const externallyResetModels = 'default: 42\nproviders:\n  local: {}\n'
  await runMonacoEditorAction(page, modelsUri, 'replace-value', { value: externallyResetModels })
  await new Promise((resolve) => setTimeout(resolve, 100))
  state = await runMonacoEditorAction(page, modelsUri, 'select', {
    anchorLine: 1, anchorColumn: 12, activeLine: 1, activeColumn: 10,
  })
  assert.equal(state.direction, state.rtlDirection)
  await page.click('button::-p-text(Refresh)')
  await page.waitForFunction(() => !document.body.textContent?.includes('Loading setup status…'))
  await page.waitForFunction(async ({ modelsModelUri, configModelUri, expectedModels, expectedConfig }) => {
    const monacoUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/node_modules\/\.vite\/deps\/monaco-editor\.js(?:\?|$)/.test(name))
    if (!monacoUrl) return false
    const monaco = await import(monacoUrl)
    const editors = monaco.editor.getEditors()
    return editors.find((editor) => editor.getModel()?.uri.toString() === modelsModelUri)?.getValue() === expectedModels
      && editors.find((editor) => editor.getModel()?.uri.toString() === configModelUri)?.getValue() === expectedConfig
  }, {}, { modelsModelUri: modelsUri, configModelUri: configUri, expectedModels: statusPayload.models.rawYaml, expectedConfig: originalConfig })
  state = await runMonacoEditorAction(page, modelsUri, 'snapshot')
  assert.equal(state.direction, state.rtlDirection)
  assert.deepEqual(state.selection, {
    startLineNumber: 1,
    startColumn: 10,
    endLineNumber: 1,
    endColumn: 12,
    positionLineNumber: 1,
    positionColumn: 10,
    selectionStartLineNumber: 1,
    selectionStartColumn: 12,
  })
  await runMonacoEditorAction(page, modelsUri, 'focus')
  await page.keyboard.press('r')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, modelsUri, 'snapshot')).value, statusPayload.models.rawYaml.replace('42', 'r'))
  await page.click('button::-p-text(Refresh)')
  await page.waitForFunction(async ({ modelUri, expectedValue }) => {
    const monacoUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/node_modules\/\.vite\/deps\/monaco-editor\.js(?:\?|$)/.test(name))
    if (!monacoUrl) return false
    const monaco = await import(monacoUrl)
    return monaco.editor.getEditors().find((editor) => editor.getModel()?.uri.toString() === modelUri)?.getValue() === expectedValue
  }, {}, { modelUri: modelsUri, expectedValue: statusPayload.models.rawYaml })
})

test('schema markers remain advisory and do not disable raw save', async () => {
  await page.waitForFunction(() => {
    const editor = document.querySelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]')
    return Number(editor?.getAttribute('data-marker-count') || 0) > 0
  }, { timeout: 15_000 })

  const saveButton = await page.waitForSelector('button::-p-text(Save models)')
  assert.equal(await saveButton.evaluate((button) => button.disabled), false)
  await saveButton.click()
  await page.waitForFunction(() => document.body.textContent?.includes('Models saved to'))
  assert.deepEqual(savedRequest, { yaml: statusPayload.models.rawYaml })
  assert.equal(savedRequestPath, '/preview/api/setup/models')
})

test('production worker provides real schema markers and current-document completions', async () => {
  const productionPage = await browser.newPage()
  await productionPage.setBypassServiceWorker(true)
  await attachRequestMocks(productionPage)
  try {
    await productionPage.goto(`${productionBaseUrl}/#setup`, { waitUntil: 'networkidle2' })
    const modelEditor = '[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]'
    await productionPage.waitForFunction((selector) => {
      const editor = document.querySelector(selector)
      return editor?.getAttribute('data-editor-ready') === 'true'
        && editor?.getAttribute('data-editor-fallback') !== 'true'
        && Number(editor?.getAttribute('data-marker-count') || 0) > 0
    }, { timeout: 20_000 }, modelEditor)

    const editorSurface = await productionPage.waitForSelector(`${modelEditor} .view-lines`, { visible: true })
    await editorSurface.click({ offset: { x: 90, y: 10 } })
    await productionPage.keyboard.press('Space')
    await productionPage.waitForSelector('.suggest-widget.visible .monaco-list-row', { timeout: 10_000 })
    const suggestions = await productionPage.$$eval('.suggest-widget.visible .monaco-list-row', (rows) => rows.map((row) => row.textContent || ''))
    assert.ok(suggestions.some((label) => label.includes('route')))
  } finally {
    await productionPage.close()
  }
})

test('backend validation error remains final authority and is shown after Monaco diagnostics', async () => {
  saveError = 'canonical backend rejected the models config'
  const saveButton = await page.waitForSelector('button::-p-text(Save models)')
  await saveButton.click()
  await page.waitForFunction(() => document.body.textContent?.includes('canonical backend rejected the models config'))
  assert.deepEqual(savedRequest, { yaml: statusPayload.models.rawYaml })
  saveError = null
})

test('OOBE remains editable and savable when lazy Monaco/YAML support import rejects', async () => {
  const degradedPage = await browser.newPage()
  await degradedPage.setCacheEnabled(false)
  await attachRequestMocks(degradedPage, { blockEditorChunks: true, oobe: true })
  try {
    await degradedPage.goto(`${baseUrl}/degraded/#setup`, { waitUntil: 'networkidle2' })
    const fallback = await degradedPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-fallback="true"] textarea', { timeout: 15_000 })
    assert.ok((await degradedPage.$eval('body', (body) => body.textContent || '')).includes('Plain-text editing and backend validation still work.'))
    const fallbackHeights = await degradedPage.$$eval('[data-editor-fallback="true"]', (editors) => editors.map((editor) => ({
      height: Number.parseFloat(getComputedStyle(editor).height),
      expected: Math.min(600, window.innerHeight * 0.8),
    })))
    assert.equal(fallbackHeights.length, 2)
    assert.ok(fallbackHeights.every(({ height, expected }) => Math.abs(height - expected) < 1))

    const initialYaml = 'default: local\nproviders:\n  local:\n    providerType: openai-completions\n    models: [model-a]\n'
    await fallback.evaluate((textarea, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }, initialYaml)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await fallback.evaluate((textarea) => {
      textarea.focus()
      textarea.setSelectionRange(9, 14, 'backward')
    })
    await degradedPage.keyboard.press('x')
    const yaml = initialYaml.replace('local', 'x')
    await degradedPage.click('button::-p-text(Save models)')
    await degradedPage.waitForFunction(() => document.body.textContent?.includes('Models saved to'))
    assert.deepEqual(savedRequest, { yaml })
  } finally {
    await degradedPage.close()
  }
})

test('embedded model filter selects one result and keeps the accessible Setup bridge', async () => {
  const hostPage = await browser.newPage()
  await hostPage.setViewport({ width: 390, height: 700 })
  await attachRequestMocks(hostPage)
  const nonce = '0123456789abcdef0123456789abcdef'
  try {
    await hostPage.goto(`${baseUrl}/preview/host`, { waitUntil: 'networkidle2' })
    await hostPage.evaluate(() => {
      document.body.replaceChildren()
      window.embedMessages = []
      window.addEventListener('message', (event) => window.embedMessages.push(event.data))
    })
    await hostPage.evaluate(({ src }) => {
      const iframe = document.createElement('iframe')
      iframe.id = 'embedded-chat'
      iframe.src = src
      iframe.style.cssText = 'border:0;width:100vw;height:100vh'
      document.body.appendChild(iframe)
    }, { src: `${baseUrl}/preview/?foxwarmEmbed=chat&foxwarmEmbedNonce=${nonce}&sessionId=embedded%2Fchat` })
    const chatFrame = await hostPage.waitForFrame((frame) => frame.url().includes('foxwarmEmbed=chat'))
    const modelButton = await chatFrame.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
    await modelButton.click()
    const filter = await chatFrame.waitForSelector('input[aria-label="Filter models"]', { timeout: 15_000 })
    await chatFrame.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    assert.equal(await filter.evaluate((input) => input.value), '')

    const configure = await chatFrame.waitForSelector('button[aria-label="Configure models"]', { timeout: 15_000 })
    assert.equal((await configure.evaluate((button) => button.textContent || '')).trim(), '')
    assert.equal(await configure.evaluate((button) => button.title), 'Configure models')
    const popupLayout = await chatFrame.$eval('[data-model-selector-popup="true"]', (popup) => {
      const popupRect = popup.getBoundingClientRect()
      const settingsRect = popup.querySelector('button[aria-label="Configure models"]')?.getBoundingClientRect()
      const filterRect = popup.querySelector('input[aria-label="Filter models"]')?.getBoundingClientRect()
      return {
        left: popupRect.left,
        right: popupRect.right,
        viewportWidth: window.innerWidth,
        settingsRight: settingsRect?.right || 0,
        filterLeft: filterRect?.left || 0,
        filterRight: filterRect?.right || 0,
      }
    })
    assert.ok(popupLayout.left >= 0)
    assert.ok(popupLayout.right <= popupLayout.viewportWidth)
    assert.ok(popupLayout.settingsRight <= popupLayout.filterLeft)
    assert.ok(popupLayout.filterRight <= popupLayout.right)

    const updatesBefore = modelUpdateRequests.length
    await filter.type('LEAF')
    await chatFrame.waitForFunction(() => (
      document.querySelectorAll('button[title="leaf/model-a"], button[title="leaf/model-b"]').length === 2
    ))
    await filter.press('Enter')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(modelUpdateRequests.length, updatesBefore)
    assert.ok(await chatFrame.$('[data-model-selector-popup="true"]'))

    await filter.evaluate((input) => input.select())
    await filter.type('missing-model')
    await chatFrame.waitForFunction(() => !document.querySelector('button[title="sticky"], button[title="route"], button[title="leaf/model-a"], button[title="leaf/model-b"]'))
    await filter.press('Enter')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(modelUpdateRequests.length, updatesBefore)

    await filter.evaluate((input) => input.select())
    await filter.type('STICKY')
    await chatFrame.waitForSelector('button[title="sticky"]')
    await filter.evaluate((input) => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'STICKY' }))
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', isComposing: true }))
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'STICKY' }))
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(modelUpdateRequests.length, updatesBefore)

    await filter.press('Enter')
    const updateDeadline = Date.now() + 5_000
    while (modelUpdateRequests.length === updatesBefore && Date.now() < updateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.deepEqual(modelUpdateRequests.at(-1), {
      path: '/preview/api/sessions/embedded%2Fchat/model',
      body: { model: 'sticky' },
    })
    await chatFrame.waitForSelector('[data-model-selector-popup="true"]', { hidden: true })

    await modelButton.click()
    const reopenedFilter = await chatFrame.waitForSelector('input[aria-label="Filter models"]')
    await chatFrame.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    assert.equal(await reopenedFilter.evaluate((input) => input.value), '')
    assert.equal(await chatFrame.$$eval('button[title="leaf/model-a"], button[title="leaf/model-b"], button[title="sticky"], button[title="route"]', (buttons) => buttons.length), 4)
    const reopenedConfigure = await chatFrame.waitForSelector('button[aria-label="Configure models"]')
    await reopenedConfigure.click()
    await hostPage.waitForFunction(() => window.embedMessages.some((message) => message?.type === 'open-setup'))
    const openSetupMessage = await hostPage.evaluate(() => window.embedMessages.find((message) => message?.type === 'open-setup'))
    assert.deepEqual(openSetupMessage, {
      channel: 'foxwarm-webui-embed', version: 1, nonce, type: 'open-setup', focus: 'models',
    })

    await hostPage.evaluate(({ src }) => {
      document.getElementById('embedded-chat')?.remove()
      const iframe = document.createElement('iframe')
      iframe.id = 'embedded-setup'
      iframe.src = src
      document.body.appendChild(iframe)
    }, { src: `${baseUrl}/preview/?foxwarmEmbed=setup&foxwarmEmbedNonce=${nonce}` })
    const setupFrame = await hostPage.waitForFrame((frame) => frame.url().includes('foxwarmEmbed=setup'))
    await setupFrame.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-ready="true"]', { timeout: 15_000 })
    await hostPage.evaluate(({ nonce: bridgeNonce }) => {
      const iframe = document.getElementById('embedded-setup')
      iframe?.contentWindow?.postMessage({ channel: 'foxwarm-webui-host', version: 1, nonce: bridgeNonce, type: 'focus-models' }, '*')
    }, { nonce })
    await setupFrame.waitForFunction(() => !!document.activeElement?.closest('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]'), { timeout: 15_000 })
  } finally {
    await hostPage.close()
  }
})

test('normal Chat keeps the icon-only model settings callback and singleton Setup focus', async () => {
  const normalPage = await browser.newPage()
  await attachRequestMocks(normalPage)
  try {
    await normalPage.goto(`${baseUrl}/normal/#session/model-filter-normal`, { waitUntil: 'networkidle2' })
    const modelButton = await normalPage.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
    await modelButton.click()
    await normalPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    const configure = await normalPage.waitForSelector('button[aria-label="Configure models"]')
    assert.equal((await configure.evaluate((button) => button.textContent || '')).trim(), '')
    await configure.click()
    await normalPage.waitForSelector('[data-tab-id="system:setup"]', { timeout: 15_000 })
    await normalPage.waitForSelector('[data-setup-section="models"] [data-editor-ready="true"]', { timeout: 15_000 })
    await normalPage.waitForFunction(() => (
      !!document.activeElement?.closest('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]')
    ), { timeout: 15_000 })
    assert.equal(await normalPage.$$eval('[data-tab-id="system:setup"]', (tabs) => tabs.length), 1)
  } finally {
    await normalPage.close()
  }
})
