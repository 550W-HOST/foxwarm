import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const port = 4176
const baseUrl = `http://127.0.0.1:${port}`
const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'

let vite
let browser
let page
let savedRequest
let savedRequestPath
let saveError = null
const requestPaths = []

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

async function waitForServer() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite dev server did not start')
}

function respondJson(request, body, status = 200) {
  return request.respond({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

before(async () => {
  vite = spawn(path.join(webuiRoot, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(port)], {
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
  await page.setRequestInterception(true)
  page.on('request', (request) => {
    const url = new URL(request.url())
    requestPaths.push(url.pathname)
    if (!url.pathname.includes('/api/')) {
      void request.continue()
      return
    }
    if (url.pathname.endsWith('/api/setup/status')) {
      void respondJson(request, statusPayload)
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

  await page.goto(`${baseUrl}/preview/#setup`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.textContent?.includes('Foxwarm Setup'), { timeout: 15_000 })
  await page.waitForSelector('[data-monaco-model-uri][data-editor-ready="true"]', { timeout: 15_000 })
})

after(async () => {
  await browser?.close()
  vite?.kill('SIGTERM')
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

test('backend validation error remains final authority and is shown after Monaco diagnostics', async () => {
  saveError = 'canonical backend rejected the models config'
  const saveButton = await page.waitForSelector('button::-p-text(Save models)')
  await saveButton.click()
  await page.waitForFunction(() => document.body.textContent?.includes('canonical backend rejected the models config'))
  assert.deepEqual(savedRequest, { yaml: statusPayload.models.rawYaml })
  saveError = null
})
