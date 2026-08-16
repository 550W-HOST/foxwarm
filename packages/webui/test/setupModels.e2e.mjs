import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const port = 4176
const baseUrl = `http://127.0.0.1:${port}`
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const firefoxPath = process.env.FOXWARM_E2E_FIREFOX || '/usr/bin/firefox-esr'

let vite
let preview
let productionBaseUrl
let browser
let page
let savedRequest
let savedRequestPath
let saveError = null
let savedConfigRequest
let configSaveError = null
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
    rawYaml: 'default: 42\nproviders:\n  gpt-5.6-sol:\n    providerType: openai-completions\n  route:\n    providerType: failover\n    targets: [leaf/model-a]\n',
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
  let mockModelsRawYaml = options.oobe ? '' : statusPayload.models.rawYaml
  let mockConfigRawYaml = options.configRawYaml ?? statusPayload.config.rawYaml
  let mockOobe = !!options.oobe
  let mockSessionModel = 'route'
  let mockSessionEffort = null
  let mockChildModel = null
  let mockChildEffort = null
  const allowedEffortsFor = (model) => model === 'leaf/model-b'
    ? ['medium', 'max']
    : model === 'route' ? ['none', 'low', 'medium', 'high'] : ['none', 'low', 'high']
  const isVirtualModel = (model) => model === 'route' || model === 'sticky'
  const effectiveEffortFor = (raw, model) => raw && allowedEffortsFor(model).includes(raw)
    ? raw
    : isVirtualModel(model) ? 'default' : (model === 'leaf/model-b' ? 'medium' : 'high')
  const buildMockSessionState = (id) => {
    const childModel = mockChildModel || mockSessionModel
    return {
      id,
      model: mockSessionModel === 'route' ? null : mockSessionModel,
      modelKey: mockSessionModel,
      defaultModelKey: 'route',
      effort: mockSessionEffort,
      effectiveEffort: effectiveEffortFor(mockSessionEffort, mockSessionModel),
      effortAllowed: allowedEffortsFor(mockSessionModel),
      effortDefault: isVirtualModel(mockSessionModel) ? null : (mockSessionModel === 'leaf/model-b' ? 'medium' : 'high'),
      childModelDefault: mockChildModel,
      effectiveChildModelKey: childModel,
      childEffortDefault: mockChildEffort,
      effectiveChildEffort: effectiveEffortFor(mockChildEffort || mockSessionEffort, childModel),
      childEffortAllowed: allowedEffortsFor(childModel),
      childModelEffortDefault: isVirtualModel(childModel) ? null : (childModel === 'leaf/model-b' ? 'medium' : 'high'),
    }
  }
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
      void respondJson(request, {
        ...statusPayload,
        oobe: mockOobe,
        models: { ...statusPayload.models, exists: !mockOobe, rawYaml: mockModelsRawYaml },
        config: { ...statusPayload.config, rawYaml: mockConfigRawYaml },
        channels: options.channels ?? statusPayload.channels,
      })
      return
    }
    if (url.pathname.endsWith('/api/models')) {
      void respondJson(request, {
        defaultKey: 'route',
        currentKey: 'route',
        models: [
          { key: 'leaf/model-a', label: 'leaf/model-a', isVirtual: false, allowedEfforts: ['none', 'low', 'high'], defaultEffort: 'high' },
          { key: 'leaf/model-b', label: 'leaf/model-b', isVirtual: false, allowedEfforts: ['medium', 'max'], defaultEffort: 'medium' },
          { key: 'sticky', label: 'sticky', isVirtual: true, allowedEfforts: ['none', 'low', 'high'], defaultEffort: null },
          { key: 'route', label: 'route', isVirtual: true, allowedEfforts: ['none', 'low', 'medium', 'high'], defaultEffort: null },
        ],
      })
      return
    }
    if (url.pathname.endsWith('/api/setup/models') && request.method() === 'POST') {
      savedRequestPath = url.pathname
      savedRequest = JSON.parse(request.postData() || '{}')
      if (options.heldModelsSaves) {
        options.heldModelsSaves.push({ request, body: savedRequest })
        return
      }
      if (saveError) {
        void respondJson(request, { error: saveError }, 400)
      } else {
        mockModelsRawYaml = savedRequest.yaml
        mockOobe = false
        void respondJson(request, { success: true, models: { ...statusPayload.models, rawYaml: savedRequest.yaml } })
      }
      return
    }
    if (url.pathname.endsWith('/api/setup/config') && request.method() === 'POST') {
      savedConfigRequest = JSON.parse(request.postData() || '{}')
      if (configSaveError) {
        void respondJson(request, { error: configSaveError }, 400)
      } else {
        mockConfigRawYaml = savedConfigRequest.yaml
        void respondJson(request, { success: true, rawYaml: savedConfigRequest.yaml, reload: { started: ['telegram'] } })
      }
      return
    }
    if (url.pathname.endsWith('/api/setup/weixin/login/start') && request.method() === 'POST') {
      void respondJson(request, {
        sessionKey: 'weixin-e2e-session',
        qrcodeUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      })
      return
    }
    if (url.pathname.endsWith('/api/setup/weixin/login/wait') && request.method() === 'POST') {
      void respondJson(request, { connected: true, userId: 'weixin-e2e-user' })
      return
    }
    if (/\/api\/sessions\/[^/]+\/model$/.test(url.pathname) && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      modelUpdateRequests.push({ path: url.pathname, body })
      if (Object.prototype.hasOwnProperty.call(body, 'model')) {
        mockSessionModel = body.model || 'route'
        if (options.staleEffort) {
          mockSessionEffort = 'max'
          mockChildEffort = 'max'
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'effort')) mockSessionEffort = body.effort || null
      void respondJson(request, buildMockSessionState(decodeURIComponent(url.pathname.split('/').at(-2) || '')))
      return
    }
    if (/\/api\/sessions\/[^/]+\/child-model$/.test(url.pathname) && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      modelUpdateRequests.push({ path: url.pathname, body })
      if (Object.prototype.hasOwnProperty.call(body, 'childModelDefault')) mockChildModel = body.childModelDefault || null
      if (Object.prototype.hasOwnProperty.call(body, 'childEffortDefault')) mockChildEffort = body.childEffortDefault || null
      void respondJson(request, buildMockSessionState(decodeURIComponent(url.pathname.split('/').at(-2) || '')))
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
    } else if (editorAction === 'trigger-suggest') {
      editor.focus()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      editor.trigger('foxwarm-e2e', 'editor.action.triggerSuggest', {})
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
    const model = editor.getModel()
    return {
      value: editor.getValue(),
      direction: selection?.getDirection(),
      rtlDirection: monaco.SelectionDirection.RTL,
      ltrDirection: monaco.SelectionDirection.LTR,
      selectionStartOffset: selection && model ? model.getOffsetAt(selection.getStartPosition()) : null,
      selectionEndOffset: selection && model ? model.getOffsetAt(selection.getEndPosition()) : null,
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

async function triggerAndAcceptVisibleSuggestion(targetPage, label) {
  await targetPage.keyboard.down('Control')
  await targetPage.keyboard.press('Space')
  await targetPage.keyboard.up('Control')
  await targetPage.waitForFunction((expectedLabel) => [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]
    .some((row) => row.textContent?.includes(expectedLabel)), { timeout: 15_000 }, label)
  const rows = await targetPage.$$('.suggest-widget.visible .monaco-list-row')
  for (const row of rows) {
    const text = await row.evaluate((element) => element.textContent || '')
    if (text.includes(label)) {
      await row.click()
      return
    }
  }
  throw new Error(`Completion suggestion was not visible: ${label}`)
}

async function waitForMonacoValue(targetPage, modelUri, expectedValue) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const state = await runMonacoEditorAction(targetPage, modelUri, 'snapshot')
    if (state.value === expectedValue) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const state = await runMonacoEditorAction(targetPage, modelUri, 'snapshot')
  assert.equal(state.value, expectedValue)
}

async function dragMonacoSelection(targetPage, modelUri, start, end) {
  const dragStart = await runMonacoEditorAction(targetPage, modelUri, 'screen-position', start)
  const dragEnd = await runMonacoEditorAction(targetPage, modelUri, 'screen-position', end)
  await targetPage.mouse.move(dragStart.x, dragStart.y)
  await targetPage.mouse.down()
  await targetPage.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 })
  await targetPage.mouse.up()
  return runMonacoEditorAction(targetPage, modelUri, 'snapshot')
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

