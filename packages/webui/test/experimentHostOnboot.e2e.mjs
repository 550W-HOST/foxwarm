// Original-App bootstrap, mandatory Main lifetime and the real delayed startup producer.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { createHostFixture, until, sleep, saveModelsInOriginalApp } from './experimentHostFixture.mjs'

const fixtures = [], requests = [], failures = [], held = new Map()
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
    if (task.startsWith('hold-') && !boot) { held.set(task, { complete, record, response }); return }
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
  execFileSync('node', [resolve('dotnet/session-catalog-seed-ts.mjs'), fixture.data, file], { env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') }, stdio: 'pipe' })
}
const row = (id, extra = {}) => ({ id, agent: 'main', busy: false, queueLength: 0, model: 'a', meta: { messageCount: 0, lastMessageTime: 0 }, ...extra })
const authority = (id, extra = {}) => ({ sessionStateVersion: 1, id, agent: 'main', busy: false, verbose: false, history: [], queue: [], stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0 }, nextMessageSeq: 1, nextBlockId: 1, meta: { messageCount: 0, lastMessageTime: 0 }, promptCacheKey: randomUUID(), persistentMemorySnapshot: 'Existing user snapshot bytes.', ...extra })
async function put(fixture, id, extra = {}) { const directory = join(fixture.data, 'state', 'sessions'); await mkdir(directory, { recursive: true }); const raw = authority(id, extra); await writeFile(join(directory, id + '.json'), JSON.stringify(raw)); return raw }
try {
  // A busy real turn receives a normal typed startup event after the unshortened delay.
  const original = '  BOOT-ONE original content.\r\n', fixture = await create('onboot-app', original)
  await writeFile(join(fixture.work, 'memory', '00_SYSTEM.md'), 'Owned legacy framework fixture bytes.')
  const started = Date.now(); await fixture.start(); await send(fixture, 'hold-first')
  await until(() => held.has('hold-first'), 'actual foreground provider held')
  const page = await fixture.openApp(); assert(await page.$('.foxwarm-chat-root'))
  await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), 'Changed after this startup read.')
  await until(async () => (await saved(fixture)).queue.some(item => item.type === 'onboot'), 'real delayed producer queued while Main busy')
  assert(Date.now() - started >= 2990); const beforeRelease = await saved(fixture), event = beforeRelease.queue.find(item => item.type === 'onboot')
  assert.equal(event.parts[0].system.split('\n').slice(1, -1).join('\n'), 'ONBOOT: ' + original)
  assert.match(event.parts[0].system, /^<foxwarm-message type="onboot" eventType="onboot" time="\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}" hint="onboot session event">/)
  assert.equal(requests.length, 1); assert.equal(await readFile(join(fixture.work, 'memory', '00_SYSTEM.md'), 'utf8'), 'Owned legacy framework fixture bytes.')
  await assert.rejects(access(join(fixture.work, 'agents', '00_SYSTEM.md')))
  held.get('hold-first').complete([text('DONE-hold-first')]); await done(fixture, 'BOOT')
  const initial = await saved(fixture); assert.equal(bootRows(initial).length, 1)
  const responses = initial.history.flatMap(value => value.parts || []).filter(value => value.functionResponse)
  assert(responses.some(value => value.functionResponse.response?.error?.type === 'tool_authorization_denied')); await assert.rejects(access(join(fixture.work, 'forbidden-onboot-effect')))
  assert(fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=? ORDER BY seq', ['main']).some(([json]) => json.includes('BOOT-ONE original content.')))
  await fixture.stop()

  // A clean Stop can fold an accepted event into canonical history without a provider round.
  // The next startup retains that row and produces a separate new event, without deduplication.
  await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), 'BOOT-TWO retained and produced again.')
  await fixture.start(); await send(fixture, 'hold-second'); await until(() => held.has('hold-second'), 'second actual foreground held')
  await until(async () => (await saved(fixture)).queue.some(item => item.type === 'onboot'), 'second startup queue durable')
  await fixture.stop(); const stopped = await saved(fixture); assert(!stopped.busy && !stopped.stopping); assert.equal(bootRows(stopped).length, 2)
  const beforeRestart = requests.length, restartAt = Date.now(); await fixture.start()
  await until(async () => bootRows(await saved(fixture)).length >= 3 && !(await saved(fixture)).busy, 'new startup event also processed')
  const restarted = await saved(fixture), occurrences = bootRows(restarted).filter(row => row.parts.some(part => part.system?.includes('BOOT-TWO retained and produced again.')))
  assert.equal(occurrences.length, 2); assert(requests.slice(beforeRestart).some(value => value.boot && value.at - restartAt >= 2990))
  assert(restarted.history.filter(value => value.role === 'tool').every(value => value.parts.every(part => part.functionResponse)))
  await fixture.stop()

  // A close during the delay has no late enqueue, and missing/whitespace files produce nothing.
  const beforeDelayStop = requests.length; await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), 'BOOT-NEVER late event.')
  await fixture.start(); await sleep(300); await fixture.stop(); assert.equal(requests.length, beforeDelayStop); assert(!JSON.stringify(await saved(fixture)).includes('BOOT-NEVER'))
  for (const content of [null, ' \n\ufeff']) { if (content === null) await unlink(join(fixture.work, 'memory', 'ONBOOT.md')); else await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), content); await fixture.start(); await sleep(3200); assert.equal(requests.length, beforeDelayStop); await fixture.stop() }
  await unlink(join(fixture.work, 'memory', 'ONBOOT.md')); await mkdir(join(fixture.work, 'memory', 'ONBOOT.md')); await fixture.start(); await until(() => fixture.output.includes('Error processing ONBOOT.md'), 'observable real read failure'); assert.equal(requests.length, beforeDelayStop); await fixture.stop()

  const queueFailure = await create('onboot-queue-failure', 'An event whose selected Main is retired before delivery.'); const beforeQueueFailure = requests.length; await queueFailure.start(); assert.equal((await queueFailure.api('DELETE', route('main'))).status, 200); await until(() => queueFailure.output.includes('Failed to queue ONBOOT event'), 'observable normal queue failure after Main retirement'); assert.equal(requests.length, beforeQueueFailure); await assert.rejects(access(join(queueFailure.data, 'state', 'sessions', 'main.json'))); await queueFailure.stop()

  // An existing valid persisted typed event resumes before the separate current-startup producer.
  const oldQueue = await create('onboot-existing-queue', 'BOOT-OLD persisted and produced again.')
  const oldWrapper = '<foxwarm-message type="onboot" eventType="onboot" time="2026-01-01 00:00:00 +0000" hint="onboot session event">\nONBOOT: BOOT-OLD persisted and produced again.\n</foxwarm-message>'
  await put(oldQueue, 'main', { queue: [{ type: 'onboot', parts: [{ system: oldWrapper }] }] }); await seedCatalog(oldQueue, [row('main', { queueLength: 1 })])
  const oldQueueAt = Date.now(); await oldQueue.start(); await until(async () => bootRows(await saved(oldQueue)).length === 1 && !(await saved(oldQueue)).busy, 'persisted old queue uses ordinary ingress'); assert(Date.now() - oldQueueAt < 2990)
  await until(async () => bootRows(await saved(oldQueue)).length === 2 && !(await saved(oldQueue)).busy, 'new startup produces independently of old typed event'); assert(Date.now() - oldQueueAt >= 2990); await oldQueue.stop()

  // Empty Setup still has a strict real Main and the original App saves a model before its first normal turn.
  const empty = await create('onboot-empty-setup', undefined, { providers: {} }); await empty.start()
  const emptyMain = await saved(empty); assert.equal(emptyMain.persistentMemorySnapshot, ''); assert(!emptyMain.model && !emptyMain.effort); assert(emptyMain.promptCacheKey)
  const emptyHistory = await empty.api('GET', route('main') + '/history'); assert.equal(emptyHistory.status, 200); assert.equal(emptyHistory.body.session.modelKey, ''); assert.equal(emptyHistory.body.session.defaultModelKey, ''); assert.equal(emptyHistory.body.session.effortDefault, 'high'); assert.equal(emptyHistory.body.session.effectiveCompactThresholdTokens, 104448)
  assert.equal((await empty.api('GET', route('main') + '/state')).status, 200)
  const frames = [], ws = new WebSocket(empty.origin.replace('http:', 'ws:') + '/api/webui/stream', { headers: { authorization: 'Bearer synthetic-onboot-empty-setup-api' } }); ws.on('message', raw => frames.push(JSON.parse(String(raw)))); await once(ws, 'open'); ws.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionIds: ['main'], sessionListIds: ['main'], sessionListActive: true })); await until(() => frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 1), 'unconfigured Main state/draft/context subscription applies'); assert(frames.some(frame => frame.type === 'session-state' && frame.session?.modelKey === '')); assert(!frames.some(frame => frame.type === 'session-error')); ws.close(); await once(ws, 'close')
  const framework = await readFile(resolve('dotnet/Foxwarm/bin/Debug/net10.0/templates/agents/00_SYSTEM.md'))
  assert.deepEqual(await readFile(join(empty.work, 'agents', '00_SYSTEM.md')), framework)
  for (const name of ['BOOTSTRAP.md', 'MEMORY.md', 'ONBOOT.md', 'SOUL.md', 'USER.md']) assert.deepEqual(await readFile(join(empty.work, 'memory', name)), await readFile(resolve('dotnet/Foxwarm/bin/Debug/net10.0/templates/main/memory', name)))
  const setupPage = await empty.openApp(); await saveModelsInOriginalApp(setupPage, `default: a\nproviders:\n  a:\n    providerType: openai-responses\n    baseUrl: 'http://127.0.0.1:${peer.address().port}'\n    apiKey: synthetic-onboot\n    models: [wire]\n    contextLimit: 20000\n`, empty.modelPath)
  await send(empty, 'after-setup'); await done(empty, 'after-setup'); assert.match((await saved(empty)).persistentMemorySnapshot, /<foxwarm-current-model model-id="a\/wire" \/>/); await empty.stop()

  // Virtual startup has no selected concrete snapshot/route; only the first real turn captures a leaf.
  const virtualConfig = { ...models, default: 'route', providers: { ...models.providers, route: { providerType: 'session-hash', targets: ['a'] } } }
  const virtual = await create('onboot-virtual', ' ', virtualConfig), beforeVirtual = requests.length; await virtual.start(); const virtualMain = await saved(virtual); assert.equal(virtualMain.persistentMemorySnapshot, ''); assert(!virtualMain.model && !virtualMain.effort); assert.equal(requests.length, beforeVirtual)
  await send(virtual, 'virtual-first'); await done(virtual, 'virtual-first'); assert.match((await saved(virtual)).persistentMemorySnapshot, /<foxwarm-current-model model-id="a\/wire" \/>/); await virtual.stop()

  // The actual main alias admits exactly one owner, retaining cold unavailable authorities and existing bytes.
  const alias = await create('onboot-alias', ' '), coldRows = Array.from({ length: 1000 }, (_, index) => row('cold-' + index))
  const existing = await put(alias, 'actual-main'); await seedCatalog(alias, [row('actual-main', { aliases: ['main'], meta: { messageCount: 0, lastMessageTime: 100 } }), ...coldRows], [row('main')])
  await mkdir(join(alias.data, 'state', 'experiment-faults'), { recursive: true }); await writeFile(join(alias.data, 'state', 'experiment-faults', 'record-admissions'), 'record')
  await alias.start(); assert.deepEqual(await saved(alias, 'actual-main'), existing); await assert.rejects(access(join(alias.data, 'state', 'sessions', 'main.json')))
  for (let offset = 0; offset < coldRows.length; offset += 100) { const listed = await alias.api('POST', '/api/session-list/by-id', { ids: coldRows.slice(offset, offset + 100).map(value => value.id) }); assert.equal(listed.status, 200, JSON.stringify(listed)); assert.equal(listed.body.results.length, 100) }
  const admissions = await readFile(join(alias.data, 'state', 'experiment-faults', 'record-admissions.events'), 'utf8'); assert(admissions.includes('read actual-main')); assert(!admissions.includes('cold-'))
  await alias.stop()

  // Every required Main authority failure precedes sibling provider/tool/deadline/exec effects.
  for (const kind of ['retained', 'missing', 'busy', 'unsupported', 'foreign']) {
    const broken = await create('onboot-main-' + kind, 'ONBOOT must not start in a failed host.')
    await put(broken, 'queued-sibling', { queue: [{ type: 'user', parts: [{ text: 'ON-TASK:sibling-should-not-start' }] }] })
    const expired = { id: 'original-required-deadline', startedAt: 1, timeoutSeconds: 1, declarationVersion: 1 }
    const deadline = await put(broken, 'deadline-sibling', { meta: { messageCount: 0, lastMessageTime: 0, wait: expired } })
    const rows = [row('queued-sibling', { queueLength: 1 }), row('deadline-sibling', { meta: deadline.meta })]
    if (kind !== 'retained') { rows.push(row('main')); if (kind !== 'missing') await put(broken, 'main', kind === 'busy' ? { busy: true, busyStartedAt: 1 } : kind === 'foreign' ? { currentNode: 'future-node' } : { sessionStateVersion: 99 }) }
    await seedCatalog(broken, rows, kind === 'retained' ? [row('main')] : [])
    const count = requests.length; await assert.rejects(broken.start(), /reserved|authoritative|Session|Unsupported|busy/i); assert.equal(requests.length, count); assert(!(await saved(broken, 'queued-sibling')).busy); assert.deepEqual(await saved(broken, 'deadline-sibling'), deadline)
  }
  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ ok: true, originalApp: true, requests: requests.length, realThreeSecondProducer: true, retainedQueueAndNewProduction: true, setupThenFirstTurn: true, deferredVirtualSnapshot: true, coldMembers: 1000, roots: fixtures.map(value => value.root), hostPids: fixtures.flatMap(value => value.hostPids) }))
} finally {
  for (const value of held.values()) if (!value.response.destroyed) value.complete([text('Owned held response cleanup.')])
  await writeFile(join(fixtures[0].root, 'onboot-requests.json'), JSON.stringify({ requests, failures, roots: fixtures.map(value => value.root), hostPids: fixtures.flatMap(value => value.hostPids) }))
  for (const fixture of fixtures) await fixture.cleanup()
  await new Promise(done => peer.close(done))
}
