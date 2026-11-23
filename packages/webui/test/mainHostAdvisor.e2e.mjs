// The bundled advisor skill through an owned Main: `ctl skill run advisor` forks the parent to the
// advisor model, archives the fork, sends the request and ends the parent's turn in a wait that the
// advice (or the fallback) ends. A recording Anthropic Messages peer plays both Sessions.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const fixture = await createHostFixture('advisor', { stopTimeout: 30000 })
const records = [], errors = [], held = new Map()
const PARENT = 'team/exec'
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const exists = id => access(join(fixture.data, 'state/sessions', id + '.json')).then(() => true, () => false)
const confirm = 'Scripted test handoff. I confirm this handoff should proceed.'

function textsOf(body) {
  const out = []
  const visit = node => {
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) node.forEach(visit)
    else if (node && typeof node === 'object') for (const key of ['text', 'content', 'input', 'output']) if (key in node) visit(node[key])
  }
  visit(body.messages)
  return out
}
const sessionOf = body => [...textsOf(body).join('\n').matchAll(/currentSessionId="([^"]+)"/g)].at(-1)?.[1]
const rowsAfter = (rows, needle) => {
  let index = -1
  rows.forEach((row, i) => { if (JSON.stringify(row).includes(needle)) index = i })
  return index < 0 ? [] : rows.slice(index + 1)
}

// Parent turns: TURN:<key> selects the steps; each later assistant row advances one step.
const consult = (question, extra = {}) => ({ tool: 'ctl', input: { command: 'skill run advisor --args @args', values: { args: { question, ...extra } } } })
const parentTurns = {
  seed: [[{ tool: 'read', input: { filePath: 'notes.txt' } }], [{ text: 'SEED-DONE' }]],
  missing: [[consult('Which plan?')], [{ text: 'MISSING-DONE' }]],
  tiny: [[consult('Which plan?', { model: 'tiny' })], [{ text: 'TINY-DONE' }]],
  consult: [[consult('Should the catalog migrate in two phases or one?\nWe tried one phase.')], [{ text: 'CONSULT-DONE' }]],
  followup: [[{ tool: 'send_to_session', advisor: true, input: { handoffRecall: 'Clarify the same decision.', message: 'FOLLOWUP: what about rollback?', currentSessionTurnAction: 'wait', handoffConfirmation: confirm } }], [{ text: 'FOLLOWUP-DONE' }]],
  stop: [[consult('HOLD-ME: is the plan safe?', { model: 'adv' })], [{ text: 'STOP-DONE' }]],
  fail: [[consult('FAIL-ME: anything missing?', { model: 'adv', waitSeconds: 2 })], [{ text: 'FAIL-DONE' }]],
}
let advisorId
function parentStep(rows) {
  const key = [...JSON.stringify(rows).matchAll(/TURN:([a-z]+)/g)].at(-1)?.[1]
  assert(key && parentTurns[key], 'parent turn key ' + key)
  const step = rowsAfter(rows, 'TURN:' + key).filter(row => row.role === 'assistant').length
  const steps = parentTurns[key]
  return { key, step, blocks: steps[Math.min(step, steps.length - 1)] }
}
function advisorStep(rows, id) {
  let last = -1
  rows.forEach((row, i) => { if (row.role === 'assistant') last = i })
  const tail = JSON.stringify(rows.slice(last + 1))
  if (tail.includes('FAIL-ME')) return 'fail'
  if (!/You are an advisor|FOLLOWUP:/.test(tail)) return [{ text: '[NO_ACTION]' }]
  return [{ tool: 'send_to_session', input: { sessionId: PARENT, handoffRecall: 'Report advice.', message: 'ADVICE from ' + id + ': proceed in two phases.', currentSessionTurnAction: 'end_turn', handoffConfirmation: confirm } }]
}

