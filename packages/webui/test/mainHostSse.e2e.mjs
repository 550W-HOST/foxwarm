// The public Session SSE surface must deliver its snapshots and stay subscribed to live messages.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createHostFixture, until } from './mainHostFixture.mjs'
import testEnvironment from '../../../scripts/test/test-process-env.cjs'

testEnvironment.initializeTestEnvironment()
const fixture = await createHostFixture('session-sse')
const peer = createServer(async (request, response) => {
  for await (const chunk of request) { /* Consume the owned mock request. */ }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: ' + JSON.stringify({ type: 'response.completed', response: {
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SSE-LIVE-ANSWER' }] }],
  } }) + '\n\n')
})
peer.listen(0, '127.0.0.1')
await once(peer, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: {
  local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] },
} }))
const cancellation = new AbortController()
const frames = []
let pump, ended = false, streamError
const waitFor = (predicate, label) => until(() => {
  if (streamError) throw new Error('SSE failed before ' + label + ': ' + JSON.stringify(frames), { cause: streamError })
  assert(!ended, 'SSE disconnected before ' + label + ': ' + JSON.stringify(frames))
  return predicate()
}, label)
try {
  await fixture.start()
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'sse' })
  assert.equal(created.status, 200)
  const id = created.body.sessionId
  const route = '/api/sessions/' + encodeURIComponent(id)
  const response = await fetch(fixture.origin + route + '/stream', {
    headers: { authorization: 'Bearer ' + fixture.token }, signal: cancellation.signal,
  })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  pump = (async () => {
    const decoder = new TextDecoder()
    let pending = ''
    for await (const bytes of response.body) {
      pending += decoder.decode(bytes, { stream: true })
      let boundary
      while ((boundary = pending.indexOf('\n\n')) !== -1) {
        const event = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const data = event.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
        if (data) frames.push(JSON.parse(data))
      }
    }
    ended = true
  })().catch(error => { if (!cancellation.signal.aborted) streamError = error })
  await waitFor(() => frames.length >= 3, 'initial SSE snapshots')
  assert.equal(frames[0].type, 'connected')
  assert.equal(frames[1].type, 'session-state')
  assert.equal(frames[1].session.id, id)
  assert.equal(frames[2].type, 'session-event')
  assert.equal(frames[2].sessionId, id)
  assert.equal(frames[2].event.type, 'tool-call-snapshot')
  assert.equal((await fixture.api('POST', route + '/message', { text: 'Send a live SSE reply.' })).status, 202)
  await waitFor(() => frames.some(frame => frame.type === 'message' && JSON.stringify(frame).includes('SSE-LIVE-ANSWER')), 'committed live SSE reply')
  console.log(JSON.stringify({ initialState: true, toolSnapshot: true, liveCommittedReply: true, connectionStillOpen: !ended }))
} finally {
  cancellation.abort()
  await pump
  await fixture.cleanup()
  peer.closeAllConnections()
  await new Promise(resolve => peer.close(resolve))
}