test('Setup uses accessible Models and Config tabs with status icons and product copy', async () => {
  const bodyText = await page.$eval('body', (body) => body.textContent || '')
  assert.equal(bodyText.includes('Test selected provider'), false)
  assert.equal(bodyText.includes('Provider 1'), false)
  assert.equal(bodyText.includes('OOBE mode is active'), false)
  assert.equal(bodyText.includes('raw config editor below preserves'), false)
  assert.equal(bodyText.includes('Models path:'), false)
  assert.equal(bodyText.includes('Config path:'), false)
  assert.equal(await page.$('button::-p-text(Form)'), null)
  assert.equal(await page.$('::-p-text(Setup checklist)'), null)

  const tabs = await page.$$eval('[role="tab"]', (elements) => elements.map((element) => ({
    tab: element.getAttribute('data-setup-tab'),
    selected: element.getAttribute('aria-selected'),
    status: element.querySelector('[data-setup-tab-status]')?.getAttribute('data-setup-tab-status') || null,
  })))
  assert.deepEqual(tabs, [
    { tab: 'models', selected: 'true', status: 'complete' },
    { tab: 'config', selected: 'false', status: null },
  ])
  assert.deepEqual(await page.$$eval('[data-monaco-model-uri]', (elements) => elements.map((element) => element.getAttribute('data-monaco-model-uri'))), [
    'inmemory://foxwarm/setup/foxwarm-models.yaml',
    'inmemory://foxwarm/setup/foxwarm-config.yaml',
  ])
  assert.equal(await page.$eval('[data-setup-section="models"]', (panel) => panel.hidden), false)
  assert.equal(await page.$eval('[data-setup-section="config"]', (panel) => panel.hidden), true)

  await page.focus('[data-setup-tab="models"]')
  await page.keyboard.press('ArrowRight')
  await page.waitForSelector('[data-setup-tab="config"][aria-selected="true"]')
  await page.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-config.yaml"][data-editor-ready="true"]', { timeout: 15_000 })
  assert.equal(await page.$eval('[data-setup-section="models"]', (panel) => panel.hidden), true)
  assert.equal(await page.$eval('[data-setup-section="config"]', (panel) => panel.hidden), false)
  assert.equal(await page.$eval('[data-setup-section="config"]', (panel) => panel.lastElementChild?.getAttribute('data-setup-config-last')), 'weixin')
  assert.ok((await page.$eval('[data-setup-config-last="weixin"]', (element) => element.textContent || '')).includes('Connect Weixin by scanning a QR code.'))
  assert.equal((await page.$eval('[data-setup-section="config"]', (element) => element.textContent || '')).includes('sessionKey'), false)
  assert.equal((await page.$eval('[data-setup-section="config"]', (element) => element.textContent || '')).includes('pairing URL'), false)
  await page.click('button::-p-text(Start Weixin login)')
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Check login'))
    return button instanceof HTMLButtonElement && !button.disabled
  })
  await page.click('button::-p-text(Check login)')
  await page.waitForFunction(() => document.body.textContent?.includes('Connected as weixin-e2e-user. Channel config saved and reloaded.'))

  await page.focus('[data-setup-tab="config"]')
  await page.keyboard.press('Home')
  await page.waitForSelector('[data-setup-tab="models"][aria-selected="true"]')
  await page.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-ready="true"]', { timeout: 15_000 })
  assert.ok(requestPaths.includes('/preview/api/setup/status'))
})

test('Config tab status reflects enabled channel health and ignores disabled channels', async () => {
  assert.equal(await page.$('[data-setup-tab="config"] [data-setup-tab-status]'), null)

  const fixtures = [
    {
      path: 'healthy-channels',
      expected: 'complete',
      channels: [
        { channelId: 'telegram', type: 'telegram', running: true, configured: true, enabled: true, managed: true, details: [] },
        { channelId: 'disabled-broken', type: 'custom', running: false, configured: false, enabled: false, managed: true, details: [], lastError: 'ignored while disabled' },
      ],
    },
    {
      path: 'channel-needs-attention',
      expected: 'attention',
      channels: [
        { channelId: 'telegram', type: 'telegram', running: false, configured: false, enabled: true, managed: true, details: [], lastError: 'missing credentials' },
      ],
    },
  ]

  for (const fixture of fixtures) {
    const statusPage = await browser.newPage()
    await statusPage.setBypassServiceWorker(true)
    await attachRequestMocks(statusPage, { channels: fixture.channels, blockEditorChunks: true })
    try {
      await statusPage.goto(`${baseUrl}/${fixture.path}/#setup`, { waitUntil: 'networkidle2' })
      await statusPage.waitForSelector(`[data-setup-tab="config"] [data-setup-tab-status="${fixture.expected}"]`, { timeout: 15_000 })
      assert.equal(await statusPage.$$eval('[data-setup-tab="config"] [data-setup-tab-status]', (icons) => icons.length), 1)
    } finally {
      await statusPage.close()
    }
  }
})

