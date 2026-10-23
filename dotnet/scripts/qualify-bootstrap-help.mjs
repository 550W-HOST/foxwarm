#!/usr/bin/env node
// Normal HTTP ingress, WebSocket command replies and model-dispatched bootstrap information.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createHostFixture, until } from '../../packages/webui/test/experimentHostFixture.mjs'

const source = process.argv.includes('--source')
const results = []
for (const configured of [false, true]) {
  const requests = []
  const peer = createServer(async (req, res) => {
    let body = ''; for await (const bytes of req) body += bytes
    requests.push(JSON.parse(body))
    const output = requests.length === 1
      ? [{ type: 'function_call', name: 'node_bootstrap_info', call_id: 'bootstrap-info', arguments: '{}' }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'bootstrap complete' }] }]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n')
  })
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
  const f = await createHostFixture('bootstrap-help', { normalStartup: true, ...(source ? { runtime: 'source' } : {}) })
  const prefix = configured && !source ? '/mount' : ''
  const expected = configured ? 'https://configured.example/mount' : `http://YOUR_MASTER:${f.port}`
  const api = async (method, path, body) => {
    const response = await f.api(method, prefix + path, body)
    assert(response.status >= 200 && response.status < 300, JSON.stringify(response))
    return response.body
  }
  let ws
  try {
    await writeFile(join(f.data, 'state/config.yaml'), JSON.stringify({
      bot: { httpPort: f.port }, vector: false,
      ...(configured ? { url: 'https://configured.example/mount' } : {}),
    }))
    await writeFile(f.modelPath, JSON.stringify({ default: 'local/wire', providers: { local: {
      providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'],
    } } }))
    await f.start()
    await api('POST', '/api/sessions', { agentId: 'main', sessionId: 'bootstrap' })
    const route = '/api/sessions/bootstrap'
    const events = []
    ws = new WebSocket(f.origin.replace(/^http/, 'ws') + prefix + '/api/webui/stream', { headers: { authorization: 'Bearer ' + f.token } })
    ws.on('message', bytes => events.push(JSON.parse(bytes.toString())))
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: false, sessionListIds: [], sessionIds: ['bootstrap'] }))
    await until(() => events.some(e => e.type === 'subscriptions-applied'), 'subscription applied')
    async function command(text, marker) {
      const start = events.length
      await api('POST', route + '/message', { text })
      return until(() => events.slice(start).map(e => e.message?.parts?.map(p => p.text || '').join('') || '').find(text => text.includes(marker)), 'transient command reply')
    }
    const help = await command('/node pair-help', 'Node Pairing')
    assert(help.includes(expected + '/node/run.sh'))
    assert(help.includes(`--host='${expected}'`))
    assert(help.includes(`-HostUrl '${expected}'`))
    assert(help.includes(`NODE_HOST='${expected}'`))
    if (!configured) assert(help.includes('Replace YOUR_MASTER'))
    const direct = await command('/node create bootstrap-direct', 'Created node')
    assert(direct.includes(expected))
    const token = /--auth-token=([a-f0-9]+)/.exec(direct)?.[1]
    assert(token)
    const summaries = await api('GET', '/api/nodes')
    assert(!JSON.stringify(summaries).includes(token))
    assert(!JSON.stringify(summaries).includes('tokenHash'))
    const browser = await api('POST', '/api/nodes/onboarding/commands', { fallbackUrl: 'https://browser.example/browser' })
    assert.equal(browser.baseUrl, configured ? expected : 'https://browser.example/browser')
    const explicit = await api('POST', '/api/nodes/onboarding/commands', { fallbackUrl: 'https://browser.example/browser', baseUrl: 'https://explicit.example/route' })
    assert.equal(explicit.baseUrl, 'https://explicit.example/route')
    await api('POST', route + '/message', { text: 'Show Node bootstrap information.' })
    const history = await until(async () => {
      const h = await api('GET', route + '/history')
      return !h.session.busy && h.messages.some(row => row.parts?.some(p => p.text === 'bootstrap complete')) && h.messages
    }, 'ordinary tool turn')
    assert.equal(requests.length, 2)
    assert.deepEqual(history.map(row => row.role), ['user', 'model', 'tool', 'model'])
    const response = history[2].parts[0].functionResponse
    assert.equal(response.tool_use_id, 'bootstrap-info')
    assert(!response.response.error, JSON.stringify(response.response))
    const info = source ? response.response : JSON.parse(response.response.output)
    // The Source DTO has a different shape; both expose the same address and instructions.
    const examples = info.commands || info.examples
    assert(examples.bareMetal.includes(expected + '/node/run.sh'))
    assert(examples.bareMetal.includes(`--host='${expected}'`))
    assert(examples.windows.includes(`-HostUrl '${expected}'`))
    assert(info.pairingToken)
    assert(examples.bareMetal.includes(info.pairingToken))
    assert(!JSON.stringify(summaries).includes(info.pairingToken))
    assert(!f.output.includes(token)); assert(!f.output.includes(info.pairingToken))
    results.push({ runtime: source ? 'source' : 'managed', configured, commandHelp: true, directCreation: true,
      browserPrecedence: true, toolRequests: requests.length, canonicalRows: history.length, credentialBoundaries: true })
    ws.close(); await f.stop()
  } finally {
    ws?.close(); await f.cleanup()
    peer.closeAllConnections(); await new Promise(done => peer.close(done))
  }
}
console.log(JSON.stringify(results, null, 2))
