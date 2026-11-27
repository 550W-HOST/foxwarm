// Setup > Authorization against a real Main server: the absent policy, an invalid save that leaves
// the active file alone, a save that the very next tool call obeys, a save refused because an
// Agent's set_config installed another policy meanwhile, Reload, and administrator-only routes.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { functionCall } from './ctlModelCalls.mjs'

const fixture = await createHostFixture('setup-authorization')
const policyPath = join(fixture.data, 'state/tool-authorization.yaml')
const scopedToken = 'synthetic-setup-authorization-viewer'
const exists = file => access(file).then(() => true, () => false)
const textOf = item => (item.content || []).map(part => part.text || '').join('')
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const scripts = new Map(), failures = []
const provider = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    const key = [...body.input.filter(item => item.role === 'user').map(textOf).join('\n').matchAll(/AUTH-TASK:([a-z0-9-]+)/g)].at(-1)?.[1]
    const calls = scripts.get(key) || []
    const answered = calls.every(call => body.input.some(item => item.type === 'function_call_output' && item.call_id === call.call_id))
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'setup-auth-' + Date.now(), output: answered ? final('DONE-' + key) : calls, usage: { input_tokens: 40, output_tokens: 5 } } }) + '\n\n')
    response.end()
  } catch (error) { failures.push(String(error.stack || error)); if (!response.headersSent) response.writeHead(500); response.end() }
})
provider.listen(0, '127.0.0.1'); await once(provider, 'listening')

