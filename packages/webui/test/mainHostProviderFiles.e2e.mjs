// Owned Main process, independent executable provider, and original directory/picker consumers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'

const env = {}, options = { env, }
const fixture = await createHostFixture('provider-files', options)
options.cwd = fixture.root
const target = join(fixture.root, 'target')
await mkdir(target)
const configPath = join(fixture.data, 'state/config.yaml')
const provider = { type: 'executable', command: 'python3', args: [resolve('dotnet/Foxwarm.Tests/Tools/Fixtures/node-provider.py'), target], timeoutSeconds: 3 }
await writeFile(configPath, JSON.stringify({ url: fixture.origin, bot: { httpPort: fixture.port }, vector: false, llm: { maxOutput: 713 }, nodeProviders: { external: provider } }))
let modelCalls = 0
const failures = []
const model = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); modelCalls++
    const fileTools = body.tools.filter(tool => ['read', 'write', 'edit', 'apply_patch', 'exec'].includes(tool.name))
    assert.deepEqual(fileTools.map(tool => tool.name).sort(), ['apply_patch', 'edit', 'exec', 'read', 'write'])
    const complete = body.input.some(row => row.type === 'function_call_output' && row.call_id === 'provider-write')
    const output = complete
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PROVIDER-FILES-DONE' }] }]
      : [{ type: 'function_call', call_id: 'provider-write', name: 'write', arguments: JSON.stringify({ filePath: 'browser.txt', content: 'original-picker-provider-effect', createDirs: true }) }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 25, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeFile(fixture.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${model.address().port}`, models: ['wire'] } } }))
try {
  await fixture.start()
  const created = await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'provider-browser' })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const id = created.body.sessionId, route = '/api/sessions/' + encodeURIComponent(id)
  const listed = await fixture.api('GET', '/api/nodes')
  assert.equal(listed.status, 200, JSON.stringify(listed.body) + '\n' + fixture.output)
  const directory = listed.body.nodes
  assert.equal(directory.find(node => node.id === 'external/target').online, true)
  assert.deepEqual(directory.find(node => node.id === 'external/target').services, {})
  const page = await fixture.openApp()
  page.on('pageerror', error => failures.push(error.stack))
  await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), id)
  await page.waitForSelector('.foxwarm-node-picker-trigger'); await page.click('.foxwarm-node-picker-trigger')
  await page.waitForSelector('[data-node-option="external/target"]:not([disabled])')
  assert.equal(await page.$eval('[data-node-option="external/offline"]', item => item.disabled), true)
  await page.click('[data-node-option="external/target"]')
  await page.waitForSelector('.foxwarm-node-picker-trigger[aria-label="Execution node: external/target"]')
  assert.equal((await fixture.api('GET', route + '/history')).body.session.currentNode, 'external/target')
  // The same directory response flows through the shared validator to the original Nodes surface.
  await page.click('[data-workbench-status-bar] button[aria-label^="Nodes:"]')
  await page.waitForSelector('[data-workbench-status-popup]')
  await page.evaluate(() => [...document.querySelectorAll('[data-workbench-status-popup] button')].find(button => button.textContent === 'Open Nodes').click())
  await page.waitForSelector('[data-node-surface]')
  await page.waitForFunction(() => document.querySelector('[data-node-surface]')?.innerText.includes('external/target'))
  const card = await page.evaluate(() => [...document.querySelectorAll('[data-node-surface] article')].find(item => item.textContent.includes('external/target'))?.textContent)
  assert(card?.includes('external/target'), card)
  assert(!card.includes('vscode-'), card)
  assert.equal((await fixture.api('POST', route + '/message', { text: 'Write the provider file.' })).status, 202)
  await until(async () => {
    if (failures.length) throw new Error(failures.join('\n'))
    const history = (await fixture.api('GET', route + '/history')).body
    return !history.session.busy && JSON.stringify(history.messages).includes('PROVIDER-FILES-DONE')
  }, 'original provider file tool turn')
  assert.equal(await readFile(join(target, 'fs/root/browser.txt'), 'utf8'), 'original-picker-provider-effect')
  assert(modelCalls >= 2)
  await fixture.stop()
  await fixture.start()
  assert.equal((await fixture.api('GET', route + '/history')).body.session.currentNode, 'external/target')
  assert.equal((await fixture.api('GET', route + '/nodes')).body.nodes.find(node => node.id === 'external/target').selectable, true)
  await fixture.stop()
  assert.deepEqual(failures, [])
  console.log('Provider directory, original picker, file-tool request/effect, and restarted selection passed.')
} finally {
  await fixture.cleanup()
  await new Promise(done => model.close(done))
}
