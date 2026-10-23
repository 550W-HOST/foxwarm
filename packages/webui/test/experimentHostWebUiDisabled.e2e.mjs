// Actual Program enablement preserves bindings while the ordinary ONBOOT runner
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
    const boot = JSON.stringify(body.input).includes('DISABLED-DELIVERY'), completed = body.input.some(row => row.type === 'function_call_output' && row.call_id === 'disabled-delivery')
    const output = boot && !completed ? [{ type: 'function_call', call_id: 'disabled-delivery', name: 'send_file', arguments: JSON.stringify({ filePath: 'delivery.txt' }) }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: boot ? 'DISABLED-DELIVERY-DONE' : 'BOUND-DONE' }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 30, output_tokens: 3 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(owned.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + peer.address().port, models: ['wire'], contextLimit: 20000 } } })
const state = async () => JSON.parse(await readFile(join(owned.data, 'state/sessions/main.json'), 'utf8'))
try {
  await owned.start(); assert.equal((await owned.api('POST', '/api/sessions/main/message', { text: 'BIND' })).status, 202)
  await until(async () => !(await state()).busy && (await state()).history.some(row => row.parts?.some(part => part.text === 'BOUND-DONE')), 'normal bound turn')
  const bindings = await readFile(join(owned.data, 'state/channels.json'), 'utf8'); assert(bindings.includes('webui:main')); await owned.stop()
  await writeFile(join(owned.data, 'state/config.yaml'), config(false)); await writeFile(join(owned.work, 'memory/ONBOOT.md'), 'DISABLED-DELIVERY\n')
  await owned.start(); for (const path of ['/', '/api/sessions', '/api/nodes', '/vscode-web/', '/download']) assert.equal((await owned.api('GET', path)).status, 404)
  await until(async () => !(await state()).busy && (await state()).history.some(row => row.parts?.some(part => part.text === 'DISABLED-DELIVERY-DONE')), 'real disabled-host ONBOOT')
  const result = (await state()).history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === 'disabled-delivery').functionResponse
  assert(JSON.stringify(result).includes('WebUI file delivery is unavailable')); assert(JSON.stringify(result).includes('Delivered: 0'))
  assert.equal(await readFile(join(owned.data, 'state/channels.json'), 'utf8'), bindings); assert.equal(requests.length, 3); assert.deepEqual(failures, [])
  await owned.stop(); console.log(JSON.stringify({ status: 'passed', requests: requests.length, preservedBindings: true, onbootActive: true, webuiReady: false }))
} finally { await owned.cleanup(); await new Promise(done => peer.close(done)) }