const route = id => '/api/sessions/' + encodeURIComponent(id)
const history = async id => (await fixture.api('GET', route(id) + '/history')).body
async function run(id, key, calls) {
  scripts.set(key, calls)
  assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'AUTH-TASK:' + key })).status, 202)
  await until(async () => (await history(id)).messages.some(row => row.parts?.some(part => part.text === 'DONE-' + key)), key + ' final')
  await until(async () => !(await history(id)).session.busy, key + ' idle')
  const results = {}
  for (const call of calls) results[call.call_id] = (await history(id)).messages.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === call.call_id)?.functionResponse.response
  return results
}
const scoped = (method, body) => fetch(fixture.origin + '/api/setup/authorization', {
  method, headers: { authorization: 'Bearer ' + scopedToken, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

let page
try {
  await writeFile(join(fixture.data, 'state/config.yaml'), `bot:\n  httpPort: ${fixture.port}\nllm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\naccess:\n  identities:\n    viewer:\n      token: ${scopedToken}\n      surfaces:\n        webui:\n          sessions: [main/*]\n`)
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + provider.address().port, apiKey: 'synthetic-setup-authorization', models: ['wire'] } } }))
  await fixture.start()
  const session = (await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'probe' })).body.sessionId
  const own = join(fixture.data, 'agents/main')

  // No policy file: an empty editor at the absent revision.
  const absent = await fixture.api('GET', '/api/setup/authorization')
  assert.equal(absent.status, 200, JSON.stringify(absent))
  assert.deepEqual(absent.body, { exists: false, yaml: '', revision: 'absent' })

  // Administrator-only: a scoped WebUI identity can neither read nor write the policy.
  const scopedSessions = await fetch(fixture.origin + '/api/sessions', { headers: { authorization: 'Bearer ' + scopedToken } })
  assert.equal(scopedSessions.status, 200)
  assert.equal((await scoped('GET')).status, 403)
  assert.equal((await scoped('POST', { yaml: 'version: 1\ndefaultAction: deny\n', revision: 'absent' })).status, 403)
  assert.equal(await exists(policyPath), false)

  page = await fixture.openApp()
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-authorization')
  await page.click('#setup-tab-authorization')
  const editor = '[aria-label="Tool authorization YAML editor"] [role="textbox"]'
  await page.waitForSelector(editor, { visible: true })
  await page.waitForSelector('[data-authorization-absent]')
  const replaceEditorText = async text => {
    await page.focus(editor)
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
    await page.keyboard.sendCharacter(text.replaceAll('\n', '\r\n'))
    await page.waitForFunction(expected => {
      const lines = [...document.querySelectorAll('[aria-label="Tool authorization YAML editor"] .view-line')]
      return lines.length > 0 && lines.map(line => line.textContent).join('\n').replace(/\u00a0/g, ' ').trim() === expected.trim()
    }, { timeout: 10000 }, text)
  }
  const feedback = async role => until(async () => page.$eval('[data-save-feedback="authorization"]', (node, expected) => node.getAttribute('role') === expected && node.textContent?.trim(), role).catch(() => null), 'authorization feedback ' + role, 10000)
  const clickSave = () => page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Save policy')?.click())

  // An invalid candidate is refused with the parser's error; the policy stays absent.
  await replaceEditorText('version: 1\nrules:\n  - tool: exec\n    action: block\n')
  await clickSave()
  assert.match(await feedback('alert'), /Invalid policy action/)
  assert.equal(await exists(policyPath), false)

  // Every call is allowed without a policy; this also loads the absent policy into the cache.
  const before = await run(session, 'before-save', [functionCall('write-before', 'write', { filePath: 'before-save.txt', content: 'allowed' })])
  assert.equal(before['write-before'].error, undefined, JSON.stringify(before))
  assert.equal(await readFile(join(own, 'before-save.txt'), 'utf8'), 'allowed')

  // A successful save creates the file and the very next authorization obeys it, well inside the
  // policy cache's ten-second lifetime.
  const denyWrite = 'version: 1\nrules:\n  - id: deny-write\n    tool: {source: node, name: write}\n    action: deny\n'
  await replaceEditorText(denyWrite)
  await clickSave()
  await feedback('status')
  const savedAt = Date.now()
  assert.equal((await readFile(policyPath, 'utf8')).replaceAll('\r\n', '\n'), denyWrite)
  const after = await run(session, 'after-save', [functionCall('write-after', 'write', { filePath: 'after-save.txt', content: 'denied' })])
  assert(Date.now() - savedAt < 10000, 'the next call ran within the cache lifetime')
  assert.equal(after['write-after'].code, 'tool_authorization_denied', JSON.stringify(after))
  assert.equal(await exists(join(own, 'after-save.txt')), false)
  assert.equal(await page.$('[data-authorization-absent]'), null)
  const loaded = await fixture.api('GET', '/api/setup/authorization')
  assert.equal(loaded.body.exists, true)
  assert.match(loaded.body.revision, /^sha256:[0-9a-f]{64}$/)

  // An Agent installs a tightened policy while the editor still holds the older revision.
  const tightened = '# installed by an Agent\nversion: 1\ndefaultAction: deny\nrules:\n  - id: allow-read\n    tool: {source: node, name: read}\n    action: allow\n'
  await writeFile(join(own, 'tightened.yaml'), tightened)
  const installed = await run(session, 'agent-install', [functionCall('agent-install', 'set_config', { target: 'tool-rules', filePath: 'tightened.yaml' })])
  assert.equal(installed['agent-install'].error, undefined, JSON.stringify(installed))
  assert.equal(await readFile(policyPath, 'utf8'), tightened)
  await replaceEditorText(denyWrite + '# an edit made before the Agent changed the policy\n')
  await clickSave()
  assert.match(await feedback('alert'), /This policy changed after you opened it/)
  assert.equal(await readFile(policyPath, 'utf8'), tightened, 'a stale save never undoes the newer policy')
  // The same refusal through the route itself, with the revision the editor loaded earlier.
  const stale = await fixture.api('POST', '/api/setup/authorization', { yaml: denyWrite, revision: loaded.body.revision })
  assert.equal(stale.status, 409, JSON.stringify(stale))
  assert.equal(stale.body.code, 'policy_changed')
  assert.equal(await readFile(policyPath, 'utf8'), tightened)

  // Reload replaces the edits with the active policy, and a save from it is accepted.
  await page.click('[data-authorization-reload]')
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Tool authorization YAML editor"] .view-line')].some(line => line.textContent?.replace(/\u00a0/g, ' ').includes('installed by an Agent')), { timeout: 10000 })
  assert.equal(await page.$('[data-save-feedback="authorization"]'), null)
  const reopened = tightened.replace('defaultAction: deny', 'defaultAction: allow')
  await replaceEditorText(reopened)
  await clickSave()
  await feedback('status')
  assert.equal((await readFile(policyPath, 'utf8')).replaceAll('\r\n', '\n'), reopened)

  // A direct file edit also changes the revision, and an unusable active file is reported so it can be fixed.
  const beforeEdit = (await fixture.api('GET', '/api/setup/authorization')).body
  await writeFile(policyPath, 'version: 1\nrules: null\n')
  const broken = await fixture.api('GET', '/api/setup/authorization')
  assert.equal(broken.body.exists, true)
  assert.equal(broken.body.yaml, 'version: 1\nrules: null\n')
  assert.match(broken.body.error, /rules must be an array/)
  assert.equal((await fixture.api('POST', '/api/setup/authorization', { yaml: reopened, revision: beforeEdit.revision })).status, 409)
  await page.click('button::-p-text(Refresh)')
  await page.waitForSelector('[data-authorization-invalid]')
  const repaired = await fixture.api('POST', '/api/setup/authorization', { yaml: 'version: 1\n', revision: broken.body.revision })
  assert.equal(repaired.status, 200, JSON.stringify(repaired))
  assert.equal(repaired.body.target, 'tool-rules')
  assert.equal(await readFile(policyPath, 'utf8'), 'version: 1\n')

  assert.deepEqual(failures, [])
  console.log(JSON.stringify({ result: 'ok', absent: true, scopedDenied: true, invalidUnchanged: true, nextCallObeysSave: true, staleRefused: true, reloaded: true, invalidActiveReported: true }))
} finally {
  await fixture.cleanup()
  provider.closeAllConnections(); await new Promise(done => provider.close(done))
}
