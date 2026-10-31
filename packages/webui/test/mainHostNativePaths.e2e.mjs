// Native Main file targets, persisted cwd and real exec observation over the original App.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { writeModelFixture } from './mainModelFixture.mjs'
const options = { env: {} }, owned = await createHostFixture('native-paths', options), requests = [], failures = [], counts = new Map(), held = new Map()
const home = join(owned.root, 'home'), changed = join(owned.root, 'changed'), relative = join(owned.root, 'relative')
for (const directory of [home, changed, join(relative, 'relative')]) await mkdir(directory, { recursive: true })
options.cwd = owned.root
options.env = { HOME: home, fw_agentdir: 'inherited-lower-wrong', fw_tmp: 'inherited-lower-wrong', FW_AGENTDIR: 'owned-upper-sentinel', OPENAI_API_KEY: 'owned-provider-sentinel', FOXWARM_API_TOKEN: 'owned-api-sentinel' }
const route = id => '/api/sessions/' + encodeURIComponent(id), authority = async id => JSON.parse(await readFile(join(owned.data, 'state/sessions', id + '.json'), 'utf8'))
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), text = body.input.filter(item => item.role === 'user').flatMap(item => item.content || []).map(part => part.text || '').join('\n')
    const key = [...text.matchAll(/NATIVE-PATHS:([\w-]+)/g)].at(-1)?.[1] || 'ordinary', n = counts.get(key) || 0, planning = text.includes('COMPACTION STARTED:')
    counts.set(key, n + 1); requests.push({ key, n, body, planning }); assert(!JSON.stringify(body).includes('"resolvedPaths"'), 'Display metadata must not enter any model request.')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const complete = output => response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'native-' + requests.length, output, usage: { input_tokens: 40, output_tokens: 3 } } }) + '\n\n')
    if (planning) {
      const ranges = [...text.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])]); assert(ranges.length)
      held.set('plan', () => complete([call('cwd-plan', 'submit_compact_plan', { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Owned earlier dialogue.' }] })])); return
    }
    let output
    if (key === 'files' && n === 0) output = [call('token-write', 'write', { filePath: '$fw_tmp/native.txt', content: 'first\n', createDirs: true }), call('token-read', 'read', { filePath: '$fw_tmp/native.txt' }), call('token-edit', 'edit', { filePath: '$fw_tmp/native.txt', oldText: 'first', newText: 'second' }), call('home-write', 'write', { filePath: '~/owned.txt', content: 'owned home' }), call('spaces', 'write', { filePath: ' spaced ', content: 'literal spaces' }), call('patch', 'edit', { apply_patch: '*** Begin Patch\n*** Add File: ' + join(home, 'patch.txt') + '\n+owned patch\n*** End Patch' })]
    else if (key === 'relative' && n === 0) output = [call('relative-file', 'write', { filePath: 'note', content: 'file base' }), call('relative-exec', 'exec', { command: 'pwd', timeout: 15 })]
    else if (key === 'exec' && n === 0) output = [call('env', 'call_tool', { source: 'node', nodeId: 'master', name: 'exec', args: { command: 'printf "%s\\n" "$HOME" "$fw_agentdir" "$fw_tmp" "$FW_AGENTDIR"; printf \"<%s><%s><%s>\\n\" \"$FW_AGENTDIR\" \"$FOXWARM_API_TOKEN\" \"$OPENAI_API_KEY\"; cd "$fw_tmp"; pwd', timeout: 15 } })]
    else if (key === 'segment' && n === 0) output = [call('first-cwd', 'exec', { command: 'cd "' + changed + '"; sleep 0.15; pwd', timeout: 15 }), call('second-cwd', 'exec', { command: 'cd "' + home + '"; pwd', timeout: 15 }), call('after-cwd', 'write', { filePath: 'after-segment.txt', content: 'model ordered' }), call('cwd-status', 'session', { action: 'status' })]
    else if (key === 'missing' && n === 0) output = [call('missing-read', 'read', { filePath: 'note' }), call('missing-exec', 'exec', { command: 'pwd', timeout: 15 })]
    else if (key === 'live' && n === 0) output = [call('live-cwd', 'call_tool', { source: 'node', nodeId: 'master', name: 'exec', args: { command: 'cd "' + changed + '"; sleep 1.8; cd "' + home + '"; printf LIVE-FINISHED', timeout: 1 } })]
    else output = final('DONE-NATIVE-' + key)
    complete(output)
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await mkdir(join(owned.work, 'memory'), { recursive: true }); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
await writeModelFixture(owned.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000, asyncCompact: true } } })
async function turn(id, key, text = '') {
  assert.equal((await owned.api('POST', route(id) + '/message', { text: 'NATIVE-PATHS:' + key + text })).status, 202)
  await until(async () => { const state = await authority(id); return !state.busy && state.history.some(row => row.parts?.some(part => part.text === 'DONE-NATIVE-' + key)) }, key)
}
function result(state, id) { return state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse }
try {
  await owned.start()
  assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200)
  const page = await owned.openApp()
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  await page.waitForSelector('[role="textbox"][aria-label="Message"]')
  await page.type('[role="textbox"][aria-label="Message"]', 'NATIVE-PATHS:files')
  const admitted = page.waitForResponse(response => new URL(response.url()).pathname === route('main') + '/message' && response.request().method() === 'POST')
  await page.click('button[aria-label="Send message"]')
  assert.equal((await admitted).status(), 202)
  await until(async () => (await authority('main')).history.some(row => row.parts?.some(part => part.text === 'DONE-NATIVE-files')), 'original App native file turn')
  const files = await authority('main'), originalCache = files.promptCacheKey, originalSnapshot = files.persistentMemorySnapshot
  for (const id of ['token-write', 'token-read', 'token-edit', 'home-write', 'spaces', 'patch']) { const value = result(files, id); assert(!value.response.error, JSON.stringify(value)); assert.equal(value.__meta.resolvedPaths[0].nodeId, 'master') }
  assert.equal(result(files, 'token-read').__meta.resolvedPaths[0].resolved, join(owned.work, 'tmp/native.txt'))
  assert.equal(await readFile(join(home, 'owned.txt'), 'utf8'), 'owned home'); assert.equal(await readFile(join(owned.work, ' spaced '), 'utf8'), 'literal spaces')
  assert.equal((await owned.api('POST', route('main') + '/cwd', { cwd: changed })).status, 200)
  const navigation = []; page.on('request', request => { if (request.url().includes('/vscode-web/')) navigation.push(request.url()) })
  await page.waitForSelector('[aria-label="Open $fw_tmp/native.txt in Code"]'); await page.click('[aria-label="Open $fw_tmp/native.txt in Code"]')
  await until(() => navigation.length, 'actual Code navigation intent')
  const target = new URL(navigation[0]); assert.equal(target.searchParams.get('initialFolderUri'), 'foxwarm://node+master' + join(owned.work, 'tmp'))
  const codeResponse = await fetch(navigation[0], { headers: { authorization: 'Bearer ' + owned.token } })
  const hasCode = await access(resolve('dotnet/Foxwarm/bin/Debug/net10.0/packages/vscode-web/assets/vscode-web/out/vs/workbench/workbench.web.main.internal.js')).then(() => true, () => false)
  assert.equal(codeResponse.status, hasCode ? 200 : 503, 'Code route retains its optional official-asset boundary.')
  const codeFile = await fetch(owned.origin + '/api/vscode-web/fs/read-file?' + new URLSearchParams({ nodeId: 'master', path: join(owned.work, 'tmp/native.txt') }), { headers: { authorization: 'Bearer ' + owned.token } })
  assert.equal(codeFile.status, 200); assert.equal(await codeFile.text(), 'second\n')
  await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
  const missing = join(owned.root, 'not-created', 'nested'), setMissing = await owned.api('POST', route('main') + '/cwd', { cwd: '  ' + missing + '  ' }); assert.equal(setMissing.body.cwd, missing)
  await assert.rejects(access(join(owned.root, 'not-created')), { code: 'ENOENT' }); await turn('main', 'missing'); await assert.rejects(access(join(owned.root, 'not-created')), { code: 'ENOENT' })
  const missingState = await authority('main'); assert(result(missingState, 'missing-read').response.error); assert(result(missingState, 'missing-exec').response.error)
  assert.equal((await owned.api('POST', route('main') + '/cwd', { cwd: 'relative' })).status, 200); await turn('main', 'relative')
  assert.equal(await readFile(join(relative, 'note'), 'utf8'), 'file base'); assert(result(await authority('main'), 'relative-exec').response.output.includes(join(relative, 'relative') + '\n'))
  assert.equal((await owned.api('POST', route('main') + '/cwd', { cwd: changed })).status, 200); await turn('main', 'exec')
  const env = result(await authority('main'), 'env').response.output; assert(env.includes([home, owned.work, join(owned.work, 'tmp')].join('\n'))); assert(env.includes('<owned-upper-sentinel><owned-api-sentinel><owned-provider-sentinel>')); assert(!env.includes('inherited-lower-wrong'))
  assert.equal((await authority('main')).cwd, join(owned.work, 'tmp')); await turn('main', 'segment'); assert.equal((await authority('main')).cwd, home); assert.equal(await readFile(join(home, 'after-segment.txt'), 'utf8'), 'model ordered'); const status = result(await authority('main'), 'cwd-status').response.output; assert(status.includes(home)); assert(status.includes('master'))
  assert.equal((await owned.api('POST', route('main') + '/cwd', { cwd: owned.work })).status, 200); await turn('main', 'live'); assert.equal((await authority('main')).cwd, changed)
  assert.equal((await owned.api('POST', route('main') + '/cwd', { cwd: owned.work })).status, 200)
  const liveRecord = JSON.parse(await readFile(join(owned.data, 'state/running-exec.json'), 'utf8')).execs.find(record => record.command.includes('LIVE-FINISHED'))
  await until(async () => (await readFile(liveRecord.cwdPath, 'utf8').catch(() => '')).trim() === home && (await readFile(liveRecord.logPath, 'utf8')).includes('LIVE-FINISHED'), 'actual background final sidecar')
  await until(async () => {
    const state = await authority('main'), completions = state.history.filter(row => row.parts?.some(part => part.system?.includes('background-process-finished') && part.system.includes(liveRecord.id)))
    const registry = JSON.parse(await readFile(join(owned.data, 'state/running-exec.json'), 'utf8'))
    return completions.length === 1 && !state.busy && state.history.some(row => row.role === 'model' && row.__meta.seq > completions[0].__meta.seq) && !registry.execs.some(record => record.id === liveRecord.id)
  }, 'single background completion consumed before restart')
  assert.equal((await authority('main')).cwd, owned.work)
  assert.equal((await authority('main')).promptCacheKey, originalCache); assert.equal((await authority('main')).persistentMemorySnapshot, originalSnapshot)
  assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'compact-cwd' })).status, 200)
  for (let i = 0; i < 7; i++) await turn('compact-cwd', 'seed-' + i, ' ' + ('owned-' + i + '-').repeat(750))
  const compact = await owned.api('POST', route('compact-cwd') + '/message', { text: '/compact' })
  assert.equal(compact.status, 200); assert.equal(compact.body.success, true); await until(() => held.has('plan'), 'actual cwd-only planner')
  assert.equal((await owned.api('POST', route('compact-cwd') + '/cwd', { cwd: changed })).status, 200); held.get('plan')(); held.delete('plan')
  await until(async () => { const state = await authority('compact-cwd'); return !state.busy && state.history.some(row => row.__meta?.contextBlock) }, 'cwd-only plan remains applicable')
  assert.equal((await authority('compact-cwd')).cwd, changed)
  assert.equal((await owned.api('POST', route('main') + '/cwd', { cwd: ' \t' })).body.cwd, null)
  await owned.stop(); const count = requests.length; await owned.start(); assert.equal((await authority('compact-cwd')).cwd, changed); assert.equal((await owned.api('GET', route('main') + '/state')).body.session.cwd, null); assert.equal(requests.length, count); await owned.stop()
  assert.equal(failures.length, 0, failures.join('\n'))
  console.log(JSON.stringify({ root: owned.root, home, hosts: owned.hostPids, requests: requests.length, originalApp: true, codeIntent: navigation[0], codeBackendStatus: codeResponse.status, officialWorkbench: hasCode, codeFileBytes: true, childHomeVerified: true, completedCwd: true, liveCwd: true, deferredModelOrder: true, compactionRetainsCwd: true }))
} finally {
  for (const release of held.values()) release()
  await writeFile(join(owned.root, 'native-paths-requests.json'), JSON.stringify({ requests, failures, hosts: owned.hostPids, home }, null, 2)).catch(() => {})
  await owned.cleanup(); await new Promise(done => peer.close(done))
}
