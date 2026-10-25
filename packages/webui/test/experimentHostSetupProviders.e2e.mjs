import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { writeModelFixture } from './experimentModelFixture.mjs'
import { createHostFixture, until, saveModelsInOriginalApp } from './experimentHostFixture.mjs'

const listToken = 'setup-list-token'
const testToken = 'setup-test-token'
const modelsUri = 'inmemory://foxwarm/setup/foxwarm-models.yaml'
let provider, browserPage
const listRequests = []
const testRequests = []
let listErrorHits = 0
let testErrorHits = 0
const fixture = await createHostFixture('setup-providers', { onPage: page => { browserPage = page } })

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendCompletion(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
  response.write(`data: ${JSON.stringify({
    type: 'response.completed',
    response: {
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 8 }, output_tokens: 5 },
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'setup test response' }],
      }],
    },
  })}\n\n`)
  response.end()
}

try {
  provider = createServer(async (request, response) => {
    if (request.method === 'GET' && (request.url === '/models' || request.url?.startsWith('/v1/models?'))) {
      const anthropic = request.url.startsWith('/v1/models?')
      const overridden = request.headers['x-fixture-mode'] === 'override'
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      assert.equal(Buffer.concat(chunks).length, 0)
      assert.equal(request.headers.authorization, anthropic ? undefined : `Bearer ${overridden ? 'override-list' : listToken}`)
      assert.equal(request.headers['x-api-key'], anthropic ? listToken : undefined)
      if (overridden) {
        assert.equal(request.headers['content-type'], 'application/custom')
        assert.equal(request.headers['content-language'], 'en')
      }
      if (anthropic) assert.equal(request.headers['anthropic-version'], '2023-06-01')
      listRequests.push({ url: request.url, anthropic })
      return sendJson(response, 200, {
        data: [
          null,
          7,
          'plain-model',
          { id: 'setup-discovered-model' },
          { id: 'setup-discovered-model' },
          { id: '' },
          { id: 'setup-second-model' },
        ],
      })
    }
    if (request.method === 'GET' && request.url === '/error-models/models') {
      listErrorHits += 1
      return sendJson(response, 401, { error: `invalid ${listToken}` })
    }
    if (request.method === 'GET' && request.url === '/oversized-models/models') {
      const body = 'x'.repeat(1024 * 1024 + 1)
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(body.length) })
      return response.end(body)
    }
    if (request.method === 'POST' && request.url === '/responses') {
      assert.equal(request.headers.authorization, `Bearer ${testToken}`)
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw)
      assert.ok(['other-model', 'priced-model'].includes(body.model))
      testRequests.push(body)
      return sendCompletion(response)
    }
    if (request.method === 'POST' && request.url === '/error-responses/responses') {
      testErrorHits += 1
      return sendJson(response, 401, { error: `invalid ${testToken}` })
    }
    return sendJson(response, 404, { error: 'not found' })
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening')
  const providerRoot = `http://127.0.0.1:${provider.address().port}`
  await writeModelFixture(fixture.data, {
    default: 'active',
    providers: {
      active: {
        providerType: 'openai-responses',
        baseUrl: providerRoot,
        apiKey: testToken,
        models: ['fixture-model'],
      },
    },
  })
  await fixture.start()

  const modelsBefore = await readFile(fixture.modelPath, 'utf8')
  const treeBefore = await fixture.api('GET', '/api/agents/tree')
  const listed = await fixture.api('POST', '/api/setup/models/list', {
    providerType: 'openai-responses',
    baseUrl: providerRoot,
    apiKey: listToken,
  })
  assert.equal(listed.status, 200, JSON.stringify(listed))
  assert.deepEqual(listed.body.models, ['setup-discovered-model', 'setup-second-model'])
  const overridden = await fixture.api('POST', '/api/setup/models/list', {
    providerType: 'openai-responses',
    baseUrl: providerRoot,
    apiKey: listToken,
    extraHeaders: { Authorization: 'Bearer override-list', 'Content-Type': 'application/custom', 'Content-Language': 'en', 'x-fixture-mode': 'override' },
  })
  assert.equal(overridden.status, 200, JSON.stringify(overridden))
  const anthropic = await fixture.api('POST', '/api/setup/models/list', {
    providerType: 'anthropic',
    baseUrl: providerRoot,
    apiKey: listToken,
  })
  assert.equal(anthropic.status, 200, JSON.stringify(anthropic))
  assert.equal(listRequests.some(request => request.anthropic), true)
  const nullHeaders = await fixture.api('POST', '/api/setup/models/list', {
    providerType: 'openai-responses',
    baseUrl: providerRoot,
    extraHeaders: null,
  })
  assert.equal(nullHeaders.status, 400, JSON.stringify(nullHeaders))

  const tested = await fixture.api('POST', '/api/setup/models/test', {
    providerKey: 'transient',
    providerType: 'openai-responses',
    baseUrl: providerRoot,
    apiKey: testToken,
    models: 'fixture-model, first-model',
    testModel: 'other-model',
  })
  assert.equal(tested.status, 200, JSON.stringify(tested))
  assert.equal(tested.body.success, true)
  assert.equal(tested.body.text, 'setup test response')
  assert.equal(testRequests.length, 1)
  const modelsAfter = await readFile(fixture.modelPath, 'utf8')
  assert.equal(modelsAfter, modelsBefore)
  const treeAfter = await fixture.api('GET', '/api/agents/tree')
  assert.deepEqual(treeAfter.body, treeBefore.body)

  const listError = await fixture.api('POST', '/api/setup/models/list', {
    providerType: 'openai-responses',
    baseUrl: `${providerRoot}/error-models`,
    apiKey: listToken,
  })
  assert.equal(listError.status, 502, JSON.stringify(listError))
  assert.equal(JSON.stringify(listError.body).includes(listToken), false)
  assert.equal(listErrorHits, 1)
  const oversized = await fixture.api('POST', '/api/setup/models/list', {
    providerType: 'openai-responses',
    baseUrl: `${providerRoot}/oversized-models`,
    apiKey: listToken,
  })
  assert.equal(oversized.status, 502, JSON.stringify(oversized))
  const testError = await fixture.api('POST', '/api/setup/models/test', {
    providerType: 'openai-responses',
    baseUrl: `${providerRoot}/error-responses`,
    apiKey: testToken,
    models: 'fixture-model',
  })
  assert.equal(testError.status, 400, JSON.stringify(testError))
  assert.equal(JSON.stringify(testError.body).includes(testToken), false)
  assert.equal(testErrorHits, 1)

  const page = await fixture.openApp()
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('[data-setup-tab="models"]')
  await page.click('[data-setup-tab="models"]')
  await page.waitForSelector(`[data-monaco-model-uri="${modelsUri}"][data-editor-ready="true"]`, { timeout: 20000 })
  const unsaved = `providers:\n  draft:\n    providerType: openai-responses\n    baseUrl: ${providerRoot}\n    apiKey: ${listToken}\n    models:\n      - setup`
  const discoveryBefore = listRequests.length
  await page.focus('[aria-label="Models YAML editor"] [role="textbox"]')
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.sendCharacter(unsaved.replaceAll('\n', '\r\n'))
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control')
  await page.keyboard.down('Control'); await page.keyboard.press('Space'); await page.keyboard.up('Control')
  await page.waitForFunction(label => [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')]
    .some(row => row.textContent?.includes(label)), { timeout: 15000 }, 'setup-discovered-model')
  assert(listRequests.length > discoveryBefore, 'Unsaved editor completion performs actual provider discovery')
  assert.equal(await readFile(fixture.modelPath, 'utf8'), modelsBefore)
  await page.keyboard.press('Escape')

  // The ordinary built App submits raw pricing YAML to the real authenticated route.
  const pricedYaml = `# user-authored pricing\ndefault: priced/priced-model\nproviders:\n  priced:\n    providerType: openai-responses\n    baseUrl: ${providerRoot}\n    apiKey: ${testToken}\n    models:\n      - id: priced-model\n        pricing: { cached: 1, input: 2, output: 3 }\n`
  await saveModelsInOriginalApp(page, pricedYaml, fixture.modelPath)
  const setupStatus = await fixture.api('GET', '/api/setup/status')
  assert.equal(setupStatus.body.models.rawYaml, pricedYaml)
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'setup-pricing' })
  assert.equal(created.status, 200, JSON.stringify(created))
  const sessionId = created.body.sessionId
  const triggered = await fixture.api('POST', '/trigger', { sessionId, text: 'exercise saved pricing' })
  assert.equal(triggered.status, 200, JSON.stringify(triggered))
  const history = await until(async () => {
    const response = await fixture.api('GET', `/api/sessions/${encodeURIComponent(sessionId)}/history`)
    return response.body.messages?.find(message => message.__meta?.usage?.cost !== undefined) && response.body
  }, 'saved pricing recorded on a normal request')
  const pricedMessage = history.messages.find(message => message.__meta?.usage?.cost !== undefined)
  assert.ok(Math.abs(pricedMessage.__meta.usage.cost - 0.000027) < 1e-12)
  assert.equal(testRequests.at(-1).model, 'priced-model')

  console.log(JSON.stringify({
    result: 'ok',
    listedModels: listed.body.models,
    anthropicList: true,
    oneShotText: tested.body.text,
    discoveryDidNotMutateConfig: modelsAfter === modelsBefore,
    discoveryDidNotMutateCatalog: JSON.stringify(treeAfter.body) === JSON.stringify(treeBefore.body),
    completion: true,
    originalAppPricingSave: true,
    recordedCost: pricedMessage.__meta.usage.cost,
  }))
} catch (error) {
  console.error('Editor/provider evidence:', { listRequests, body: await browserPage?.evaluate(() => document.body.innerText), active: await browserPage?.evaluate(() => ({ tag: document.activeElement?.tagName, role: document.activeElement?.getAttribute('role'), classes: document.activeElement?.className })) })
  throw error
} finally {
  await fixture.cleanup()
  if (provider?.listening) await new Promise(done => provider.close(done))
}
