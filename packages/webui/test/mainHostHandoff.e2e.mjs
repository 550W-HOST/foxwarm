import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { functionCall, responsesHistory } from './ctlModelCalls.mjs'

const fixture = await createHostFixture('handoff'), requests = [], failures = [], scripts = new Map(), shellPids = []
await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), ' \n')
// Older ToolScripts, skills and models still send the removed review fields; the handlers ignore them.
const legacy = args => ({ handoffRecall: 'The parent requested these owned fixture checks.', ...args, handoffConfirmation: 'The recipient needs this handoff. I confirm this handoff should proceed.' })
const mentionsFields = text => /handoff(?:Recall|Confirmation)/.test(text)
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const exists = path => access(path).then(() => true, () => false)
const tool = (id, name, args, raw) => raw === undefined ? { ...functionCall(id, name, args), id: 'output-' + id } : { type: 'function_call', id: 'output-' + id, call_id: id, name, arguments: raw }
const wrapped = (id, name, args, controls = {}) => tool(id, 'call_tool', { toolId: 'builtin:' + name, args, ...controls })
const idle = id => until(async () => { const value = await history(id); return !value.session.busy && !value.session.runtimeState.queueLength }, 'idle ' + id)
const response = async (id, callId) => (await history(id)).messages.flatMap(row => row.parts || []).map(part => part.functionResponse).find(value => value?.tool_use_id === callId)
const countTask = key => requests.filter(value => value.key === key).length
const run = async (key, calls, id = 'parent') => { if (calls) scripts.set(key, calls); assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'HAND-TASK:' + key })).status, 202); await idle(id); if (calls) { await until(async () => await response(id, calls.at(-1).call_id), 'paired ' + key); const rows = (await saved(id)).history; const paired = rows.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === calls[0].call_id)); assert.deepEqual(paired.parts.map(part => part.functionResponse.tool_use_id), calls.map(call => call.call_id)); const first = rows.findIndex(row => row.parts?.some(part => part.functionCall?.id === calls[0].call_id)); assert(first >= 0 && first < rows.indexOf(paired)) } }
let childReports = 0
const provider = createServer(async (request, output) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    // A forked child reads its instruction from the copied creating call, identified by its own fork result.
    const forked = new Set(body.input.filter(item => item.type === 'function_call_output' && JSON.stringify(item.output ?? '').includes('Fork complete: you are the child session')).map(item => item.call_id))
    const matches = [...JSON.stringify(body.input.filter(item => item.role === 'user' || item.type === 'function_call' && forked.has(item.call_id))).matchAll(/HAND-TASK:([A-Za-z0-9_-]+)/g)], key = matches.at(-1)?.[1] || 'ordinary'
    requests.push({ key, body })
    const handoffs = body.tools.filter(value => ['send_to_session', 'create_child_session'].includes(value.name))
    assert.equal(handoffs.length, 2)
    for (const schema of handoffs) {
      const properties = Object.keys(schema.parameters.properties), required = schema.parameters.required || []
      for (const field of ['confirmation', 'handoffRecall', 'handoffConfirmation']) { assert.equal(properties.includes(field), false); assert.equal(required.includes(field), false) }
    }
    let calls = scripts.get(key); if (calls) scripts.delete(key)
    if (!calls && ['child-report', 'fork-report'].includes(key) && !body.input.some(item => item.type === 'function_call_output' && item.call_id?.startsWith('report-'))) {
      const history = JSON.stringify(responsesHistory(body)); assert(history.includes('send_to_session')); assert.equal(history.includes('handoffRecall:'), false); childReports++
      calls = [tool('report-' + key, 'send_to_session', legacy({ sessionId: '<parent>', message: 'HAND-TASK:result-' + key, currentSessionTurnAction: 'end_turn' }))]
    }
    if (key === 'finish-with-error' && !calls) {
      const ids = ['finish-bad-args', 'finish-valid', 'finish-sibling']
      const outputs = body.input.filter(item => item.type === 'function_call_output' && ids.includes(item.call_id))
      assert.deepEqual(outputs.map(item => item.call_id), ids, 'Error handling sees the complete ordered batch')
      assert(outputs.every(item => item.output), 'Every completed sibling reaches the continuation')
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
  // An existing config that still sets the removed startup key keeps starting; the key is ignored.
  const retainedConfig = originalConfig + '# removed key retained\nhandoffConfirmation: true\n'
  await writeFile(fixture.modelPath, modelRaw); await writeFile(config, retainedConfig); await fixture.start(); await fixture.openApp()
  for (const id of ['parent', 'recipient']) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  await run('legacy-fields', [tool('l-empty', 'create_child_session', { suffix: 'plain-empty' }), tool('l-send', 'send_to_session', { sessionId: 'recipient', message: 'HAND-TASK:recipient-plain' }), tool('l-extra', 'create_child_session', { suffix: 'legacy-extra', handoffRecall: 42, handoffConfirmation: 42 }), wrapped('l-unified', 'create_child_session', legacy({ suffix: 'legacy-unified' })), tool('l-space', 'send_to_session', legacy({ sessionId: 'recipient', message: 'HAND-TASK:recipient-legacy' })), tool('l-fallback', 'call_tool', { toolId: 'builtin:send_to_session', argsJson: JSON.stringify(legacy({ sessionId: 'recipient', message: 'HAND-TASK:recipient-fallback' })) }), tool('l-fork', 'create_child_session', { suffix: 'plain-fork', fork: true })])
  for (const id of ['l-empty', 'l-send', 'l-extra', 'l-unified', 'l-space', 'l-fallback', 'l-fork']) assert.equal((await response('parent', id)).response.error, undefined, id)
  for (const id of ['parent_plain-empty', 'parent_legacy-extra', 'parent_plain-fork', 'parent_legacy-unified']) { const value = await saved(id); assert(JSON.stringify(value.history).includes('send_to_session')); assert.doesNotMatch(JSON.stringify(value.history), /handoff(?:Recall|Confirmation):/) }
  await idle('recipient')
  const delivered = (await history('recipient')).messages.flatMap(row => row.parts || []).map(part => part.system || '').filter(Boolean)
  for (const key of ['recipient-plain', 'recipient-legacy', 'recipient-fallback']) assert.equal(delivered.filter(text => text.includes('HAND-TASK:' + key)).length, 1, key)
  assert.equal(delivered.some(mentionsFields), false)
  await run('invalid-isolated', [tool('bad-direct', 'create_child_session', { suffix: 'bad-direct', handoffReview: 'not a former field' }), wrapped('bad-unified', 'send_to_session', { sessionId: 'recipient', handoffRecall: 'missing message' }), tool('okay-write', 'write', { filePath: 'sibling.txt', content: 'ordinary sibling' })])
  assert.match((await response('parent', 'bad-direct')).response.error, /unsupported or missing fields/)
  assert((await response('parent', 'bad-unified')).response.error); assert.equal(await readFile(join(fixture.work, 'sibling.txt'), 'utf8'), 'ordinary sibling')
  assert.equal(await exists(join(fixture.data, 'state/sessions/parent_bad-direct.json')), false)
  await run('canceled-all', [tool('all-missing', 'create_child_session', { suffix: 'all-missing' }), tool('all-trigger', 'send_to_session', { sessionId: 'recipient', message: 'unused', __cancelAllToolsThisTurn: true }), wrapped('all-wrapped', 'create_child_session', { suffix: 'all-wrapped' }), tool('all-write', 'write', { filePath: 'canceled.txt', content: 'no' })])
  for (const id of ['all-missing', 'all-trigger', 'all-wrapped', 'all-write']) assert((await response('parent', id)).response.canceled)
  assert.equal(await exists(join(fixture.work, 'canceled.txt')), false)
  await run('individual-malformed', [tool('individual', 'create_child_session', { suffix: 'individual', __cancelTool: true }), wrapped('wrapped-cancel', 'send_to_session', { sessionId: 'recipient', message: 'unused' }, { __cancelTool: true }), tool('malformed', 'create_child_session', {}, '{"__cancelAllToolsThisTurn":true,broken'), tool('malformed-neighbor', 'write', { filePath: 'malformed-neighbor.txt', content: 'live' })])
  assert((await response('parent', 'individual')).response.canceled); assert((await response('parent', 'wrapped-cancel')).response.canceled); assert((await response('parent', 'malformed')).response.error); assert.equal(await readFile(join(fixture.work, 'malformed-neighbor.txt'), 'utf8'), 'live')
  // Discovery describes the handoff tools with the declared schema, which no longer lists the review fields.
  await run('search-concrete', [tool('search', 'run_script', { code: 'return ctl("tool search send_to_session create_child_session --source builtin --limit 10")' })])
  const discovered = (await response('parent', 'search')).response.result.tools
  for (const name of ['send_to_session', 'create_child_session']) { const row = discovered.find(value => value.toolId === 'builtin:' + name); assert(row, JSON.stringify(discovered)); assert.equal(row.kind, 'declared'); const keys = Object.keys(row.inputSchema.properties); assert(keys.includes('message'), keys.join()); assert.equal(mentionsFields(keys.join()), false, keys.join()) }
  const barrierCalls = [tool('barrier-exec-first', 'exec', { command: 'printf %s $$ > handoff-first-pid; touch handoff-start; while [ ! -f handoff-release ]; do sleep 0.02; done; printf first', timeout: 60 }), tool('barrier-child', 'create_child_session', { suffix: 'barrier-child' }), tool('barrier-exec-next', 'exec', { command: 'printf %s $$ > handoff-next-pid; touch handoff-next; printf next', timeout: 60 })]
  scripts.set('actual-barrier', barrierCalls); assert.equal((await fixture.api('POST', route('parent') + '/message', { text: 'HAND-TASK:actual-barrier' })).status, 202)
  await until(() => exists(join(fixture.work, 'handoff-start')), 'real first exec held'); assert.equal(await exists(join(fixture.data, 'state/sessions/parent_barrier-child.json')), false); assert.equal(await exists(join(fixture.work, 'handoff-next')), false)
  await writeFile(join(fixture.work, 'handoff-release'), ''); await idle('parent'); assert.equal((await response('parent', 'barrier-child')).response.error, undefined); assert(await exists(join(fixture.data, 'state/sessions/parent_barrier-child.json'))); assert(await exists(join(fixture.work, 'handoff-next')))
  const barrierRows = (await saved('parent')).history; const barrierPair = barrierRows.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'barrier-exec-first')); assert.deepEqual(barrierPair.parts.map(part => part.functionResponse.tool_use_id), barrierCalls.map(call => call.call_id))
  const beforeFork = (await saved('parent')).history
  await run('children-start', [tool('v-start', 'create_child_session', legacy({ suffix: 'active', message: 'HAND-TASK:child-report' })), wrapped('v-fork', 'create_child_session', { suffix: 'forked', fork: true, message: 'HAND-TASK:fork-report' })])
  await idle('parent_active'); await idle('parent_forked'); await idle('parent'); assert.equal(childReports, 2)
  const fork = await saved('parent_forked'), parent = await saved('parent'); assert(beforeFork.every(row => fork.history.some(value => JSON.stringify(value) === JSON.stringify(row))))
  assert.equal(fork.promptCacheKey, parent.promptCacheKey); assert.equal(fork.persistentMemorySnapshot, parent.persistentMemorySnapshot); assert(JSON.stringify(fork.history).includes('report-fork-report'))
  for (const id of ['parent_active', 'parent_forked']) { const value = await saved(id); const calls = value.history.flatMap(row => row.parts || []).filter(part => part.functionCall?.name === 'send_to_session'); assert(calls.length); assert(value.history.flatMap(row => row.parts || []).some(part => part.functionResponse?.tool_use_id?.startsWith('report-'))) }
  await run('finish-with-error', [tool('finish-bad-args', 'create_child_session', { displayName: 'missing suffix' }), wrapped('finish-valid', 'send_to_session', legacy({ sessionId: 'recipient', message: 'HAND-TASK:recipient-finish', currentSessionTurnAction: 'end_turn' })), tool('finish-sibling', 'write', { filePath: 'finish-sibling.txt', content: 'complete batch' })])
  assert((await response('parent', 'finish-bad-args')).response.error); assert.equal((await response('parent', 'finish-valid')).response.error, undefined); assert.equal(await readFile(join(fixture.work, 'finish-sibling.txt'), 'utf8'), 'complete batch'); assert.equal(countTask('finish-with-error'), 2)
  const finishRows = (await history('parent')).messages
  assert(finishRows.some(row => row.parts?.some(part => part.text === 'DONE-finish-with-error')), 'Sibling error continues the model after successful delivery')
  for (const id of ['finish-bad-args', 'finish-valid', 'finish-sibling']) assert.equal(finishRows.flatMap(row => row.parts || []).filter(part => part.functionCall?.id === id).length, 1, id + ' is not replayed')
  await idle('recipient')
  assert.equal((await history('recipient')).messages.flatMap(row => row.parts || []).filter(part => part.system?.includes('HAND-TASK:recipient-finish')).length, 1)
  assert.equal(countTask('recipient-finish'), 1)
  const humanPrefix = (await saved('parent')).history
  const humanFork = await fixture.api('POST', route('parent') + '/fork', { suffix: 'human-fork' }); assert.equal(humanFork.status, 200)
  const humanHistory = (await saved('parent_human-fork')).history
  assert.deepEqual(humanHistory.slice(0, humanPrefix.length), humanPrefix)
  const humanBoundary = humanHistory.slice(humanPrefix.length)
  assert(humanBoundary.length > 0); assert(humanBoundary.every(row => row.role === 'user' && row.parts.every(part => typeof part.system === 'string')))
  const humanInstructions = humanBoundary.flatMap(row => row.parts.map(part => part.system))
  assert(humanInstructions.some(text => text.includes('event="history-inherited"') && text.includes('parentSessionId="parent"') && text.includes('currentSessionId="parent_human-fork"')))
  for (const text of humanInstructions) assert.equal(mentionsFields(text), false)
  // A model configuration save leaves the separate app config, including the ignored key, unchanged.
  await fixture.save(modelRaw); assert.equal(await readFile(config, 'utf8'), retainedConfig)
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ ok: true, root: fixture.root, hostPids: fixture.hostPids, requests: requests.length, childReports, originalApp: true, ignoredLegacyFields: true, ignoredConfigKey: true, strictPairs: true, cancellationBeforeEffect: true, forkCanonicalCopy: true }))
} finally {
  await writeFile(join(fixture.work, 'handoff-release'), '').catch(() => {})
  for (const file of ['handoff-first-pid', 'handoff-next-pid']) { const value = await readFile(join(fixture.work, file), 'utf8').catch(() => ''); if (/^[0-9]+$/.test(value)) shellPids.push(Number(value)) }
  await writeFile(join(fixture.root, 'handoff-requests.json'), JSON.stringify({ requests, failures }, null, 2))
  if (failures.length) console.error(JSON.stringify({ failures }))
  console.log(JSON.stringify({ ownedRoot: fixture.root, ownedHostPids: fixture.hostPids, ownedShellPids: shellPids }))
  await fixture.cleanup(); await new Promise(resolve => provider.close(resolve))
}
