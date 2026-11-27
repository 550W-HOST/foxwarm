// Task cards and complete delivery records through a real Main, real ToolScript and the original App.
// A scripted Responses peer drives every Session; a `TURN:<key>` marker in the newest input selects its script.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until, sleep } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'
import { functionCall, responsesHistory } from './ctlModelCalls.mjs'

const owned = await createHostFixture('taskcards', { env: {}, stopTimeout: 30000 })
const scripts = new Map(), failures = [], bodies = []
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const rowText = row => (row.content || []).map(part => part.text || '').join('\n')
function respond(body) {
  const history = responsesHistory(body)
  let last = -1
  for (let index = history.length - 1; index >= 0; index--) if (history[index].role === 'user' && !/kind="task-reminder"/.test(rowText(history[index]))) { last = index; break }
  const text = last >= 0 ? rowText(history[last]) : ''
  const key = [...text.matchAll(/TURN:([\w-]+)/g)].at(-1)?.[1]
  const outputs = new Map(history.slice(last + 1).filter(row => row.type === 'function_call_output').map(row => [row.call_id, typeof row.output === 'string' ? row.output : JSON.stringify(row.output)]))
  const steps = scripts.get(key)
  if (!steps) return final('Noted.')
  const context = { text }
  for (let index = 0; index < steps.length; index++) {
    const calls = (typeof steps[index] === 'function' ? steps[index](context) : steps[index]).map((call, n) => functionCall(`${key}-${index}-${n}`, call.name, call.args))
    if (!calls.every(call => outputs.has(call.call_id))) return calls
  }
  return final('DONE-' + key)
}
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    bodies.push(raw)
    const output = respond(JSON.parse(raw))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'cards-' + bodies.length, output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(owned.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })

const sessionFile = id => join(owned.data, 'state/sessions', id + '.json')
const authority = async id => JSON.parse(await readFile(sessionFile(id), 'utf8'))
const idle = async id => { try { return !(await authority(id)).busy } catch { return false } }
async function turn(owner, key, steps) {
  scripts.set(key, steps)
  assert.equal((await owned.api('POST', '/api/sessions/' + encodeURIComponent(owner) + '/message', { text: 'Go TURN:' + key })).status, 202)
  await until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const state = await authority(owner)
    return !state.busy && state.history.some(row => row.parts?.some(part => part.text === 'DONE-' + key))
  }, key, 40000)
}
const RESULT = 'Completion result: the delivery records are complete.'
// The browser preference key, read from its owner rather than repeated here.
const INTER_AGENT_KEY = (await readFile(new URL('../src/chatPreferences.ts', import.meta.url), 'utf8')).match(/SHOW_INTER_AGENT_MESSAGES_STORAGE_KEY = '([^']+)'/)[1]