test('each Setup tab editor uses the responsive 600px/80vh height without mobile overflow', async () => {
  const measureEditor = (targetPage, tab) => targetPage.$eval(`[data-setup-section="${tab}"] [data-monaco-model-uri]`, (editor) => {
    const rect = editor.getBoundingClientRect()
    return {
      authoredHeight: editor.style.height,
      computedHeight: Number.parseFloat(getComputedStyle(editor).height),
      width: rect.width,
      viewportWidth: window.innerWidth,
      expectedHeight: Math.min(600, window.innerHeight * 0.8),
      documentWidth: document.documentElement.scrollWidth,
    }
  })

  for (const tab of ['models', 'config']) {
    await page.click(`[data-setup-tab="${tab}"]`)
    await page.waitForSelector(`[data-setup-section="${tab}"] [data-editor-ready="true"]`, { timeout: 15_000 })
    const editor = await measureEditor(page, tab)
    assert.ok(['calc(min(600px, 80vh))', 'min(600px, 80vh)'].includes(editor.authoredHeight))
    assert.ok(Math.abs(editor.computedHeight - editor.expectedHeight) < 1)
    assert.ok(editor.width <= editor.viewportWidth)
  }
  await page.click('[data-setup-tab="models"]')
  await page.waitForSelector('[data-setup-section="models"] [data-editor-ready="true"]', { timeout: 15_000 })

  const mobilePage = await browser.newPage()
  await mobilePage.setViewport({ width: 390, height: 700 })
  await attachRequestMocks(mobilePage)
  try {
    await mobilePage.goto(`${baseUrl}/mobile/#setup`, { waitUntil: 'networkidle2' })
    for (const tab of ['models', 'config']) {
      await mobilePage.click(`[data-setup-tab="${tab}"]`)
      await mobilePage.waitForSelector(`[data-setup-section="${tab}"] [data-editor-ready="true"]`, { timeout: 15_000 })
      const editor = await measureEditor(mobilePage, tab)
      assert.ok(Math.abs(editor.computedHeight - 560) < 1)
      assert.ok(editor.width <= editor.viewportWidth)
      assert.ok(editor.documentWidth <= editor.viewportWidth)
    }
  } finally {
    await mobilePage.close()
  }
})

test('both Setup Monaco editors preserve controlled selection replacement', async () => {
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  const configUri = 'inmemory://foxwarm/setup/foxwarm-config.yaml'
  const originalModels = (await runMonacoEditorAction(page, modelsUri, 'snapshot')).value

  let state = await dragMonacoSelection(page, modelsUri, { line: 1, column: 12 }, { line: 1, column: 10 })
  assert.equal(state.direction, state.rtlDirection)
  await page.keyboard.press('x')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, modelsUri, 'snapshot')).value, originalModels.replace('42', 'x'))

  await runMonacoEditorAction(page, modelsUri, 'replace-value', { value: 'default: 42\nproviders:\n  local: {}\n' })
  state = await runMonacoEditorAction(page, modelsUri, 'select', {
    anchorLine: 1, anchorColumn: 12, activeLine: 1, activeColumn: 10,
  })
  assert.equal(state.direction, state.rtlDirection)
  await page.click('button::-p-text(Refresh)')
  await waitForMonacoValue(page, modelsUri, statusPayload.models.rawYaml)
  state = await runMonacoEditorAction(page, modelsUri, 'snapshot')
  assert.equal(state.direction, state.rtlDirection)
  await runMonacoEditorAction(page, modelsUri, 'focus')
  await page.keyboard.press('r')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, modelsUri, 'snapshot')).value, statusPayload.models.rawYaml.replace('42', 'r'))
  await page.click('button::-p-text(Refresh)')
  await waitForMonacoValue(page, modelsUri, statusPayload.models.rawYaml)

  await page.click('[data-setup-tab="config"]')
  await page.waitForSelector(`[data-monaco-model-uri="${configUri}"][data-editor-ready="true"]`, { timeout: 15_000 })
  const originalConfig = (await runMonacoEditorAction(page, configUri, 'snapshot')).value
  await runMonacoEditorAction(page, configUri, 'replace-value', { value: 'alpha beta\nsecond line\nthird line\n' })
  state = await dragMonacoSelection(page, configUri, { line: 3, column: 6 }, { line: 2, column: 1 })
  assert.equal(state.direction, state.rtlDirection)
  await page.keyboard.type('Y')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, configUri, 'snapshot')).value, 'alpha beta\nY line\n')

  await runMonacoEditorAction(page, configUri, 'replace-value', { value: '# temporary config value\n' })
  state = await runMonacoEditorAction(page, configUri, 'select', {
    anchorLine: 1, anchorColumn: 10, activeLine: 1, activeColumn: 3,
  })
  assert.equal(state.direction, state.rtlDirection)
  await page.click('button::-p-text(Refresh)')
  await waitForMonacoValue(page, configUri, originalConfig)
  state = await runMonacoEditorAction(page, configUri, 'snapshot')
  assert.equal(state.direction, state.rtlDirection)
  await runMonacoEditorAction(page, configUri, 'focus')
  await page.keyboard.press('C')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal((await runMonacoEditorAction(page, configUri, 'snapshot')).value, originalConfig.replace('Foxwarm', 'C'))

  await page.click('[data-setup-tab="models"]')
  await page.waitForSelector(`[data-monaco-model-uri="${modelsUri}"][data-editor-ready="true"]`, { timeout: 15_000 })
})

