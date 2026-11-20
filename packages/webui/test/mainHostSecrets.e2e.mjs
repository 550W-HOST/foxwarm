// Setup secret routes and a provider credential reference on the normal host, across a restart.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const value = 'synthetic-secret-provider-credential-0123456789'
const authorizations = []
const peer = createServer(async (request, response) => {
  for await (const _ of request) {}
  authorizations.push(request.headers.authorization)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic secret answer.' }] }]
  response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n')
})
peer.listen(0, '127.0.0.1')
await once(peer, 'listening')
const fixture = await createHostFixture('secrets')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'fixture/synthetic', providers: { fixture: {
  providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, apiKey: '${secret:provider-key}', models: ['synthetic'],
} } }))
const status = async () => {
  const result = await fixture.api('GET', '/api/setup/secrets')
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert(!JSON.stringify(result.body).includes(value), 'Secret routes never return a stored value')
  return result.body
}
async function answered(sessionId) {
  assert.equal((await fixture.api('POST', `/api/sessions/${sessionId}/message`, { text: 'Use the provider.' })).status, 202)
  await until(async () => {
    const history = await fixture.api('GET', `/api/sessions/${sessionId}/history`)
    return history.body.messages?.some(message => message.role === 'model' && JSON.stringify(message.parts).includes('Synthetic secret answer.'))
  }, 'model answer for ' + sessionId)
}
try {
  await fixture.start()
  const empty = await status()
  assert.equal(empty.locked, false)
  assert.deepEqual(empty.secrets, [])
  assert.deepEqual(empty.missing.map(row => row.name), ['provider-key'])

  const saved = await fixture.api('PUT', '/api/setup/secrets/provider-key', { value, description: 'Synthetic provider key' })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.secret.name, 'provider-key')
  assert.equal(saved.body.warning, undefined)
  assert(!JSON.stringify(saved.body).includes(value))
  const listed = await status()
  assert.deepEqual(listed.missing, [])
  assert.equal(listed.secrets[0].name, 'provider-key')
  assert.equal(listed.secrets[0].description, 'Synthetic provider key')
  assert(listed.secrets[0].usages.length > 0, JSON.stringify(listed.secrets[0]))
  assert(!(await readFile(join(fixture.data, 'state/secrets.json'), 'utf8')).includes(value), 'Stored values are encrypted at rest')

  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'secret-before' })).status, 200)
  await answered('secret-before')
  assert.equal(authorizations.at(-1), 'Bearer ' + value)

  await fixture.stop()
  await fixture.start()
  assert.equal((await status()).secrets[0].name, 'provider-key')
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'secret-after' })).status, 200)
  await answered('secret-after')
  assert.equal(authorizations.at(-1), 'Bearer ' + value)

  const deleted = await fixture.api('DELETE', '/api/setup/secrets/provider-key')
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
  assert.equal(deleted.body.deleted, 'provider-key')
  assert.deepEqual((await status()).missing.map(row => row.name), ['provider-key'])
  await fixture.stop()
  console.log('Normal host secrets: write-only routes, resolved provider reference, restart, delete.')
} finally {
  await fixture.cleanup()
  peer.close()
}
