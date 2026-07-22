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

const statusPayload = {
  oobe: false,
  models: {
    exists: true,
    path: 'state/models.yaml',
    templatePath: 'templates/models.example.yaml',
    providerCount: 3,
    defaultModel: 'route',
    rawYaml: 'default: route\nproviders: {}\n',
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
      savedRequest = JSON.parse(request.postData() || '{}')
      void respondJson(request, { success: true, models: { ...statusPayload.models, rawYaml: 'saved' } })
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

  await page.goto(`${baseUrl}/#setup`, { waitUntil: 'networkidle2' })
  await page.waitForFunction(() => document.body.textContent?.includes('Foxwarm Setup'), { timeout: 15_000 })
  const formButton = await page.waitForSelector('button::-p-text(Form)')
  await formButton.click()
})

after(async () => {
  await browser?.close()
  vite?.kill('SIGTERM')
})

test('virtual setup cards hydrate discriminated controls, disable transient tests, and submit only routing fields', async () => {
  const stickyTab = await page.waitForSelector('button::-p-text(sticky)')
  await stickyTab.click()
  await page.waitForFunction(() => document.body.textContent?.includes('Session hash requires at least one concrete target.'))

  const stickyInputs = await page.$$eval('input', (inputs) => inputs.map((input) => ({ type: input.type, value: input.value })))
  assert.equal(stickyInputs.some((input) => input.type === 'password'), false)
  const testButton = await page.waitForSelector('button::-p-text(Test selected provider)')
  assert.equal(await testButton.evaluate((button) => button.disabled), true)
  assert.ok((await page.$eval('body', (body) => body.textContent)).includes('Save virtual providers, then test them through normal model selection.'))

  const suggestionOptions = await page.$$eval('option', (options) => options.map((option) => option.value))
  assert.ok(suggestionOptions.includes('leaf/model-a'))
  assert.ok(suggestionOptions.includes('leaf/model-b'))
  assert.equal(suggestionOptions.includes('route'), false)
  assert.equal(suggestionOptions.includes('sticky'), false)

  const routeTab = await page.waitForSelector('button::-p-text(route)')
  await routeTab.click()
  await page.waitForFunction(() => document.body.textContent?.includes('Failover requires at least two concrete targets in priority order.'))
  const numbers = await page.$$eval('input[type=number]', (inputs) => inputs.map((input) => input.value))
  assert.deepEqual(numbers, ['5', '600000'])

  await page.$$eval('input[type=number]', (inputs) => inputs.forEach((input) => {
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }))
  const saveButton = await page.waitForSelector('button::-p-text(Save models)')
  await saveButton.click()
  await page.waitForFunction(() => document.body.textContent?.includes('Models saved to'))

  const route = savedRequest.providers.find((provider) => provider.id === 'route')
  assert.deepEqual(route, {
    id: 'route',
    providerType: 'failover',
    isVirtual: true,
    targets: ['leaf/model-a', 'leaf/model-b'],
  })
  assert.equal(Object.hasOwn(route, 'baseUrl'), false)
  assert.equal(Object.hasOwn(route, 'apiKey'), false)
  assert.equal(Object.hasOwn(route, 'models'), false)
})