test('Firefox replaces real reverse mouse selections on the first physical key', {
  skip: existsSync(firefoxPath) ? false : `Firefox is not available at ${firefoxPath}`,
}, async () => {
  const firefox = await puppeteer.launch({
    browser: 'firefox',
    executablePath: firefoxPath,
    headless: true,
  })
  const firefoxPage = await firefox.newPage()
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  const configUri = 'inmemory://foxwarm/setup/foxwarm-config.yaml'
  const configRawYaml = 'name: Foxwarm\nchannels: {}\n'

  await attachRequestMocks(firefoxPage, { configRawYaml })
  try {
    await firefoxPage.goto(`${baseUrl}/firefox-reverse-selection/#setup`, { waitUntil: 'domcontentloaded' })
    await firefoxPage.waitForSelector(`[data-monaco-model-uri="${modelsUri}"][data-editor-ready="true"]`, { timeout: 20_000 })

    const scenarios = [
      {
        tab: 'models',
        uri: modelsUri,
        start: { line: 1, column: 11 },
        end: { line: 1, column: 7 },
        key: 'x',
      },
      {
        tab: 'config',
        uri: configUri,
        start: { line: 3, column: 6 },
        end: { line: 2, column: 1 },
        key: 'Y',
      },
    ]

    for (const scenario of scenarios) {
      await firefoxPage.click(`[data-setup-tab="${scenario.tab}"]`)
      await firefoxPage.waitForSelector(`[data-setup-section="${scenario.tab}"]:not([hidden]) [data-editor-ready="true"]`, { timeout: 15_000 })
      await runMonacoEditorAction(firefoxPage, scenario.uri, 'replace-value', {
        value: 'alpha beta\nsecond line\nthird line\n',
      })
      const selection = await dragMonacoSelection(firefoxPage, scenario.uri, scenario.start, scenario.end)
      assert.equal(selection.direction, selection.rtlDirection)
      assert.equal(await firefoxPage.$eval(`[data-monaco-model-uri="${scenario.uri}"] textarea.inputarea`, (input) => (
        input.selectionStart === input.selectionEnd
      )), true)

      await firefoxPage.keyboard.press(scenario.key)
      const expected = selection.value.slice(0, selection.selectionStartOffset)
        + scenario.key
        + selection.value.slice(selection.selectionEndOffset)
      assert.equal((await runMonacoEditorAction(firefoxPage, scenario.uri, 'snapshot')).value, expected)
    }

    await firefoxPage.click('[data-setup-tab="models"]')
    await runMonacoEditorAction(firefoxPage, modelsUri, 'replace-value', {
      value: 'default: XX\nproviders: {}\n',
    })
    let selection = await dragMonacoSelection(firefoxPage, modelsUri, { line: 1, column: 12 }, { line: 1, column: 10 })
    assert.equal(selection.direction, selection.rtlDirection)
    const modelsStartOffset = selection.selectionStartOffset
    const modelsEndOffset = selection.selectionEndOffset
    await firefoxPage.click('button::-p-text(Refresh)')
    await waitForMonacoValue(firefoxPage, modelsUri, statusPayload.models.rawYaml)
    selection = await runMonacoEditorAction(firefoxPage, modelsUri, 'snapshot')
    assert.equal(selection.direction, selection.rtlDirection)
    await runMonacoEditorAction(firefoxPage, modelsUri, 'focus')
    await firefoxPage.keyboard.press('r')
    assert.equal((await runMonacoEditorAction(firefoxPage, modelsUri, 'snapshot')).value,
      statusPayload.models.rawYaml.slice(0, modelsStartOffset) + 'r' + statusPayload.models.rawYaml.slice(modelsEndOffset))

    await firefoxPage.click('[data-setup-tab="config"]')
    await runMonacoEditorAction(firefoxPage, configUri, 'replace-value', {
      value: 'name: TEMP123\nchannels: {}\n',
    })
    selection = await dragMonacoSelection(firefoxPage, configUri, { line: 1, column: 14 }, { line: 1, column: 7 })
    assert.equal(selection.direction, selection.rtlDirection)
    const configStartOffset = selection.selectionStartOffset
    const configEndOffset = selection.selectionEndOffset
    await firefoxPage.click('button::-p-text(Refresh)')
    await waitForMonacoValue(firefoxPage, configUri, configRawYaml)
    selection = await runMonacoEditorAction(firefoxPage, configUri, 'snapshot')
    assert.equal(selection.direction, selection.rtlDirection)
    await runMonacoEditorAction(firefoxPage, configUri, 'focus')
    await firefoxPage.keyboard.press('C')
    assert.equal((await runMonacoEditorAction(firefoxPage, configUri, 'snapshot')).value,
      configRawYaml.slice(0, configStartOffset) + 'C' + configRawYaml.slice(configEndOffset))
  } finally {
    await firefox.close()
  }
})

test('local and schema completions replace the current punctuated YAML scalar', async () => {
  const completionPage = await browser.newPage()
  await attachRequestMocks(completionPage)
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  try {
    await completionPage.goto(`${productionBaseUrl}/#setup`, { waitUntil: 'networkidle2' })
    await completionPage.bringToFront()
    const modelEditor = `[data-monaco-model-uri="${modelsUri}"]`
    await completionPage.waitForFunction((selector) => {
      const editor = document.querySelector(selector)
      return document.hasFocus()
        && editor?.getAttribute('data-editor-ready') === 'true'
        && editor?.getAttribute('data-editor-fallback') !== 'true'
        && Number(editor?.getAttribute('data-marker-count') || 0) > 0
    }, { timeout: 20_000 }, modelEditor)
    const editorSurface = await completionPage.waitForSelector(`${modelEditor} .view-lines`, { visible: true })
    await editorSurface.click()
    await completionPage.waitForFunction((selector) => document.hasFocus() && !!document.activeElement?.closest(selector), {}, modelEditor)

    const localYaml = 'default: gpt-5.6\nproviders: { gpt-5.6-sol: { providerType: openai-completions } }'
    await completionPage.keyboard.down('Control')
    await completionPage.keyboard.press('KeyA')
    await completionPage.keyboard.up('Control')
    await completionPage.keyboard.type(localYaml)
    await completionPage.keyboard.down('Control')
    await completionPage.keyboard.press('Home')
    await completionPage.keyboard.up('Control')
    await completionPage.keyboard.press('End')
    await triggerAndAcceptVisibleSuggestion(completionPage, 'gpt-5.6-sol')
    const completedLocalYaml = localYaml.replace('default: gpt-5.6', 'default: gpt-5.6-sol')
    savedRequest = null
    await completionPage.click('button::-p-text(Save models)')
    await completionPage.waitForSelector('[data-save-feedback="models"][role="status"]')
    assert.deepEqual(savedRequest, { yaml: completedLocalYaml })

    const schemaYaml = 'providers: { local: { providerType: openai- } }'
    await editorSurface.click()
    await completionPage.keyboard.down('Control')
    await completionPage.keyboard.press('KeyA')
    await completionPage.keyboard.up('Control')
    await completionPage.keyboard.type(schemaYaml)
    await completionPage.keyboard.down('Control')
    await completionPage.keyboard.press('End')
    await completionPage.keyboard.up('Control')
    await completionPage.keyboard.press('ArrowLeft')
    await completionPage.keyboard.press('ArrowLeft')
    await completionPage.keyboard.press('ArrowLeft')
    await completionPage.keyboard.press('ArrowLeft')
    await triggerAndAcceptVisibleSuggestion(completionPage, 'openai-completions')
    await completionPage.waitForFunction(() => !document.querySelector('[data-save-feedback="models"]'))
    savedRequest = null
    await completionPage.click('button::-p-text(Save models)')
    await completionPage.waitForSelector('[data-save-feedback="models"][role="status"]')
    assert.deepEqual(savedRequest, { yaml: schemaYaml.replace('openai-', 'openai-completions') })
  } finally {
    await completionPage.close()
  }
})