const sse = (response, data) => response.write('data: ' + JSON.stringify(data) + '\n\n')
let serial = 0
function reply(response, blocks, model) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  sse(response, { type: 'message_start', message: { id: 'msg-' + (++serial), role: 'assistant', model, usage: { input_tokens: 10, output_tokens: 1 } } })
  let index = 0, tool = false
  for (const block of blocks) {
    if (block.text !== undefined) {
      sse(response, { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      sse(response, { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    } else {
      tool = true
      const input = block.advisor ? { sessionId: advisorId, ...block.input } : block.input
      sse(response, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_' + (++serial), name: block.tool, input: {} } })
      sse(response, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
    }
    sse(response, { type: 'content_block_stop', index }); index++
  }
  sse(response, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
  sse(response, { type: 'message_stop' }); response.end()
}
const peer = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const session = sessionOf(body)
    const record = { index: records.length, model: body.model, session, body }
    records.push(record)
    if (session === PARENT) {
      const step = parentStep(body.messages); record.turn = step.key + '#' + step.step
      return reply(response, step.blocks, body.model)
    }
    const blocks = advisorStep(body.messages, session)
    if (blocks === 'fail') {
      response.writeHead(400, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'scripted advisor failure' } }))
    }
    if (JSON.stringify(body.messages.at(-1)).includes('HOLD-ME')) await new Promise(release => held.set(session, release))
    reply(response, blocks, body.model)
  } catch (error) { errors.push(error.stack); response.destroy(error) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const base = `http://127.0.0.1:${peer.address().port}`
const leaf = (model, extra = {}) => ({ providerType: 'anthropic', baseUrl: base, apiKey: 'local-provider-token', models: [model], maxOutput: 2000, ...extra })
const models = { default: 'exec', providers: { exec: leaf('claude-exec-4'), adv: leaf('claude-adv-5'), tiny: leaf('claude-tiny-1', { contextLimit: 40 }) } }
await writeFile(fixture.modelPath, JSON.stringify(models, null, 2))
await writeFile(join(fixture.data, 'state/config.yaml'), (await readFile(join(fixture.data, 'state/config.yaml'), 'utf8')) + 'handoffConfirmation: true\n')

const parentRequests = () => records.filter(record => record.session === PARENT)
const toolResult = (state, name) => {
  const calls = state.history.flatMap(row => row.parts ?? []).filter(part => part.functionCall?.name === name)
  const id = calls.at(-1)?.functionCall?.id
  return state.history.flatMap(row => row.parts ?? []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
}
async function turn(key, done) {
  const sent = await fixture.api('POST', route(PARENT) + '/message', { text: 'TURN:' + key })
  assert.equal(sent.status, 202, JSON.stringify(sent.body))
  if (done) await until(async () => {
    if (errors.length) throw new Error(errors.join('\n'))
    const state = await saved(PARENT)
    return JSON.stringify(state.history.slice(-2)).includes(done) && !state.busy
  }, 'turn ' + key, 60000)
}
const children = async () => (await fixture.api('POST', '/api/session-list/children', { mode: 'default', limit: 50, parents: [{ parentSessionId: PARENT }] })).body.children?.[0]?.sessions ?? []
const row = async id => (await fixture.api('POST', '/api/session-list/by-id', { ids: [id] })).body
const rowsEqual = (a, b) => a.length <= b.length && a.every((item, i) => JSON.stringify(item) === JSON.stringify(b[i]))

try {
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/agents', { agentId: 'team' })).status, 201)
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'team', sessionId: 'exec' })).status, 200)
  await writeFile(join(fixture.data, 'agents/team/notes.txt'), 'Plan: migrate the catalog in two phases.\n'.repeat(40))
  await turn('seed', 'SEED-DONE')

  // No `model` and no key named advisor: the entry fails before creating anything.
  await turn('missing', 'MISSING-DONE')
  assert.match(JSON.stringify(toolResult(await saved(PARENT), 'ctl')), /No advisor model is configured/)
  assert.deepEqual(await children(), [])

  // A history larger than the advisor's context: the idle fork is deleted and the run fails.
  await turn('tiny', 'TINY-DONE')
  assert.match(JSON.stringify(toolResult(await saved(PARENT), 'ctl')), /exceeds the context limit of `tiny`/)
  assert.equal(await exists('team/exec_advice'), false)
  assert.equal(records.filter(record => record.model === 'claude-tiny-1').length, 0)

  // The `advisor` key is used, and it outranks the parent's child-model default.
  models.providers.advisor = 'adv'
  await fixture.save(models)
  assert.equal((await fixture.api('POST', route(PARENT) + '/child-model', { model: 'exec' })).status, 200)
  await turn('consult')
  const waiting = await until(async () => { const state = await saved(PARENT); return state.meta?.wait && !state.busy ? state : false }, 'parent waits on the advisor', 30000)
  const result = toolResult(waiting, 'ctl')
  advisorId = result.result.advisor
  assert.equal(result.status, 'completed', JSON.stringify(result))
  assert.equal(result.result.model, 'advisor')
  assert.match(advisorId, /^team\/exec_advice/)
  assert.deepEqual(waiting.meta.wait.waitAnySessions, [advisorId], JSON.stringify(waiting.meta.wait))
  assert.equal(waiting.meta.wait.timeoutSeconds, 3600, JSON.stringify(waiting.meta.wait))
  const consultRequest = parentRequests().at(-1)
  assert.equal(consultRequest.turn, 'consult#0')
  await until(async () => JSON.stringify((await saved(PARENT)).history.slice(-2)).includes('CONSULT-DONE'), 'advice wakes the parent', 30000)
  const advisor = await saved(advisorId)
  assert.equal(advisor.authority?.model ?? advisor.model ?? advisor.envelope?.model, 'advisor', JSON.stringify(Object.keys(advisor)))
  const listed = JSON.stringify(await row(advisorId))
  assert.match(listed, /"archived":true/)
  assert.match(listed, /Advice: Should the catalog migrate in two phases or one\? We tried o/)
  const advisorRequest = records.find(record => record.session === advisorId)
  assert.equal(advisorRequest.model, 'claude-adv-5')
  const request = JSON.stringify(advisorRequest.body.messages.at(-1))
  assert.match(request, /You are an advisor\. The Session that forked you, `team\/exec`, asks:/)
  assert.match(request, /We tried one phase\./)
  // The wake extends the request that ran the skill: same system, earlier rows byte-identical, advice appended.
  const wake = parentRequests().at(-1)
  assert.equal(wake.turn, 'consult#1')
  assert.equal(JSON.stringify(wake.body.system), JSON.stringify(consultRequest.body.system))
  assert(rowsEqual(consultRequest.body.messages, wake.body.messages), 'parent prefix preserved')
  assert.match(JSON.stringify(wake.body.messages.slice(consultRequest.body.messages.length)), /ADVICE from team\/exec_advice/)

  // A follow-up reaches the archived advisor, which answers and stays archived.
  await turn('followup', 'FOLLOWUP-DONE')
  assert.match(JSON.stringify((await saved(advisorId)).history), /FOLLOWUP: what about rollback\?/)
  assert.match(JSON.stringify(await row(advisorId)), /"archived":true/)

  // Stop the waiting parent; the advisor keeps running and its report starts a new parent turn.
  await turn('stop')
  const holding = await until(() => [...held.keys()][0], 'advisor request held', 30000)
  await until(async () => { const state = await saved(PARENT); return state.meta?.wait && !state.busy }, 'parent waits on the held advisor', 30000)
  assert.equal((await fixture.api('POST', route(PARENT) + '/stop', {})).status, 200)
  await until(async () => !(await saved(PARENT)).busy, 'parent stopped', 30000)
  const beforeRelease = parentRequests().length
  held.get(holding)(); held.clear()
  await until(async () => parentRequests().length > beforeRelease && JSON.stringify((await saved(PARENT)).history.slice(-3)).includes('ADVICE from ' + holding), 'report starts a parent turn', 30000)

  // The advisor fails: no report arrives and the fallback wakes the parent.
  const beforeFail = parentRequests().length
  await turn('fail')
  await until(() => parentRequests().length >= beforeFail + 2, 'fallback wake', 40000)
  assert.equal(parentRequests().at(-1).turn, 'fail#1')
  assert.doesNotMatch(JSON.stringify(parentRequests().at(-1).body.messages.slice(-2)), /ADVICE from/)
  assert.deepEqual(errors, [])
  await fixture.stop()
  console.log(JSON.stringify({ result: 'ok', requests: records.length }))
} catch (error) {
  console.error('HOST_OUTPUT', fixture.output?.slice(-6000)); console.error('PEER_ERRORS', errors)
  console.error('RECORDS', JSON.stringify(records.map(({ body, ...rest }) => rest)))
  throw error
} finally { await fixture.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
