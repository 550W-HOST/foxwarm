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
const selectedBrowser = process.env.FOXWARM_E2E_BROWSER || 'chromium'

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
let webUiSettings = { instanceName: 'Fixture Foxwarm', tabIcon: '🧪' }
let webUiSettingsError = null
const webUiSettingsRequests = []

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
      const respondModels = () => respondJson(request, {
        defaultKey: 'route',
        currentKey: 'route',
        models: [
          { key: 'leaf/model-a', label: 'leaf/model-a', isVirtual: false, allowedEfforts: ['none', 'low', 'high'], defaultEffort: 'high' },
          { key: 'leaf/model-b', label: 'leaf/model-b', isVirtual: false, allowedEfforts: ['medium', 'max'], defaultEffort: 'medium' },
          { key: 'sticky', label: 'sticky', isVirtual: true, allowedEfforts: ['none', 'low', 'high'], defaultEffort: null },
          { key: 'route', label: 'route', isVirtual: true, allowedEfforts: ['none', 'low', 'medium', 'high'], defaultEffort: null },
        ],
      })
      if (options.heldModelOptionsResponses && request.frame()?.url().includes('foxwarmEmbed=chat')) options.heldModelOptionsResponses.push(respondModels)
      else void respondModels()
      return
    }
    if (url.pathname.endsWith('/api/setup/models/list') && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      options.providerModelListRequests?.push(body)
      if (options.heldProviderModelLists) {
        options.heldProviderModelLists.push({ request, body })
        return
      }
      if (options.providerModelListError) {
        void respondJson(request, { error: options.providerModelListError }, 502)
      } else {
        void respondJson(request, { models: options.providerModelListResponse || ['gpt-5.6/x', 'ft:gpt-5.6:project'] })
      }
      return
    }
    if (url.pathname.endsWith('/api/setup/models') && request.method() === 'POST') {
      savedRequestPath = url.pathname
      savedRequest = JSON.parse(request.postData() || '{}')
      options.modelsSaveRequests?.push(savedRequest)
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
      options.configSaveRequests?.push(savedConfigRequest)
      if (options.heldConfigSaves) {
        options.heldConfigSaves.push({ request, body: savedConfigRequest })
        return
      }
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
      if (Object.prototype.hasOwnProperty.call(body, 'effort') && options.heldEffortRequests) {
        options.heldEffortRequests.push(async (fail = false) => {
          if (fail) return respondJson(request, { error: 'Effort save rejected' }, 500)
          mockSessionEffort = body.effort || null
          return respondJson(request, buildMockSessionState(decodeURIComponent(url.pathname.split('/').at(-2) || '')))
        })
        return
      }
      if (Object.prototype.hasOwnProperty.call(body, 'effort')) mockSessionEffort = body.effort || null
      void respondJson(request, buildMockSessionState(decodeURIComponent(url.pathname.split('/').at(-2) || '')))
      return
    }
    if (/\/api\/sessions\/[^/]+\/child-model$/.test(url.pathname) && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      modelUpdateRequests.push({ path: url.pathname, body })
      if (Object.prototype.hasOwnProperty.call(body, 'model')) mockChildModel = body.model || null
      if (body.clear) mockChildModel = null
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
    if (url.pathname.endsWith('/api/webui/settings') && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}')
      webUiSettingsRequests.push(body)
      if (webUiSettingsError) void respondJson(request, { error: webUiSettingsError }, 400)
      else {
        webUiSettings = {
          instanceName: Object.prototype.hasOwnProperty.call(body, 'instanceName') ? body.instanceName || '' : webUiSettings.instanceName,
          tabIcon: Object.prototype.hasOwnProperty.call(body, 'tabIcon') ? body.tabIcon || '' : webUiSettings.tabIcon,
        }
        const responseSettings = { ...webUiSettings }
        if (options.heldWebUiSettingsSaves && options.heldWebUiSettingsSaves.length < 2) {
          options.heldWebUiSettingsSaves.push({ request, body, responseSettings })
        } else {
          void respondJson(request, { settings: responseSettings })
        }
      }
      return
    }
    if (url.pathname.endsWith('/api/webui/settings')) {
      void respondJson(request, { settings: webUiSettings })
      return
    }
    void respondJson(request, {})
  })
}

// The only transient observed in CI is CDP "Promise was collected", which drops an
// evaluate's response after its side effect already applied: the editor kept the value
// written by the failing call, and a page reload restores the pristine mock YAML, so
// this is a lost-response race, not a reload. Only that exact error is retried, so a
// genuine crash (target/context closed) still fails loudly. Every action here is
// idempotent (setValue with a fixed payload, setSelection/position/focus,
// trigger-suggest, read-only snapshots), so a bounded re-issue cannot double-apply.
const TRANSIENT_CDP_ERROR = /Promise was collected/i

async function runMonacoEditorAction(targetPage, modelUri, action, payload = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await evaluateMonacoEditorAction(targetPage, modelUri, action, payload)
    } catch (error) {
      if (attempt >= 2 || !TRANSIENT_CDP_ERROR.test(String(error?.message || error))) throw error
      try {
        // Best-effort readiness gate: a no-op when the editor is already mounted.
        await targetPage.waitForFunction((uri) => {
          const editor = document.querySelector(`[data-monaco-model-uri="${uri}"]`)
          return editor?.getAttribute('data-editor-ready') === 'true'
        }, { timeout: 20_000 }, modelUri)
      } catch {}
    }
  }
}

async function evaluateMonacoEditorAction(targetPage, modelUri, action, payload = {}) {
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
  await acceptVisibleSuggestion(targetPage, label)
}