test('raw model save remains enabled and preserves editor text', async () => {
  const saveButton = await page.waitForSelector('button::-p-text(Save models)')
  assert.equal(await saveButton.evaluate((button) => button.disabled), false)
  await saveButton.click()
  const feedback = await page.waitForSelector('[data-save-feedback="models"][role="status"]')
  assert.equal((await feedback.evaluate((element) => element.textContent || '')).trim(), 'Models saved.')
  assert.equal(await feedback.evaluate((element) => element.closest('[data-setup-section]')?.getAttribute('data-setup-section')), 'models')
  assert.deepEqual(savedRequest, { yaml: statusPayload.models.rawYaml })
  assert.equal(savedRequestPath, '/preview/api/setup/models')

  await runMonacoEditorAction(page, 'inmemory://foxwarm/setup/foxwarm-models.yaml', 'position', { line: 1, column: statusPayload.models.rawYaml.split('\n')[0].length + 1 })
  await page.keyboard.type('#')
  await page.waitForFunction(() => !document.querySelector('[data-save-feedback="models"]'))
  await page.click('button::-p-text(Refresh)')
  await waitForMonacoValue(page, 'inmemory://foxwarm/setup/foxwarm-models.yaml', statusPayload.models.rawYaml)

  await saveButton.click()
  await page.waitForSelector('[data-save-feedback="models"][role="status"]')
  await page.click('button::-p-text(Refresh)')
  await page.waitForFunction(() => !document.querySelector('[data-save-feedback="models"]'))
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

    const saveButton = await productionPage.waitForSelector('button::-p-text(Save models)')
    assert.equal(await saveButton.evaluate((button) => button.disabled), false)

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
  const feedback = await page.waitForSelector('[data-save-feedback="models"][role="alert"]')
  assert.ok((await feedback.evaluate((element) => element.textContent || '')).includes('canonical backend rejected the models config'))
  assert.equal(await feedback.evaluate((element) => element.closest('[data-setup-section]')?.getAttribute('data-setup-section')), 'models')
  assert.deepEqual(savedRequest, { yaml: statusPayload.models.rawYaml })
  await runMonacoEditorAction(page, 'inmemory://foxwarm/setup/foxwarm-models.yaml', 'position', { line: 1, column: statusPayload.models.rawYaml.split('\n')[0].length + 1 })
  await page.keyboard.type('#')
  await page.waitForFunction(() => !document.querySelector('[data-save-feedback="models"]'))
  saveError = null
  await page.click('button::-p-text(Refresh)')
  await waitForMonacoValue(page, 'inmemory://foxwarm/setup/foxwarm-models.yaml', statusPayload.models.rawYaml)
})

test('config save success and error feedback stay with the Config Save button', async () => {
  const configUri = 'inmemory://foxwarm/setup/foxwarm-config.yaml'
  const configYaml = 'channels:\n  telegram:\n    enabled: true\n'
  await page.click('[data-setup-tab="config"]')
  await page.waitForSelector(`[data-monaco-model-uri="${configUri}"][data-editor-ready="true"]`, { timeout: 15_000 })
  await runMonacoEditorAction(page, configUri, 'replace-value', { value: configYaml })
  const saveButton = await page.waitForSelector('button::-p-text(Save config)')
  await saveButton.click()
  let feedback = await page.waitForSelector('[data-save-feedback="config"][role="status"]')
  assert.equal((await feedback.evaluate((element) => element.textContent || '')).trim(), 'Config saved. Active channels refreshed: telegram.')
  assert.equal(await feedback.evaluate((element) => element.closest('[data-setup-section]')?.getAttribute('data-setup-section')), 'config')
  assert.deepEqual(savedConfigRequest, { yaml: configYaml })
  assert.equal(await page.$('[data-setup-section="models"] [data-save-feedback="config"]'), null)

  await page.click('[data-setup-tab="models"]')
  await page.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-ready="true"]', { timeout: 15_000 })
  assert.equal(await page.$eval('[data-save-feedback="config"][role="status"]', (feedback) => feedback.closest('[data-setup-section]')?.getAttribute('data-setup-section')), 'config')

  await page.click('[data-setup-tab="config"]')
  await page.waitForSelector(`[data-monaco-model-uri="${configUri}"][data-editor-ready="true"]`, { timeout: 15_000 })
  assert.ok(await page.$('[data-save-feedback="config"][role="status"]'))

  configSaveError = 'canonical backend rejected the app config'
  await saveButton.click()
  feedback = await page.waitForSelector('[data-save-feedback="config"][role="alert"]')
  assert.ok((await feedback.evaluate((element) => element.textContent || '')).includes(configSaveError))
  assert.equal(await feedback.evaluate((element) => element.closest('[data-setup-section]')?.getAttribute('data-setup-section')), 'config')
  await runMonacoEditorAction(page, configUri, 'position', { line: 1, column: 'channels:'.length + 1 })
  await page.keyboard.type(' ')
  await page.waitForFunction(() => !document.querySelector('[data-save-feedback="config"]'))
  configSaveError = null
  await page.click('button::-p-text(Refresh)')
  await page.waitForFunction(() => !document.querySelector('[data-save-feedback="models"], [data-save-feedback="config"]'))
  await page.click('[data-setup-tab="models"]')
  await page.waitForSelector('[data-setup-section="models"] [data-editor-ready="true"]', { timeout: 15_000 })
})

test('editing while a models save is held preserves the newer document and suppresses stale feedback', async () => {
  const heldModelsSaves = []
  const racePage = await browser.newPage()
  await attachRequestMocks(racePage, { heldModelsSaves })
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  try {
    await racePage.goto(`${baseUrl}/save-race/#setup`, { waitUntil: 'networkidle2' })
    await racePage.bringToFront()
    await racePage.waitForSelector(`[data-monaco-model-uri="${modelsUri}"][data-editor-ready="true"]`, { timeout: 15_000 })
    await racePage.click('button::-p-text(Save models)')
    const deadline = Date.now() + 10_000
    while (heldModelsSaves.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(heldModelsSaves.length, 1)

    await runMonacoEditorAction(racePage, modelsUri, 'position', { line: 1, column: statusPayload.models.rawYaml.split('\n')[0].length + 1 })
    await racePage.keyboard.type('# newer')
    const editedYaml = (await runMonacoEditorAction(racePage, modelsUri, 'snapshot')).value
    assert.notEqual(editedYaml, heldModelsSaves[0].body.yaml)

    await respondJson(heldModelsSaves[0].request, {
      success: true,
      models: { ...statusPayload.models, rawYaml: heldModelsSaves[0].body.yaml },
    })
    await racePage.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Save models'))
      return button && !button.disabled
    })
    await racePage.waitForFunction(() => !document.body.textContent?.includes('Loading setup status…'))
    await waitForMonacoValue(racePage, modelsUri, editedYaml)
    assert.equal(await racePage.$('[data-save-feedback="models"]'), null)
  } finally {
    await racePage.close()
  }
})

