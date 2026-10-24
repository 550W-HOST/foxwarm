// Actual Program enablement preserves bindings while authenticated Trigger ingress
// remains active and cannot claim that an unavailable WebUI delivered a file.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
const options = { env: {}, normalStartup: true }, owned = await createHostFixture('webui-disabled', options)
options.cwd = owned.root; options.env.HOME = join(owned.root, 'home'); await mkdir(options.env.HOME)
await mkdir(join(owned.work, 'memory')); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n'); await writeFile(join(owned.work, 'delivery.txt'), 'owned delivery\n')
await writeFile(join(owned.data, 'state/token'), owned.token, { mode: 0o600 })
const config = enabled => 'bot:\n  httpPort: ' + owned.port + '\n  enableWebUI: ' + enabled + '\nllm:\n  maxOutput: 713\n'
await writeFile(join(owned.data, 'state/config.yaml'), config(true))
const requests = [], failures = []
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const triggered = JSON.stringify(body.input).includes('DISABLED-DELIVERY'), completed = body.input.some(row => row.type === 'function_call_output' && row.call_id === 'disabled-delivery')
    const output = triggered && !completed ? [{ type: 'function_call', call_id: 'disabled-delivery', name: 'send_file', arguments: JSON.stringify({ filePath: 'delivery.txt' }) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: triggered ? 'DISABLED-DELIVERY-DONE' : 'BOUND-DONE' }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 30, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(owned.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })
const state = async () => JSON.parse(await readFile(join(owned.data, 'state/sessions/main.json'), 'utf8'))
try {
  await owned.start(); assert.equal((await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200)
  assert.equal((await owned.api('POST', '/api/sessions/main/message', { text: 'BIND' })).status, 202)
  await until(async () => !(await state()).busy && (await state()).history.some(row => row.parts?.some(part => part.text === 'BOUND-DONE')), 'normal bound turn')
  const bindings = await readFile(join(owned.data, 'state/channels.json'), 'utf8'); assert(bindings.includes('webui:main')); await owned.stop()
  await writeFile(join(owned.data, 'state/config.yaml'), config(false)); await writeFile(join(owned.work, 'memory/ONBOOT.md'), 'RETIRED-ONBOOT-SENTINEL\n')
  await owned.start(); for (const path of ['/', '/api/sessions', '/vscode-web/', '/download']) assert.equal((await owned.api('GET', path)).status, 404, path)
  const nodes = await owned.api('GET', '/api/nodes'); assert.equal(nodes.status, 200); assert(nodes.body.nodes.some(node => node.id === 'master'))
  assert.equal((await fetch(owned.origin + '/trigger', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'UNAUTHORIZED-TRIGGER' }) })).status, 401)
  assert.equal(requests.length, 1)
  const triggered = await owned.api('POST', '/trigger', { text: 'DISABLED-DELIVERY', sessionId: 'main' }); assert.equal(triggered.status, 200); assert.equal(triggered.body.success, true)
  await until(async () => !(await state()).busy && (await state()).history.some(row => row.parts?.some(part => part.text === 'DISABLED-DELIVERY-DONE')), 'real disabled-host Trigger')
  assert(!JSON.stringify((await state()).history).includes('RETIRED-ONBOOT-SENTINEL'))
  const result = (await state()).history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'disabled-delivery').functionResponse
  assert(JSON.stringify(result).includes('WebUI file delivery is unavailable')); assert(JSON.stringify(result).includes('Delivered: 0'))
  assert.equal(await readFile(join(owned.data, 'state/channels.json'), 'utf8'), bindings); assert.equal(requests.length, 3); assert.deepEqual(failures, [])
  await owned.stop(); console.log(JSON.stringify({ status: 'passed', requests: requests.length, preservedBindings: true, triggerActive: true, onbootFileIgnored: true, webuiReady: false }))
} finally { await owned.cleanup(); await new Promise(done => peer.close(done)) }
