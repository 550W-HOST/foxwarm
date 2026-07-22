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
  await attachRequestMocks(page)

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

test('OOBE remains editable and savable when Monaco or YAML chunks cannot load', async () => {
  const degradedPage = await browser.newPage()
  await degradedPage.setCacheEnabled(false)
  await attachRequestMocks(degradedPage, { blockEditorChunks: true, oobe: true })
  try {
    await degradedPage.goto(`${baseUrl}/degraded/#setup`, { waitUntil: 'networkidle2' })
    const fallback = await degradedPage.waitForSelector('[data-monaco-model-uri="inmemory://foxwarm/setup/foxwarm-models.yaml"][data-editor-fallback="true"] textarea', { timeout: 15_000 })
    assert.ok((await degradedPage.$eval('body', (body) => body.textContent || '')).includes('Plain-text editing and backend validation still work.'))
    const yaml = 'default: local\nproviders:\n  local:\n    providerType: openai-completions\n    models: [model-a]\n'
    await fallback.evaluate((textarea, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }, yaml)
    await degradedPage.click('button::-p-text(Save models)')
    await degradedPage.waitForFunction(() => document.body.textContent?.includes('Models saved to'))
    assert.deepEqual(savedRequest, { yaml })
  } finally {
    await degradedPage.close()
  }
})

test('embedded Chat requests focused Models Setup and embedded Setup accepts the nonce-bound focus signal', async () => {
  const hostPage = await browser.newPage()
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
      document.body.appendChild(iframe)
    }, { src: `${baseUrl}/preview/?foxwarmEmbed=chat&foxwarmEmbedNonce=${nonce}&sessionId=embedded%2Fchat` })
    const chatFrame = await hostPage.waitForFrame((frame) => frame.url().includes('foxwarmEmbed=chat'))
    const modelButton = await chatFrame.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 15_000 })
    await modelButton.click()
    const configure = await chatFrame.waitForSelector('button::-p-text(Configure models…)', { timeout: 15_000 })
    await configure.click()
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
