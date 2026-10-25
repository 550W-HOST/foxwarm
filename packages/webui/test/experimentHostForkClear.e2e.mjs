import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { WebSocketServer } from 'ws'
import { createHostFixture, saveModelsInOriginalApp, until } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('fork-clear'), records = [], errors = [], connections = [], held = new Map(), heldOnce = new Set(), commandNotices = []
const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
const authorityPath = id => join(fixture.data, 'state/sessions', id + '.json')
const authority = id => readFile(authorityPath(id), 'utf8').then(JSON.parse)
const sha = id => createHash('sha256').update(id).digest('hex')
const textOf = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(part => part.text || '').join('') : ''
const inputText = input => input.filter(item => item.role === 'user').map(item => textOf(item.content)).join('\n')
const tool = (id, name, args) => ({ type: 'function_call', id: 'output-' + id, call_id: id, name, arguments: JSON.stringify(args) })
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const replay = output => output.map(item => { const copy = { ...item }; delete copy.id; delete copy.status; return copy })
let sequence = 0, planCount = 0, holdPlan = false, crossAgent = 'team'
function dispatch(value) {
  records.push(value)
  const input = inputText(value.full), scenario = [...input.matchAll(/CASE:([a-z0-9-]+)/g)].at(-1)?.[1] || 'none'
  value.scenario = scenario; value.planning = input.includes('COMPACTION STARTED:')
  if (value.planning) {
    const segments = [...input.matchAll(/^Segment \d+: raw message candidates[^\n]*\n([\s\S]*?)(?=^Segment \d+:|^Review the older candidate items)/gm)]
    const replacements = segments.map(segment => {
      const ranges = [...segment[1].matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])])
      assert(ranges.length, 'real eligible message candidates')
      return { level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Ordered dialogue, inherited provenance and paired tool results.' }
    })
    assert(replacements.length, 'real legal raw candidate segments')
    value.valid = () => value.complete([tool('plan-' + (++planCount), 'submit_compact_plan', { replaceAsBlocks: replacements })])
    if (holdPlan) held.set('plan', value); else value.valid()
    return
  }
  if (scenario === 'retry-hidden' && !records.slice(0, -1).some(row => row.scenario === scenario)) { value.fail(); return }
  if (scenario === 'self-fork' && !value.full.some(item => item.type === 'function_call_output' && item.call_id === 'fork-child')) {
    value.complete([tool('fork-child', 'create_child_session', { suffix: 'worker', fork: true, message: 'CASE:child-task Complete the new task independently.' }),
      tool('held-effect', 'exec', { command: "printf '%s\\n' once >> fork-effect.log; printf started > fork-started; while [ ! -f fork-release ]; do sleep 0.05; done; printf finished", timeout: 15 })]); return
  }
  if (scenario.startsWith('held-') && !heldOnce.has(scenario)) { heldOnce.add(scenario); held.set(scenario, value); return }
  if (scenario.startsWith('recall-') && !value.full.some(item => item.type === 'function_call_output' && item.call_id === scenario)) {
    value.complete([tool(scenario, 'recall', { target: scenario.endsWith('two') ? 'msg:B#2' : 'msg:B#1', toolDetail: 'full', previewLength: 6000 })]); return
  }
  if (scenario === 'create-agent' && !value.full.some(item => item.type === 'function_call_output' && item.call_id === scenario)) { value.complete([tool(scenario, 'create_agent', { agentName: crossAgent })]); return }
  if (scenario === 'force-fork' && !value.full.some(item => item.type === 'function_call_output' && item.call_id === scenario)) { value.complete([tool(scenario, 'create_child_session', { suffix: scenario, fork: true, forceModel: { modelId: 'sync', effort: 'none' } })]); return }
  if (['selected-fork', 'selected-fresh', 'cross-fresh', 'cross-fork'].includes(scenario) && !value.full.some(item => item.type === 'function_call_output' && item.call_id === scenario)) {
    value.complete([tool(scenario, 'create_child_session', { suffix: scenario, fork: scenario.endsWith('fork'), ...(scenario.startsWith('cross-') ? { agentName: crossAgent } : {}), message: 'CASE:' + scenario + '-task New owned task.' })]); return
  }
  value.complete(final('DONE-' + scenario))
}
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const bytes of request) raw += bytes
    const body = JSON.parse(raw), value = { body, full: body.input, kind: 'http', headers: request.headers, closed: false }
    value.complete = output => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'http-' + (++sequence), status: 'completed', output, usage: { input_tokens: 40, output_tokens: 3 } } }) + '\n\n') }
    value.fail = () => { response.writeHead(503); response.end('synthetic bounded retry') }
    response.on('close', () => { value.closed = true }); dispatch(value)
  } catch (error) { errors.push(error.stack); response.destroy() }
})
const server = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 0 } })
peer.on('upgrade', (request, socket, head) => server.handleUpgrade(request, socket, head, ws => server.emit('connection', ws, request)))
server.on('connection', (ws, request) => {
  const connection = { ws, states: new Map(), closed: false }; connections.push(connection)
  ws.on('close', () => { connection.closed = true }); ws.on('error', error => errors.push(error.message))
  ws.on('message', raw => {
    try {
      const body = JSON.parse(raw), prefix = body.previous_response_id ? connection.states.get(body.previous_response_id) : []
      assert(prefix, 'previous response belongs to this real connection')
      const full = [...prefix, ...body.input], value = { body, full, kind: 'ws', headers: request.headers, connection }
      value.complete = output => { const id = 'ws-' + (++sequence); connection.states.set(id, [...full, ...replay(output)]); ws.send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 40, output_tokens: 3 } } }), { compress: true }) }
      value.fail = () => ws.send(JSON.stringify({ type: 'error', error: { message: 'synthetic bounded retry' } }))
      dispatch(value)
    } catch (error) { errors.push(error.stack); ws.close(1011) }
  })
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const base = 'http://127.0.0.1:' + peer.address().port
const config = { default: 'a', providers: { a: { providerType: 'openai-ws', baseUrl: base + '/ws', apiKey: 'synthetic-ws', models: ['wire'], contextLimit: 20000 }, sync: { providerType: 'openai-responses', baseUrl: base + '/http', apiKey: 'synthetic-http', models: ['wire'], contextLimit: 20000, extraFields: { cache: '${SESSION_CACHE_KEY}' }, asyncCompact: false } } }
async function command(id, text) {
  const before = commandNotices.length
  const response = await fixture.api('POST', route(id) + '/message', { text })
  if (text === '/session clear' || text.startsWith('/fork ')) {
    await until(() => commandNotices.slice(before).some(row => row.sessionId === id), 'original App command reply')
  }
  return response
}
const commandFailed = id => commandNotices.findLast(row => row.sessionId === id)?.text.startsWith('❌') === true
async function create(model) { const result = await fixture.api('POST', '/api/sessions', {}); assert.equal(result.status, 200); if (model) assert.equal((await fixture.api('POST', route(result.body.sessionId) + '/model', { model })).status, 200); return result.body.sessionId }
async function send(id, scenario, extra = '') {
  const count = records.length; assert.equal((await command(id, 'CASE:' + scenario + ' ' + extra)).status, 202)
  await until(async () => { const live = await history(id); return !live.session.busy && live.messages.some(row => row.parts?.some(part => part.text === 'DONE-' + scenario)) }, 'completed ' + scenario)
  assert.deepEqual(errors, []); return records.slice(count).filter(row => row.scenario === scenario)
}
async function seed(id, label, count = 7) { for (let index = 0; index < count; index++) await send(id, 'seed-' + label + '-' + index, ('ordered-' + label + '-' + index + '-').repeat(750)) }
async function compact(id) {
  const before = fixture.sql('SELECT MAX(id) FROM archive_blocks WHERE session_id=?', [id])[0][0] || 0
  assert.equal((await command(id, '/compact')).status, 200)
  await until(async () => (fixture.sql('SELECT MAX(id) FROM archive_blocks WHERE session_id=?', [id])[0][0] || 0) > before && !(await history(id)).session.busy, 'real compact authority ' + id)
}
const branch = id => fixture.sql('SELECT parent_session_id,fork_message_seq,fork_block_id FROM archive_branches WHERE session_id=?', [id])[0]
const archive = id => fixture.sql('SELECT seq,message_json FROM archive_messages WHERE session_id=? ORDER BY seq', [id])
const fork = async (id, suffix) => { const result = await fixture.api('POST', route(id) + '/fork', { suffix }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.newSessionId }

try {
  await fixture.start(); const parent = await create(), page = await fixture.openApp()
  await saveModelsInOriginalApp(page, yaml.dump(config), fixture.modelPath)
  const cdp = await page.createCDPSession(); await cdp.send('Network.enable')
  cdp.on('Network.webSocketFrameReceived', event => {
    try {
      const row = JSON.parse(event.response.payloadData)
      if (row.type === 'message' && row.message?.__meta?.isCommandResponse) commandNotices.push({ sessionId: row.sessionId, text: row.message.parts.map(part => part.text || '').join('') })
    } catch {}
  })
  assert.equal((await fixture.api('POST', route(parent) + '/model', { model: 'sync' })).status, 200)
  await send(parent, 'retry-hidden'); assert((await history(parent)).messages.some(row => row.modelVisible === false), 'real retry notice is canonical but hidden')
  assert.equal((await fixture.api('POST', route(parent) + '/model', { model: 'a', effort: 'low' })).status, 200)
  await seed(parent, 'parent'); await compact(parent)
  const firstBlock = fixture.sql('SELECT * FROM archive_blocks WHERE session_id=? AND id=1', [parent]), oldArchive = archive(parent), oldCache = (await authority(parent)).promptCacheKey
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), parent)
  await page.waitForSelector(`[data-workbench-content-tab=${JSON.stringify('chat:' + parent)}] .foxwarm-chat-root[data-chat-connection-state="connected"]`, { visible: true })
  await page.evaluate(() => window.foxwarmTest.sendMessage('CASE:self-fork'))
  await until(async () => (await readFile(join(fixture.work, 'fork-started'), 'utf8').catch(() => '')) === 'started', 'actual executing parent effect')
  const child = parent + '_worker'; await until(async () => (await history(child)).messages?.some(row => row.parts?.some(part => part.text === 'DONE-child-task')), 'genuine tool-created fork task')
  const parentCut = (await authority(parent)).history, childState = await authority(child), cap = branch(child)
  assert.deepEqual(childState.history.slice(0, parentCut.length), parentCut); assert.equal(childState.promptCacheKey, oldCache)
  assert.equal(childState.model, 'a'); assert.equal(childState.effort, 'low'); assert.equal(cap[1], (await authority(parent)).nextMessageSeq - 1); assert.equal(cap[2], 1)
  const closure = childState.history[parentCut.length].parts.map(part => part.functionResponse)
  assert(closure[0].response.output.includes(child)); assert.equal(closure[1].response.output, 'Pending execution in parent session')
  const childWire = records.find(row => row.scenario === 'child-task'); assert(childWire); assert.equal(childWire.body.prompt_cache_key, sha(child)); assert(!childWire.body.previous_response_id)
  assert(!JSON.stringify(childWire.full).includes('Retrying model request'), 'hidden copied notice is not projected')
  await page.waitForSelector('[data-session-id="' + parent + '"]'); const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/fork'))
  await page.click('[data-session-id="' + parent + '"]', { button: 'right' }); await page.waitForSelector('[role="menuitem"]')
  await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === 'Fork').click())
  const sidebarReply = await (await responsePromise).json(), manual = sidebarReply.newSessionId; assert(manual)
  const manualState = await authority(manual); assert.deepEqual(manualState.history.slice(0, parentCut.length), parentCut)
  assert(manualState.history[parentCut.length].parts.every(part => part.functionResponse.response.output === 'Pending execution in parent session'))
  assert.deepEqual((await authority(parent)).history, parentCut, 'Sidebar created no parent notice')
  const beforeContinue = records.length; assert.equal((await command(manual, '/continue')).status, 200); await until(async () => !(await history(manual)).session.busy, 'Continue uses copied paired history')
  assert(records.length > beforeContinue); assert.equal((await readFile(join(fixture.work, 'fork-effect.log'), 'utf8')).trim().split('\n').length, 1)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), parent); await page.waitForSelector(`[data-workbench-content-tab=${JSON.stringify('chat:' + parent)}] .foxwarm-chat-root[data-chat-connection-state="connected"]`, { visible: true }); await command(parent, 'captured queued input to drop'); const busyClear = await command(parent, '/session clear')
  assert.equal(busyClear.status, 200); assert.equal(busyClear.body.success, true); assert.equal(commandFailed(parent), false)
  assert((await authority(parent)).history.length > 0); assert.equal((await authority(parent)).queue.length, 0)
  await writeFile(join(fixture.work, 'fork-release'), 'release'); await until(async () => !(await history(parent)).session.busy, 'Stop does not kill or replay ordinary effect')
  assert(!(await history(parent)).messages.some(row => row.parts?.some(part => part.text === 'captured queued input to drop')))
  await until(async () => (await history(parent)).messages.some(row => row.parts?.some(part => part.system?.includes('background-process-finished'))) && !(await history(parent)).session.busy, 'real surviving exec completion is consumed before idle clear')
  const expanded = await fixture.api('GET', route(child) + '/context-blocks/1/expand'); assert.equal(expanded.status, 200); assert(expanded.body.items.every(item => item.inherited && item.sourceSessionId === parent))
  assert(archive(child).every(([seq]) => seq > cap[1]), 'fork stores only owned suffix, not copied parent Archive')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), parent); await page.evaluate(() => window.foxwarmTest.sendMessage('/session clear'))
  await until(async () => (await authority(parent)).history.length === 0, 'original Chat idle clear')
  const cleared = await authority(parent); assert.equal(cleared.nextBlockId, 2); assert.notEqual(cleared.promptCacheKey, oldCache); assert.equal((await authority(child)).promptCacheKey, oldCache)
  assert.deepEqual(fixture.sql('SELECT * FROM archive_blocks WHERE session_id=? AND id=1', [parent]), firstBlock)
  assert.deepEqual(archive(parent).slice(0, oldArchive.length), oldArchive)
  await seed(parent, 'after-clear'); await compact(parent); assert.equal((await authority(parent)).nextBlockId, 3)
  assert.deepEqual(branch(child), cap); assert.equal((await fixture.api('GET', route(child) + '/context-blocks/2/expand')).status, 404, 'parent later block cannot leak through fixed fork cap')
  await seed(child, 'child'); await compact(child); const childFrontier = (await authority(child)).nextBlockId - 1; assert(childFrontier >= 2)
  const nested = await fork(child, 'nested'), nestedCap = branch(nested)
  assert.equal(nestedCap[2], childFrontier); await seed(child, 'child-later'); await compact(child)
  assert.equal((await fixture.api('GET', route(nested) + '/context-blocks/' + (childFrontier + 1) + '/expand')).status, 404, 'nested child excludes later immediate-parent block')
  const inheritedTwo = await fixture.api('GET', route(nested) + '/context-blocks/2/expand'); assert.equal(inheritedTwo.status, 200)
  assert(inheritedTwo.body.items.some(item => item.inherited && item.sourceSessionId === child))
  const recalled = await send(nested, 'recall-grand-two'); const recallOutput = recalled.flatMap(row => row.full).find(item => item.type === 'function_call_output' && item.call_id === 'recall-grand-two')
  assert(textOf(recallOutput.output).includes('[inherited: ')); assert(!textOf(recallOutput.output).includes('seed-child-later'))
  assert.deepEqual(branch(nested), nestedCap); assert.deepEqual(branch(child), cap)

  const manualInstruction = 'CASE:manual-task First line.\nSecond line includes complete instructions.\nFinal line and trailing newline.\n'
  const beforeManual = records.length, idleFork = await command(parent, '/fork instructed ' + manualInstruction)
  assert.equal(idleFork.status, 200); const instructed = parent + '_instructed'
  await until(async () => !(await history(instructed)).session.busy && (await history(instructed)).messages.some(row => row.parts?.some(part => part.text === 'DONE-manual-task')), 'manual initial task')
  const instructedState = await authority(instructed)
  assert(instructedState.history.some(row => row.role === 'user' && row.parts?.some(part => part.text === manualInstruction)))
  assert(!instructedState.history.some(row => row.parts?.some(part => part.system?.includes('type="inter-session"') && part.system.includes(manualInstruction))))
  assert.equal(instructedState.childHandoffState?.boundary, 'direct-user')
  const notice = (await history(parent)).messages.at(-1).parts[0].system
  assert(notice.includes('event="manual-fork-created"')); assert(notice.includes('currentSessionId="' + parent + '"')); assert(notice.includes('childSessionId="' + instructed + '"')); assert(notice.includes('time="')); assert(notice.includes(manualInstruction))
  assert.equal(records.slice(beforeManual).filter(row => row.body.prompt_cache_key === sha(parent)).length, 0, 'idle parent notice did not trigger provider')
  const none = await command(parent, '/fork no-initial'); assert.equal(none.status, 200); assert((await history(parent)).messages.at(-1).parts[0].system.includes('Initial message: (none)'))
  await command(parent, 'CASE:held-notice'); await until(() => held.has('held-notice'), 'busy parent for ordinary notice queue')
  const queuedNotice = await command(parent, '/fork busy-notice'); assert.equal(queuedNotice.status, 200)
  assert((await authority(parent)).queue.some(item => item.parts?.some(part => part.system?.includes('manual-fork-created') && part.system.includes(parent + '_busy-notice'))))
  held.get('held-notice').complete(final('DONE-held-notice')); held.delete('held-notice')
  await until(async () => !(await history(parent)).session.busy && (await authority(parent)).queue.length === 0, 'ordinary busy notice was consumed')

  await seed(parent, 'cancelled'); holdPlan = true; held.delete('plan'); assert.equal((await command(parent, '/compact')).status, 200)
  await until(() => held.has('plan'), 'held real background planner before clear'); const cancelledPlan = held.get('plan'), beforeCancelledClear = records.length
  assert.equal((await command(parent, '/session clear')).status, 200); assert.equal(commandFailed(parent), false); await until(() => cancelledPlan.connection.closed, 'clear settles exactly its planner')
  assert.equal((await authority(parent)).history.length, 0); assert(!(await authority(parent)).queue.some(item => item.type === 'compact-commit')); assert.equal(records.length, beforeCancelledClear)
  holdPlan = false; held.delete('plan')
  const beforeRestartArchive = archive(parent), childBeforeRestart = (await authority(child)).history, nestedBeforeRestart = (await authority(nested)).history
  await fixture.stop()
  const persisted = await authority(parent); persisted.systemPromptFiles = 'selected-prompt.md, ordinary-link.md, selected-prompt.md'; persisted.persistentMemorySnapshot = ''; persisted.nextBlockId = 1
  await writeFile(authorityPath(parent), JSON.stringify(persisted) + '\n')
  await writeFile(join(fixture.work, 'selected-prompt.md'), '---\ninclude-session: ' + parent + '\n---\nSelected parent-only memory.\n<foxwarm-if model-id="a/wire">\nWS selected memory.\n</foxwarm-if>\n<foxwarm-if model-id="sync/wire">\nHTTP selected memory.\n</foxwarm-if>\n')
  await writeFile(join(fixture.root, 'selected-common.md'), 'Selected common regular memory.')
  await symlink(join(fixture.root, 'selected-common.md'), join(fixture.work, 'ordinary-link.md'))
  await fixture.start(); await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.foxwarm-chat-root')
  assert.deepEqual((await authority(child)).history, childBeforeRestart); assert.deepEqual((await authority(nested)).history, nestedBeforeRestart); assert.deepEqual(archive(parent), beforeRestartArchive)
  assert.deepEqual(branch(nested), nestedCap); assert.deepEqual(branch(child), cap); assert.equal((await readFile(join(fixture.work, 'fork-effect.log'), 'utf8')).trim().split('\n').length, 1)
  assert.equal((await authority(parent)).nextBlockId, 1, 'startup did not mass-rewrite old positive-low frontier')
  await send(parent, 'selected-parent'); const selected = (await authority(parent)).persistentMemorySnapshot
  assert(selected.includes('Selected parent-only memory.')); assert(selected.includes('Selected common regular memory.')); assert(selected.includes('WS selected memory.')); assert(!selected.includes('HTTP selected memory.'))
  assert.deepEqual((await authority(parent)).systemPromptFiles, ['selected-prompt.md', 'ordinary-link.md', 'selected-prompt.md'])
  await writeFile(join(fixture.work, 'selected-prompt.md'), 'Changed file must not be read by fork snapshot copy.')
  assert.equal((await fixture.api('POST', route(parent) + '/child-model', { model: 'a', childEffortDefault: 'medium' })).status, 200)
  await send(parent, 'force-fork'); const forced = parent + '_force-fork', forcedState = await authority(forced)
  assert.equal(forcedState.model, 'sync'); assert.equal(forcedState.effort, 'none'); assert.equal(forcedState.childModelDefault, undefined); assert.equal(forcedState.childEffortDefault, undefined)
  assert.equal(forcedState.persistentMemorySnapshot, selected); assert.equal(forcedState.nextBlockId, 3); assert.equal(branch(forced)[2], 2)
  assert.equal((await authority(parent)).nextBlockId, 1, 'fork resolves target/cap without correcting source counter')
  const forcedWire = await send(forced, 'force-fork-task'); assert(forcedWire.every(row => row.kind === 'http')); assert.equal(forcedWire.at(-1).body.cache, (await authority(parent)).promptCacheKey)
  assert(forcedWire.at(-1).body.instructions.includes('Changed file must not be read by fork snapshot copy.'))
  await send(parent, 'selected-fork'); const selectedFork = parent + '_selected-fork', forkPrompt = (await authority(selectedFork)).persistentMemorySnapshot
  assert.equal(forkPrompt, selected); assert.deepEqual((await authority(selectedFork)).systemPromptFiles, (await authority(parent)).systemPromptFiles)
  await send(parent, 'selected-fresh'); const selectedFresh = parent + '_selected-fresh', freshPrompt = (await authority(selectedFresh)).persistentMemorySnapshot
  assert(freshPrompt.includes('Changed file must not be read by fork snapshot copy.')); assert(freshPrompt.includes('Selected common regular memory.')); assert.notEqual((await authority(selectedFresh)).promptCacheKey, (await authority(parent)).promptCacheKey)
  assert.equal(branch(selectedFresh)[0], null, 'fresh graph child is an Archive root')
  assert.equal((await fixture.api('POST', route(parent) + '/refresh-memory', {})).status, 200); assert((await authority(parent)).persistentMemorySnapshot.includes('Changed file must not be read by fork snapshot copy.'))
  assert.equal((await fixture.api('POST', route(parent) + '/model', { model: 'sync' })).status, 200)
  const httpRequests = await send(parent, 'selected-http'); assert(httpRequests.every(row => row.kind === 'http')); assert(httpRequests.at(-1).body.instructions.includes('Changed file must not be read by fork snapshot copy.'))
  assert.equal(httpRequests.at(-1).body.cache, (await authority(parent)).promptCacheKey)
  await send(parent, 'create-agent'); await writeFile(join(fixture.data, 'agents', crossAgent, 'memory', 'MEMORY.md'), 'Separate Agent memory.'); await send(parent, 'cross-fresh')
  const crossFresh = crossAgent + '/cross-fresh'; assert.equal((await authority(crossFresh)).systemPromptFiles, undefined); assert((await authority(crossFresh)).persistentMemorySnapshot.includes('Separate Agent memory.')); assert.equal(branch(crossFresh)[0], null)
  const crossCount = fixture.sql('SELECT COUNT(*) FROM archive_branches')[0][0]; await send(parent, 'cross-fork')
  assert.equal(fixture.sql('SELECT COUNT(*) FROM archive_branches')[0][0], crossCount); assert.equal((await fixture.api('GET', route(crossAgent + '/cross-fork') + '/history')).status, 404)
  await seed(parent, 'selected-plan', 12); holdPlan = true; held.delete('plan'); const selectedCompact = command(parent, '/compact')
  await until(() => held.has('plan'), 'actual selected-file awaited HTTP planner')
  const selectedPlan = held.get('plan'); assert.equal(selectedPlan.kind, 'http'); assert(selectedPlan.body.instructions.includes('Changed file must not be read by fork snapshot copy.')); assert(selectedPlan.body.instructions.includes('Selected common regular memory.'))
  await writeFile(join(fixture.work, 'selected-prompt.md'), 'Selected live commit refresh uses the current file.')
  selectedPlan.valid(); holdPlan = false; held.delete('plan'); assert.equal((await selectedCompact).status, 200)
  await until(async () => !(await history(parent)).session.busy && (await authority(parent)).nextBlockId > 3, 'old frontier corrected only by real nonempty allocation')
  assert((await authority(parent)).persistentMemorySnapshot.includes('Selected live commit refresh uses the current file.'))
  assert.deepEqual(errors, []); await fixture.stop()
  console.log(JSON.stringify({ requests: records.length, planningRequests: records.filter(row => row.planning).length, plans: planCount, connections: connections.length, hostPids: fixture.hostPids, root: fixture.root, parent, child, nested }))
} catch (error) {
  console.error(error.stack); console.error(fixture.output); throw error
} finally {
  await writeFile(join(fixture.root, 'synthetic-peer-records.json'), JSON.stringify(records.map(({ body, full, kind, headers, scenario, planning }) => ({ body, full, kind, headers, scenario, planning })), null, 2))
  console.log(JSON.stringify({ ownedRoot: fixture.root, ownedHostPids: fixture.hostPids, ownedPeerPid: process.pid }))
  for (const connection of connections) connection.ws.terminate()
  for (const value of held.values()) if (value.kind === 'http') value.complete(final('cleanup'))
  await new Promise(done => server.close(done)); peer.closeAllConnections(); await new Promise(done => peer.close(done)); await fixture.cleanup()
}
