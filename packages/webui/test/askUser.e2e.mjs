// Real .NET Main ask_user flow: blocking card/dock answer, plain-message answer and asynchronous dock answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

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
  // Page notifications are recorded instead of shown; permission is granted.
  const fixture = await createHostFixture('ask-user', { onPage: page => page.evaluateOnNewDocument(() => {
    window.__notifications = []
    window.Notification = class {
      static permission = 'granted'
      static requestPermission() { return Promise.resolve('granted') }
      constructor(title, options) { window.__notifications.push({ title, body: options?.body }); this.onclick = null; this.onclose = null }
      close() {}
    }
  }) })
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
  const storedDraft = (page, id) => page.evaluate(questionId => (localStorage.getItem('foxwarm_question_drafts_v1') || '').includes(questionId), id)
  const toggleDock = async (page, expanded) => {
    await page.click('[data-question-dock] > button')
    await page.waitForSelector(`[data-question-dock][data-question-dock-expanded="${expanded}"]`)
  }
  // Keys an input method is still composing: the DOM flag (Chromium) and a CDP key with keyCode 229 (Safari's commit Enter).
  const composingKey = (page, selector, key, init = {}) => page.$eval(selector, (node, key, init) => {
    node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true, ...init }))
  }, key, init)
  const processKey = async (page, modifiers = 0) => {
    const cdp = await page.createCDPSession()
    for (const type of ['rawKeyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, modifiers })
    await cdp.detach()
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
    await page.waitForSelector('[data-placeholder="Reply to answer the question"]')
    assert.ok(await page.evaluate(() => document.body.innerText.includes('Waiting for your answer')))
    await screenshot(page, 'desktop-blocking-card-dock')

    // The timeline card is read-only while open: it shows the question and opens the dock.
    assert.equal(await page.$(`[data-ask-user-card="${questionId}"] [data-question-form]`), null)
    assert.match(await page.$eval(`[data-ask-user-card="${questionId}"]`, node => node.textContent), /PostgreSQL.*SQLite/)
    await page.click('[data-question-dock] > button')
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="false"]')
    await page.click(`[data-ask-user-card="${questionId}"]`)
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="true"]')
    // Keyboard flow in the dock, which the card focused: 1 selects the first option, Enter advances, Enter submits.
    const form = `[data-question-dock] [data-question-form="${questionId}"]`
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), {}, form)
    // A number key that belongs to an input method composition does not select an option.
    await composingKey(page, form, '1')
    assert.equal(await page.$eval(`${form} [data-question-option="PostgreSQL"]`, node => node.getAttribute('aria-checked')), 'false')
    await page.keyboard.press('1')
    assert.equal(await page.$eval(`${form} [data-question-option="PostgreSQL"]`, node => node.getAttribute('aria-checked')), 'true')
    await page.keyboard.press('Enter')
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Any naming preference'), {}, form)
    // The unsent answer, including its step, survives collapsing the dock and reloading the page.
    await page.type(`${form} textarea`, 'svc-')
    await until(() => storedDraft(page, questionId), 'draft stored')
    await toggleDock(page, false)
    await toggleDock(page, true)
    await page.waitForFunction(selector => document.querySelector(selector + ' textarea')?.value === 'svc-', {}, form)
    assert.match(await page.$eval(form, node => node.textContent), /Question 2 of 2/)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
    await waitForWebUiReady(page)
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), blocking)
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="true"]')
    await page.waitForFunction(selector => document.querySelector(selector + ' textarea')?.value === 'svc-', {}, form)
    assert.match(await page.$eval(form, node => node.textContent), /Question 2 of 2/)
    await screenshot(page, 'desktop-restored-draft')
    await page.evaluate(() => [...document.querySelectorAll('[data-question-dock] button')].find(button => button.textContent === 'Back').click())
    await page.waitForFunction(selector => document.querySelector(selector + ' [data-question-option="PostgreSQL"]')?.getAttribute('aria-checked') === 'true', {}, form)
    await page.evaluate(() => [...document.querySelectorAll('[data-question-dock] button')].find(button => button.textContent === 'Next').click())
    await page.$eval(`${form} textarea`, node => { node.focus(); node.setSelectionRange(node.value.length, node.value.length) })
    await page.keyboard.type('data')
    // Default send key (Ctrl/Cmd+Enter): plain Enter in a text field is a newline, and composing keys never submit.
    assert.equal(await page.$eval(`${form} button[aria-keyshortcuts]`, node => node.title), 'Ctrl+Enter')
    await page.keyboard.press('Enter')
    assert.equal(await page.$eval(`${form} textarea`, node => node.value), 'svc-data\n')
    await page.keyboard.press('Backspace')
    await composingKey(page, `${form} textarea`, 'Enter', { ctrlKey: true })
    await processKey(page, 2)
    await sleep(300)
    assert.equal((await view(blocking)).questions[0].status, 'open')
    assert.equal(await page.$eval(`${form} textarea`, node => node.value), 'svc-data')
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')
    await until(async () => (await view(blocking)).questions[0].status === 'answered', 'card answer recorded')
    await until(async () => (inputs.get('block') || []).length >= 2, 'answer reached the model')
    const answerInput = inputs.get('block')[1]
    assert.match(answerInput, new RegExp('Answer to question ' + questionId))
    assert.match(answerInput, /PostgreSQL/)
    assert.match(answerInput, /svc-data/)
    assert.equal((await view(blocking)).questions[0].answer.answers[1].text, 'svc-data')
    await page.waitForSelector(`[data-ask-user-card="${questionId}"][data-question-status="answered"]`)
    await page.waitForSelector('[data-question-dock]', { hidden: true })
    assert.equal(await storedDraft(page, questionId), false, 'a submitted answer leaves no draft')
    // The answering message shows question/answer pairs, not the model-facing protocol text.
    const bubble = await page.waitForSelector('[data-question-answer-bubble="answered"]')
    const bubbleText = await bubble.evaluate(node => node.textContent)
    assert.match(bubbleText, /Which database should the service use\?\s*PostgreSQL/)
    assert.match(bubbleText, /svc-data/)
    assert.doesNotMatch(bubbleText, new RegExp(questionId + '|Answer to question'))
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
    await page.waitForSelector('[data-placeholder="Reply to answer the question"]')
    await page.evaluate(() => window.foxwarmTest.sendMessage('Tomorrow morning, please.'))
    await until(async () => (await view(replyId)).questions.find(item => item.id === replyQuestion)?.status === 'answered', 'message answered the question')
    const replyRecord = (await view(replyId)).questions.find(item => item.id === replyQuestion)
    assert.equal(replyRecord.answer.text, 'Tomorrow morning, please.')
    await until(async () => (inputs.get('reply') || []).some(text => text.includes('question-answer')), 'message answer reached the model')
    await page.waitForSelector('[data-question-answered-by-message]')
    assert.equal(await page.evaluate(() => document.body.innerText.includes("The user's message above answers")), false)
    assert.ok(await page.evaluate(() => document.body.innerText.includes('Tomorrow morning, please.')))
    await screenshot(page, 'desktop-message-answer')

    // The asynchronous question is answered from the dock; it starts a turn on the idle Session.
    // With Enter as the Chat send key, Shift+Enter is a newline, a composing Enter is ignored and Enter submits.
    await page.evaluate(() => localStorage.setItem('foxwarm_send_key_mode_v1', 'enter'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
    await waitForWebUiReady(page)
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), asyncId)
    await page.waitForSelector('[data-question-dock][data-question-dock-expanded="false"]')
    await page.click('[data-question-dock] > button')
    assert.equal(await page.$eval('[data-question-dock] button[aria-keyshortcuts]', node => node.title), 'Enter')
    await page.type('[data-question-dock] textarea', 'Yes,')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Shift')
    await page.keyboard.type('include it.')
    await composingKey(page, '[data-question-dock] textarea', 'Enter')
    await processKey(page)
    await sleep(300)
    assert.equal((await view(asyncId)).questions[0].status, 'open')
    assert.equal(await page.$eval('[data-question-dock] textarea', node => node.value), 'Yes,\ninclude it.')
    await screenshot(page, 'desktop-async-dock')
    await page.keyboard.press('Enter')
    await until(async () => (await view(asyncId)).questions[0].status === 'answered', 'dock answer recorded')
    assert.equal((await view(asyncId)).questions[0].answer.answers[0].text, 'Yes,\ninclude it.')
    await until(async () => (inputs.get('async') || []).some(text => text.includes('include it.')), 'asynchronous answer started a turn')
    await page.waitForSelector('[data-session-section="questions"]', { hidden: true })

    // Skipping from the dock records a skipped answer, shown as such in the user bubble.
    await send(asyncId, 'skip', [[call('ask-5', 'ask_user', { questions: [{ question: 'Add charts to the report?' }], afterAsk: 'continue' })]])
    await page.waitForSelector('[data-question-dock]')
    if (await page.$('[data-question-dock][data-question-dock-expanded="false"]')) await page.click('[data-question-dock] > button')
    await page.waitForSelector('[data-question-dock] [data-question-form]')
    await page.evaluate(() => [...document.querySelectorAll('[data-question-dock] button')].find(button => button.textContent === 'Skip').click())
    await until(async () => (await view(asyncId)).questions.some(item => item.status === 'skipped'), 'skip recorded')
    const skipped = await page.waitForSelector('[data-question-answer-bubble="skipped"]')
    assert.match(await skipped.evaluate(node => node.textContent), /Skipped the question.*Add charts to the report\?/)

    // A draft is dropped once its question is answered elsewhere.
    await send(asyncId, 'elsewhere', [[call('ask-6', 'ask_user', { questions: [{ question: 'Email the report too?' }], afterAsk: 'continue' })]])
    const elsewhere = (await until(async () => (await view(asyncId)).questions.find(item => item.status === 'open'), 'question to answer elsewhere')).id
    await page.waitForSelector('[data-question-dock]')
    if (await page.$('[data-question-dock][data-question-dock-expanded="false"]')) await toggleDock(page, true)
    await page.type(`[data-question-dock] [data-question-form="${elsewhere}"] textarea`, 'Only to the team')
    await until(() => storedDraft(page, elsewhere), 'draft stored before the answer elsewhere')
    const answeredElsewhere = await fixture.api('POST', route(asyncId) + '/questions/' + elsewhere + '/answer', { answers: [{ text: 'Yes' }] })
    assert.equal(answeredElsewhere.status, 202, JSON.stringify(answeredElsewhere))
    await page.waitForSelector('[data-question-dock]', { hidden: true })
    await until(async () => !(await storedDraft(page, elsewhere)), 'draft dropped after the answer elsewhere')

    // Question notifications follow the browser-local Setup choice; the Session is not visible.
    const notified = () => page.evaluate(() => window.__notifications.filter(item => item.title === 'Question for you').map(item => item.body))
    const askReply = async key => {
      const before = (await session(replyId)).questions?.open ?? 0
      await send(replyId, key, [[call('ask-' + key, 'ask_user', { questions: [{ question: 'Notification check ' + key }], afterAsk: 'continue' })]])
      await until(async () => ((await session(replyId)).questions?.open ?? 0) > before, key + ' question open')
    }
    await askReply('notify-all')
    await until(async () => (await notified()).includes('reply'), 'all-sessions question notification')
    const setQuestionNotifications = async value => {
      await page.evaluate(() => { location.hash = 'setup' })
      await page.waitForSelector('[data-setup-tab="notifications"]')
      await page.click('[data-setup-tab="notifications"]')
      await page.waitForSelector('[data-notification-permission="granted"]')
      await page.click(`[data-question-notification-choice="${value}"] input`)
      await page.waitForSelector(`[data-question-notification-choice="${value}"] input:checked`)
      assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_question_notifications_v1')), value === 'all' ? null : value)
      if (value === 'off') await screenshot(page, 'setup-notifications')
      await page.evaluate(() => { location.hash = 'chat' })
      await page.waitForSelector('.foxwarm-chat-root')
    }
    for (const value of ['off', 'watched']) {
      await setQuestionNotifications(value)
      const count = (await notified()).length
      await askReply('notify-' + value)
      await sleep(1500)
      assert.equal((await notified()).length, count, value + ' sends no notification for an unwatched Session')
    }
    await setQuestionNotifications('all')
    await askReply('notify-again')
    await until(async () => (await notified()).filter(body => body === 'reply').length >= 2, 'notifications resume for all sessions')

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
    await toggleDock(page, false)
    await toggleDock(page, true)
    assert.deepEqual(await page.$$eval('[data-question-dock] [data-question-option][aria-checked="true"]', nodes => nodes.map(node => node.getAttribute('data-question-option'))), ['Europe', 'Asia'])
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
