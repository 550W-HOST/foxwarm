// Actual model/tool lifetimes across busy identity moves, preserved exec segments and one-shot wait deadlines.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
const owned = await createHostFixture('identity-effects'), requests = [], failures = [], counts = new Map(), processes = []
const route = id => '/api/sessions/' + encodeURIComponent(id)
const execRecords = async () => JSON.parse(await readFile(join(owned.data, 'state/running-exec.json'), 'utf8')).execs
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
let backgroundId, backgroundLog
const preparationControl = process.env.IDENTITY_PREPARATION_CONTROL === '1', concreteControl = process.env.IDENTITY_CONCRETE_CONTROL === '1', deniedLate = preparationControl || concreteControl
const segmentCommand = index => `printf '${index}\\n' >> ${JSON.stringify(join(owned.work, 'segment-launches'))}; while [ ! -f ${JSON.stringify(join(owned.work, 'segment-release'))} ]; do sleep 0.05; done; printf '${index}:'; pwd`
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), key = [...JSON.stringify(body.input).matchAll(/EFFECT-CASE:([\w-]+)/g)].at(-1)?.[1] || 'ordinary', n = counts.get(key) || 0
    counts.set(key, n + 1); requests.push({ key, n, body })
    for (const value of body.input.filter(value => value.type === 'function_call')) assert(body.input.some(item => item.type === 'function_call_output' && item.call_id === value.call_id))
    let output
    if (key === 'busy' && n === 0) output = [1, 2, 3, 4, 5, 6].map(index => call('exec-' + index, 'exec', { command: segmentCommand(index), timeout: 15 })).concat([
      call('new-file', 'write', { filePath: 'new-workspace.txt', content: 'Future file effect uses the actual destination Agent.' }),
      call('new-segment', 'exec', { command: 'pwd; printf once >> new-segment.txt', timeout: 15 })])
    else if (key === 'background' && n === 0) output = [call('background-exec', 'exec', { command: 'printf once >> background-launches; while [ ! -f background-release ]; do sleep 0.05; done; printf BACKGROUND-OLD-ARTIFACT', timeout: 1 })]
    else if (key === 'read' && n === 0) output = [call('original-log', 'read', { filePath: backgroundLog })]
    else if (key === 'waiter' && n === 0) output = [call('declared-wait', 'wait', { reason: 'One original absolute deadline.', wakeIfNoActivityAfterSeconds: 2 })]
    else output = final('DONE-EFFECT-' + key)
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'effects-' + requests.length, output, usage: { input_tokens: 20, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await mkdir(join(owned.work, 'memory'), { recursive: true }); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
await writeModelFixture(owned.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })
if (deniedLate) await writeFile(join(owned.data, 'state/tool-authorization.yaml'), JSON.stringify({ version: 1, defaultAction: 'allow', rules: [{ id: 'prepared-old-agent-denial', match: { agent: preparationControl ? 'main' : 'destination', tool: { source: 'node', name: 'exec' }, args: { command: { oneOf: [segmentCommand(5), segmentCommand(6)] } } }, action: 'deny' }] }))
const authority = async id => JSON.parse(await readFile(join(owned.data, 'state/sessions', id + '.json'), 'utf8'))
async function create(id) { const response = await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: id }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.sessionId }
async function move(id, target) { const response = await owned.api('POST', route(id) + '/message', { text: '/session move ' + target }); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.result }
async function hasFinal(id, text) { return (await owned.api('GET', route(id) + '/history')).body.messages?.some(row => row.parts?.some(part => part.text === text)) }
try {
  await owned.start(); const page = await owned.openApp(); await create('busy'); assert.equal((await owned.api('POST', '/api/agents', { agentId: 'destination' })).status, 201)
  await page.evaluate(() => window.foxwarmTest.switchToSession('busy')); await page.evaluate(() => window.foxwarmTest.sendMessage('EFFECT-CASE:busy'))
  await until(async () => (await readFile(join(owned.work, 'segment-launches'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length === 4, 'four real held sibling shells')
  assert.equal((await authority('busy')).busy, true); const before = await authority('busy')
  await move('busy', 'destination/moved'); assert.equal((await authority('destination/moved')).busy, true); assert.equal((await authority('destination/moved')).promptCacheKey, before.promptCacheKey)
  for (const record of await execRecords()) if (record.sessionId === 'busy' && record.pid) processes.push(record.pid)
  await writeFile(join(owned.work, 'segment-release'), 'release')
  await until(() => hasFinal('destination/moved', 'DONE-EFFECT-busy'), 'moved busy owner full model-order pairs and final')
  const saved = await authority('destination/moved'), pairs = saved.history.flatMap(row => row.parts || []).filter(part => part.functionResponse).map(part => part.functionResponse)
  assert.deepEqual(pairs.map(value => value.tool_use_id), ['exec-1', 'exec-2', 'exec-3', 'exec-4', 'exec-5', 'exec-6', 'new-file', 'new-segment'])
  if (deniedLate) assert(pairs.filter(value => ['exec-5', 'exec-6'].includes(value.tool_use_id)).every(value => value.response.error), 'Actual Source preparation denials must survive a later Agent change that would otherwise allow execution.')
  for (const value of pairs.filter(value => value.tool_use_id.startsWith('exec-') && !value.response.error)) { const index = Number(value.tool_use_id.slice(5)); assert(value.response.output.includes(index + ':' + (index <= 4 ? owned.work : join(owned.data, 'agents/destination')) + '\n'), JSON.stringify(value)) }
  const replayedCwd = deniedLate ? owned.work : join(owned.data, 'agents/destination'); assert.equal(saved.cwd, replayedCwd)
  assert.equal(await readFile(join(replayedCwd, 'new-workspace.txt'), 'utf8'), 'Future file effect uses the actual destination Agent.')
  assert.equal(await readFile(join(replayedCwd, 'new-segment.txt'), 'utf8'), 'once')
  assert(pairs.find(value => value.tool_use_id === 'new-segment').response.output.includes(replayedCwd))
  assert.deepEqual((await readFile(join(owned.work, 'segment-launches'), 'utf8')).trim().split('\n').sort(), deniedLate ? ['1', '2', '3', '4'] : ['1', '2', '3', '4', '5', '6'])
  await until(async () => (await page.evaluate(() => document.body.textContent)).includes('DONE-EFFECT-busy'), 'original Chat follows actual busy owner')

  await create('background'); assert.equal((await owned.api('POST', route('background') + '/message', { text: 'EFFECT-CASE:background' })).status, 202)
  await until(() => hasFinal('background', 'DONE-EFFECT-background'), 'real shell background result')
  const background = await authority('background'), result = background.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'background-exec').functionResponse.response.output
  backgroundId = /execId: ([a-z]+-[a-z]+)/.exec(result)[1]
  const metadata = (await execRecords()).find(record => record.id === backgroundId); backgroundLog = metadata.logPath; processes.push(metadata.pid)
  await move('background', 'background-current'); await writeFile(join(owned.work, 'background-release'), 'release')
  await until(async () => (await authority('background-current')).history.some(row => JSON.stringify(row).includes(backgroundId) && JSON.stringify(row).includes('background-process-finished')), 'historical process once-only current-owner completion')
  assert.equal(await readFile(join(owned.work, 'background-launches'), 'utf8'), 'once'); assert.equal(await readFile(backgroundLog, 'utf8'), 'BACKGROUND-OLD-ARTIFACT')
  assert.equal((await owned.api('POST', route('background-current') + '/message', { text: 'EFFECT-CASE:read' })).status, 202)
  await until(() => hasFinal('background-current', 'DONE-EFFECT-read'), 'original log path remains readable after identity move')
  assert((await authority('background-current')).history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'original-log').functionResponse.response.output.includes('BACKGROUND-OLD-ARTIFACT'))
  const completions = (await authority('background-current')).history.filter(row => JSON.stringify(row).includes('background-process-finished')).length; assert.equal(completions, 1)

  await create('waiter'); await owned.api('POST', route('waiter') + '/message', { text: 'EFFECT-CASE:waiter' })
  const waiting = await until(async () => { const state = await authority('waiter'); return state.meta?.wait && !state.busy ? state : false }, 'strict paired original wait')
  await move('waiter', 'wait-current'); const movedWait = await authority('wait-current'); assert.deepEqual(movedWait.meta.wait, waiting.meta.wait)
  await until(() => hasFinal('wait-current', 'DONE-EFFECT-waiter'), 'same original absolute deadline wakes new binding')
  const timeoutRows = (await authority('wait-current')).history.filter(row => JSON.stringify(row).includes('type=\\"wait-timeout\\"')); assert.equal(timeoutRows.length, 1)
  await owned.stop(); const beforeRequests = requests.length; await owned.start(); await sleep(1100); assert.equal(requests.length, beforeRequests)
  assert.equal((await authority('background-current')).history.filter(row => JSON.stringify(row).includes('background-process-finished')).length, 1)
  assert.equal(await readFile(join(owned.work, 'background-launches'), 'utf8'), 'once'); await owned.stop()
  assert.equal(failures.length, 0, failures.join('\n')); console.log(JSON.stringify({ root: owned.root, hosts: owned.hostPids, processes, requests: requests.length, originalApp: true, busyFour: true, historicalExec: true, oneDeadline: true, preparationControl, concreteControl }))
} finally {
  await writeFile(join(owned.root, 'identity-effects-requests.json'), JSON.stringify({ requests, failures, hosts: owned.hostPids, processes }, null, 2)).catch(() => {})
  await writeFile(join(owned.work, 'segment-release'), 'cleanup').catch(() => {}); await writeFile(join(owned.work, 'background-release'), 'cleanup').catch(() => {})
  await owned.cleanup(); await new Promise(done => peer.close(done))
}
