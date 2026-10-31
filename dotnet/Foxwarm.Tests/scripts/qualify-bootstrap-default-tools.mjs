#!/usr/bin/env node
// Owned normal Main, browser-shaped onboarding requests and a real ordinary model request.
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHostFixture, until } from '../../../packages/webui/test/mainHostFixture.mjs'

const source = process.argv.includes('--source')
const hidden = ['set_session_child_model', 'set_session_compact_threshold', 'refresh_session_snapshot', 'compact_session', 'create_agent', 'create_session', 'set_agent_inherit']
const results = { runtime: source ? 'source' : 'managed', checks: [], ordinaryRequestTools: [] }
const failures = []
async function check(name, action) {
  try { await action(); results.checks.push({ name, passed: true }) }
  catch (error) { results.checks.push({ name, passed: false, error: error.message }) }
}
function text(origin, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { headers }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk }); response.on('end', () => { try { assert.equal(response.statusCode, 200); resolve(body) } catch (error) { reject(error) } })
    }); req.on('error', reject); req.end()
  })
}
const peer = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); results.ordinaryRequestTools = body.tools.map(tool => tool.name)
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ordinary request completed' }] }]
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output } }) + '\n\n')
  } catch (error) { failures.push(error.stack); res.writeHead(500); res.end('fixture failure') }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
try {
  for (const configured of [false, true]) {
    const env = {}
    const f = await createHostFixture('bootstrap-default-tools', { runtime: source ? 'source' : undefined, env })
    env.FOXWARM_AGENTS_DIR = join(f.root, 'agents')
    const prefix = configured && !source ? '/mount' : ''
    const post = async (path, body, expected = 200) => { const value = await f.api('POST', prefix + path, body); assert.equal(value.status, expected, JSON.stringify(value)); return value.body }
    try {
      await writeFile(join(f.data, 'state/config.yaml'), `bot:\n  httpPort: ${f.port}\n` + (configured ? 'url: https://configured.example/mount\n' : ''))
      await writeFile(f.modelPath, JSON.stringify({ default: 'fixture', providers: { fixture: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['fixture-wire'] } } }))
      await f.start()
      await check((configured ? 'configured' : 'browser fallback') + ' command precedence, deployment prefix and shell creation', async () => {
        const body = { fallbackUrl: 'https://browser.example/browser/' }
        const commands = await post('/api/nodes/onboarding/commands', body)
        const expected = configured ? 'https://configured.example/mount' : 'https://browser.example/browser'
        assert.equal(commands.baseUrl, expected)
        assert(commands.commands.bareMetal.includes(expected + '/node/run.sh'))
        const override = await post('/api/nodes/onboarding/commands', { ...body, baseUrl: ' https://override.example/explicit/ ', installDir: "/opt/node's dir" })
        assert.equal(override.baseUrl, 'https://override.example/explicit'); assert(override.commands.bareMetal.includes("'\"'\"'"))
        const shell = await post('/api/nodes/onboarding/create-shell', { ...body, nodeId: 'owned-shell' })
        assert(shell.command.includes(expected + '/node/run-shell.sh'))
        for (const bad of [null, '', 42, 'https://user:pass@example.test', 'https://example.test/?', 'https://example.test/#', 'https://example.test/\\bad', 'https://example.test/x\ny']) await post('/api/nodes/onboarding/commands', { ...body, baseUrl: bad }, 400)
        if (!configured) await post('/api/nodes/onboarding/commands', {}, 400)
      })
      await check((configured ? 'configured' : 'unconfigured') + ' public templates retain request-derived defaults', async () => {
        for (const name of ['run-shell.sh', 'run.sh', 'run-docker.sh', 'run-interactive.sh', 'run-cli-node.sh', 'run.ps1', 'docker-compose.yaml']) {
          const template = await readFile(join('templates/node', name === 'run-cli-node.sh' ? 'run-interactive.sh' : name), 'utf8')
          const rendered = await text(f.origin, prefix + '/node/' + name, { host: 'internal.example:3001', 'x-forwarded-host': 'edge.example:8443, ignored.example', 'x-forwarded-proto': 'HTTPS, http' })
          assert.equal(rendered, template.replaceAll('__FOXWARM_DEFAULT_BASE_URL__', 'https://edge.example:8443').replaceAll('__FOXWARM_NATIVE_CLI_URL__', 'https://foxwarm.net/downloads/native-cli-node-latest-v3.tar.gz'), name)
        }
        const template = await readFile('templates/node/run.sh', 'utf8')
        for (const [headers, expected] of [
          [{ host: 'direct.example:8800' }, 'http://direct.example:8800'],
          [{ host: '[::1]:8800', 'x-forwarded-proto': 'bogus' }, 'http://[::1]:8800'],
          [{ host: 'direct.example', 'x-forwarded-host': 'bad/host' }, ''],
          [{ host: 'direct.example', 'x-forwarded-host': ' , ignored.example', 'x-forwarded-proto': 'javascript' }, 'http://direct.example'],
        ]) assert.equal(await text(f.origin, prefix + '/node/run.sh', headers), template.replaceAll('__FOXWARM_DEFAULT_BASE_URL__', expected).replaceAll('__FOXWARM_NATIVE_CLI_URL__', 'https://foxwarm.net/downloads/native-cli-node-latest-v3.tar.gz'))
      })
      if (!configured) await check('ordinary real provider request omits default-hidden management definitions', async () => {
        const created = await post('/api/sessions', { agentId: 'main', sessionId: 'ordinary-tools' })
        await post('/api/sessions/' + encodeURIComponent(created.sessionId) + '/message', { text: 'Capture ordinary default tool definitions.' }, source ? 200 : 202)
        await until(() => results.ordinaryRequestTools.length, 'ordinary provider request')
        assert.deepEqual(hidden.filter(name => results.ordinaryRequestTools.includes(name)), [])
        assert(results.ordinaryRequestTools.includes('read')); assert(results.ordinaryRequestTools.includes('search_tools'))
      })
      await f.stop()
    } finally { await f.cleanup() }
  }
  assert.deepEqual(failures, [])
} finally { peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
console.log(JSON.stringify(results, null, 2))
if (results.checks.some(row => !row.passed)) process.exitCode = 1