try {
  await owned.start()
  for (const id of ['main', 'peer']) assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  await mkdir(join(owned.work, 'workflows'), { recursive: true })
  await writeFile(join(owned.work, 'workflows/delegate.py'), [
    "task = call_tool('task', {'action': 'create', 'title': args['title'], 'description': args['description']})",
    "call_tool('create_child_session', {'suffix': args['suffix'], 'taskId': task['taskId'], 'message': 'Use the disposable workspace.'})",
    "return task['taskId']",
    '',
  ].join('\n'))
  scripts.set('child-work', [ctx => [{ name: 'task', args: { action: 'complete', taskId: ctx.text.match(/task_[0-9a-f]{12}/)[0], result: RESULT } }]])
  scripts.set('noop', [])
  await turn('main', 'coordinate', [[{ name: 'run_script', args: { summary: 'Delegate', code: [
    "t = call_tool('run_script', {'filePath': 'workflows/delegate.py', 'args': {'title': 'Card review', 'description': 'Review the cards. TURN:child-work', 'suffix': 'worker'}})",
    "call_tool('send_to_session', {'sessionId': 'peer', 'message': 'Heads-up from the workflow. TURN:noop', 'currentSessionTurnAction': 'continue'})",
    'return t',
  ].join('\n') } }]])
  await until(async () => (await authority('main')).history.some(row => row.parts?.some(part => part.system?.includes('event="completed"'))), 'completion', 40000)
  await until(async () => await idle('main') && await idle('peer') && await idle('worker'), 'idle', 40000)
  await sleep(500)

  // Evidence: the outer subcall records the nested assignment and the send; no provider body carries the records.
  const main = await authority('main')
  const subCalls = main.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'coordinate-0-0').functionResponse.__meta.toolScriptSubCalls
  const records = subCalls.flatMap(call => call.sessionMessages || [])
  assert.deepEqual(records.map(item => [item.targetSessionId, item.task?.event ?? null]), [['worker', 'assigned'], ['peer', null]])
  assert(!bodies.some(body => body.includes('sessionMessages')), 'Delivery records must not enter provider requests.')
  const taskId = records[0].task.taskId

  const page = await owned.openApp()
  const timeline = '[data-workbench-content-tab="chat:main"] [data-chat-timeline=committed]'
  const open = async id => {
    await page.evaluate(id => window.foxwarmTest.switchToSession(id), id)
    await page.waitForSelector(`[data-workbench-content-tab="chat:${id}"] .foxwarm-chat-root[data-chat-connection-state="connected"]`, { visible: true })
  }
  const cards = id => page.$$eval(`[data-workbench-content-tab="chat:${id}"] [data-chat-timeline=committed] [data-session-communication]`, nodes => nodes.map(node => ({
    direction: node.getAttribute('data-session-communication'), event: node.getAttribute('data-task-event'), label: node.getAttribute('aria-label'),
    text: node.textContent.replace(/\s+/g, ' ').trim(), inActivity: !!node.closest('[data-timeline-activity]'),
  })))
  await open('main')
  await page.waitForFunction(selector => document.querySelectorAll(selector + ' [data-session-communication]').length >= 3, {}, timeline)
  let shown = await cards('main')
  const assigned = shown.find(card => card.event === 'assigned'), completed = shown.find(card => card.event === 'completed')
  assert(assigned && assigned.direction === 'sent' && !assigned.inActivity && assigned.text.includes('Task assigned') && assigned.text.includes('Review the cards.'), JSON.stringify(shown))
  assert(completed && completed.direction === 'received' && !completed.inActivity && completed.text.includes('Task completed') && completed.text.includes(RESULT), JSON.stringify(shown))
  assert(shown.some(card => card.direction === 'sent' && !card.event && card.text.includes('Heads-up from the workflow.')), JSON.stringify(shown))
  // Cards follow source order: the assignment and send after the script, the completion after them.
  assert(shown.indexOf(assigned) < shown.indexOf(completed))

  // Conversation Search finds the completion result once.
  await page.click(`[data-workbench-content-tab="chat:main"] button[aria-label="Find in chat"]`)
  await page.type('[data-chat-search] input[aria-label="Search messages"]', 'delivery records are complete')
  await page.waitForFunction(() => /1\/1/.test(document.querySelector('[data-chat-search]')?.textContent || ''))
  await page.keyboard.press('Escape')

  // The Task link opens Tasks with that Task selected.
  await page.click(`${timeline} [data-task-link="${taskId}"]`)
  await page.waitForSelector(`[data-task-row="${taskId}"][data-selected], [data-task-card="${taskId}"][data-selected]`, { visible: true })

  // The inter-agent switch folds Task cards with To/From cards.
  await page.evaluate(key => localStorage.setItem(key, 'false'), INTER_AGENT_KEY)
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
  await open('main')
  await page.waitForSelector(`${timeline} [data-timeline-activity]`)
  await sleep(800)
  assert.equal((await cards('main')).filter(card => !card.inActivity).length, 0)
  // Expanded Activity shows the folded Task card with its full body.
  await page.$$eval(`${timeline} [aria-label="Expand activity"]`, buttons => buttons.forEach(button => button.click()))
  await page.waitForFunction(selector => [...document.querySelectorAll(selector + ' [data-timeline-activity] [data-session-communication]')].some(node => node.getAttribute('data-task-event') === 'completed'), {}, timeline)
  await page.evaluate(key => localStorage.setItem(key, 'true'), INTER_AGENT_KEY)
  await page.reload({ waitUntil: 'networkidle0' })
  await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)

  // The peer's first input shares a history message with its Session tag and still shows a From card.
  await open('peer')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-workbench-content-tab="chat:peer"] [data-session-communication="received"]')].some(node => node.textContent.includes('Heads-up from the workflow.')))
  // The child reads its assignment and sees the completion it reported.
  await open('worker')
  await page.waitForFunction(() => document.querySelectorAll('[data-workbench-content-tab="chat:worker"] [data-session-communication]').length >= 2)
  const child = await cards('worker')
  assert(child.some(card => card.direction === 'received' && card.event === 'assigned' && card.text.includes('Additional instruction:')), JSON.stringify(child))
  assert(child.some(card => card.direction === 'sent' && card.event === 'completed' && card.text.includes(RESULT)), JSON.stringify(child))
  console.log('mainHostTaskCards: ok')
} finally {
  peer.close()
  await owned.stop().catch(() => {})
  await owned.cleanup()
}
