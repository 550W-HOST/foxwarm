// Cold startup, retained typed queue compatibility and explicit first-turn snapshots.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { createHostFixture, until, saveModelsInOriginalApp } from './experimentHostFixture.mjs'

const fixtures = [], requests = [], failures = []
const text = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] })
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), user = JSON.stringify(body.input.filter(item => item.role === 'user').at(-1) || {})
    const boot = user.includes('ONBOOT: '), task = [...user.matchAll(/ON-TASK:([\w-]+)/g)].at(-1)?.[1] || 'ordinary'
    const record = { body, boot, task, at: Date.now() }; requests.push(record)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const complete = output => { if (!response.destroyed) response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'boot-' + requests.length, output, usage: { input_tokens: 30, output_tokens: 4 } } }) + '\n\n') }
    for (const item of body.input.filter(item => item.type === 'function_call')) assert(body.input.some(value => value.type === 'function_call_output' && value.call_id === item.call_id), item.call_id + ' historical pair')
    if (boot && body.input.at(-1)?.type !== 'function_call_output') {
      assert(!body.tools.some(value => value.name === 'exec'))
      complete([call('boot-write-' + requests.length, 'write', { filePath: 'onboot-proof-' + requests.length + '.txt', content: user }), call('boot-denied-' + requests.length, 'exec', { command: 'touch forbidden-onboot-effect' })]); return
    }
    complete([text('DONE-' + (boot ? 'BOOT' : task))])
  } catch (error) { failures.push(error.stack); if (!response.destroyed) { response.writeHead(500); response.end() } }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const models = { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } }
