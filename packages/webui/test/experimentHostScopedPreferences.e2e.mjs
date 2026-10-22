// Shared read-only display preferences through the production restricted root and real C# producers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const options = { normalStartup: true, env: {} }
const host = await createHostFixture('scoped-preferences', options)
options.cwd = host.root
options.env.FOXWARM_CONFIG_PATH = join(host.data, 'state/config.yaml')
const prefix = '/nested/app'
const readerToken = 'synthetic-preferences-reader'
await writeFile(options.env.FOXWARM_CONFIG_PATH, JSON.stringify({
  url: host.origin + prefix,
  bot: { httpPort: host.port },
  channels: { webui: {} },
  access: { identities: { reader: { token: readerToken, surfaces: { webui: { sessions: ['source'] } } } } },
}))
await mkdir(join(host.work, 'memory'), { recursive: true })
await writeFile(join(host.work, 'memory/ONBOOT.md'), ' \n')
await writeFile(join(host.work, 'memory/MEMORY.md'), 'PRIVATE-PROMPT-SNAPSHOT')
const errors = [], browserErrors = [], scopedRequests = []
let requests = 0, browser, context, page
const message = (value, phase) => ({
  type: 'message', role: 'assistant', ...(phase ? { phase } : {}),
  content: [{ type: 'output_text', text: value }],
})
const peer = createServer(async (request, response) => {
  try {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests++
    const output = JSON.stringify(body.input).includes('SCOPED-PREFERENCES')
      ? [message('SCOPED-COMMENTARY', 'commentary'), message('SCOPED-ORDINARY'), message('SCOPED-FINAL', 'final_answer'), {
        type: 'function_call', call_id: 'scoped-send', name: 'send_to_session',
        arguments: JSON.stringify({ sessionId: 'target', message: 'SCOPED-DELIVERY', afterSend: 'finish' }),
      }]
      : [message('TARGET-REPLY')]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: {
      id: 'scoped-preferences-' + requests, output, usage: { input_tokens: 40, output_tokens: 4 },
    } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1')
await once(peer, 'listening')
await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: {
  providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'],
} } }))
const standalone = '[data-session-communication]:not([data-activity-details] [data-session-communication])'
try {
  await host.start()
  for (const sessionId of ['source', 'target']) {
    assert.equal((await host.api('POST', '/api/sessions', { agentId: 'main', sessionId })).status, 200)
  }
  assert.equal((await host.api('POST', '/api/sessions/source/message', { text: 'SCOPED-PREFERENCES' })).status, 202)
  const history = await until(async () => {
    const value = (await host.api('GET', '/api/sessions/source/history')).body
    return !value.session.busy && value.messages.some(row => row.parts.some(part => part.functionResponse)) && value
  }, 'real send committed')
  const receipt = history.messages.flatMap(row => row.parts).find(part => part.functionResponse).functionResponse
  assert.equal(receipt.__meta.sessionMessages[0].message, 'SCOPED-DELIVERY')
  assert(history.messages.some(row => row.parts.some(part => part.phase === 'commentary')))
  const administrator = await host.openApp()
  browser = administrator.browser()
  context = await browser.createBrowserContext()
  page = await context.newPage()
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.includes('/api/')) scopedRequests.push(path)
  })
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('foxwarm_timeline_view_v1', 'conversation')
    if (localStorage.getItem('foxwarm_show_commentary_v1') === null) {
      localStorage.setItem('foxwarm_show_commentary_v1', 'false')
      localStorage.setItem('foxwarm_show_inter_agent_messages_v1', 'false')
    }
  })
  // Scoped auth must choose the restricted root even for a popup/management request.
  await page.goto(host.origin + prefix + '/?foxwarmPopupVersion=1&foxwarmPopup=chat&sessionId=target#setup', { waitUntil: 'networkidle0' })
  await page.type('input[type="password"]', readerToken)
  await page.click('button[type="submit"]')
  await page.waitForSelector('[data-webui-role="webui"] .foxwarm-chat-root')
  await waitForWebUiReady(page)
  await page.waitForFunction(() => document.body.innerText.includes('SCOPED-FINAL'))
  const visible = () => page.$eval('.foxwarm-chat-messages', node => node.textContent)
  assert(!(await visible()).includes('SCOPED-COMMENTARY'))
  assert((await visible()).includes('SCOPED-ORDINARY'))
  assert.equal(await page.$(standalone), null)
  assert.equal(await page.$('.foxwarm-model-selector-trigger'), null)
  const scopedHistory = await page.evaluate(async () => (await fetch('./api/sessions/source/history')).json())
  assert.equal(scopedHistory.persistentMemorySnapshot, null)
  assert(!JSON.stringify(scopedHistory).includes('PRIVATE-PROMPT-SNAPSHOT'))
  const settings = await page.browserContext().newPage()
  await settings.goto(host.origin + prefix + '/', { waitUntil: 'networkidle0' })
  await settings.evaluate(() => {
    localStorage.setItem('foxwarm_show_commentary_v1', 'true')
    localStorage.setItem('foxwarm_show_inter_agent_messages_v1', 'true')
  })
  await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages').textContent.includes('SCOPED-COMMENTARY'))
  await page.waitForSelector(standalone)
  await settings.close()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector(standalone)
  assert((await visible()).includes('SCOPED-COMMENTARY'))
  assert(!scopedRequests.some(path => /\/(models|setup|nodes|session-list)\b/.test(path)), JSON.stringify(scopedRequests))
  assert.deepEqual(errors, [])
  assert.deepEqual(browserErrors, [])
  await context.close()
  context = null
  await host.stop()
  console.log(JSON.stringify({ normalHost: true, originalRestrictedRoot: true, actualPhaseAndSend: true, sharedPreferences: true, requests }))
} finally {
  if (context) await context.close().catch(() => {})
  await host.cleanup()
  peer.closeAllConnections()
  await new Promise(done => peer.close(done))
}