async function acceptVisibleSuggestion(targetPage, label) {
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

async function readVisibleSuggestions(targetPage, modelUri, position) {
  await runMonacoEditorAction(targetPage, modelUri, 'position', position)
  await runMonacoEditorAction(targetPage, modelUri, 'trigger-suggest')
  await targetPage.waitForSelector('.suggest-widget.visible .monaco-list-row', { timeout: 15_000 })
  const suggestions = await targetPage.$$eval('.suggest-widget.visible .monaco-list-row', (rows) => rows.map((row) => row.textContent || ''))
  await targetPage.keyboard.press('Escape')
  return suggestions
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

async function pressSaveShortcut(targetPage, modifier) {
  await targetPage.keyboard.down(modifier)
  await targetPage.keyboard.press('s')
  await targetPage.keyboard.up(modifier)
}

async function waitForItems(items, expectedLength) {
  const deadline = Date.now() + 10_000
  while (items.length < expectedLength && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.equal(items.length, expectedLength)
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

test('Setup uses accessible Models, Config, and Appearance tabs with status icons and product copy', async () => {
  const setupPage = await browser.newPage()
  await setupPage.setBypassServiceWorker(true)
  await attachRequestMocks(setupPage)
  try {
    await setupPage.goto(`${productionBaseUrl}/#setup`, { waitUntil: 'networkidle2' })
    await setupPage.waitForFunction(() => document.body.textContent?.includes('Foxwarm Setup'), { timeout: 15_000 })
    await setupPage.waitForSelector('[data-monaco-model-uri][data-editor-ready="true"]', { timeout: 15_000 })
    const bodyText = await setupPage.$eval('body', (body) => body.textContent || '')
    assert.equal(bodyText.includes('Test selected provider'), false)
    assert.equal(bodyText.includes('Provider 1'), false)
    assert.equal(bodyText.includes('OOBE mode is active'), false)
    assert.equal(bodyText.includes('raw config editor below preserves'), false)
    assert.equal(bodyText.includes('Models path:'), false)
    assert.equal(bodyText.includes('Config path:'), false)
    assert.equal(await setupPage.$('button::-p-text(Form)'), null)
    assert.equal(await setupPage.$('::-p-text(Setup checklist)'), null)

    const tabs = await setupPage.$$eval('[role="tab"]', (elements) => elements.map((element) => ({
      tab: element.getAttribute('data-setup-tab'),
      selected: element.getAttribute('aria-selected'),
      status: element.querySelector('[data-setup-tab-status]')?.getAttribute('data-setup-tab-status') || null,
    })))
    assert.deepEqual(tabs, [
      { tab: 'appearance', selected: 'true', status: null },
      { tab: 'models', selected: 'false', status: 'complete' },
      { tab: 'config', selected: 'false', status: null },
    ])
    assert.deepEqual(await setupPage.$$eval('[data-monaco-model-uri]', (elements) => elements.map((element) => element.getAttribute('data-monaco-model-uri'))), [
      'inmemory://foxwarm/setup/foxwarm-models.yaml',
      'inmemory://foxwarm/setup/foxwarm-config.yaml',
    ])
    assert.equal(await setupPage.$eval('[data-setup-section="appearance"]', (panel) => panel.hidden), false)
    assert.equal(await setupPage.$eval('[data-setup-section="models"]', (panel) => panel.hidden), true)
    assert.equal(await setupPage.$eval('[data-setup-section="config"]', (panel) => panel.hidden), true)

    await setupPage.focus('[data-setup-tab="appearance"]')
    await setupPage.keyboard.press('ArrowRight')
    await setupPage.waitForSelector('[data-setup-tab="models"][aria-selected="true"]')
    await setupPage.click('[data-setup-tab="config"]')
    await setupPage.waitForSelector('[data-setup-tab="config"][aria-selected="true"]')
    await setupPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-config.yaml"][data-editor-ready="true"]', { timeout: 15_000 })
    assert.equal(await setupPage.$eval('[data-setup-section="models"]', (panel) => panel.hidden), true)
    assert.equal(await setupPage.$eval('[data-setup-section="config"]', (panel) => panel.hidden), false)
    assert.equal(await setupPage.$eval('[data-setup-section="config"]', (panel) => panel.lastElementChild?.getAttribute('data-setup-config-last')), 'weixin')
    assert.ok((await setupPage.$eval('[data-setup-config-last="weixin"]', (element) => element.textContent || '')).includes('Connect Weixin by scanning a QR code.'))
    assert.equal((await setupPage.$eval('[data-setup-section="config"]', (element) => element.textContent || '')).includes('sessionKey'), false)
    assert.equal((await setupPage.$eval('[data-setup-section="config"]', (element) => element.textContent || '')).includes('pairing URL'), false)
    await setupPage.click('button::-p-text(Start Weixin login)')
    await setupPage.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Check login'))
      return button instanceof HTMLButtonElement && !button.disabled
    })
    await setupPage.click('button::-p-text(Check login)')
    await setupPage.waitForFunction(() => document.body.textContent?.includes('Connected as weixin-e2e-user. Channel config saved and reloaded.'))

    await setupPage.focus('[data-setup-tab="config"]')
    await setupPage.keyboard.press('ArrowRight')
    await setupPage.waitForSelector('[data-setup-tab="appearance"][aria-selected="true"]')
    assert.equal(await setupPage.$eval('[data-theme-manager]', element => element.textContent?.includes('WebUI theme')), true)
    assert.equal(await setupPage.$$eval('[data-theme-color-mode]', buttons => buttons.length), 3)
    await setupPage.click('[data-theme-color-mode="dark"]')
    await setupPage.waitForFunction(() => document.documentElement.getAttribute('data-foxwarm-theme-mode') === 'dark')
    await setupPage.click('[data-theme-color-mode="auto"]')
    await setupPage.waitForSelector('[data-theme-color-mode="auto"][aria-pressed="true"]')
    await setupPage.click('[data-theme-color-mode="light"]')
    await setupPage.waitForFunction(() => document.documentElement.getAttribute('data-foxwarm-theme-mode') === 'light')
    await setupPage.click('button[data-theme-option="foxwarm.550a"]')
    await setupPage.waitForFunction(() => document.documentElement.getAttribute('data-foxwarm-component-treatment') === 'console')
    const builtinConsoleTokens = await setupPage.evaluate(() => ['--foxwarm-color-canvas', '--foxwarm-color-accent', '--foxwarm-ui-font-family'].map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()))
    await setupPage.$eval('[data-theme-manager]', manager => Array.from(manager.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Clone')?.click())
    await setupPage.click('input[aria-label="Cloned theme ID"]', { clickCount: 3 })
    await setupPage.type('input[aria-label="Cloned theme ID"]', 'custom.setup-e2e')
    await setupPage.$eval('[data-theme-manager]', manager => Array.from(manager.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Create theme')?.click())
    await setupPage.waitForSelector('button[data-theme-option="custom.setup-e2e"][aria-pressed="true"]')
    assert.equal(await setupPage.evaluate(() => JSON.parse(localStorage.getItem('foxwarm_custom_themes_v2')).themes[0].id), 'custom.setup-e2e')
    assert.equal(await setupPage.evaluate(() => document.documentElement.getAttribute('data-foxwarm-component-treatment')), 'console')
    assert.deepEqual(await setupPage.evaluate(() => ['--foxwarm-color-canvas', '--foxwarm-color-accent', '--foxwarm-ui-font-family'].map(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim())), builtinConsoleTokens)
    const deleteDialog = new Promise(resolve => setupPage.once('dialog', async dialog => { await dialog.accept(); resolve() }))
    await setupPage.$eval('[data-theme-manager]', manager => Array.from(manager.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Delete')?.click())
    await deleteDialog
    await setupPage.waitForFunction(() => !document.querySelector('button[data-theme-option="custom.setup-e2e"]'))
    assert.equal(await setupPage.evaluate(() => JSON.parse(localStorage.getItem('foxwarm_theme_selection_v2')).themeId), 'foxwarm.default')
    await setupPage.waitForFunction(() => document.documentElement.getAttribute('data-foxwarm-component-treatment') === 'standard')

    await setupPage.focus('[data-setup-tab="appearance"]')
    await setupPage.keyboard.press('Home')
    await setupPage.waitForSelector('[data-setup-tab="appearance"][aria-selected="true"]')
    await setupPage.click('[data-setup-tab="models"]')
    await setupPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-ready="true"]', { timeout: 15_000 })
    assert.ok(requestPaths.includes('/preview/api/setup/status'))
  } finally {
    await setupPage.close()
  }
})

test('Appearance owns browser name and tab icon editing with save, cancel, and server errors', async () => {
  const brandingPage = await browser.newPage()
  await brandingPage.setBypassServiceWorker(true)
  await attachRequestMocks(brandingPage)
  try {
    await brandingPage.goto(`${productionBaseUrl}/#setup`, { waitUntil: 'networkidle2' })
    await brandingPage.waitForFunction(() => document.body.textContent?.includes('Foxwarm Setup'), { timeout: 15_000 })
    await brandingPage.click('[data-setup-tab="appearance"]')
    await brandingPage.waitForSelector('[data-webui-branding-settings]')
    const brandingText = await brandingPage.$eval('[data-webui-branding-settings]', section => section.textContent || '')
    assert.equal(brandingText.includes('Rename instance'), true)
    assert.equal(brandingText.includes('Change tab icon'), true)
    assert.equal(await brandingPage.$eval('#webui-instance-name', input => input.value), 'Fixture Foxwarm')
    assert.equal(await brandingPage.$eval('#webui-tab-icon', input => input.value), '🧪')

    await brandingPage.click('#webui-instance-name', { clickCount: 3 })
    await brandingPage.type('#webui-instance-name', 'Unsaved name')
    await brandingPage.$eval('[data-webui-branding-settings] form:first-of-type', form => [...form.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')?.click())
    assert.equal(await brandingPage.$eval('#webui-instance-name', input => input.value), 'Fixture Foxwarm')

    await brandingPage.click('#webui-instance-name', { clickCount: 3 })
    await brandingPage.type('#webui-instance-name', 'Renamed fixture')
    await brandingPage.click('button::-p-text(Save name)')
    await brandingPage.waitForFunction(() => document.querySelector('#webui-instance-name')?.value === 'Renamed fixture')
    assert.deepEqual(webUiSettingsRequests.at(-1), { instanceName: 'Renamed fixture' })

    webUiSettingsError = 'Tab icon is too long'
    await brandingPage.click('#webui-tab-icon', { clickCount: 3 })
    await brandingPage.type('#webui-tab-icon', 'icon that is too long')
    await brandingPage.click('button::-p-text(Save icon)')
    await brandingPage.waitForFunction(() => document.querySelector('[data-webui-branding-settings] [role="alert"]')?.textContent?.includes('Tab icon is too long'))
    assert.equal(await brandingPage.$eval('#webui-tab-icon', input => input.value), 'icon that is too long')
    webUiSettingsError = null
  } finally {
    await brandingPage.close()
  }
})

test('overlapping browser name and icon saves keep both server and UI fields across reversed responses', async () => {
  const heldWebUiSettingsSaves = []
  const racePage = await browser.newPage()
  webUiSettings = { instanceName: 'Before name', tabIcon: '🔵' }
  await attachRequestMocks(racePage, { heldWebUiSettingsSaves })
  try {
    await racePage.goto(`${baseUrl}/branding-race/#setup`, { waitUntil: 'networkidle2' })
    await racePage.waitForSelector('[data-webui-branding-settings]')
    await racePage.$eval('#webui-instance-name', (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, 'After name')
    await racePage.click('button::-p-text(Save name)')
    await racePage.$eval('#webui-tab-icon', (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, '🟢')
    await racePage.click('button::-p-text(Save icon)')
    const deadline = Date.now() + 10_000
    while (heldWebUiSettingsSaves.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(heldWebUiSettingsSaves.length, 2)
    assert.deepEqual(heldWebUiSettingsSaves.map(entry => entry.body), [{ instanceName: 'After name' }, { tabIcon: '🟢' }])
    assert.deepEqual(webUiSettings, { instanceName: 'After name', tabIcon: '🟢' })

    await respondJson(heldWebUiSettingsSaves[1].request, { settings: heldWebUiSettingsSaves[1].responseSettings })
    await respondJson(heldWebUiSettingsSaves[0].request, { settings: heldWebUiSettingsSaves[0].responseSettings })
    await racePage.waitForFunction(() => (
      document.querySelector('#webui-instance-name')?.value === 'After name'
      && document.querySelector('#webui-tab-icon')?.value === '🟢'
      && [...document.querySelectorAll('[data-webui-branding-settings] button')].some(button => button.textContent?.trim() === 'Save name')
      && [...document.querySelectorAll('[data-webui-branding-settings] button')].some(button => button.textContent?.trim() === 'Save icon')
    ))

    webUiSettingsError = 'Rejected icon'
    await racePage.$eval('#webui-tab-icon', (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, 'bad icon')
    await racePage.click('button::-p-text(Save icon)')
    await racePage.waitForSelector('[data-webui-branding-settings] [role="alert"]')
    assert.equal(await racePage.$eval('#webui-instance-name', input => input.value), 'After name')
    assert.equal(webUiSettings.instanceName, 'After name')
  } finally {
    webUiSettingsError = null
    await racePage.close()
  }
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

test('Setup editors fill available desktop space and remain scroll-reachable on mobile', async () => {
  const measureEditor = (targetPage, tab) => targetPage.$eval(`[data-setup-section="${tab}"] [data-monaco-model-uri]`, (editor) => {
    const rect = editor.getBoundingClientRect()
    const panel = editor.closest('[role="tabpanel"]')
    const saveButton = panel?.querySelector('button')
    return {
      authoredHeight: editor.style.height,
      width: rect.width,
      height: rect.height,
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      panelClientHeight: panel?.clientHeight || 0,
      panelScrollHeight: panel?.scrollHeight || 0,
      saveTop: saveButton?.getBoundingClientRect().top || 0,
      saveBottom: saveButton?.getBoundingClientRect().bottom || 0,
    }
  })

  const largePage = await browser.newPage()
  await largePage.setViewport({ width: 2560, height: 1440 })
  await attachRequestMocks(largePage)
  try {
    await largePage.goto(`${productionBaseUrl}/?case=large#setup`, { waitUntil: 'networkidle2' })
    for (const tab of ['models', 'config']) {
      await largePage.click(`[data-setup-tab="${tab}"]`)
      await largePage.waitForSelector(`[data-setup-section="${tab}"] [data-editor-ready="true"]`, { timeout: 15_000 })
      const editor = await measureEditor(largePage, tab)
      assert.equal(editor.authoredHeight, '100%')
      assert.ok(editor.width > 1600, `${tab} editor should use the wide desktop pane`)
      assert.ok(editor.height > 600, `${tab} editor should grow beyond the removed 600px cap`)
      assert.ok(editor.width <= editor.viewportWidth)
      assert.ok(editor.documentWidth <= editor.viewportWidth)
    }
    await largePage.setViewport({ width: 1280, height: 800 })
    await largePage.click('[data-setup-tab="models"]')
    await largePage.waitForFunction(() => {
      const editor = document.querySelector('[data-setup-section="models"] [data-monaco-model-uri]')
      return !!editor && editor.getBoundingClientRect().width < 1200
    })
    const regularEditor = await measureEditor(largePage, 'models')
    assert.ok(regularEditor.width > 700)
    assert.ok(regularEditor.height >= 288)
    assert.ok(regularEditor.documentWidth <= regularEditor.viewportWidth)
  } finally {
    await largePage.close()
  }

  const mobilePage = await browser.newPage()
  await mobilePage.setViewport({ width: 390, height: 700 })
  await attachRequestMocks(mobilePage)
  try {
    await mobilePage.goto(`${baseUrl}/mobile/#setup`, { waitUntil: 'networkidle2' })
    for (const tab of ['models', 'config']) {
      await mobilePage.click(`[data-setup-tab="${tab}"]`)
      await mobilePage.waitForSelector(`[data-setup-section="${tab}"] [data-editor-ready="true"]`, { timeout: 15_000 })
      const editor = await measureEditor(mobilePage, tab)
      assert.equal(editor.authoredHeight, '100%')
      assert.ok(editor.height >= 288)
      assert.ok(editor.width <= editor.viewportWidth)
      assert.ok(editor.documentWidth <= editor.viewportWidth)
      await mobilePage.$eval(`[data-setup-section="${tab}"] button`, (button) => button.scrollIntoView({ block: 'nearest' }))
      const saveVisible = await mobilePage.$eval(`[data-setup-section="${tab}"] button`, (button) => {
        const rect = button.getBoundingClientRect()
        return rect.top >= 0 && rect.bottom <= innerHeight
      })
      assert.equal(saveVisible, true)
      assert.ok(editor.panelScrollHeight >= editor.panelClientHeight)
    }
  } finally {
    await mobilePage.close()
  }
})

test('both Setup Monaco editors preserve controlled selection replacement', async () => {
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  const configUri = 'inmemory://foxwarm/setup/foxwarm-config.yaml'
  await page.click('[data-setup-tab="models"]')
  await page.$eval(`[data-monaco-model-uri="${modelsUri}"]`, (editor) => editor.scrollIntoView({ block: 'nearest' }))
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
  await page.$eval(`[data-monaco-model-uri="${configUri}"]`, (editor) => editor.scrollIntoView({ block: 'nearest' }))
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

test('Setup editor Ctrl/Cmd+S shortcuts save once, prevent browser Save, and stay editor-scoped', async () => {
  const shortcutPage = await browser.newPage()
  const heldModelsSaves = []
  const heldConfigSaves = []
  const modelsSaveRequests = []
  const configSaveRequests = []
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  const configUri = 'inmemory://foxwarm/setup/foxwarm-config.yaml'
  await attachRequestMocks(shortcutPage, { heldModelsSaves, heldConfigSaves, modelsSaveRequests, configSaveRequests })

  const recordEditorShortcuts = async (modelUri) => {
    await shortcutPage.$eval(`[data-monaco-model-uri="${modelUri}"]`, (editor) => {
      window.__setupSaveShortcutEvents = []
      editor.addEventListener('keydown', (event) => {
        if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
          window.__setupSaveShortcutEvents.push({
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            repeat: event.repeat,
            defaultPrevented: event.defaultPrevented,
          })
        }
      }, { capture: true })
    })
  }
  const readEditorShortcuts = () => shortcutPage.evaluate(() => window.__setupSaveShortcutEvents || [])

  try {
    await shortcutPage.goto(`${baseUrl}/setup-save-shortcuts/#setup`, { waitUntil: 'networkidle2' })
    await shortcutPage.waitForFunction(() => document.body.textContent?.includes('Foxwarm Setup'), { timeout: 15_000 })
    await shortcutPage.waitForSelector('[data-setup-tab="models"]', { timeout: 15_000 })
    await shortcutPage.click('[data-setup-tab="models"]')
    await shortcutPage.waitForSelector(`[data-monaco-model-uri="${modelsUri}"][data-editor-ready="true"]`, { timeout: 15_000 })
    const modelsYaml = 'default: local/model-a\nproviders:\n  local:\n    models: [model-a]\n'
    await runMonacoEditorAction(shortcutPage, modelsUri, 'replace-value', { value: modelsYaml })
    await runMonacoEditorAction(shortcutPage, modelsUri, 'focus')
    await recordEditorShortcuts(modelsUri)

    await shortcutPage.keyboard.down('Control')
    await shortcutPage.keyboard.down('s')
    await shortcutPage.keyboard.down('s')
    await shortcutPage.keyboard.up('s')
    await shortcutPage.keyboard.up('Control')
    await waitForItems(heldModelsSaves, 1)
    assert.deepEqual(modelsSaveRequests, [{ yaml: modelsYaml }])
    assert.deepEqual((await readEditorShortcuts()).slice(0, 2).map(event => ({ repeat: event.repeat, defaultPrevented: event.defaultPrevented })), [
      { repeat: false, defaultPrevented: true },
      { repeat: true, defaultPrevented: true },
    ])

    await pressSaveShortcut(shortcutPage, 'Control')
    await shortcutPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(heldModelsSaves.length, 1)
    assert.equal(modelsSaveRequests.length, 1)
    assert.equal((await readEditorShortcuts()).at(-1)?.defaultPrevented, true)

    await respondJson(heldModelsSaves[0].request, {
      success: true,
      models: { ...statusPayload.models, rawYaml: heldModelsSaves[0].body.yaml },
    })
    await shortcutPage.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent?.includes('Save models'))
      return button instanceof HTMLButtonElement && !button.disabled
    })

    for (const modifiers of [['Control', 'Shift'], ['Control', 'Alt']]) {
      for (const modifier of modifiers) await shortcutPage.keyboard.down(modifier)
      await shortcutPage.keyboard.press('s')
      for (const modifier of [...modifiers].reverse()) await shortcutPage.keyboard.up(modifier)
    }
    await shortcutPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(modelsSaveRequests.length, 1)
    const composingPrevented = await shortcutPage.$eval(`[data-monaco-model-uri="${modelsUri}"]`, (editor) => {
      const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true })
      editor.dispatchEvent(event)
      return event.defaultPrevented
    })
    assert.equal(composingPrevented, true)
    assert.equal(modelsSaveRequests.length, 1)

    await shortcutPage.click('[data-setup-tab="config"]')
    await shortcutPage.waitForSelector(`[data-monaco-model-uri="${configUri}"][data-editor-ready="true"]`, { timeout: 15_000 })
    const configYaml = 'channels:\n  telegram:\n    enabled: true\n'
    await runMonacoEditorAction(shortcutPage, configUri, 'replace-value', { value: configYaml })
    await runMonacoEditorAction(shortcutPage, configUri, 'focus')
    await recordEditorShortcuts(configUri)
    await pressSaveShortcut(shortcutPage, 'Meta')
    await waitForItems(heldConfigSaves, 1)
    assert.deepEqual(configSaveRequests, [{ yaml: configYaml }])
    assert.deepEqual((await readEditorShortcuts()).map(event => ({ metaKey: event.metaKey, defaultPrevented: event.defaultPrevented })), [
      { metaKey: true, defaultPrevented: true },
    ])

    await pressSaveShortcut(shortcutPage, 'Meta')
    await shortcutPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(heldConfigSaves.length, 1)
    assert.equal(configSaveRequests.length, 1)
    assert.equal((await readEditorShortcuts()).at(-1)?.defaultPrevented, true)
    await respondJson(heldConfigSaves[0].request, { success: true, rawYaml: heldConfigSaves[0].body.yaml, reload: { started: ['telegram'] } })
    await shortcutPage.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent?.includes('Save config'))
      return button instanceof HTMLButtonElement && !button.disabled
    })

    await shortcutPage.click('[data-setup-tab="appearance"]')
    await shortcutPage.waitForSelector('[data-setup-tab="appearance"][aria-selected="true"]')
    const outsidePrevented = await shortcutPage.$eval('[data-setup-tab="appearance"]', (tab) => {
      const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
      tab.dispatchEvent(event)
      return event.defaultPrevented
    })
    const hiddenEditorPrevented = await shortcutPage.$eval(`[data-monaco-model-uri="${modelsUri}"]`, (editor) => {
      const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
      editor.dispatchEvent(event)
      return event.defaultPrevented
    })
    assert.equal(outsidePrevented, false)
    assert.equal(hiddenEditorPrevented, false)
    assert.equal(modelsSaveRequests.length, 1)
    assert.equal(configSaveRequests.length, 1)
  } finally {
    await shortcutPage.close()
  }
})

if (selectedBrowser === 'firefox' || selectedBrowser === 'all') test('Firefox replaces real reverse mouse selections on the first physical key', {
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
    await completionPage.click('[data-setup-tab="models"]')
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

test('provider model completions request only at the active model-id list and preserve unsaved connection context', async () => {
  const completionPage = await browser.newPage()
  const providerModelListRequests = []
  await attachRequestMocks(completionPage, { providerModelListRequests })
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  const firstYaml = `providers:
  open:
    providerType: openai-completions
    baseUrl: https://provider.test/v1
    apiKey: first-secret
    models:
      - 'gpt-5.'
`
  try {
    await completionPage.goto(`${baseUrl}/provider-model-completions/#setup`, { waitUntil: 'networkidle2' })
    await completionPage.click('[data-setup-tab="models"]')
    await completionPage.waitForSelector(`[data-monaco-model-uri="${modelsUri}"][data-editor-ready="true"]`, { timeout: 20_000 })
    assert.equal(providerModelListRequests.length, 0)

    await runMonacoEditorAction(completionPage, modelsUri, 'replace-value', { value: firstYaml })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(providerModelListRequests.length, 0)
    await runMonacoEditorAction(completionPage, modelsUri, 'position', { line: 7, column: 16 })
    await runMonacoEditorAction(completionPage, modelsUri, 'trigger-suggest')
    let requestDeadline = Date.now() + 5_000
    while (providerModelListRequests.length < 1 && Date.now() < requestDeadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(providerModelListRequests.length, 1)
    await completionPage.waitForFunction((expectedLabel) => [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]
      .some((row) => row.textContent?.includes(expectedLabel)), { timeout: 15_000 }, 'gpt-5.6/x')
    await acceptVisibleSuggestion(completionPage, 'gpt-5.6/x')
    assert.deepEqual(providerModelListRequests, [{
      providerType: 'openai-completions',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'first-secret',
    }])
    assert.equal((await runMonacoEditorAction(completionPage, modelsUri, 'snapshot')).value,
      firstYaml.replace("'gpt-5.'", "'gpt-5.6/x'"))

    await runMonacoEditorAction(completionPage, modelsUri, 'position', { line: 7, column: 18 })
    await runMonacoEditorAction(completionPage, modelsUri, 'trigger-suggest')
    await completionPage.waitForSelector('.suggest-widget.visible .monaco-list-row', { timeout: 15_000 })
    await completionPage.keyboard.press('Escape')
    assert.equal(providerModelListRequests.length, 1)

    const changedYaml = firstYaml.replace('first-secret', 'second-secret').replace("'gpt-5.'", "'ft:'")
    await runMonacoEditorAction(completionPage, modelsUri, 'replace-value', { value: changedYaml })
    await runMonacoEditorAction(completionPage, modelsUri, 'position', { line: 7, column: 12 })
    await runMonacoEditorAction(completionPage, modelsUri, 'trigger-suggest')
    requestDeadline = Date.now() + 5_000
    while (providerModelListRequests.length < 2 && Date.now() < requestDeadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(providerModelListRequests.length, 2)
    await completionPage.waitForFunction((expectedLabel) => [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]
      .some((row) => row.textContent?.includes(expectedLabel)), { timeout: 15_000 }, 'ft:gpt-5.6:project')
    await acceptVisibleSuggestion(completionPage, 'ft:gpt-5.6:project')
    assert.equal(providerModelListRequests.length, 2)
    assert.equal(providerModelListRequests[1].apiKey, 'second-secret')
    assert.equal((await runMonacoEditorAction(completionPage, modelsUri, 'snapshot')).value,
      changedYaml.replace("'ft:'", "'ft:gpt-5.6:project'"))

    const requestsBeforeVirtual = providerModelListRequests.length
    const virtualYaml = 'providers:\n  route:\n    providerType: failover\n    targets: [open]\n    models:\n      - should-not-request\n'
    await runMonacoEditorAction(completionPage, modelsUri, 'replace-value', { value: virtualYaml })
    await runMonacoEditorAction(completionPage, modelsUri, 'position', { line: 6, column: 15 })
    await runMonacoEditorAction(completionPage, modelsUri, 'trigger-suggest')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(providerModelListRequests.length, requestsBeforeVirtual)
  } finally {
    await completionPage.close()
  }
})

test('provider model list failure leaves the editor and Save usable', async () => {
  const failurePage = await browser.newPage()
  const providerModelListRequests = []
  await attachRequestMocks(failurePage, { providerModelListRequests, providerModelListError: 'provider unavailable' })
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  const yaml = 'providers:\n  open:\n    providerType: openai\n    apiKey: transient-secret\n    models:\n      - gpt\n'
  try {
    await failurePage.goto(`${baseUrl}/provider-model-failure/#setup`, { waitUntil: 'networkidle2' })
    await failurePage.click('[data-setup-tab="models"]')
    await failurePage.waitForSelector(`[data-monaco-model-uri="${modelsUri}"][data-editor-ready="true"]`, { timeout: 20_000 })
    await runMonacoEditorAction(failurePage, modelsUri, 'replace-value', { value: yaml })
    await runMonacoEditorAction(failurePage, modelsUri, 'position', { line: 6, column: 12 })
    await runMonacoEditorAction(failurePage, modelsUri, 'trigger-suggest')
    const deadline = Date.now() + 5_000
    while (providerModelListRequests.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(providerModelListRequests.length, 1)
    await failurePage.keyboard.type('-manual')
    assert.ok((await runMonacoEditorAction(failurePage, modelsUri, 'snapshot')).value.includes('gpt-manual'))
    await failurePage.click('button::-p-text(Save models)')
    await failurePage.waitForSelector('[data-save-feedback="models"][role="status"]')
  } finally {
    await failurePage.close()
  }
})

test('provider model completion aborts changed connections and canceled lists do not reappear', async () => {
  const cancellationPage = await browser.newPage()
  const heldProviderModelLists = []
  const failedProviderModelLists = []
  cancellationPage.on('requestfailed', (request) => {
    if (new URL(request.url()).pathname.endsWith('/api/setup/models/list')) failedProviderModelLists.push(request)
  })
  await attachRequestMocks(cancellationPage, { heldProviderModelLists })
  const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
  const yamlFor = (apiKey, model = 'draft') => `providers:
  open:
    providerType: openai
    apiKey: ${apiKey}
    models:
      - ${model}
`
  const waitForHeld = async (count) => {
    const deadline = Date.now() + 5_000
    while (heldProviderModelLists.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(heldProviderModelLists.length, count)
  }
  try {
    await cancellationPage.goto(`${baseUrl}/provider-model-cancellation/#setup`, { waitUntil: 'networkidle2' })
    await cancellationPage.click('[data-setup-tab="models"]')
    await cancellationPage.waitForSelector(`[data-monaco-model-uri="${modelsUri}"][data-editor-ready="true"]`, { timeout: 20_000 })

    await runMonacoEditorAction(cancellationPage, modelsUri, 'replace-value', { value: yamlFor('first-secret') })
    await runMonacoEditorAction(cancellationPage, modelsUri, 'position', { line: 6, column: 14 })
    await runMonacoEditorAction(cancellationPage, modelsUri, 'trigger-suggest')
    await waitForHeld(1)

    await runMonacoEditorAction(cancellationPage, modelsUri, 'replace-value', { value: yamlFor('second-secret') })
    await runMonacoEditorAction(cancellationPage, modelsUri, 'position', { line: 6, column: 14 })
    await runMonacoEditorAction(cancellationPage, modelsUri, 'trigger-suggest')
    await waitForHeld(2)
    const abortDeadline = Date.now() + 5_000
    while (failedProviderModelLists.length === 0 && Date.now() < abortDeadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(failedProviderModelLists.length, 1)
    assert.equal(heldProviderModelLists[1].body.apiKey, 'second-secret')
    await respondJson(heldProviderModelLists[1].request, { models: ['second-model'] })
    await new Promise(resolve => setTimeout(resolve, 200))

    await runMonacoEditorAction(cancellationPage, modelsUri, 'replace-value', { value: yamlFor('third-secret') })
    await runMonacoEditorAction(cancellationPage, modelsUri, 'position', { line: 6, column: 14 })
    await runMonacoEditorAction(cancellationPage, modelsUri, 'trigger-suggest')
    await waitForHeld(3)
    await cancellationPage.keyboard.press('Escape')
    await respondJson(heldProviderModelLists[2].request, { models: ['must-not-reappear'] })
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(await cancellationPage.$$eval('.suggest-widget.visible .monaco-list-row', (rows) => rows
      .some((row) => row.textContent?.includes('must-not-reappear'))), false)
  } finally {
    await cancellationPage.close()
  }
})

test('raw model save remains enabled and preserves editor text', async () => {
  // Establish the pristine precondition explicitly so an earlier Monaco failure cannot
  // leak a dirty editor into this save assertion.
  await page.click('[data-setup-tab="models"]')
  await page.click('button::-p-text(Refresh)')
  await waitForMonacoValue(page, 'inmemory://foxwarm/setup/foxwarm-models.yaml', statusPayload.models.rawYaml)
  const saveButton = await page.waitForSelector('button::-p-text(Save models)')
  assert.equal(await saveButton.evaluate((button) => button.disabled), false)
  await saveButton.evaluate((button) => button.scrollIntoView({ block: 'nearest' }))
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
    await productionPage.click('[data-setup-tab="models"]')
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

test('channel property completions follow each instance type and canonical-key fallback', async () => {
  const completionPage = await browser.newPage()
  await completionPage.setBypassServiceWorker(true)
  await attachRequestMocks(completionPage)
  const configUri = 'inmemory://foxwarm/setup/foxwarm-config.yaml'
  const assertSuggestions = async (yaml, line, expected, excluded) => {
    await runMonacoEditorAction(completionPage, configUri, 'replace-value', { value: yaml })
    const suggestions = await readVisibleSuggestions(completionPage, configUri, { line, column: 5 })
    for (const name of expected) assert.ok(suggestions.some((text) => text.includes(name)), `${name} missing from ${suggestions.join(' | ')}`)
    for (const name of excluded) assert.equal(suggestions.some((text) => text.includes(name)), false, `${name} leaked into ${suggestions.join(' | ')}`)
  }
  try {
    await completionPage.goto(`${baseUrl}/channel-completions/#setup`, { waitUntil: 'networkidle2' })
    await completionPage.click('[data-setup-tab="config"]')
    await completionPage.waitForSelector(`[data-monaco-model-uri="${configUri}"][data-editor-ready="true"]`, { timeout: 20_000 })

    await assertSuggestions('channels:\n  primary:\n    type: telegram\n    \n  secondary:\n    type: matrix\n    \n', 4,
      ['botToken', 'enabled'], ['homeserver', 'appId', 'webhookUrl'])
    await assertSuggestions('channels:\n  primary:\n    type: telegram\n    \n  secondary:\n    type: matrix\n    \n', 7,
      ['homeserver', 'enabled'], ['botToken', 'appId', 'webhookUrl'])
    await assertSuggestions('channels:\n  primary:\n    type: qqbot\n    \n', 4,
      ['appId', 'media'], ['botToken', 'homeserver', 'webhookUrl'])
    await assertSuggestions('channels:\n  custom:\n    type: company-platform\n    \n', 4,
      ['enabled', 'channelProgress'], ['botToken', 'homeserver', 'appId', 'webhookUrl'])
    await assertSuggestions('channels:\n  qqbot:\n    type: ""\n    \n', 4,
      ['appId', 'enabled'], ['botToken', 'homeserver'])
    await assertSuggestions('channels:\n  telegram:\n    \n', 3,
      ['botToken', 'enabled'], ['homeserver', 'appId'])
    await assertSuggestions('channels:\n  telegram:\n    type: matrix\n    \n', 4,
      ['homeserver', 'enabled'], ['botToken', 'appId'])
  } finally {
    await completionPage.close()
  }
})

test('backend validation error remains final authority and is shown after Monaco diagnostics', async () => {
  // Restore the pristine precondition and always clear the injected mock error, so a
  // failed assertion cannot leak either the dirty editor or `saveError` into later tests.
  await page.click('[data-setup-tab="models"]')
  await page.click('button::-p-text(Refresh)')
  await waitForMonacoValue(page, 'inmemory://foxwarm/setup/foxwarm-models.yaml', statusPayload.models.rawYaml)
  saveError = 'canonical backend rejected the models config'
  try {
    const saveButton = await page.waitForSelector('button::-p-text(Save models)')
    await saveButton.evaluate((button) => button.scrollIntoView({ block: 'nearest' }))
    await saveButton.click()
    const feedback = await page.waitForSelector('[data-save-feedback="models"][role="alert"]')
    assert.ok((await feedback.evaluate((element) => element.textContent || '')).includes('canonical backend rejected the models config'))
    assert.equal(await feedback.evaluate((element) => element.closest('[data-setup-section]')?.getAttribute('data-setup-section')), 'models')
    assert.deepEqual(savedRequest, { yaml: statusPayload.models.rawYaml })
    await runMonacoEditorAction(page, 'inmemory://foxwarm/setup/foxwarm-models.yaml', 'position', { line: 1, column: statusPayload.models.rawYaml.split('\n')[0].length + 1 })
    await page.keyboard.type('#')
    await page.waitForFunction(() => !document.querySelector('[data-save-feedback="models"]'))
  } finally {
    saveError = null
  }
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
    await racePage.click('[data-setup-tab="models"]')
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
  const modelsSaveRequests = []
  const configSaveRequests = []
  await degradedPage.setCacheEnabled(false)
  await attachRequestMocks(degradedPage, { blockEditorChunks: true, oobe: true, modelsSaveRequests, configSaveRequests })
  try {
    await degradedPage.goto(`${baseUrl}/degraded/#setup`, { waitUntil: 'networkidle2' })
    await degradedPage.waitForFunction(() => document.body.textContent?.includes('Foxwarm first-time setup'), { timeout: 15_000 })
    await degradedPage.waitForSelector('[data-setup-tab="models"] [data-setup-tab-status="attention"]')
    await degradedPage.click('[data-setup-tab="models"]')
    const forcedSetupClose = await degradedPage.waitForSelector('[data-tab-id="system:setup"] button[title="Close tab"]')
    await forcedSetupClose.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(await degradedPage.$('[data-tab-id="system:setup"]'))
    const fallback = await degradedPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-fallback="true"] textarea', { timeout: 15_000 })
    assert.ok((await degradedPage.$eval('body', (body) => body.textContent || '')).includes('Advanced editor features are unavailable. You can still edit and save this YAML.'))
    const fallbackHeight = await degradedPage.$eval('[data-editor-fallback="true"]', (editor) => ({
      height: Number.parseFloat(getComputedStyle(editor).height),
      authoredHeight: editor.style.height,
    }))
    assert.equal(fallbackHeight.authoredHeight, '100%')
    assert.ok(fallbackHeight.height >= 288)

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
    await fallback.evaluate((textarea) => {
      window.__fallbackSaveShortcutEvents = []
      textarea.addEventListener('keydown', (event) => {
        if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
          window.__fallbackSaveShortcutEvents.push({ ctrlKey: event.ctrlKey, metaKey: event.metaKey, defaultPrevented: event.defaultPrevented })
        }
      }, { capture: true })
      textarea.focus()
    })
    await pressSaveShortcut(degradedPage, 'Control')
    await degradedPage.waitForFunction(() => document.body.textContent?.includes('Models saved.'))
    assert.deepEqual(savedRequest, { yaml })
    assert.deepEqual(modelsSaveRequests, [{ yaml }])
    assert.deepEqual(await degradedPage.evaluate(() => window.__fallbackSaveShortcutEvents), [
      { ctrlKey: true, metaKey: false, defaultPrevented: true },
    ])

    await degradedPage.click('[data-setup-tab="config"]')
    const configFallback = await degradedPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-config.yaml"][data-editor-fallback="true"]', { timeout: 15_000 })
    const configFallbackHeight = await configFallback.evaluate((editor) => ({
      height: Number.parseFloat(getComputedStyle(editor).height),
      authoredHeight: editor.style.height,
    }))
    assert.equal(configFallbackHeight.authoredHeight, '100%')
    assert.ok(configFallbackHeight.height >= 288)
    await degradedPage.$eval('button::-p-text(Save config)', (button) => button.scrollIntoView({ block: 'nearest' }))
    assert.equal(await degradedPage.$eval('button::-p-text(Save config)', (button) => {
      const rect = button.getBoundingClientRect()
      return rect.top >= 0 && rect.bottom <= innerHeight
    }), true)
    const configYaml = 'channels:\n  telegram:\n    enabled: true\n'
    const configTextarea = await configFallback.$('textarea')
    await configTextarea.evaluate((textarea, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      window.__fallbackSaveShortcutEvents = []
      textarea.addEventListener('keydown', (event) => {
        if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey)) {
          window.__fallbackSaveShortcutEvents.push({ ctrlKey: event.ctrlKey, metaKey: event.metaKey, defaultPrevented: event.defaultPrevented })
        }
      }, { capture: true })
      textarea.focus()
    }, configYaml)
    await pressSaveShortcut(degradedPage, 'Meta')
    await degradedPage.waitForFunction(() => document.body.textContent?.includes('Config saved. Active channels refreshed: telegram.'))
    assert.deepEqual(configSaveRequests, [{ yaml: configYaml }])
    assert.deepEqual(await degradedPage.evaluate(() => window.__fallbackSaveShortcutEvents), [
      { ctrlKey: false, metaKey: true, defaultPrevented: true },
    ])
  } finally {
    await degradedPage.close()
  }
})

test('embedded model filter selects one result and keeps the accessible Setup bridge', async () => {
  const hostPage = await browser.newPage()
  await hostPage.setBypassServiceWorker(true)
  await hostPage.setViewport({ width: 390, height: 700 })
  const heldModelOptionsResponses = []
  await attachRequestMocks(hostPage, { staleEffort: true, heldModelOptionsResponses })
  const modelOptionsRequested = hostPage.waitForRequest(request => (
    new URL(request.url()).pathname.endsWith('/api/models') && request.frame()?.url().includes('foxwarmEmbed=chat')
  ))
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
    // Opening the popup/focusing search does not imply the async model catalog is ready.
    await modelOptionsRequested
    assert.equal(heldModelOptionsResponses.length, 1)
    assert.equal(await chatFrame.$$eval('[data-model-option-row="true"]', rows => rows.length), 1)
    await heldModelOptionsResponses[0]()
    await chatFrame.waitForFunction(() => (
      ['leaf/model-a', 'leaf/model-b', 'sticky', 'route'].every(key => (
        [...document.querySelectorAll('[data-model-column="current"] [data-model-option-key]')]
          .some(row => row.getAttribute('data-model-option-key') === key)
      ))
    ))

    const configure = await chatFrame.waitForSelector('button[aria-label="Configure models"]', { timeout: 15_000 })
    assert.equal((await configure.evaluate((button) => button.textContent || '')).trim(), '')
    assert.equal(await configure.evaluate((button) => button.title), 'Configure models')
    const popupState = await chatFrame.$eval('[data-model-selector-popup="true"]', (popup) => {
      const rect = popup.getBoundingClientRect()
      const columns = popup.querySelectorAll('[data-model-column]')
      return {
        withinViewport: rect.left >= 0 && rect.right <= window.innerWidth,
        columnCount: columns.length,
        optionCount: popup.querySelectorAll('[data-model-option-row="true"]').length,
        currentEffortCount: popup.querySelectorAll('input[type="range"][aria-label="Current effort"]').length,
        childEffortCount: popup.querySelectorAll('input[type="range"][aria-label="Child effort"]').length,
      }
    })
    assert.equal(popupState.withinViewport, true)
    assert.equal(popupState.columnCount, 1)
    assert.ok(popupState.optionCount >= 5)
    assert.equal(popupState.currentEffortCount, 1)
    assert.equal(popupState.childEffortCount, 0)

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
    const currentEffort = await chatFrame.waitForSelector('input[type="range"][aria-label="Current effort"]')
    assert.equal(await currentEffort.evaluate(input => input.value), '0')
    assert.match(await currentEffort.evaluate(input => input.getAttribute('aria-valuetext') || ''), /unavailable/)

    const effortUpdatesBefore = modelUpdateRequests.length
    await currentEffort.evaluate((input) => { input.value = '1'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })) })
    const effortDeadline = Date.now() + 5_000
    while (modelUpdateRequests.length === effortUpdatesBefore && Date.now() < effortDeadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(modelUpdateRequests.at(-1), {
      path: '/preview/api/sessions/embedded%2Fchat/model',
      body: { effort: 'low' },
    })

    await chatFrame.click('[data-model-child-mode="specific"]')
    await chatFrame.waitForSelector('[data-model-child-mode="follow"]')
    assert.ok(await chatFrame.$('input[aria-label="Filter models"]'))
    assert.ok(await chatFrame.$('input[aria-label="Filter child models"]'))
    const childFilter = await chatFrame.$('input[aria-label="Filter child models"]')
    await childFilter.type('model-b')
    await chatFrame.waitForFunction(() => document.querySelectorAll('[data-model-column="child"] [data-model-option-row]').length === 1)
    assert.equal(await chatFrame.$eval('input[aria-label="Filter models"]', input => input.value), '')
    assert.equal(await chatFrame.$$eval('[data-model-column="current"] [data-model-option-row]', nodes => nodes.length), 5)
    assert.ok(await chatFrame.$eval('[data-model-selector-popup="true"]', popup => {
      const rect = popup.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= innerWidth && popup.scrollWidth <= popup.clientWidth
    }))

    const childEffort = await chatFrame.waitForSelector('input[type="range"][aria-label="Child effort"]')
    assert.equal(await childEffort.evaluate(input => input.value), '0')
    assert.match(await childEffort.evaluate(input => input.getAttribute('aria-valuetext') || ''), /unavailable/)
    await childEffort.evaluate((input) => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })) })
    const childEffortDeadline = Date.now() + 5_000
    while (modelUpdateRequests.at(-1)?.body?.childEffortDefault !== 'none' && Date.now() < childEffortDeadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(modelUpdateRequests.at(-1), {
      path: '/preview/api/sessions/embedded%2Fchat/child-model',
      body: { childEffortDefault: 'none' },
    })
    await chatFrame.waitForFunction(() => document.querySelector('button[aria-haspopup="dialog"]')?.textContent?.includes('Low'))
    assert.ok(await chatFrame.$('[data-model-trigger-child="true"]'))

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
    await hostPage.close()
  }
})

test('embedded Setup defaults to Appearance and explicit host focus activates Models', async () => {
  const hostPage = await browser.newPage()
  await hostPage.setBypassServiceWorker(true)
  await hostPage.setViewport({ width: 2560, height: 1440 })
  await attachRequestMocks(hostPage)
  const nonce = 'abcdef0123456789abcdef0123456789'
  try {
    await hostPage.goto(`${baseUrl}/preview/host`, { waitUntil: 'networkidle2' })
    await hostPage.evaluate(({ src }) => {
      document.body.replaceChildren()
      const iframe = document.createElement('iframe')
      iframe.id = 'embedded-setup-focus'
      iframe.src = src
      iframe.style.cssText = 'border:0;width:100vw;height:100vh'
      document.body.appendChild(iframe)
    }, { src: `${baseUrl}/preview/?foxwarmEmbed=setup&foxwarmEmbedNonce=${nonce}` })
    const setupFrame = await hostPage.waitForFrame(frame => frame.url().includes('foxwarmEmbed=setup'))
    await setupFrame.waitForSelector('[data-setup-tab="appearance"][aria-selected="true"]', { timeout: 15_000 })
    await hostPage.evaluate(({ bridgeNonce }) => {
      const iframe = document.getElementById('embedded-setup-focus')
      iframe?.contentWindow?.postMessage({ channel: 'foxwarm-webui-host', version: 1, nonce: bridgeNonce, type: 'focus-models' }, '*')
    }, { bridgeNonce: nonce })
    await setupFrame.waitForSelector('[data-setup-tab="models"][aria-selected="true"]', { timeout: 15_000 })
    await setupFrame.waitForFunction(() => !!document.activeElement?.closest('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]'), { timeout: 15_000 })
    const editorSize = await setupFrame.$eval('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"]', (editor) => {
      const rect = editor.getBoundingClientRect()
      return { width: rect.width, height: rect.height, documentWidth: document.documentElement.scrollWidth }
    })
    assert.ok(editorSize.width > 2000)
    assert.ok(editorSize.height > 600)
    assert.ok(editorSize.documentWidth <= 2560)
  } finally {
    await hostPage.close()
  }
})

test('model columns preserve child policy and commit effort only after dragging ends', async () => {
  const desktopPage = await browser.newPage()
  await desktopPage.setViewport({ width: 900, height: 700 })
  await attachRequestMocks(desktopPage)
  try {
    await desktopPage.goto(`${baseUrl}/normal/#session/model-effort-default-desktop`, { waitUntil: 'networkidle2' })
    const modelButton = await desktopPage.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
    await modelButton.click()
    await desktopPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    await desktopPage.click('button[title="leaf/model-a"]')
    await desktopPage.waitForFunction(() => document.querySelector('[data-model-option-key="leaf/model-a"]')?.getAttribute('data-model-option-selected') === 'true')
    assert.equal(await desktopPage.$$eval('input[type="range"][aria-label="Current effort"]', nodes => nodes.length), 1)
    assert.equal(await desktopPage.$$eval('input[type="range"][aria-label="Child effort"]', nodes => nodes.length), 0)

    const popupHeight = await desktopPage.$eval('[data-model-selector-popup="true"]', el => el.getBoundingClientRect().height)
    await desktopPage.click('[data-model-child-mode="specific"]')
    await desktopPage.waitForSelector('[data-model-column="child"]')
    assert.equal(await desktopPage.$$eval('input[type="range"][aria-label="Current effort"]', nodes => nodes.length), 1)
    assert.equal(await desktopPage.$$eval('input[type="range"][aria-label="Child effort"]', nodes => nodes.length), 1)
    assert.equal(await desktopPage.$eval('[data-model-selector-popup="true"]', el => el.getBoundingClientRect().height), popupHeight)
    await desktopPage.keyboard.press('Escape')
    await desktopPage.click('[data-model-trigger-child="true"]')
    await desktopPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter child models"]'))
    assert.ok(await desktopPage.$('[data-model-column="child"]'))
    const slider = await desktopPage.$('input[type="range"][aria-label="Child effort"]')
    const rect = await slider.boundingBox()
    const beforeDrag = modelUpdateRequests.length
    await desktopPage.mouse.move(rect.x + 11, rect.y + rect.height / 2)
    await desktopPage.mouse.down()
    await desktopPage.mouse.move(rect.x + rect.width * 0.5, rect.y + rect.height / 2, { steps: 4 })
    assert.equal(modelUpdateRequests.length, beforeDrag)
    assert.equal(await slider.evaluate(input => input.disabled), false)
    const midDragRect = await slider.boundingBox()
    assert.ok(Math.abs(midDragRect.x - rect.x) < 1 && Math.abs(midDragRect.width - rect.width) < 1,
      'changing effort labels must not move or resize the slider during dragging')
    await desktopPage.mouse.move(rect.x + rect.width - 11, rect.y + rect.height / 2, { steps: 4 })
    assert.equal(modelUpdateRequests.length, beforeDrag)
    await desktopPage.mouse.up()
    await desktopPage.waitForFunction(() => document.querySelector('input[type="range"][aria-label="Child effort"]')?.getAttribute('aria-valuetext')?.toLowerCase().includes('high'))
    assert.equal(modelUpdateRequests.length, beforeDrag + 1)
    await desktopPage.waitForSelector('[data-model-child-mode="follow"]:not(:disabled)')
    await desktopPage.click('[data-model-child-mode="follow"]')
    await desktopPage.waitForSelector('[data-model-column="child"]', { hidden: true })
    assert.equal(await desktopPage.$('[data-model-trigger-child="true"]'), null)
    assert.equal(await desktopPage.$eval('[data-model-selector-popup="true"]', el => el.getBoundingClientRect().height), popupHeight)


  } finally {
    await desktopPage.close()
  }
})

test('desktop model popup remains bounded and supports single-selection rows', async () => {
  const desktopPage = await browser.newPage()
  await desktopPage.setViewport({ width: 1000, height: 700 })
  await attachRequestMocks(desktopPage)
  try {
    await desktopPage.goto(`${baseUrl}/normal/#session/model-popup-geometry`, { waitUntil: 'networkidle2' })
    await desktopPage.click('button[aria-haspopup="dialog"]')
    await desktopPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    const bounded = await desktopPage.$eval('[data-model-selector-popup="true"]', (popup) => {
      const rect = popup.getBoundingClientRect()
      const scroll = popup.querySelector('[data-model-selector-scroll="true"]')
      const footer = popup.querySelector('[data-model-effort-footer="true"]')
      return {
        inViewport: rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
        footerOutsideScroll: !!scroll && !!footer && !scroll.contains(footer),
      }
    })
    assert.equal(bounded.inViewport, true)
    assert.equal(bounded.footerOutsideScroll, true)
    await desktopPage.click('button[title="leaf/model-a"]')
    await desktopPage.waitForFunction(() => document.querySelector('[data-model-option-key="leaf/model-a"]')?.getAttribute('data-model-option-selected') === 'true')
    assert.equal(await desktopPage.$$eval('[data-model-option-selected="true"]', nodes => nodes.length), 1)
  } finally {
    await desktopPage.close()
  }
})

test('normal Chat keeps the icon-only model settings callback and singleton Setup focus', async () => {
  const normalPage = await browser.newPage()
  await attachRequestMocks(normalPage)
  try {
    await normalPage.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('foxwarm_theme_selection_v2', JSON.stringify({ version: 2, themeId: 'foxwarm.550a', colorMode: 'auto' }))
      } catch {}
    })
    await normalPage.goto(`${baseUrl}/normal/#session/model-filter-normal`, { waitUntil: 'networkidle2' })
    const modelButton = await normalPage.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
    await modelButton.click()
    await normalPage.waitForFunction(() => document.activeElement?.matches('input[aria-label="Filter models"]'))
    const pickerState = await normalPage.$eval('[data-model-selector-popup="true"]', (popup) => ({
      treatment: document.documentElement.getAttribute('data-foxwarm-component-treatment'),
      columnCount: popup.querySelectorAll('[data-model-column]').length,
      currentEffortCount: popup.querySelectorAll('input[type="range"][aria-label="Current effort"]').length,
      childEffortCount: popup.querySelectorAll('input[type="range"][aria-label="Child effort"]').length,
      configureCount: popup.querySelectorAll('button[aria-label="Configure models"]').length,
      refreshCount: popup.querySelectorAll('button[aria-label="Refresh models"]').length,
    }))
    assert.equal(pickerState.treatment, 'console')
    assert.equal(pickerState.columnCount, 1)
    assert.equal(pickerState.currentEffortCount, 1)
    assert.equal(pickerState.childEffortCount, 0)
    assert.equal(pickerState.configureCount, 1)
    assert.equal(pickerState.refreshCount, 1)
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

test('effort dragging saves concrete levels without flashing, and automatic mode is independent', async () => {
  const p = await browser.newPage()
  const held = []
  await p.setViewport({ width: 1000, height: 700 })
  await attachRequestMocks(p, { heldEffortRequests: held })
  try {
    await p.goto(`${baseUrl}/normal/#session/effort-interaction`, { waitUntil: 'networkidle2' })
    await p.click('button[aria-haspopup="dialog"]')
    await p.waitForSelector('button[title="leaf/model-a"]')
    await p.click('button[title="leaf/model-a"]')
    const sliderSelector = 'input[aria-label="Current effort"]'
    await p.waitForFunction(sel => document.querySelector(sel)?.value === '2' && !document.querySelector(sel)?.disabled, {}, sliderSelector)
    const slider = await p.$(sliderSelector)
    const originalBox = await slider.boundingBox()
    const before = modelUpdateRequests.length
    await p.mouse.move(originalBox.x + originalBox.width - 11, originalBox.y + originalBox.height / 2)
    await p.mouse.down()
    await p.mouse.move(originalBox.x + originalBox.width / 2, originalBox.y + originalBox.height / 2, { steps: 5 })
    assert.equal(modelUpdateRequests.length, before)
    assert.match(await slider.evaluate(el => el.getAttribute('aria-valuetext')), /low/)
    await p.mouse.up()
    await p.waitForFunction(sel => document.querySelector(sel)?.disabled, {}, sliderSelector)
    assert.deepEqual(modelUpdateRequests.at(-1).body, { effort: 'low' })
    assert.match(await slider.evaluate(el => el.getAttribute('aria-valuetext')), /low/)
    assert.equal(await slider.evaluate(el => getComputedStyle(el).opacity), '1')
    assert.equal(await p.$eval('[data-model-option-row]', el => getComputedStyle(el).opacity), '1')
    const savingBox = await slider.boundingBox()
    assert.equal(savingBox.x, originalBox.x)
    assert.equal(savingBox.width, originalBox.width)
    assert.ok(held.length)
    await held.shift()()
    await p.waitForFunction(sel => !document.querySelector(sel)?.disabled, {}, sliderSelector)
    assert.equal(await slider.evaluate(el => el.value), '1')
    assert.match(await slider.evaluate(el => el.getAttribute('aria-valuetext')), /low/)

    // Auto is an explicit action, and previews the configured High, not old Low.
    await p.click('button[aria-label="Current: Use model default"]')
    await p.waitForFunction(sel => document.querySelector(sel)?.disabled, {}, sliderSelector)
    assert.deepEqual(modelUpdateRequests.at(-1).body, { effort: null })
    assert.match(await slider.evaluate(el => el.getAttribute('aria-valuetext')), /high/)
    await held.shift()()
    await p.waitForFunction(sel => !document.querySelector(sel)?.disabled, {}, sliderSelector)
    assert.equal(await slider.evaluate(el => el.value), '2')

    // Lowest concrete level (Off in this model) never submits a default clear.
    const box = await slider.boundingBox()
    await p.mouse.click(box.x + 2, box.y + box.height / 2)
    await p.waitForFunction(sel => document.querySelector(sel)?.disabled, {}, sliderSelector)
    assert.deepEqual(modelUpdateRequests.at(-1).body, { effort: 'none' })
    await held.shift()(true)
    await p.waitForFunction(sel => !document.querySelector(sel)?.disabled, {}, sliderSelector)
    assert.equal(await slider.evaluate(el => el.value), '2')
    assert.match(await p.$eval('[data-model-selector-popup]', el => el.textContent), /Effort save rejected/)
  } finally {
    await p.close()
  }
})
