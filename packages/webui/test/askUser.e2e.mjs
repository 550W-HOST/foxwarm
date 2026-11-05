// Real .NET Main ask_user flow: blocking card/dock answer, plain-message answer and asynchronous dock answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'

const require = createRequire(import.meta.url)
const { initializeTestEnvironment } = require('../../../scripts/test/test-process-env.cjs')
initializeTestEnvironment()

const shots = process.env.FOXWARM_ASK_USER_SCREENSHOTS
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ASK-DONE-' + key }] }]
const questions = [
  { question: 'Which database should the service use?', options: [
    { label: 'PostgreSQL', description: 'Shared server with backups', recommended: true },
    { label: 'SQLite', description: 'Single file next to the service' },
  ] },
  { question: 'Any naming preference for the database?' },
]

test('ask_user questions are answered from the card, the dock and an ordinary message', { timeout: 180000 }, async () => {
  const fixture = await createHostFixture('ask-user')
  const plans = new Map(), rounds = new Map(), inputs = new Map(), errors = []
  const model = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes
      const body = JSON.parse(raw)
      const text = JSON.stringify(body.input || [])
      const key = [...text.matchAll(/ASKUSER:([\w-]+)/g)].at(-1)?.[1]
      const round = rounds.get(key) || 0; rounds.set(key, round + 1)
      inputs.set(key, [...(inputs.get(key) || []), text])
      const step = plans.get(key)?.[round]
      const output = typeof step === 'function' ? step(body) : step || final(key)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
    } catch (error) { errors.push(error.stack); response.writeHead(500); response.end(String(error)) }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  name: ask-user-fixture\n  httpPort: ${fixture.port}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(join(fixture.data, 'state/mcp.json'))}\n`)
  await writeFile(join(fixture.data, 'state/mcp.json'), '{}')
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', apiKey: 'synthetic-model', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, asyncCompact: false, models: ['wire'] } } }))
  const route = id => '/api/sessions/' + encodeURIComponent(id)
  const view = async id => (await fixture.api('GET', route(id) + '/questions')).body
  const session = async id => (await fixture.api('GET', route(id) + '/history')).body.session
  async function create(name) { const response = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: name }); assert.equal(response.status, 200, JSON.stringify(response)); return response.body.sessionId }
  async function send(id, key, steps) {
    plans.set(key, steps); rounds.set(key, 0)
    const accepted = await fixture.api('POST', route(id) + '/message', { text: 'ASKUSER:' + key })
    assert([200, 202].includes(accepted.status), JSON.stringify(accepted))
  }
  const screenshot = async (page, name) => { if (shots) { await mkdir(shots, { recursive: true }); await page.screenshot({ path: join(shots, name + '.png') }) } }
  try {
    await fixture.start()
    const blocking = await create('blocking')
    const asyncId = await create('later')
    const replyId = await create('reply')
    await send(blocking, 'block', [[call('ask-1', 'ask_user', { questions })]])
    const asked = await until(async () => { const current = await view(blocking); return current.questions?.[0]?.status === 'open' && current.waitingQuestionIds?.length ? current : null }, 'blocking question open')
    const questionId = asked.questions[0].id
    await until(async () => (await session(blocking)).runtimeState?.waiting?.waitingFor === 'question', 'runtime waits for the answer')
    await send(asyncId, 'async', [[call('ask-2', 'ask_user', { questions: [{ question: 'Should the report include last year?' }], afterAsk: 'continue' })]])
    await until(async () => { const current = await session(asyncId); return current.questions?.open === 1 && !current.busy && current.runtimeState?.state === 'idle' ? current : null }, 'asynchronous question open and Session idle')

    const page = await fixture.openApp()
    await page.setViewport({ width: 1280, height: 860 })
    await page.evaluate(() => { location.hash = 'chat' })
    await page.waitForSelector('.foxwarm-chat-root')
    await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
    // Both Sessions are elevated; the waiting one comes first and carries the strong marker.
    await page.waitForSelector('[data-session-section="questions"] [data-session-id]')
    const elevated = await page.$$eval('[data-session-section="questions"] [data-session-id]', rows => rows.map(row => [row.getAttribute('data-session-id'), row.querySelector('[data-session-question]')?.getAttribute('data-session-question')]))
    assert.deepEqual(elevated, [[blocking, 'waiting'], [asyncId, 'open']])
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), blocking)
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="true"]')
    await page.waitForSelector(`[data-ask-user-card="${questionId}"][data-question-status="open"]`)
    assert.match(await page.$eval('[data-composer-answer-hint]', node => node.textContent), /answers the question/)
    assert.ok(await page.evaluate(() => document.body.innerText.includes('Waiting for your answer')))
    await screenshot(page, 'desktop-blocking-card-dock')

    // Keyboard flow in the timeline card: 1 selects the first option, Enter advances, Enter submits.
    const form = `[data-ask-user-card="${questionId}"] [data-question-form]`
    await page.focus(form)
    await page.keyboard.press('1')
    assert.equal(await page.$eval(`${form} [data-question-option="PostgreSQL"]`, node => node.getAttribute('aria-checked')), 'true')
    await page.keyboard.press('Enter')
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Any naming preference'), {}, form)
    await page.type(`${form} textarea`, 'svc-data')
    await page.keyboard.press('Enter')
    await until(async () => (await view(blocking)).questions[0].status === 'answered', 'card answer recorded')
    await until(async () => (inputs.get('block') || []).length >= 2, 'answer reached the model')
    const answerInput = inputs.get('block')[1]
    assert.match(answerInput, new RegExp('Answer to question ' + questionId))
    assert.match(answerInput, /PostgreSQL/)
    assert.match(answerInput, /svc-data/)
    await page.waitForSelector(`[data-ask-user-card="${questionId}"][data-question-status="answered"]`)
    await page.waitForSelector('[data-question-dock]', { hidden: true })
    // A second answer for the same question is rejected.
    const again = await fixture.api('POST', route(blocking) + '/questions/' + questionId + '/answer', { skip: true })
    assert.equal(again.status, 409)
    await screenshot(page, 'desktop-answered-card')

    // An ordinary composer message answers a waited question.
    await send(replyId, 'reply', [[call('ask-3', 'ask_user', { questions: [{ question: 'Deploy today or tomorrow?', options: [{ label: 'Today' }, { label: 'Tomorrow' }] }] })]])
    const replyQuestion = (await until(async () => { const current = await view(replyId); return current.waitingQuestionIds?.length ? current : null }, 'reply question waiting')).questions[0].id
    // A question asked while the page is open elevates its Session through the live list refresh.
    await page.waitForSelector(`[data-session-section="questions"] [data-session-id="${replyId}"] [data-session-question="waiting"]`)
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), replyId)
    await page.waitForSelector('[data-composer-answer-hint]')
    await page.evaluate(() => window.foxwarmTest.sendMessage('Tomorrow morning, please.'))
    await until(async () => (await view(replyId)).questions.find(item => item.id === replyQuestion)?.status === 'answered', 'message answered the question')
    const replyRecord = (await view(replyId)).questions.find(item => item.id === replyQuestion)
    assert.equal(replyRecord.answer.text, 'Tomorrow morning, please.')
    await until(async () => (inputs.get('reply') || []).some(text => text.includes('question-answer')), 'message answer reached the model')

    // The asynchronous question is answered from the dock; it starts a turn on the idle Session.
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), asyncId)
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="false"]')
    await page.click('[data-question-dock] > button')
    await page.type('[data-question-dock] textarea', 'Yes, include it.')
    await screenshot(page, 'desktop-async-dock')
    await page.evaluate(() => [...document.querySelectorAll('[data-question-dock] button')].find(button => button.textContent === 'Submit').click())
    await until(async () => (await view(asyncId)).questions[0].status === 'answered', 'dock answer recorded')
    await until(async () => (inputs.get('async') || []).some(text => text.includes('Yes, include it.')), 'asynchronous answer started a turn')
    await page.waitForSelector('[data-session-section="questions"]', { hidden: true })

    // Narrow layout: a new waiting question keeps the dock and card usable.
    await send(blocking, 'mobile', [[call('ask-4', 'ask_user', { questions: [{ question: 'Pick the regions to deploy to', multiSelect: true, options: [{ label: 'Europe' }, { label: 'Asia', recommended: true }, { label: 'Americas' }] }] })]])
    await until(async () => (await view(blocking)).waitingQuestionIds?.length, 'mobile question waiting')
    await page.setViewport({ width: 390, height: 780, isMobile: true, hasTouch: true })
    await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
    await page.waitForSelector('[data-fox-splash]', { hidden: true })
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), blocking)
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="true"]', { visible: true })
    await sleep(300)
    const dock = await page.$eval('[data-question-dock]', node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: innerWidth } })
    assert.ok(dock.left >= 0 && dock.right <= dock.width + 1, JSON.stringify(dock))
    await page.click('[data-question-dock] [data-question-option="Europe"]')
    await page.click('[data-question-dock] [data-question-option="Asia"]')
    await screenshot(page, 'mobile-dock')
    await page.evaluate(() => [...document.querySelectorAll('[data-question-dock] button')].find(button => button.textContent === 'Submit').click())
    await until(async () => (await view(blocking)).questions.find(item => item.status === 'answered' && item.answer?.answers?.[0]?.selected?.length === 2), 'multi-select answer recorded')
    await sleep(200)
    assert.deepEqual(errors, [])
  } finally {
    model.close()
    await fixture.cleanup()
  }
})