test('OOBE remains editable and savable when lazy Monaco/YAML support import rejects', async () => {
  const degradedPage = await browser.newPage()
  await degradedPage.setCacheEnabled(false)
  await attachRequestMocks(degradedPage, { blockEditorChunks: true, oobe: true })
  try {
    await degradedPage.goto(`${baseUrl}/degraded/#setup`, { waitUntil: 'networkidle2' })
    await degradedPage.waitForFunction(() => document.body.textContent?.includes('Foxwarm first-time setup'), { timeout: 15_000 })
    await degradedPage.waitForSelector('[data-setup-tab="models"] [data-setup-tab-status="attention"]')
    const forcedSetupClose = await degradedPage.waitForSelector('[data-tab-id="system:setup"] button[title="Close tab"]')
    await forcedSetupClose.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(await degradedPage.$('[data-tab-id="system:setup"]'))
    const fallback = await degradedPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-fallback="true"] textarea', { timeout: 15_000 })
    assert.ok((await degradedPage.$eval('body', (body) => body.textContent || '')).includes('Advanced editor features are unavailable. You can still edit and save this YAML.'))
    const fallbackHeight = await degradedPage.$eval('[data-editor-fallback="true"]', (editor) => ({
      height: Number.parseFloat(getComputedStyle(editor).height),
      expected: Math.min(600, window.innerHeight * 0.8),
    }))
    assert.ok(Math.abs(fallbackHeight.height - fallbackHeight.expected) < 1)

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
    await degradedPage.waitForFunction(() => document.body.textContent?.includes('Models saved.'))
    assert.deepEqual(savedRequest, { yaml })

    await degradedPage.click('[data-setup-tab="config"]')
    const configFallback = await degradedPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-config.yaml"][data-editor-fallback="true"]', { timeout: 15_000 })
    const configFallbackHeight = await configFallback.evaluate((editor) => ({
      height: Number.parseFloat(getComputedStyle(editor).height),
      expected: Math.min(600, window.innerHeight * 0.8),
    }))
    assert.ok(Math.abs(configFallbackHeight.height - configFallbackHeight.expected) < 1)
  } finally {
    await degradedPage.close()
  }
})

test('embedded model filter selects one result and keeps the accessible Setup bridge', async () => {
  const embeddedBrowser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const hostPage = await embeddedBrowser.newPage()
  await hostPage.setBypassServiceWorker(true)
  await hostPage.setViewport({ width: 390, height: 700 })
  await attachRequestMocks(hostPage, { staleEffort: true })
  const nonce = '0123456789abcdef0123456789abcdef'
  try {
    await hostPage.goto(`${baseUrl}/preview/host`, { waitUntil: 'networkidle2' })
    await hostPage.bringToFront()
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
    const modelButton = await chatFrame.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 30_000 })
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
    const alignedEffortLayout = await chatFrame.$eval('[data-model-selector-popup="true"]', (popup) => {
      const header = popup.querySelector('[data-model-selector-header="true"]')
      const footer = popup.querySelector('[data-model-effort-footer="true"]')
      const row = popup.querySelector('[data-model-selector-row="true"]')
      if (!header || !footer || !row) throw new Error('model selector table rows are missing')
      const columnRects = (element) => Array.from(element.children).map((child) => {
        const rect = child.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width }
      })
      const selects = Array.from(footer.querySelectorAll('select')).map((select) => {
        const rect = select.getBoundingClientRect()
        const style = getComputedStyle(select)
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (context) context.font = style.font
        const selectedLabel = select.selectedOptions[0]?.label || ''
        const textWidth = context?.measureText(selectedLabel).width || 0
        const description = select.getAttribute('aria-describedby')
        return {
          width: rect.width,
          left: rect.left,
          right: rect.right,
          fontSize: Number.parseFloat(style.fontSize),
          selectedLabel,
          readable: textWidth + 28 <= rect.width,
          description: description ? document.getElementById(description)?.textContent : '',
        }
      })
      return {
        headerLabels: Array.from(header.children).map((child) => child.textContent?.trim()),
        headerSelectCount: header.querySelectorAll('select').length,
        footerLabel: footer.firstElementChild?.textContent?.trim(),
        footerImmediatelyAboveSearch: !!footer.nextElementSibling?.querySelector('input[aria-label="Filter models"]'),
        headerColumns: columnRects(header),
        footerColumns: columnRects(footer),
        rowColumns: Array.from(row.querySelectorAll('[data-model-selector-column]')).map((child) => {
          const rect = child.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width: rect.width }
        }),
        footerHeight: footer.getBoundingClientRect().height,
        selects,
      }
    })
    assert.deepEqual(alignedEffortLayout.headerLabels, ['Model id', 'Current', 'Child'])
    assert.equal(alignedEffortLayout.headerSelectCount, 0)
    assert.equal(alignedEffortLayout.footerLabel, 'Effort')
    assert.equal(alignedEffortLayout.footerImmediatelyAboveSearch, true)
    assert.ok(alignedEffortLayout.footerHeight <= 36)
    assert.equal(alignedEffortLayout.selects.length, 2)
    for (let index = 0; index < 3; index += 1) {
      assert.ok(Math.abs(alignedEffortLayout.headerColumns[index].left - alignedEffortLayout.footerColumns[index].left) <= 1)
      assert.ok(Math.abs(alignedEffortLayout.headerColumns[index].right - alignedEffortLayout.footerColumns[index].right) <= 1)
      assert.ok(Math.abs(alignedEffortLayout.rowColumns[index].left - alignedEffortLayout.footerColumns[index].left) <= 1)
      assert.ok(Math.abs(alignedEffortLayout.rowColumns[index].right - alignedEffortLayout.footerColumns[index].right) <= 1)
    }
    assert.ok(Math.abs(alignedEffortLayout.headerColumns[1].width - 100) <= 1)
    assert.ok(Math.abs(alignedEffortLayout.headerColumns[2].width - 100) <= 1)
    assert.ok(alignedEffortLayout.selects.every(({ left, right, width }, index) => left >= alignedEffortLayout.footerColumns[index + 1].left && right <= alignedEffortLayout.footerColumns[index + 1].right && width >= 76))
    assert.ok(alignedEffortLayout.selects.every(({ fontSize }) => fontSize === 16))
    assert.deepEqual(alignedEffortLayout.selects.map(({ selectedLabel }) => selectedLabel), ['Per leaf', 'Per leaf'])
    assert.ok(alignedEffortLayout.selects.every(({ readable }) => readable))
    assert.deepEqual(alignedEffortLayout.selects.map(({ description }) => description), [
      'Current effort: default (per leaf)',
      'Child effort: follow/default (per leaf)',
    ])

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
    const currentEffort = await chatFrame.waitForSelector('select[aria-label="Current effort"]')
    assert.equal(await currentEffort.evaluate(select => select.value), 'max')
    assert.equal(await currentEffort.$eval('option[value=""]', option => option.textContent), 'default (per leaf)')
    assert.equal(await currentEffort.$eval('option[value=""]', option => option.label), 'Per leaf')
    assert.deepEqual(await currentEffort.$eval('option[value="max"]', option => ({ text: option.textContent, disabled: option.disabled })), {
      text: 'max (unavailable; using per-leaf default)', disabled: true,
    })
    assert.equal(await currentEffort.$eval('option[value="max"]', option => option.label), 'Max ⚠')
    assert.equal(await currentEffort.evaluate(select => select.title), 'Current effort: max (unavailable; using per-leaf default)')
    const childEffort = await chatFrame.waitForSelector('select[aria-label="Child effort"]')
    assert.equal(await childEffort.evaluate(select => select.value), 'max')
    assert.equal(await childEffort.$eval('option[value=""]', option => option.textContent), 'follow/default (per leaf)')
    assert.equal(await childEffort.$eval('option[value=""]', option => option.label), 'Per leaf')
    assert.deepEqual(await childEffort.$eval('option[value="max"]', option => ({ text: option.textContent, disabled: option.disabled })), {
      text: 'max (unavailable; using per-leaf default)', disabled: true,
    })
    assert.equal(await childEffort.$eval('option[value="max"]', option => option.label), 'Max ⚠')
    assert.equal(await childEffort.evaluate(select => select.title), 'Child effort: max (unavailable; using per-leaf default)')

    const effortUpdatesBefore = modelUpdateRequests.length
    await currentEffort.select('low')
    const effortDeadline = Date.now() + 5_000
    while (modelUpdateRequests.length === effortUpdatesBefore && Date.now() < effortDeadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(modelUpdateRequests.at(-1), {
      path: '/preview/api/sessions/embedded%2Fchat/model',
      body: { effort: 'low' },
    })
    await childEffort.select('none')
    const childEffortDeadline = Date.now() + 5_000
    while (modelUpdateRequests.at(-1)?.body?.childEffortDefault !== 'none' && Date.now() < childEffortDeadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(modelUpdateRequests.at(-1), {
      path: '/preview/api/sessions/embedded%2Fchat/child-model',
      body: { childEffortDefault: 'none' },
    })
    await chatFrame.waitForFunction(() => document.querySelector('button[aria-haspopup="dialog"]')?.textContent?.includes('low'))
    assert.ok((await modelButton.evaluate(button => button.textContent || '')).includes('child follow · none'))
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
    await setupFrame.click('[data-setup-tab="config"]')
    await setupFrame.waitForSelector('[data-setup-tab="config"][aria-selected="true"]')
    await hostPage.evaluate(({ nonce: bridgeNonce }) => {
      const iframe = document.getElementById('embedded-setup')
      iframe?.contentWindow?.postMessage({ channel: 'foxwarm-webui-host', version: 1, nonce: bridgeNonce, type: 'focus-models' }, '*')
    }, { nonce })
    await setupFrame.waitForSelector('[data-setup-tab="models"][aria-selected="true"]', { timeout: 15_000 })
    await setupFrame.waitForFunction(() => !!document.activeElement?.closest('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]'), { timeout: 15_000 })
  } finally {
    await embeddedBrowser.close()
  }
})

