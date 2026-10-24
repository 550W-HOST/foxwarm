// Real old-identity planning, ready-held background and awaited standalone plans settle without publishing after a move.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
const owned = await createHostFixture('identity-compact'), requests = [], failures = [], held = new Map()
const route = id => '/api/sessions/' + encodeURIComponent(id), textOf = input => input.filter(item => item.role === 'user').flatMap(item => item.content || []).map(part => part.text || '').join('\n')
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), text = textOf(body.input), key = [...text.matchAll(/IDENTITY-COMPACT:([\w-]+)/g)].at(-1)?.[1] || 'ordinary', planning = text.includes('COMPACTION STARTED:')
    const record = { key, planning, body, closed: false }; requests.push(record); response.writeHead(200, { 'content-type': 'text/event-stream' })
    const complete = output => response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'identity-compact-' + requests.length, output, usage: { input_tokens: 40, output_tokens: 3 } } }) + '\n\n')
    response.on('close', () => { record.closed = true })
    if (planning) {
      const ranges = [...text.matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])]); assert(ranges.length, 'genuine positive-retention candidates')
      held.set('plan', { record, release: () => complete([{ type: 'function_call', call_id: 'old-plan', name: 'submit_compact_plan', arguments: JSON.stringify({ replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Owned older source-identity dialogue.' }] }) }]) }); return
    }
    if (key.startsWith('held-')) { held.set(key, { record, release: () => complete(final('DONE-' + key)) }); return }
    complete(final('DONE-' + key))
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await mkdir(join(owned.work, 'memory'), { recursive: true }); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
const provider = asyncCompact => ({ providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000, asyncCompact })
await writeModelFixture(owned.data, { default: 'a', providers: { a: provider(true), sync: provider(false) } })
const authority = async id => JSON.parse(await readFile(join(owned.data, 'state/sessions', id + '.json'), 'utf8'))
const command = (id, text) => owned.api('POST', route(id) + '/message', { text })
async function seed(id, model) {
  assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  if (model) assert.equal((await owned.api('POST', route(id) + '/model', { model })).status, 200)
  for (let i = 0; i < 7; i++) {
    const key = `seed-${id}-${i}`; assert.equal((await command(id, 'IDENTITY-COMPACT:' + key + ' ' + ('ordered-' + id + '-' + i + '-').repeat(750))).status, 202)
    await until(async () => { const state = await authority(id); return !state.busy && state.history.some(row => row.parts?.some(part => part.text === 'DONE-' + key)) }, key)
  }
}
async function moved(id) { const result = await command(id, '/session move ' + id + '-moved'); assert.equal(result.status, 200, JSON.stringify(result.body)); return id + '-moved' }
async function settled(id) {
  await until(async () => { const state = (await owned.api('GET', route(id) + '/state')).body; return !state.session.busy && !state.session.compacting && !(await authority(id)).queue.some(item => item.type === 'compact-commit') }, 'moved old-identity operation settled')
  assert(!(await authority(id)).history.some(row => row.__meta?.contextBlock)); assert.equal(owned.sql('SELECT COUNT(*) FROM archive_blocks WHERE session_id=?', [id])[0][0], 0)
}
try {
  await owned.start(); await owned.openApp()
  for (const kind of ['planning', 'ready', 'awaited']) {
    const id = 'compact-' + kind; await seed(id, kind === 'awaited' ? 'sync' : undefined); held.delete('plan')
    if (kind !== 'awaited') { await command(id, 'IDENTITY-COMPACT:held-' + kind); await until(() => held.has('held-' + kind), 'real held busy foreground') }
    const compact = await command(id, '/compact'); assert.equal(compact.status, 200); assert.equal(compact.body.success, true); await until(() => held.has('plan'), 'real manual planner')
    const plan = held.get('plan'), before = await authority(id)
    if (kind === 'ready') { plan.release(); await until(async () => (await authority(id)).queue.some(item => item.type === 'compact-commit'), 'ready wake saved behind real foreground') }
    const target = await moved(id); assert.equal((await authority(target)).promptCacheKey, before.promptCacheKey)
    assert.equal((await authority(target)).busy, true); assert(!(await authority(target)).history.some(row => row.__meta?.contextBlock))
    if (kind !== 'ready') plan.release()
    if (kind !== 'awaited') held.get('held-' + kind).release()
    await settled(target); assert.equal((await owned.api('GET', route(id) + '/state')).body.session.id, target)
  }
  assert.equal(failures.length, 0, failures.join('\n')); await owned.stop(); const count = requests.length; await owned.start(); await sleep(600); assert.equal(requests.length, count); await owned.stop()
  console.log(JSON.stringify({ root: owned.root, hosts: owned.hostPids, requests: requests.length, originalApp: true, backgroundPlanning: true, backgroundReady: true, awaited: true, noPublishedBlocks: true }))
} finally {
  for (const value of held.values()) if (!value.record.closed) value.release()
  await writeFile(join(owned.root, 'identity-compact-requests.json'), JSON.stringify({ requests, failures, hosts: owned.hostPids }, null, 2)).catch(() => {})
  await owned.cleanup(); await new Promise(done => peer.close(done))
}
