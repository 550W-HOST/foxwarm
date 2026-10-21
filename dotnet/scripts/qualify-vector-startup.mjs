#!/usr/bin/env node
// Optional derived Vector failure must not stop the actual owned Main process.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile, readFile, readdir, stat, truncate, access } from 'node:fs/promises'
import { join } from 'node:path'
import testEnvironment from '../../scripts/test/test-process-env.cjs'
import { createHostFixture, until, sleep } from '../../packages/webui/test/experimentHostFixture.mjs'

// Establish disposable runtime paths before any application imports or children.
testEnvironment.initializeTestEnvironment()
const requests = [], unexpectedPaths = []
const peer = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  requests.push({ path: request.url, body })
  if (request.url === '/v1/embeddings') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ embedding: Array(1024).fill(0.01) }] }))
    return
  }
  if (request.url !== '/responses') {
    unexpectedPaths.push(request.url)
    response.writeHead(404).end()
    return
  }
  const lastUser = body.input.findLastIndex(row => row.role === 'user')
  const toolResult = body.input.slice(lastUser + 1).some(row => row.type === 'function_call_output')
  const semantic = JSON.stringify(body.input).includes('SEMANTIC:') && !toolResult
  const output = semantic
    ? [{ type: 'function_call', call_id: 'startup-recall', name: 'recall', arguments: JSON.stringify({ vector_query: 'synthetic query', scope: 'current-session' }) }]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic startup answer.' }] }]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n')
})
peer.listen(0, '127.0.0.1')
await once(peer, 'listening')
const provider = `http://127.0.0.1:${peer.address().port}`