test('default desktop model effort footer stays compact and table-aligned', async () => {
  const desktopPage = await browser.newPage()
  await desktopPage.setViewport({ width: 900, height: 700 })
  await attachRequestMocks(desktopPage)
  try {
    await desktopPage.goto(`${baseUrl}/normal/#session/model-effort-default-desktop`, { waitUntil: 'networkidle2' })
    const modelButton = await desktopPage.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
    await modelButton.click()
    await desktopPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    await desktopPage.click('button[title="leaf/model-a"]')
    await desktopPage.waitForFunction(() => document.querySelector('select[aria-label="Current effort"]')?.title === 'Current effort: default (high)')
    const layout = await desktopPage.$eval('[data-model-selector-popup="true"]', (popup) => {
      const header = popup.querySelector('[data-model-selector-header="true"]')
      const footer = popup.querySelector('[data-model-effort-footer="true"]')
      const row = popup.querySelector('[data-model-selector-row="true"]')
      if (!header || !footer || !row) throw new Error('model selector table rows are missing')
      const columns = (element) => Array.from(element.children).map((child) => {
        const rect = child.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      })
      const headerColumns = columns(header)
      const footerColumns = columns(footer)
      const rowColumns = Array.from(row.querySelectorAll('[data-model-selector-column]')).map((child) => {
        const rect = child.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      })
      const selects = Array.from(footer.querySelectorAll('select')).map((select) => {
        const rect = select.getBoundingClientRect()
        const style = getComputedStyle(select)
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (context) context.font = style.font
        const selectedLabel = select.selectedOptions[0]?.label || ''
        const description = select.getAttribute('aria-describedby')
        return {
          width: rect.width,
          fontSize: Number.parseFloat(style.fontSize),
          selectedLabel,
          readable: (context?.measureText(selectedLabel).width || 0) + 28 <= rect.width,
          title: select.title,
          description: description ? document.getElementById(description)?.textContent : '',
        }
      })
      return {
        selects,
        aligned: footerColumns.every((column, index) => (
          Math.abs(column.left - headerColumns[index].left) <= 1
          && Math.abs(column.right - headerColumns[index].right) <= 1
          && Math.abs(column.left - rowColumns[index].left) <= 1
          && Math.abs(column.right - rowColumns[index].right) <= 1
        )),
        headerLabels: Array.from(header.children).map((child) => child.textContent?.trim()),
        footerLabel: footer.firstElementChild?.textContent?.trim(),
      }
    })
    assert.equal(layout.aligned, true)
    assert.deepEqual(layout.headerLabels, ['Model id', 'Current', 'Child'])
    assert.equal(layout.footerLabel, 'Effort')
    assert.deepEqual(layout.selects.map(({ selectedLabel }) => selectedLabel), ['Default', 'Follow'])
    assert.ok(layout.selects.every(({ fontSize }) => fontSize === 11))
    assert.ok(layout.selects.every(({ width }) => width >= 80))
    assert.ok(layout.selects.every(({ readable }) => readable))
    assert.deepEqual(layout.selects.map(({ title }) => title), [
      'Current effort: default (high)',
      'Child effort: follow/default (high)',
    ])
    assert.deepEqual(layout.selects.map(({ description }) => description), [
      'Current effort: default (high)',
      'Child effort: follow/default (high)',
    ])
  } finally {
    await desktopPage.close()
  }
})

