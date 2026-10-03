import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('handoff'), requests = [], failures = [], scripts = new Map(), shellPids = []
const prefix = 'Before performing this inter-agent handoff, have I checked that it is necessary, accurate, self-contained, appropriately scoped, and compliant with the communication rules?'
const suffix = 'I have completed the check, found no issue, and confirm this inter-agent handoff should proceed.'
const placeholder = '<replace this with your own non-empty review; do not copy this placeholder verbatim>'
const review = (middle = '\nThe recipient needs this handoff to complete the assigned work.\n') => prefix + middle + suffix
const confirmed = (args, middle) => ({ ...args, confirmation: review(middle) })
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const exists = path => access(path).then(() => true, () => false)
const tool = (id, name, args, raw) => ({ type: 'function_call', id: 'output-' + id, call_id: id, name, arguments: raw ?? JSON.stringify(args) })
const wrapped = (id, name, args, controls = {}) => tool(id, 'call_tool', { toolId: 'builtin:' + name, args, ...controls })
const idle = id => until(async () => { const value = await history(id); return !value.session.busy && !value.session.runtimeState.queueLength }, 'idle ' + id)
const response = async (id, callId) => (await history(id)).messages.flatMap(row => row.parts || []).map(part => part.functionResponse).find(value => value?.tool_use_id === callId)
const countTask = key => requests.filter(value => value.key === key).length
const run = async (key, calls, id = 'parent') => { if (calls) scripts.set(key, calls); assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'HAND-TASK:' + key })).status, 202); await idle(id); if (calls) { await until(async () => await response(id, calls.at(-1).call_id), 'paired ' + key); const rows = (await saved(id)).history; const paired = rows.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === calls[0].call_id)); assert.deepEqual(paired.parts.map(part => part.functionResponse.tool_use_id), calls.map(call => call.call_id)); const first = rows.findIndex(row => row.parts?.some(part => part.functionCall?.id === calls[0].call_id)); assert(first >= 0 && first < rows.indexOf(paired)) } }
let mode = false, childReports = 0
const provider = createServer(async (request, output) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), input = JSON.stringify(body.input), matches = [...JSON.stringify(body.input.filter(item => item.role === 'user')).matchAll(/HAND-TASK:([A-Za-z0-9_-]+)/g)], key = matches.at(-1)?.[1] || 'ordinary'
    requests.push({ key, body, mode })
    const handoffs = body.tools.filter(value => ['send_to_session', 'create_child_session'].includes(value.name))
    assert.equal(handoffs.length, 2)
    for (const schema of handoffs) {
      assert.equal(Object.hasOwn(schema.parameters.properties, 'confirmation'), mode)
      assert.equal(schema.parameters.required.includes('confirmation'), mode)
      if (mode) { assert.equal(Object.keys(schema.parameters.properties).filter(key => !key.startsWith('__cancel')).at(-1), 'confirmation'); assert.equal(schema.parameters.required.at(-1), 'confirmation') }
    }
    let calls = scripts.get(key); if (calls) scripts.delete(key)
    if (!calls && ['child-report', 'fork-report'].includes(key) && !body.input.some(item => item.type === 'function_call_output' && item.call_id?.startsWith('report-'))) {
      assert(input.includes(prefix)); assert(input.includes(placeholder)); childReports++
      calls = [tool('report-' + key, 'send_to_session', confirmed({ sessionId: '<parent>', message: 'HAND-TASK:result-' + key, afterSend: 'finish' }))]
    }
    output.writeHead(200, { 'content-type': 'text/event-stream' })
    const emit = value => output.write('data: ' + JSON.stringify(value) + '\n\n')
    emit({ type: 'response.created', response: { id: 'handoff-' + requests.length } })
    if (calls) calls.forEach((item, index) => { emit({ type: 'response.output_item.added', output_index: index, item }); emit({ type: 'response.output_item.done', output_index: index, item }) })
    else emit({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] } })
    emit({ type: 'response.completed', response: { id: 'handoff-' + requests.length, status: 'completed' } }); output.end()
  } catch (error) { failures.push(String(error.stack)); output.writeHead(500); output.end(String(error)) }
})
provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
const modelRaw = JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${provider.address().port}`, models: ['wire'] } } })
const config = join(fixture.data, 'state/config.yaml'), originalConfig = await readFile(config, 'utf8')
try {
  await writeFile(fixture.modelPath, modelRaw); await writeFile(config, originalConfig + 'handoffConfirmation: "true"\n')
  await assert.rejects(() => fixture.start(), /handoffConfirmation.*boolean/)
  await writeFile(config, originalConfig); await fixture.start(); await fixture.openApp()
  for (const id of ['parent', 'recipient']) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  await run('disabled-old', [tool('d-empty', 'create_child_session', { suffix: 'disabled-empty' }), tool('d-send', 'send_to_session', { sessionId: 'recipient', message: 'HAND-TASK:recipient-disabled' }), tool('d-extra', 'create_child_session', { suffix: 'disabled-extra', confirmation: 42 }), tool('d-fork', 'create_child_session', { suffix: 'disabled-fork', fork: true })])
  for (const id of ['parent_disabled-empty', 'parent_disabled-extra', 'parent_disabled-fork']) { const value = await saved(id); assert(JSON.stringify(value.history).includes('send_to_session')); assert(!JSON.stringify(value.history).includes(prefix)) }
  assert.equal((await response('parent', 'd-send')).response.error, undefined)
  const oldBytes = await readFile(join(fixture.data, 'state/sessions/parent_disabled-empty.json'), 'utf8')
  await fixture.stop(); mode = true; await writeFile(config, originalConfig + '# checkpoint retained\nhandoffConfirmation: true\n'); await fixture.start()
  assert.equal(await readFile(join(fixture.data, 'state/sessions/parent_disabled-empty.json'), 'utf8'), oldBytes)
  await run('invalid-isolated', [tool('bad-direct', 'create_child_session', { suffix: 'bad-direct' }), wrapped('bad-unified', 'send_to_session', { sessionId: 'recipient', message: 'HAND-TASK:SHOULD-NOT-ARRIVE' }), tool('okay-write', 'write', { filePath: 'sibling.txt', content: 'ordinary sibling' })])
  assert.equal((await response('parent', 'bad-direct')).response.error.type, 'invalid_inter_agent_handoff_confirmation')
  assert((await response('parent', 'bad-unified')).response.error); assert.equal(countTask('SHOULD-NOT-ARRIVE'), 0); assert.equal(await readFile(join(fixture.work, 'sibling.txt'), 'utf8'), 'ordinary sibling')
  assert.equal(await exists(join(fixture.data, 'state/sessions/parent_bad-direct.json')), false)
  const wrongOrder = confirmed({ suffix: 'wrong-order' }); wrongOrder.displayName = 'late'
  await run('shape-errors', [tool('wrong-order', 'create_child_session', wrongOrder), wrapped('placeholder', 'create_child_session', { suffix: 'placeholder', confirmation: review(placeholder) }), tool('prefix-space', 'send_to_session', { sessionId: 'recipient', message: 'not delivered', confirmation: ' ' + review() }), tool('correct-neighbor', 'write', { filePath: 'neighbor.txt', content: 'not swallowed' })])
  for (const id of ['wrong-order', 'placeholder', 'prefix-space']) assert((await response('parent', id)).response.error)
  assert.equal(await readFile(join(fixture.work, 'neighbor.txt'), 'utf8'), 'not swallowed')
  await run('canceled-all', [tool('all-missing', 'create_child_session', { suffix: 'all-missing' }), tool('all-trigger', 'send_to_session', { sessionId: 'recipient', message: 'unused', __cancelAllToolsThisTurn: true }), wrapped('all-wrapped', 'create_child_session', { suffix: 'all-wrapped' }), tool('all-write', 'write', { filePath: 'canceled.txt', content: 'no' })])
  for (const id of ['all-missing', 'all-trigger', 'all-wrapped', 'all-write']) assert((await response('parent', id)).response.canceled)
  assert.equal(await exists(join(fixture.work, 'canceled.txt')), false)
  await run('individual-malformed', [tool('individual', 'create_child_session', { suffix: 'individual', __cancelTool: true }), wrapped('wrapped-cancel', 'send_to_session', { sessionId: 'recipient', message: 'unused' }, { __cancelTool: true }), tool('malformed', 'create_child_session', {}, '{"__cancelAllToolsThisTurn":true,broken'), tool('malformed-neighbor', 'write', { filePath: 'malformed-neighbor.txt', content: 'live' })])
  assert((await response('parent', 'individual')).response.canceled); assert((await response('parent', 'wrapped-cancel')).response.canceled); assert((await response('parent', 'malformed')).response.error); assert.equal(await readFile(join(fixture.work, 'malformed-neighbor.txt'), 'utf8'), 'live')
  await run('search-concrete', [tool('search', 'search_tools', { query: 'send_to_session create_child_session', sources: ['builtin'], limit: 10, includeSchema: true })])
  const discovered = (await response('parent', 'search')).response.output
  for (const name of ['send_to_session', 'create_child_session']) { const line = discovered.split('\n').find(value => value.includes('builtin:' + name)); assert(line); assert.match(line, /confirmation: string/); assert(line.indexOf('confirmation: string') > line.indexOf('afterSend')) }
  const barrierCalls = [tool('barrier-exec-first', 'exec', { command: 'printf %s $$ > handoff-first-pid; touch handoff-start; while [ ! -f handoff-release ]; do sleep 0.02; done; printf first', timeout: 60 }), tool('barrier-child', 'create_child_session', confirmed({ suffix: 'barrier-child' })), tool('barrier-exec-next', 'exec', { command: 'printf %s $$ > handoff-next-pid; touch handoff-next; printf next', timeout: 60 })]
  scripts.set('actual-barrier', barrierCalls); assert.equal((await fixture.api('POST', route('parent') + '/message', { text: 'HAND-TASK:actual-barrier' })).status, 202)
  await until(() => exists(join(fixture.work, 'handoff-start')), 'real first exec held'); assert.equal(await exists(join(fixture.data, 'state/sessions/parent_barrier-child.json')), false); assert.equal(await exists(join(fixture.work, 'handoff-next')), false)
  await writeFile(join(fixture.work, 'handoff-release'), ''); await idle('parent'); assert(await exists(join(fixture.data, 'state/sessions/parent_barrier-child.json'))); assert(await exists(join(fixture.work, 'handoff-next')))
  const barrierRows = (await saved('parent')).history; const barrierPair = barrierRows.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'barrier-exec-first')); assert.deepEqual(barrierPair.parts.map(part => part.functionResponse.tool_use_id), barrierCalls.map(call => call.call_id))
  const beforeFork = (await saved('parent')).history
  await run('valid-no-message', [tool('v-empty', 'create_child_session', confirmed({ suffix: 'enabled-empty' }, 'Own review without separators.')), wrapped('v-empty-unified', 'create_child_session', confirmed({ suffix: 'enabled-unified' }, '\r\nOriginal CRLF review.\r\n')), tool('v-space', 'send_to_session', confirmed({ sessionId: 'recipient', message: 'HAND-TASK:recipient-space' }, ' Original spaced review. ')), tool('v-fallback', 'call_tool', { toolId: 'builtin:send_to_session', argsJson: JSON.stringify(confirmed({ sessionId: 'recipient', message: 'HAND-TASK:recipient-fallback' })) })])
  for (const id of ['parent_enabled-empty', 'parent_enabled-unified']) { assert(JSON.stringify((await saved(id)).history).includes(prefix)); assert.equal(countTask(id), 0) }
  await run('children-start', [tool('v-start', 'create_child_session', confirmed({ suffix: 'active', message: 'HAND-TASK:child-report' })), wrapped('v-fork', 'create_child_session', confirmed({ suffix: 'forked', fork: true, message: 'HAND-TASK:fork-report' }))])
  await idle('parent_active'); await idle('parent_forked'); await idle('parent'); assert.equal(childReports, 2)
  const fork = await saved('parent_forked'), parent = await saved('parent'); assert(beforeFork.every(row => fork.history.some(value => JSON.stringify(value) === JSON.stringify(row))))
  assert.equal(fork.promptCacheKey, parent.promptCacheKey); assert.equal(fork.persistentMemorySnapshot, parent.persistentMemorySnapshot); assert(JSON.stringify(fork.history).includes('report-fork-report'))
  for (const id of ['parent_active', 'parent_forked']) { const value = await saved(id); const calls = value.history.flatMap(row => row.parts || []).filter(part => part.functionCall?.name === 'send_to_session'); assert(calls.length); assert(value.history.flatMap(row => row.parts || []).some(part => part.functionResponse?.tool_use_id?.startsWith('report-'))) }
  await run('finish-with-error', [tool('finish-bad-review', 'create_child_session', { suffix: 'finish-bad-review' }), wrapped('finish-valid', 'send_to_session', confirmed({ sessionId: 'recipient', message: 'HAND-TASK:recipient-finish', afterSend: 'finish' })), tool('finish-sibling', 'write', { filePath: 'finish-sibling.txt', content: 'complete batch' })])
  assert((await response('parent', 'finish-bad-review')).response.error); assert.equal((await response('parent', 'finish-valid')).response.error, undefined); assert.equal(await readFile(join(fixture.work, 'finish-sibling.txt'), 'utf8'), 'complete batch'); assert.equal(countTask('finish-with-error'), 1)
  const humanFork = await fixture.api('POST', route('parent') + '/fork', { suffix: 'human-fork' }); assert.equal(humanFork.status, 200)
  assert(JSON.stringify((await saved('parent_human-fork')).history).includes('by user command'))
  await writeFile(config, originalConfig + '# disabled on next startup\nhandoffConfirmation: false\n'); await fixture.save(modelRaw); assert.equal(await readFile(config, 'utf8'), originalConfig + '# disabled on next startup\nhandoffConfirmation: false\n')
  await run('no-hot-mode', [tool('still-requires', 'create_child_session', { suffix: 'still-requires' })]); assert((await response('parent', 'still-requires')).response.error)
  await fixture.stop(); mode = false; await fixture.start()
  await run('disabled-after-restart', [wrapped('disabled-again', 'create_child_session', { suffix: 'disabled-again' }), tool('disabled-send', 'send_to_session', { sessionId: 'recipient', message: 'HAND-TASK:recipient-again' })])
  assert.equal((await response('parent', 'disabled-again')).response.error, undefined); assert(!JSON.stringify((await saved('parent_disabled-again')).history).includes(prefix))
  assert.equal(await readFile(config, 'utf8'), originalConfig + '# disabled on next startup\nhandoffConfirmation: false\n')
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ ok: true, root: fixture.root, hostPids: fixture.hostPids, requests: requests.length, childReports, originalApp: true, disabledEnabledDisabled: true, strictPairs: true, cancellationBeforeEffect: true, forkCanonicalCopy: true, noHotReload: true }))
} finally {
  await writeFile(join(fixture.work, 'handoff-release'), '').catch(() => {})
  for (const file of ['handoff-first-pid', 'handoff-next-pid']) { const value = await readFile(join(fixture.work, file), 'utf8').catch(() => ''); if (/^[0-9]+$/.test(value)) shellPids.push(Number(value)) }
  await writeFile(join(fixture.root, 'handoff-requests.json'), JSON.stringify({ requests, failures }, null, 2))
  if (failures.length) console.error(JSON.stringify({ failures }))
  console.log(JSON.stringify({ ownedRoot: fixture.root, ownedHostPids: fixture.hostPids, ownedShellPids: shellPids }))
  await fixture.cleanup(); await new Promise(resolve => provider.close(resolve))
}