const route = id => '/api/sessions/' + encodeURIComponent(id)
async function create(name, content, config = models) {
  const fixture = await createHostFixture(name); fixtures.push(fixture)
  if (content !== undefined) { await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), content) }
  await writeFile(fixture.modelPath, JSON.stringify(config))
  await writeFile(join(fixture.data, 'state', 'tool-authorization.yaml'), "version: 1\nrules:\n  - id: deny-main-exec\n    action: deny\n    match: {tool: {source: node, name: exec}}\n")
  return fixture
}
const saved = async (fixture, id = 'main') => JSON.parse(await readFile(join(fixture.data, 'state', 'sessions', id + '.json'), 'utf8'))
async function history(fixture, id = 'main') { const result = await fixture.api('GET', route(id) + '/history'); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.messages }
async function done(fixture, marker, id = 'main') { await until(async () => (await history(fixture, id)).some(row => row.parts?.some(part => part.text === 'DONE-' + marker)) && !(await saved(fixture, id)).busy, marker + ' completed') }
async function send(fixture, task, id = 'main') { assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'ON-TASK:' + task })).status, 202) }
function bootRows(raw) { return raw.history.filter(row => row.role === 'user' && row.parts?.some(part => part.system?.includes('ONBOOT: '))) }
async function seedCatalog(fixture, rows, archiveOnly = []) {
  const module = await import(pathToFileURL(resolve('lib/session/catalogStore.js')).href)
  const store = new module.SessionCatalogStore(join(fixture.data, 'state', 'catalog.sqlite')); store.initializeEmpty(); store.replaceAll(rows); store.close()
  const file = join(fixture.root, 'catalog-seed.json'); await writeFile(file, JSON.stringify([...rows, ...archiveOnly]))
  execFileSync('node', [resolve('dotnet/Foxwarm.Tests/Fixtures/session-catalog-seed-ts.mjs'), fixture.data, file], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
}
const row = (id, extra = {}) => ({ id, agent: 'main', busy: false, queueLength: 0, model: 'a', meta: { messageCount: 0, lastMessageTime: 0 }, ...extra })
const authority = (id, extra = {}) => ({ sessionStateVersion: 1, id, agent: 'main', busy: false, verbose: false, history: [], queue: [], stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 }, nextMessageSeq: 1, nextBlockId: 1, meta: { messageCount: 0, lastMessageTime: 0 }, promptCacheKey: randomUUID(), persistentMemorySnapshot: 'Existing user snapshot bytes.', ...extra })
async function put(fixture, id, extra = {}) { const directory = join(fixture.data, 'state', 'sessions'); await mkdir(directory, { recursive: true }); const raw = authority(id, extra); await writeFile(join(directory, id + '.json'), JSON.stringify(raw)); return raw }
try {
  // Retired startup files stay inert through a real explicit actor turn and restart.
  const original = 'Legacy file content must not become startup input.\r\n'
  const fixture = await create('onboot-retired-file', original)
  await fixture.start()
  assert.deepEqual((await fixture.api('GET', '/api/sessions')).body.sessions, [])
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200)
  await send(fixture, 'explicit-first'); await done(fixture, 'explicit-first')
  assert.equal(bootRows(await saved(fixture)).length, 0)
  assert(!JSON.stringify(requests).includes(original.trim()))
  assert.equal(await readFile(join(fixture.work, 'memory/ONBOOT.md'), 'utf8'), original)
  await fixture.stop(); const beforeRestart = requests.length
  await fixture.start(); await send(fixture, 'explicit-restart'); await done(fixture, 'explicit-restart')
  assert.equal(requests.length, beforeRestart + 1)
  assert.equal(bootRows(await saved(fixture)).length, 0)
  await fixture.stop()

  // A retained typed event remains ordinary mandatory queue recovery, without a new file trigger.
  const oldQueue = await create('onboot-existing-queue', 'No fresh event from this legacy file.')
  const oldWrapper = '<foxwarm-message type="onboot" eventType="onboot" time="2026-01-01 00:00:00 +0000" hint="onboot session event">\nONBOOT: Retained typed input.\n</foxwarm-message>'
  await put(oldQueue, 'main', { queue: [{ type: 'onboot', parts: [{ system: oldWrapper }] }] })
  await seedCatalog(oldQueue, [row('main', { queueLength: 1 })])
  await oldQueue.start(); await done(oldQueue, 'BOOT')
  assert.equal(bootRows(await saved(oldQueue)).length, 1)
  assert.equal((await saved(oldQueue)).queue.length, 0)
  await assert.rejects(access(join(oldQueue.work, 'forbidden-onboot-effect')))
  assert((await saved(oldQueue)).history.some(value => value.parts?.some(part => part.functionResponse?.response?.error?.type === 'tool_authorization_denied')))
  await oldQueue.stop(); const settledRequests = requests.length
  await oldQueue.start(); await send(oldQueue, 'legacy-restart'); await done(oldQueue, 'legacy-restart')
  assert.equal(bootRows(await saved(oldQueue)).length, 1)
  assert.equal(requests.length, settledRequests + 1)
  await oldQueue.stop()

  // Empty Setup stays cold; explicitly create its actor before the original App model save.
  const empty = await create('onboot-empty-setup', undefined, { providers: {} }); await empty.start()
  assert.deepEqual((await empty.api('GET', '/api/sessions')).body.sessions, [])
  assert.equal((await empty.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200)
  const emptyMain = await saved(empty); assert.equal(emptyMain.persistentMemorySnapshot, ''); assert(!emptyMain.model && !emptyMain.effort); assert(emptyMain.promptCacheKey)
  const emptyHistory = await empty.api('GET', route('main') + '/history'); assert.equal(emptyHistory.status, 200); assert.equal(emptyHistory.body.session.modelKey, ''); assert.equal(emptyHistory.body.session.defaultModelKey, ''); assert.equal(emptyHistory.body.session.effortDefault, 'high'); assert.equal(emptyHistory.body.session.effectiveCompactThresholdTokens, Math.floor(200000 * 0.85))
  assert.equal((await empty.api('GET', route('main') + '/state')).status, 200)
  const frames = [], ws = new WebSocket(empty.origin.replace('http:', 'ws:') + '/api/webui/stream', { headers: { authorization: 'Bearer synthetic-onboot-empty-setup-api' } }); ws.on('message', raw => frames.push(JSON.parse(String(raw)))); await once(ws, 'open'); ws.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionIds: ['main'], sessionListIds: ['main'], sessionListActive: true })); await until(() => frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 1), 'unconfigured Main state/draft/context subscription applies'); assert(frames.some(frame => frame.type === 'session-state' && frame.session?.modelKey === '')); assert(!frames.some(frame => frame.type === 'session-error')); ws.close(); await once(ws, 'close')
  const framework = await readFile(resolve('dotnet/Foxwarm/bin/Debug/net10.0/templates/agents/00_SYSTEM.md'))
  assert.deepEqual(await readFile(join(empty.data, 'agents', '00_SYSTEM.md')), framework)
  for (const name of ['BOOTSTRAP.md', 'MEMORY.md', 'SOUL.md', 'USER.md']) assert.deepEqual(await readFile(join(empty.work, 'memory', name)), await readFile(resolve('dotnet/Foxwarm/bin/Debug/net10.0/templates/main/memory', name)))
  await assert.rejects(access(join(empty.work, 'memory/ONBOOT.md')), { code: 'ENOENT' })
  const setupPage = await empty.openApp(); await saveModelsInOriginalApp(setupPage, `default: a\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: 'http://127.0.0.1:${peer.address().port}'\n    apiKey: synthetic-onboot\n    models: [wire]\n    contextLimit: 20000\n`, empty.modelPath)
  await send(empty, 'after-setup'); await done(empty, 'after-setup'); assert.match((await saved(empty)).persistentMemorySnapshot, /<foxwarm-current-model model-id="a\/wire" \/>/); await empty.stop()

  // Virtual startup has no selected concrete snapshot/route; only the first real turn captures a leaf.
  const virtualConfig = { ...models, default: 'route', providers: { ...models.providers, route: { providerType: 'session-hash', targets: ['a'] } } }
  const virtual = await create('onboot-virtual', ' ', virtualConfig), beforeVirtual = requests.length; await virtual.start(); assert.equal((await virtual.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200); const virtualMain = await saved(virtual); assert.equal(virtualMain.persistentMemorySnapshot, ''); assert(!virtualMain.model && !virtualMain.effort); assert.equal(requests.length, beforeVirtual)
  await send(virtual, 'virtual-first'); await done(virtual, 'virtual-first'); assert.match((await saved(virtual)).persistentMemorySnapshot, /<foxwarm-current-model model-id="a\/wire" \/>/); await virtual.stop()

  // A Main alias remains cold metadata and preserves its existing authority bytes.
  const alias = await create('onboot-alias', ' '), coldRows = Array.from({ length: 1000 }, (_, index) => row('cold-' + index))
  const existing = await put(alias, 'actual-main'); await seedCatalog(alias, [row('actual-main', { aliases: ['main'], meta: { messageCount: 0, lastMessageTime: 100 } }), ...coldRows], [row('main')])
  await alias.start(); assert.deepEqual(await saved(alias, 'actual-main'), existing); await assert.rejects(access(join(alias.data, 'state', 'sessions', 'main.json')))
  for (let offset = 0; offset < coldRows.length; offset += 100) { const listed = await alias.api('POST', '/api/session-list/by-id', { ids: coldRows.slice(offset, offset + 100).map(value => value.id) }); assert.equal(listed.status, 200, JSON.stringify(listed)); assert.equal(listed.body.results.length, 100) }
  await alias.stop()

  // Only real mandatory busy catalog members reject before sibling effects.
  for (const kind of ['missing', 'unsupported', 'malformed-json', 'malformed-node']) {
    const broken = await create('onboot-required-' + kind, 'Legacy files remain inert even on failed startup.')
    await put(broken, 'queued-sibling', { queue: [{ type: 'user', parts: [{ text: 'ON-TASK:sibling-should-not-start' }] }] })
    const expired = { id: 'original-required-deadline', startedAt: 1, timeoutSeconds: 1, declarationVersion: 1 }
    const deadline = await put(broken, 'deadline-sibling', { meta: { messageCount: 0, lastMessageTime: 0, wait: expired } })
    if (kind !== 'missing') await put(broken, 'main', kind === 'unsupported' ? { sessionStateVersion: 99 } : kind === 'malformed-node' ? { currentNode: 'provider/instance/invalid' } : {})
    if (kind === 'malformed-json') await writeFile(join(broken.data, 'state/sessions/main.json'), '{broken')
    await seedCatalog(broken, [row('main', { busy: true }), row('queued-sibling', { queueLength: 1 }), row('deadline-sibling', { meta: deadline.meta })])
    const count = requests.length
    await assert.rejects(broken.start(), /authority|Session|Unsupported|invalid/i)
    assert.equal(requests.length, count)
    assert(!(await saved(broken, 'queued-sibling')).busy)
    assert.deepEqual(await saved(broken, 'deadline-sibling'), deadline)
  }
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ ok: true, originalApp: true, requests: requests.length, retiredFileInert: true, retainedQueueRecovery: true, setupThenFirstTurn: true, deferredVirtualSnapshot: true, coldMembers: 1000, roots: fixtures.map(value => value.root), hostPids: fixtures.flatMap(value => value.hostPids) }))
} finally {
  await writeFile(join(fixtures[0].root, 'onboot-requests.json'), JSON.stringify({ requests, failures, roots: fixtures.map(value => value.root), hostPids: fixtures.flatMap(value => value.hostPids) }))
  for (const fixture of fixtures) await fixture.cleanup()
  await new Promise(done => peer.close(done))
}