test('desktop model popup keeps stable 600/100/100 geometry across scroll and current selection', async () => {
  const desktopPage = await browser.newPage()
  await desktopPage.setViewport({ width: 1000, height: 700 })
  await attachRequestMocks(desktopPage)
  try {
    await desktopPage.goto(`${baseUrl}/normal/#session/model-popup-geometry`, { waitUntil: 'networkidle2' })
    await desktopPage.click('button[aria-haspopup="dialog"]')
    await desktopPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))

    const readGeometry = () => desktopPage.$eval('[data-model-selector-popup="true"]', (popup) => {
      const header = popup.querySelector('[data-model-selector-header="true"]')
      const footer = popup.querySelector('[data-model-effort-footer="true"]')
      const row = popup.querySelector('[data-model-selector-row="true"]')
      const scroll = popup.querySelector('[data-model-selector-scroll="true"]')
      if (!header || !footer || !row || !scroll) throw new Error('model selector geometry missing')
      scroll.scrollTop = scroll.scrollHeight
      const columns = (element) => Array.from(element.children).map((child) => {
        const rect = child.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width }
      })
      return {
        popup: popup.getBoundingClientRect().width,
        header: columns(header),
        footer: columns(footer),
        row: Array.from(row.querySelectorAll('[data-model-selector-column]')).map((child) => {
          const rect = child.getBoundingClientRect()
          return { left: rect.left, right: rect.right, width: rect.width }
        }),
        scrollGutter: scroll.getBoundingClientRect().width - scroll.clientWidth,
      }
    })

    const before = await readGeometry()
    assert.ok(Math.abs(before.popup - 600) <= 1)
    assert.ok(Math.abs(before.header[1].width - 100) <= 1)
    assert.ok(Math.abs(before.header[2].width - 100) <= 1)
    const hoverRegions = await desktopPage.$eval('[data-model-selector-row="true"]', (row) => {
      const current = row.querySelector('[data-model-current-region="true"]')
      const child = row.querySelector('[data-model-selector-column="child"]')
      return {
        currentClasses: current?.className || '',
        currentColumns: current ? Array.from(current.children).map(cell => cell.getAttribute('data-model-selector-column')) : [],
        childClasses: child?.className || '',
        currentTag: current?.tagName,
        childTag: child?.tagName,
      }
    })
    assert.equal(hoverRegions.currentTag, 'BUTTON')
    assert.deepEqual(hoverRegions.currentColumns, ['model', 'current'])
    assert.match(hoverRegions.currentClasses, /hover:bg-blue-50/)
    assert.equal(hoverRegions.childTag, 'BUTTON')
    assert.match(hoverRegions.childClasses, /hover:bg-purple-50/)
    await desktopPage.click('button[title="leaf/model-a"]')
    await desktopPage.waitForFunction(() => document.querySelector('button[title="leaf/model-a"]')?.className.includes('text-blue-700'))
    const after = await readGeometry()
    assert.deepEqual(after, before)
  } finally {
    await desktopPage.close()
  }
})

test('normal Chat keeps the icon-only model settings callback and singleton Setup focus', async () => {
  const normalPage = await browser.newPage()
  await attachRequestMocks(normalPage)
  try {
    await normalPage.evaluateOnNewDocument(() => {
      try { localStorage.setItem('foxwarm_ui_theme_style_v1', '550a') } catch {}
    })
    await normalPage.goto(`${baseUrl}/normal/#session/model-filter-normal`, { waitUntil: 'networkidle2' })
    const modelButton = await normalPage.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
    await modelButton.click()
    await normalPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    const themeLayout = await normalPage.$eval('[data-model-selector-popup="true"]', (popup) => {
      const current = popup.querySelector('select[aria-label="Current effort"]')
      const child = popup.querySelector('select[aria-label="Child effort"]')
      const header = popup.querySelector('[data-model-selector-header="true"]')
      const footer = popup.querySelector('[data-model-effort-footer="true"]')
      const row = popup.querySelector('[data-model-selector-row="true"]')
      const columns = (element) => element ? Array.from(element.children).map((cell) => {
        const rect = cell.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      }) : []
      const headerColumns = columns(header)
      const footerColumns = columns(footer)
      const rowColumns = Array.from(row.querySelectorAll('[data-model-selector-column]')).map((child) => {
        const rect = child.getBoundingClientRect()
        return { left: rect.left, right: rect.right }
      })
      return {
        theme: document.documentElement.getAttribute('data-foxwarm-ui-style'),
        popupWidth: popup.getBoundingClientRect().width,
        headerContainsCurrent: !!header?.contains(current),
        headerContainsChild: !!header?.contains(child),
        footerContainsCurrent: !!footer?.contains(current),
        footerContainsChild: !!footer?.contains(child),
        currentWidth: current?.getBoundingClientRect().width || 0,
        childWidth: child?.getBoundingClientRect().width || 0,
        currentFontSize: current ? Number.parseFloat(getComputedStyle(current).fontSize) : 0,
        currentLabel: current?.selectedOptions[0]?.label || '',
        childLabel: child?.selectedOptions[0]?.label || '',
        filterBorderColor: getComputedStyle(popup.querySelector('input[aria-label="Filter models"]')).borderColor,
        filterBoxShadow: getComputedStyle(popup.querySelector('input[aria-label="Filter models"]')).boxShadow,
        themeAccentDim: getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-550a-accent-dim').trim(),
        aligned: footerColumns.length === 3 && footerColumns.every((column, index) => (
          Math.abs(column.left - headerColumns[index].left) <= 1
          && Math.abs(column.right - headerColumns[index].right) <= 1
          && Math.abs(column.left - rowColumns[index].left) <= 1
          && Math.abs(column.right - rowColumns[index].right) <= 1
        )),
      }
    })
    assert.equal(themeLayout.theme, '550a')
    assert.ok(Math.abs(themeLayout.popupWidth - 600) <= 1)
    assert.equal(themeLayout.headerContainsCurrent, false)
    assert.equal(themeLayout.headerContainsChild, false)
    assert.equal(themeLayout.footerContainsCurrent, true)
    assert.equal(themeLayout.footerContainsChild, true)
    assert.ok(themeLayout.currentWidth >= 80)
    assert.ok(themeLayout.childWidth >= 80)
    assert.ok(themeLayout.currentFontSize <= 11)
    assert.equal(themeLayout.currentLabel, 'Per leaf')
    assert.equal(themeLayout.childLabel, 'Per leaf')
    assert.equal(themeLayout.filterBorderColor, `rgb(${Number.parseInt(themeLayout.themeAccentDim.slice(1, 3), 16)}, ${Number.parseInt(themeLayout.themeAccentDim.slice(3, 5), 16)}, ${Number.parseInt(themeLayout.themeAccentDim.slice(5, 7), 16)})`)
    assert.doesNotMatch(themeLayout.filterBoxShadow, /59, 130, 246|96, 165, 250/)
    assert.equal(themeLayout.aligned, true)
    const configure = await normalPage.waitForSelector('button[aria-label="Configure models"]')
    assert.equal((await configure.evaluate((button) => button.textContent || '')).trim(), '')
    await configure.click()
    await normalPage.waitForSelector('[data-tab-id="system:setup"]', { timeout: 15_000 })
    await normalPage.waitForSelector('[data-setup-section="models"] [data-editor-ready="true"]', { timeout: 15_000 })
    await normalPage.waitForFunction(() => (
      !!document.activeElement?.closest('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]')
    ), { timeout: 15_000 })

    await normalPage.click('[data-setup-tab="config"]')
    await normalPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-config.yaml"][data-editor-ready="true"]', { timeout: 15_000 })
    await normalPage.click('[data-tab-id="chat:model-filter-normal"]')
    const reopenedModelButton = await normalPage.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
    await reopenedModelButton.click()
    await normalPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    await normalPage.click('button[aria-label="Configure models"]')
    await normalPage.waitForSelector('[data-setup-tab="models"][aria-selected="true"]', { timeout: 15_000 })
    await normalPage.waitForFunction(() => (
      !!document.activeElement?.closest('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]')
    ), { timeout: 15_000 })
    assert.equal(await normalPage.$$eval('[data-tab-id="system:setup"]', (tabs) => tabs.length), 1)
  } finally {
    await normalPage.close()
  }
})
