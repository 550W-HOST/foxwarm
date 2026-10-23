// Foreground display bounds through an ordinary Main, model request and provider exec.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const env = {}, options = { env, normalStartup: true }
const fixture = await createHostFixture('provider-output', options)
options.cwd = fixture.root
const target = join(fixture.root, 'target')
await mkdir(target)
const configPath = join(fixture.data, 'state/config.yaml')
await writeFile(configPath, JSON.stringify({
  url: fixture.origin, bot: { httpPort: fixture.port }, vector: false, llm: { maxOutput: 713 },
  nodeProviders: { external: { type: 'executable', command: 'python3', args: [resolve('dotnet/Foxwarm.Tests/Tools/Fixtures/node-provider.py'), target], timeoutSeconds: 3 } }
}))
const cases = [
  { byte: 0, length: 4096, shortened: false },
  { byte: 0, length: 4097, shortened: false },
  { byte: 0, length: 20000, shortened: false },
  { byte: 0, length: 20001, shortened: true },
  { byte: 255, length: 4097, shortened: false },
  { byte: 92, length: 4097, shortened: false },
  { byte: 65, length: 20000, shortened: false },
  { byte: 65, length: 20001, shortened: true }
]
let current = 0
const results = [], failures = []
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), callId = 'output-' + current
    const result = body.input.find(row => row.type === 'function_call_output' && row.call_id === callId)
    let output
    if (!result) {
      const command = `python3 -c 'import sys;sys.stdout.buffer.write(bytes([${cases[current].byte}])*${cases[current].length})'`
      output = [{ type: 'function_call', call_id: callId, name: 'exec', arguments: JSON.stringify({ command, timeout: 15 }) }]
    } else {
      const text = typeof result.output === 'string' ? result.output : result.output.map(part => part.text).join('\n')
      assert(!text.includes('outputFullPath') && !text.includes('.temp/tool-output'), 'Foreground output reached the generic artifact guard.')
      assert(text.length < 40000, 'Unexpectedly expanded wire output: ' + text.length)
      assert.equal(text.includes('shortened for inline display'), cases[current].shortened)
      assert(text.includes('Exit code: 0'))
      assert(text.includes('had no trailing newline'))
      results.push({ ...cases[current], wireLength: text.length, genericArtifact: false })
      output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OUTPUT-COMPLETED-' + current }] }]
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 25, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
try {
  await fixture.start()
  for (current = 0; current < cases.length; current++) {
    const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'output-' + current })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    const route = '/api/sessions/' + encodeURIComponent(created.body.sessionId)
    assert.equal((await fixture.api('POST', route + '/node', { nodeId: 'external/target' })).status, 200)
    assert.equal((await fixture.api('POST', route + '/message', { text: 'Run foreground output probe.' })).status, 202)
    await until(async () => {
      if (failures.length) throw new Error(failures.join('\n'))
      const history = (await fixture.api('GET', route + '/history')).body
      return !history.session.busy && JSON.stringify(history.messages).includes('OUTPUT-COMPLETED-' + current)
    }, 'normal model continuation')
  }
  assert.equal(results.length, cases.length)
  const artifacts = (await readdir(fixture.work, { recursive: true })).filter(path => path.includes('tool-output'))
  assert.deepEqual(artifacts, [])
  console.log(JSON.stringify({ results, artifacts, failures }, null, 2))
  await fixture.stop()
} finally {
  await fixture.cleanup()
  model.closeAllConnections()
  await new Promise(done => model.close(done))
}
