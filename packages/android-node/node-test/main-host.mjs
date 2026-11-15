// The JVM runs the app's actual NodeClient. Only Android device operations are substituted.
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
testEnvironment.initializeTestEnvironment()
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { createHostFixture, until } from '../../webui/test/mainHostFixture.mjs'
import { functionCall } from '../../webui/test/ctlModelCalls.mjs'

const fixture = await createHostFixture('android-node')
const prefix = '/phone-test', host = fixture.origin + prefix
const scripts = new Map(), rounds = new Map(), errors = []
let client, clientOutput = ''
const peer = createServer(async (request, response) => {
  try {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    const prompt = (body.input || []).filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
    const key = [...prompt.matchAll(/ANDROID:(\w+)/g)].at(-1)?.[1]
    const round = rounds.get(key) || 0; rounds.set(key, round + 1)
    const output = round === 0 ? scripts.get(key) : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-' + key }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output, usage: { input_tokens: 30, output_tokens: 5 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.writeHead(500); response.end('Fixture model failed') }
})
const api = (method, path, body) => fixture.api(method, prefix + path, body)
const nodes = async () => (await api('GET', '/api/nodes')).body.nodes
const saved = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
const pair = (state, id) => state.history.flatMap(row => row.parts || []).find(part => part.functionResponse?.tool_use_id === id)?.functionResponse?.response
async function turn(id, key, tools) {
  scripts.set(key, tools)
  assert.equal((await api('POST', '/api/sessions/' + encodeURIComponent(id) + '/message', { text: 'ANDROID:' + key })).status, 202)
  return until(async () => {
    assert.deepEqual(errors, [])
    const state = await saved(id)
    return state.history.some(row => row.parts?.some(part => part.text === 'DONE-' + key)) ? state : null
  }, 'Android tool turn ' + key)
}
try {
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
  await writeFile(join(fixture.data, 'state/config.yaml'), `url: ${host}\nbot: {httpPort: ${fixture.port}, enableTrigger: false}\nvector: {enabled: false}\n`)
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'] } } }))
  await fixture.start()
  const created = await api('POST', '/api/nodes/onboarding/create', { nodeId: 'owned-phone' })
  assert.equal(created.status, 200)
  const pairingFile = join(fixture.root, 'pairing.json'), imageFile = join(fixture.root, 'screen.base64')
  await writeFile(pairingFile, JSON.stringify(created.body.androidPairing), { mode: 0o600 })
  await writeFile(imageFile, (await sharp({ create: { width: 1440, height: 3200, channels: 3, background: '#f9a845' } }).jpeg().toBuffer()).toString('base64'))
  client = spawn(process.env.FOXWARM_ANDROID_GRADLE || resolve('packages/android-node/gradlew'), ['--console=plain', '-p', resolve('packages/android-node'), ':core:runMainPeer'], {
    env: { ...process.env, FOXWARM_ANDROID_PAIRING_FILE: pairingFile, FOXWARM_ANDROID_IMAGE_FILE: imageFile }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  client.stdout.on('data', data => { clientOutput += data }); client.stderr.on('data', data => { clientOutput += data })
  const online = () => until(async () => {
    if (client.exitCode !== null) throw new Error('JVM client exited: ' + clientOutput)
    return (await nodes()).find(node => node.id === 'owned-phone' && node.online && node.executable)
  }, 'production Android JVM client online', 180000)
  const node = await online()
  assert.equal(node.type, 'android-node')
  assert.equal(node.protocolCompatibility.negotiated, 3)
  assert.equal(node.tools.length, 14)
  assert(!node.tools.some(tool => tool.name === 'android_unlock'))
  client.stdin.write('unlock:on\n')
  await until(async () => (await nodes()).some(node => node.id === 'owned-phone' && node.tools.some(tool => tool.name === 'android_unlock')), 'unlock capability added')
  const session = (await api('POST', '/api/sessions', { agentId: 'main', sessionId: 'phone' })).body.sessionId
  const call = (id, tool, args = {}) => functionCall(id, 'call_tool', { toolId: 'node:owned-phone/' + tool, args })
  let state = await turn(session, 'ordinary', [call('app', 'android_current_app'), call('input', 'android_input', { text: 'JVM wire test' }), call('error', 'android_global_action', { action: 'back' })])
  assert.equal(pair(state, 'app').packageName, 'owned.test.app')
  assert.equal(pair(state, 'input').args.text, 'JVM wire test')
  assert.match(JSON.stringify(pair(state, 'error')), /Synthetic device action unavailable/)
  state = await turn(session, 'unlock', [call('unlock', 'android_unlock')])
  assert.equal(pair(state, 'unlock').packageName, 'owned.test.app')
  client.stdin.write('unlock:off\n')
  await until(async () => (await nodes()).some(node => node.id === 'owned-phone' && node.online && node.executable && node.tools.length === 14 && !node.tools.some(tool => tool.name === 'android_unlock')), 'unlock capability removed')
  state = await turn(session, 'image', [call('screen', 'android_screenshot')])
  assert.match(JSON.stringify(pair(state, 'screen')), /1440.*3200/)
  assert(state.history.some(row => row.parts?.some(part => part.inlineData?.mimeType?.startsWith('image/') || part.inlineDataRef)), 'Screenshot reaches image history')
  await fixture.stop(); await fixture.start()
  await online()
  state = await turn(session, 'reconnected', [call('again', 'android_current_app')])
  assert.equal(pair(state, 'again').packageName, 'owned.test.app')
  assert(!(await readFile(join(fixture.data, 'state/nodes.json'), 'utf8')).includes(created.body.authToken))
  assert(!fixture.output.includes(created.body.authToken)); assert(!clientOutput.includes(created.body.authToken))
  const exited = once(client, 'exit'); client.stdin.end('\n'); assert.deepEqual(await exited, [0, null], clientOutput)
  console.log('Android production JVM client: direct QR credential, prefixed endpoint, protocol 3, ordinary result/error, capability-change reconnect, structured screenshot history, cold Main reconnect and secret-free persistence/logs passed. Device operations were synthetic.')
} catch (error) {
  console.error(clientOutput); console.error(fixture.output); throw error
} finally {
  if (client && client.exitCode === null && client.signalCode === null) { client.stdin.end('\n'); const timer = setTimeout(() => client.kill('SIGTERM'), 5000); await once(client, 'exit'); clearTimeout(timer) }
  await fixture.cleanup()
  peer.close(); peer.closeAllConnections()
}
