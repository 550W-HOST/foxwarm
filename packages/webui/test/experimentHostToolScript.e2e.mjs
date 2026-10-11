// Unmanaged Main ToolScript through the original App, real native VM and official MCP SDK.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
// Three real stdio peers have sequential bounded SDK disposal; allow that actual drain workload.
const options = { env: {}, stopTimeout: 30000 }, owned = await createHostFixture('toolscript', options), requests = [], failures = [], scripts = new Map()
const home = join(owned.root, 'home'), sdk = join(owned.root, 'sdk'), image = join(owned.work, 'pixel.png')
await mkdir(home); await mkdir(sdk); options.env = { HOME: home, FOXWARM_EXPERIMENT_MONTY_BINARY: process.env.FOXWARM_EXPERIMENT_MONTY_BINARY }; options.cwd = owned.root
const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 90, g: 20, b: 200, alpha: 1 } } }).png().toBuffer()
await writeFile(image, png); await writeFile(join(owned.work, 'input.txt'), '  raw\r\nlast\n'); await mkdir(join(owned.work, 'memory')); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
await writeFile(join(owned.data, 'state/mcp.json'), JSON.stringify({ servers: {
  schema: { transport: 'stdio', command: process.execPath, args: [resolve(import.meta.dirname, 'experimentHostToolScript.peer.mjs')], enable: true, timeoutSeconds: 30 },
  sdk: { transport: 'stdio', command: process.execPath, args: [resolve(import.meta.dirname, 'experimentHostMcp.peer.mjs'), 'stdio', sdk], enable: true, timeoutSeconds: 30 },
  image: { transport: 'stdio', command: process.execPath, args: [resolve(import.meta.dirname, 'experimentHostImages.peer.mjs'), owned.root, image], enable: true, timeoutSeconds: 30 }
} }))
const route = id => '/api/sessions/' + encodeURIComponent(id), authority = async id => JSON.parse(await readFile(join(owned.data, 'state/sessions', id + '.json'), 'utf8'))
const result = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const oneShot = body.input.some(row => row.role === 'user' && row.content?.some(part => part.text === 'TOOL-SCRIPT-ONESHOT'))
    let output
    if (oneShot) { assert.equal(body.input.length, 1); assert(!body.tools?.length); assert(!JSON.stringify(body).includes('TOOL-SCRIPT-TURN:')); output = final('one-shot text') }
    else {
      const text = body.input.filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const key = [...text.matchAll(/TOOL-SCRIPT-TURN:([\w-]+)/g)].at(-1)?.[1], scripted = scripts.get(key); assert(scripted, key)
      assert(!JSON.stringify(body).includes('toolScriptSubCalls'), 'Display-only nested rows must not enter provider bodies.')
      const definitions = body.tools || []; assert(definitions.some(tool => tool.name === 'run_script')); assert(definitions.some(tool => tool.name === 'continue_script')); assert(!definitions.some(tool => tool.name === 'get_toolscript_run'))
      output = scripted.every(item => body.input.some(row => row.type === 'function_call_output' && row.call_id === item.call_id)) ? final('DONE-TOOL-SCRIPT-' + key) : scripted
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'toolscript-' + requests.length, output, usage: { input_tokens: 40, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(owned.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })
async function turn(owner, key, calls, page) {
  scripts.set(key, calls)
  if (page) await page.evaluate(text => window.foxwarmTest.sendMessage(text), 'TOOL-SCRIPT-TURN:' + key)
  else assert.equal((await owned.api('POST', route(owner) + '/message', { text: 'TOOL-SCRIPT-TURN:' + key })).status, 202)
  await until(async () => { const state = await authority(owner); if (failures.length) throw new Error(failures.join('\n')); return !state.busy && state.history.some(row => row.parts?.some(part => part.text === 'DONE-TOOL-SCRIPT-' + key)) }, key)
  return authority(owner)
}
const exists = path => access(path).then(() => true, () => false)
try {
  await owned.start(); assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200); const page = await owned.openApp(), frames = []
  page.on('response', async response => { if (response.url().includes('/history')) frames.push(response.url()) })
  let state = await turn('main', 'source', [call('source-run', 'run_script', { code: "x=call_tool('read', {'filePath':'input.txt'})\ncall_tool('write', {'filePath':'copy.txt','content':x['content']})\nx=call_tool('exec', {'command':'printf exec-raw', 'timeout':15})\ny=request_model_without_context('TOOL-SCRIPT-ONESHOT', model='a')\nz=call_tool({'toolId':'mcp:sdk/result_case', 'args':{'kind':'error_object','tag':'opaque'}})\nprint('before')\nanswer=ask_agent({'question':'continue'})\nprint('after')\nreturn [answer,y['text'],x['content'],z['error']['message']]\n" })], page)
  const paused = result(state, 'source-run'); assert.equal(paused.response.status, 'waiting', JSON.stringify(paused)); assert.equal(paused.response.stdout, 'before\n'); assert.equal(paused.response.question, '{"question":"continue"}'); assert(paused.__meta.toolScriptSubCalls.length >= 4); assert.equal(await readFile(join(owned.work, 'copy.txt'), 'utf8'), '  raw\r\nlast\n')
  await page.waitForFunction(() => document.body.innerText.includes('call_tool') && document.body.innerText.includes('read'))
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('.foxwarm-chat-root'); await page.waitForFunction(() => document.body.innerText.includes('read'))
  await owned.stop(); const requestCount = requests.length; await owned.start(); assert.equal(requests.length, requestCount)
  state = await turn('main', 'continue', [call('continued', 'continue_script', { runId: paused.response.runId, continuationId: paused.response.continuationId, input: false })]); const resumed = result(state, 'continued').response; assert.equal(resumed.status, 'completed'); assert.equal(resumed.stdout, 'after\n'); assert.deepEqual(resumed.result, [false, 'one-shot text', 'exec-raw', 'vendor-error'])
  assert.equal((await readFile(join(sdk, 'calls.ndjson'), 'utf8')).split('\n').filter(line => line.includes('"tag":"opaque"')).length, 1)
  state = await turn('main', 'schemas', [call('script-schemas', 'run_script', { code: "discovery=call_tool('search_tools', {'sources':['mcp'],'server':'schema','query':'schema_echo'})\nx=call_tool({'toolId':'mcp:schema/schema_echo','args':{}})\nreturn {'row':discovery['tools'][0], 'structured':x}\n" })])
  const discovered = result(state, 'script-schemas').response; assert.equal(discovered.status, 'completed', JSON.stringify(discovered)); assert.equal(discovered.result.row.toolId, 'mcp:schema/schema_echo'); assert.deepEqual(discovered.result.row.outputSchema.required, ['data']); assert.equal(discovered.result.row.inputSchema.properties.value.description, 'Escaped */\nmetadata\u202e'); assert.equal(discovered.result.structured._meta.retained, true); assert.deepEqual(discovered.result.structured.structuredContent.data, { flag: false, zero: 0, nothing: null }); assert(!('output' in discovered.result.row))
  state = await turn('main', 'images', [call('script-images', 'run_script', { code: "native=call_tool('read', {'filePath':'pixel.png'})\nsdk=call_tool({'toolId':'mcp:image/image','args':{}})\nreturn {'parts':native['parts']+sdk['parts'], 'business':sdk['business']}\n" })])
  const imageRow = state.history.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'script-images')), imageResult = result(state, 'script-images').response
  assert.equal(imageResult.status, 'completed'); assert.equal(imageResult.result.business.data, 'opaque business data'); assert(imageRow.parts.filter(part => part.inlineDataRef).length >= 2); assert(imageRow.parts.filter(part => part.inlineDataRef).every(part => part.toolUseId === 'script-images')); assert(!JSON.stringify(state).includes(png.toString('base64')))
  const runRecord = JSON.parse(await readFile(join(owned.data, 'state/toolscript-runs', imageResult.runId + '.json'), 'utf8')); assert(!JSON.stringify(runRecord).includes(png.toString('base64'))); assert(runRecord.lastResult.parts.some(part => part.inlineDataRef))
  const ref = imageRow.parts.find(part => part.inlineDataRef).inlineDataRef, blob = await fetch(owned.origin + '/api/blobs/' + ref.blobId, { headers: { authorization: 'Bearer synthetic-toolscript-api' } }); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png)
  // A started SDK host call is stopped through the real Session path. Its later shell effect never starts.
  assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'stopped' })).status, 200)
  scripts.set('stop', [call('stopped-run', 'run_script', { code: "call_tool({'toolId':'mcp:sdk/hold_effect','args':{'tag':'stop'}})\ncall_tool('write', {'filePath':'stop-after','content':'forbidden'})\nreturn True\n" })])
  assert.equal((await owned.api('POST', route('stopped') + '/message', { text: 'TOOL-SCRIPT-TURN:stop' })).status, 202); await until(() => exists(join(sdk, 'started-stop')), 'actual SDK request started')
  assert.equal((await owned.api('POST', route('stopped') + '/message', { text: '/stop' })).status, 200); await until(async () => !(await authority('stopped')).busy, 'actual Stop drain'); assert(!await exists(join(owned.work, 'stop-after'))); await until(() => exists(join(sdk, 'cancelled-stop')), 'official SDK cancellation')

  // Underway host work follows its same mutable owner; history keeps its literal ID.
  assert.equal((await owned.api('POST', '/api/sessions', { sessionId: 'moving', agentId: 'main' })).status, 200)
  scripts.set('moving-start', [call('moving-run', 'run_script', { code: "call_tool({'toolId':'mcp:sdk/hold_effect','args':{'tag':'move'}})\ncall_tool('write', {'filePath':" + JSON.stringify(join(owned.work, 'moved-after')) + ", 'content':'once'})\nreturn 7\n" })])
  await owned.api('POST', route('moving') + '/message', { text: 'TOOL-SCRIPT-TURN:moving-start' }); await until(() => exists(join(sdk, 'started-move')), 'moving call accepted')
  state = await turn('main', 'move-identity', [call('identity-move', 'move_session', { sessionId: 'moving', newSessionId: 'moved' })]); assert(!result(state, 'identity-move').response.error, JSON.stringify(result(state, 'identity-move').response))
  await writeFile(join(sdk, 'release-move'), 'release'); state = await until(async () => { const value = await authority('moved'); return !value.busy && result(value, 'moving-run') ? value : null }, 'moved script settlement')
  const movedRun = result(state, 'moving-run').response; assert.equal(movedRun.status, 'completed', JSON.stringify(movedRun)); assert.equal(movedRun.result, 7); assert.equal(await readFile(join(owned.work, 'moved-after'), 'utf8'), 'once')
  const movedFile = join(owned.data, 'state/toolscript-runs', movedRun.runId + '.json'); assert.equal(JSON.parse(await readFile(movedFile, 'utf8')).ownerSessionId, 'moving')
  state = await turn('moved', 'literal-history', [call('literal-get', 'get_toolscript_run', { runId: movedRun.runId })]); assert(result(state, 'literal-get').response.error); assert.equal(JSON.parse(await readFile(movedFile, 'utf8')).status, 'completed')

  // Busy delete retains its established stop/drain/retry behavior and the run file.
  assert.equal((await owned.api('POST', '/api/sessions', { sessionId: 'doomed', agentId: 'main' })).status, 200)
  scripts.set('delete-start', [call('deleted-run', 'run_script', { code: "call_tool({'toolId':'mcp:sdk/hold_effect','args':{'tag':'delete'}})\ncall_tool('write', {'filePath':" + JSON.stringify(join(owned.work, 'deleted-after')) + ", 'content':'wrong'})\n" })])
  await owned.api('POST', route('doomed') + '/message', { text: 'TOOL-SCRIPT-TURN:delete-start' }); await until(() => exists(join(sdk, 'started-delete')), 'delete call accepted')
  const pendingDelete = await owned.api('DELETE', route('doomed')); assert.equal(pendingDelete.status, 409); assert.equal(pendingDelete.body.code, "SESSION_DELETE_BUSY")
  state = await until(async () => { const value = await authority('doomed'); return !value.busy && result(value, 'deleted-run') ? value : null }, 'delete drain')
  const deletedRun = result(state, 'deleted-run').response; assert.equal(deletedRun.status, 'cancelled'); assert.equal((await owned.api('DELETE', route('doomed'))).status, 200)
  const retained = JSON.parse(await readFile(join(owned.data, 'state/toolscript-runs', deletedRun.runId + '.json'), 'utf8')); assert.equal(retained.ownerSessionId, 'doomed'); assert.equal(retained.status, 'cancelled'); assert(!await exists(join(owned.work, 'deleted-after'))); assert(await exists(join(sdk, 'started-delete')))

  // Stop cancels the script wait without killing an already-started user process.
  assert.equal((await owned.api('POST', '/api/sessions', { sessionId: 'process', agentId: 'main' })).status, 200)
  const born = join(owned.work, 'process-born'), survived = join(owned.work, 'process-survived'), forbidden = join(owned.work, 'process-after')
  const shell = "printf born > '" + born + "'; sleep 2; printf real > '" + survived + "'"
  scripts.set('process-start', [call('process-run', 'run_script', { code: "call_tool('exec', {'command':" + JSON.stringify(shell) + ", 'timeout':60})\ncall_tool('write', {'filePath':" + JSON.stringify(forbidden) + ", 'content':'wrong'})\n" })])
  await owned.api('POST', route('process') + '/message', { text: 'TOOL-SCRIPT-TURN:process-start' }); await until(() => exists(born), 'user process started'); assert.equal((await owned.api('POST', route('process') + '/message', { text: '/stop' })).status, 200)
  state = await until(async () => { const value = await authority('process'); return !value.busy && result(value, 'process-run') ? value : null }, 'process script cancelled'); assert.equal(result(state, 'process-run').response.status, 'cancelled')
  assert(!await exists(survived)); await until(() => exists(survived), 'started process survives script cancellation'); assert.equal(await readFile(survived, 'utf8'), 'real'); assert(!await exists(forbidden))
  await owned.stop(); assert.equal(failures.length, 0, failures.join('\n'))
  console.log(JSON.stringify({ hosts: owned.hostPids, requests: requests.length, originalApp: true, nativeRawReadExec: true, officialSdk: true, oneShotNoContext: true, waitingRestartDelta: true, refreshedNestedRows: true, authenticatedReferenceImages: true, stopDrain: true, activeMoveLiteralOwner: true, busyDeleteDrain: true, startedProcessSurvival: true }))
} finally { await owned.cleanup(); await new Promise(done => peer.close(done)) }
