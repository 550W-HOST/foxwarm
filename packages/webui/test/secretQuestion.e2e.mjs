// Real .NET Main secret question: the value is typed into the dock, stored for the asking Agent and never shown to the model.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()

const shots = process.env.FOXWARM_SECRET_QUESTION_SCREENSHOTS
const VALUE = 'synthetic-ci-token-e2e-4242'
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const final = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SECRET-DONE' }] }]

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath ?? entry.path, entry.name))
}

test('a secret question stores the typed value without showing it to the model', { timeout: 180000 }, async () => {
  const fixture = await createHostFixture('secret-question')
  const inputs = [], errors = []
  let round = 0
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes
      inputs.push(JSON.stringify(JSON.parse(raw).input || []))
      const output = round++ === 0
        ? [call('ask-secret', 'ask_user', { questions: [
          { question: 'Paste the CI token for the build.', secret: { name: 'ci-token', description: 'CI token' } },
          { question: 'Which repository?' },
        ] })]
        : final
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: secret-question-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, models: ['wire'] } } }))
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const view = async id => (await fixture.api('GET', route(id) + '/questions')).body
  try {
    await fixture.start()
    const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'secret' })
    assert.equal(created.status, 200, JSON.stringify(created))
    const id = created.body.sessionId
    const accepted = await fixture.api('POST', route(id) + '/message', { text: 'Set up the build.' })
    assert([200, 202].includes(accepted.status), JSON.stringify(accepted))
    const questionId = (await until(async () => { const current = await view(id); return current.waitingQuestionIds?.length ? current : null }, 'secret question waiting')).questions[0].id

    const page = await fixture.openApp()
    await page.setViewport({ width: 1280, height: 860 })
    await page.evaluate(() => { location.hash = 'chat' })
    // Switching before the chat route lands lets the route change cancel the pending navigation.
    await page.waitForSelector('.foxwarm-chat-root')
    await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
    await page.evaluate(sessionId => window.foxwarmTest.switchToSession(sessionId), id)
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="true"]')
    const form = `[data-question-dock] [data-question-form="${questionId}"]`
    const field = `${form} [data-question-secret="ci-token"] input[type="password"]`
    await page.waitForSelector(field)
    assert.match(await page.$eval(`${form} [data-question-secret="ci-token"]`, node => node.textContent), /ci-token · CI token/)
    assert.match(await page.$eval(`[data-ask-user-card="${questionId}"]`, node => node.textContent), /Secret ci-token/)
    assert.match(await page.$eval(form, node => node.textContent), /Question 1 of 2/)
    // The composer does not offer to answer: a message never answers a secret question set.
    assert.equal(await page.$('[data-placeholder="Reply to answer the question"]'), null)

    // A message sent while the Session waits does not answer a secret question set.
    await page.evaluate(() => window.foxwarmTest.sendMessage('I will paste it in a moment.'))
    await until(() => inputs.length >= 2, 'message reached the model')
    assert.equal((await view(id)).questions[0].status, 'open')

    await page.type(field, VALUE)
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control')
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Which repository?'), {}, form)
    await page.type(`${form} textarea`, 'foxwarm')
    // The typed value is in the form only, never in the browser's answer drafts.
    assert.equal(await page.evaluate(value => JSON.stringify({ ...localStorage }).includes(value), VALUE), false)
    if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, 'secret-question-dock.png') }) }
    await page.evaluate(() => [...document.querySelectorAll('[data-question-dock] button')].find(button => button.textContent === 'Back').click())
    assert.equal(await page.$eval(field, node => node.value), VALUE)
    await page.evaluate(() => [...document.querySelectorAll('[data-question-dock] button')].find(button => button.textContent === 'Next').click())
    await page.evaluate(() => [...document.querySelectorAll('[data-question-dock] button')].find(button => button.textContent === 'Submit').click())
    await until(async () => (await view(id)).questions[0].status === 'answered', 'secret answer recorded')
    await until(() => inputs.length >= 3, 'answer reached the model')
    const answerInput = inputs[2]
    assert.match(answerInput, /stored as secret/)
    assert.match(answerInput, /ci-token/)
    assert.match(answerInput, /foxwarm/)
    assert.deepEqual((await view(id)).questions[0].answer.answers, [{ secret: 'ci-token', stored: true }, { text: 'foxwarm' }])

    const bubble = await page.waitForSelector('[data-question-answer-bubble="answered"]')
    assert.match(await bubble.evaluate(node => node.textContent), /Stored as secret ci-token/)
    await page.waitForSelector(`[data-ask-user-card="${questionId}"][data-question-status="answered"]`)

    const secrets = (await fixture.api('GET', '/api/setup/secrets')).body
    const stored = secrets.secrets.find(item => item.name === 'ci-token')
    assert.equal(stored.description, 'CI token')
    assert.deepEqual(stored.owner, { kind: 'agent', agent: 'main' })

    await sleep(300)
    assert.equal(inputs.some(text => text.includes(VALUE)), false)
    assert.equal(await page.evaluate(value => document.body.innerText.includes(value), VALUE), false)
    for (const file of await files(fixture.data)) assert.equal((await readFile(file)).includes(VALUE), false, file)
    assert.deepEqual(errors, [])
  } finally {
    model.close()
    await fixture.cleanup()
  }
})