async function fixture(label) {
  const env = {}
  const f = await createHostFixture(label, { env })
  Object.assign(env, testEnvironment.isolatedApplicationEnv(f.data), { FOXWARM_BIND_ADDRESS: '127.0.0.1', FOXWARM_SYNC_FILE_LOG: '0' })
  await writeFile(f.modelPath, JSON.stringify({ default: 'fixture', providers: { fixture: {
    providerType: 'openai-responses', baseUrl: provider, models: ['synthetic'],
  } } }))
  const start = f.start
  f.start = async () => { try { await start() } catch (error) { console.error(f.output); throw error } }
  return f
}
async function config(f, child, enabled = true) {
  const raw = JSON.stringify({ vector: enabled ? { baseUrl: provider + '/v1' } : false, dbWorkers: child, vectorMaintenance: false })
  await writeFile(join(f.data, 'state/config.yaml'), raw)
  return raw
}
async function noNativeOwnerInMain(f) {
  if (process.platform === 'linux') assert(!/lancedb_ffi/.test(await readFile(`/proc/${f.hostPids.at(-1)}/maps`, 'utf8')))
}
async function corrupt(f) {
  const directory = join(f.data, 'state/db/messages_v7.lance/_versions')
  const latest = (await readdir(directory)).filter(name => name.endsWith('.manifest')).sort()[0]
  assert(latest, 'Actual managed owner must have committed a Lance manifest')
  const manifest = join(directory, latest)
  assert((await stat(manifest)).size > 0)
  await truncate(manifest, 0)
  return manifest
}
const route = id => '/api/sessions/' + encodeURIComponent(id)
const saved = (f, id) => readFile(join(f.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
async function post(f, path, body, status = 200) {
  const result = await f.api('POST', path, body)
  assert.equal(result.status, status, JSON.stringify(result))
  return result.body
}
async function exchange(f, id, marker, code) {
  await post(f, route(id) + '/message', { text: 'SEMANTIC: ' + marker }, 202)
  const state = await until(async () => {
    const value = await saved(f, id)
    return !value.busy && JSON.stringify(value.history).includes(marker) ? value : null
  }, 'committed exchange ' + marker)
  assert(JSON.stringify(state.history).includes('Synthetic startup answer.'))
  const tool = state.history.filter(row => row.role === 'tool').at(-1).parts[0].functionResponse.response
  assert.equal(tool.code, code, JSON.stringify(tool))
  assert.equal(tool.retryable === true, code === 'VECTOR_UNAVAILABLE')
  assert(JSON.stringify((await f.api('GET', route(id) + '/history')).body).includes(marker))
  const exact = await f.api('GET', '/api/history/window?sessionId=' + encodeURIComponent(id) + '&target=msg%231-50')
  assert.equal(exact.status, 200, JSON.stringify(exact))
  assert(JSON.stringify(exact.body).includes(marker))
  for (const row of state.history) {
    const archived = f.sql('SELECT message_json FROM archive_messages WHERE session_id=? AND seq=?', [id, row.__meta.seq])
    assert.deepEqual(archived.map(value => JSON.parse(value[0])), [row])
  }
}

try {
  for (const child of [false, true]) {
    const f = await fixture('vector-startup-' + (child ? 'child' : 'local'))
    try {
      const raw = await config(f, child)
      await f.start()
      const healthy = await f.api('GET', '/api/history/search?query=synthetic')
      assert.equal(healthy.status, 200, JSON.stringify(healthy))
      await f.stop()
      const manifest = await corrupt(f)
      const before = requests.filter(row => row.path === '/v1/embeddings').length
      let id
      for (let restart = 0; restart < 2; restart++) {
        await f.start()
        if (child) await noNativeOwnerInMain(f)
        assert(f.output.includes('Vector initialization failed'), f.output)
        assert(f.output.includes('Invalid range 0..0 for object of size 0'), f.output)
        const search = await f.api('GET', '/api/history/search?query=synthetic')
        assert.equal(search.status, 503, JSON.stringify(search))
        assert.equal(search.body.code, 'VECTOR_UNAVAILABLE')
        if (restart === 0) id = (await post(f, '/api/sessions', { agentId: 'main', sessionId: 'surviving' })).sessionId
        else {
          assert(JSON.stringify((await f.api('GET', route(id) + '/history')).body).includes('first exchange'))
        }
        await exchange(f, id, restart ? 'second exchange' : 'first exchange', 'VECTOR_UNAVAILABLE')
        if (child && restart === 0) {
          // Observe the existing watchdog, rather than introducing another retry path.
          await until(() => (f.output.match(/Unhandled exception\. lancedb\.LanceDbException/g) || []).length >= 2, 'existing child watchdog retry')
          assert.equal((await f.api('GET', '/health')).status, 200)
        } else if (!child) {
          await sleep(800)
          assert.equal((f.output.match(/Vector initialization failed/g) || []).length, 1)
        }
        assert.equal((await stat(manifest)).size, 0)
        assert.equal(await readFile(join(f.data, 'state/config.yaml'), 'utf8'), raw)
        assert.equal(requests.filter(row => row.path === '/v1/embeddings').length, before)
        if (restart === 0) await f.stop()
        else { f.signalStop(); assert.deepEqual(await f.waitForExit(), { code: 0, signal: null }, f.output) }
      }
      console.log(JSON.stringify({ child, enabledSeed: true, corruptMainStarts: 2, unavailableApiAndTool: true, ordinaryPersistenceAndExactArchive: true, restartAndShutdown: true, corruptManifestPreserved: true }))
    } finally { await f.cleanup() }

    const disabled = await fixture('vector-disabled-' + child)
    try {
      await config(disabled, child, false)
      const before = requests.filter(row => row.path === '/v1/embeddings').length
      await disabled.start()
      await noNativeOwnerInMain(disabled)
      const search = await disabled.api('GET', '/api/history/search?query=synthetic')
      assert.equal(search.status, 503)
      assert.equal(search.body.code, 'VECTOR_DISABLED')
      const id = (await post(disabled, '/api/sessions', { agentId: 'main', sessionId: 'disabled' })).sessionId
      await exchange(disabled, id, 'disabled exchange', 'VECTOR_DISABLED')
      await disabled.stop()
      await assert.rejects(access(join(disabled.data, 'state/db/messages_v7.lance')), { code: 'ENOENT' })
      assert.equal(requests.filter(row => row.path === '/v1/embeddings').length, before)
      assert(!disabled.output.includes('Vector initialization failed'))
      console.log(JSON.stringify({ child, explicitDisabled: true, semanticCodeDistinct: true, noDenseOrEmbeddingSideEffects: true, ordinaryPersistenceAndShutdown: true }))
    } finally { await disabled.cleanup() }
  }
  for (const database of ['catalog.sqlite', 'archive-store.sqlite']) {
    const f = await fixture('vector-fatal-authority')
    try {
      await config(f, true)
      await writeFile(join(f.data, 'state', database), 'not a SQLite database')
      await assert.rejects(f.start(), /exited before binding/)
      const exit = await f.waitForExit()
      assert(exit.code !== 0 || exit.signal !== null)
      assert(!f.output.includes('Vector initialization failed'), f.output)
      assert(!f.output.includes('Main HTTP listening:'), f.output)
      assert(f.output.includes('SQLite Error 26'), f.output)
      console.log(JSON.stringify({ database, authoritativeFailureRemainsFatal: true, exit }))
    } finally { await f.cleanup() }
  }
  assert.deepEqual(unexpectedPaths, [])
} finally {
  peer.closeAllConnections()
  await new Promise(resolve => peer.close(resolve))
}
