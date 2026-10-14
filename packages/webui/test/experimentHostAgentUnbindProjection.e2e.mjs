// Supported Agent unbind refreshes retained admitted Session placement on the normal host.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const options = { normalStartup: true, env: {} }
const fixture = await createHostFixture('agent-unbind-projection', options)
options.cwd = fixture.root
options.env.FOXWARM_CONFIG_PATH = join(fixture.data, 'state/config.yaml')
await writeFile(options.env.FOXWARM_CONFIG_PATH, `bot:\n  httpPort: ${fixture.port}\nllm:\n  maxOutput: 713\n`)
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'] } } }))
await writeFile(join(fixture.data, 'state/agents.json'), JSON.stringify({ version: 2, agents: [], metadata: { main: { isolated: true, isolatedNode: 'retained-bound' } } }))
const sessions = join(fixture.data, 'state/sessions')
await mkdir(sessions, { recursive: true })
const variants = [['legacy-absent', {}], ['legacy-null', { currentNode: null }], ['explicit-remote', { currentNode: 'retained-remote' }]]
const originals = new Map(), rows = {}, frames = []
for (const [id, placement] of variants) {
  const raw = {
    sessionStateVersion: 1, id, agent: 'main', busy: false, history: [
      { role: 'user', parts: [{ text: 'Retained historical input' }], __meta: { seq: 1, timestamp: 100 } },
      { role: 'model', parts: [{ text: 'Retained historical reply' }], __meta: { seq: 2, timestamp: 200 } },
    ], queue: [], nextMessageSeq: 3, nextBlockId: 1, historyVersion: 0,
    stats: { totalCachedTokens: 4, totalInputTokens: 17, totalOutputTokens: 6 },
    meta: { messageCount: 2, lastMessageTime: 200 }, cwd: fixture.work,
    model: null, effort: 'high', verbose: false,
    promptCacheKey: '00000000000000000000000000000001', persistentMemorySnapshot: 'Retained snapshot',
    ...placement,
  }
  const bytes = JSON.stringify(raw)
  originals.set(id, bytes)
  await writeFile(join(sessions, id + '.json'), bytes)
  rows[id] = { id, agent: 'main', aliases: [], busy: false, queueLength: 0, meta: raw.meta, stats: raw.stats, cwd: raw.cwd, ...placement }
}
await writeFile(join(fixture.data, 'state/sessions.json'), JSON.stringify({ sessions: rows }))
let socket
async function observe(phase, revision) {
  const histories = new Map()
  for (const [id] of variants) {
    const result = await fixture.api('GET', '/api/sessions/' + id + '/history')
    assert.equal(result.status, 200, JSON.stringify(result.body))
    histories.set(id, result.body)
  }
  socket.send(JSON.stringify({ type: 'set-subscriptions', revision, sessionListActive: true, sessionIds: variants.map(([id]) => id), sessionListIds: variants.map(([id]) => id) }))
  await until(() => frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === revision), 'subscription ' + revision)
  const list = await fixture.api('POST', '/api/session-list/by-id', { ids: variants.map(([id]) => id) })
  assert.equal(list.status, 200)
  for (const [id] of variants) {
    const expected = id === 'explicit-remote' ? 'retained-remote' : phase === 'bound' ? 'retained-bound' : 'master'
    const history = histories.get(id), live = frames.filter(frame => frame.type === 'session-state' && frame.sessionId === id).at(-1)
    const listed = list.body.results.find(result => result.session.id === id).session
    const actual = { phase, id, history: history.session.currentNode, live: live?.session.currentNode, list: listed.currentNode }
    console.log(JSON.stringify(actual))
    assert.equal(actual.history, expected)
    assert.equal(actual.live, expected)
    assert.equal(actual.list, expected)
    for (const dto of [history.session, live.session, listed]) assert.equal(dto.cwd, fixture.work)
    assert.deepEqual(history.messages, JSON.parse(originals.get(id)).history)
    assert.equal(await readFile(join(sessions, id + '.json'), 'utf8'), originals.get(id), 'Unbind/observation must not write Session authority')
  }
}
try {
  await fixture.start()
  socket = new WebSocket(fixture.origin.replace(/^http/, 'ws') + '/api/webui/stream', { headers: { authorization: 'Bearer ' + fixture.token } })
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())))
  await once(socket, 'open')
  await observe('bound', 1)
  const priorInvalidations = frames.filter(frame => frame.type === 'session-list-invalidated').length
  const response = await fixture.api('PUT', '/api/agents/main', { isolatedNode: null })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(response.body.agent.isolated, false)
  assert.equal(response.body.agent.isolatedNode, null)
  await until(() => frames.filter(frame => frame.type === 'session-list-invalidated').length > priorInvalidations, 'unbind list invalidation')
  await observe('cleared', 2)
  socket.terminate(); socket = undefined
  await fixture.stop()
  console.log('Normal host Agent unbind: history/live/list agree, explicit selection wins, cwd and retained authority unchanged.')
} finally {
  socket?.terminate()
  await fixture.cleanup()
}
