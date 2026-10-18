// Original prefixed WebUI and normal Main with owned model, legacy and AIBot WS peers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import sharp from 'sharp'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const options = { normalStartup: true, env: { FOXWARM_BIND_ADDRESS: '127.0.0.1' } }
const host = await createHostFixture('wework', options)
options.cwd = host.root
options.publicRoot = host.origin + '/nested/chat/'
const frames = [], models = [], errors = [], webhooks = []
let ws, requestIndex = 0, releaseFirst
const firstHeld = new Promise(done => { releaseFirst = done })
const image = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#2060c0' } }).jpeg().toBuffer()
const report = join(host.work, 'report.bin')
await writeFile(report, Buffer.alloc(512 * 1024 + 17, 71))
const peer = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    if (request.url === '/responses') {
      const index = requestIndex++; models.push(body)
      if (index === 0) await firstHeld
      let output
      if (index === 0) output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'intermediate before steering' }] }]
      else if (index === 1) output = [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'working with explicit tools' }] },
        { type: 'function_call', call_id: 'native', name: 'run_script', arguments: JSON.stringify({ code: `call_tool('builtin:send_to_channel', {'channelTargetId':'work:explicit-native','message':'native text'})\nreturn call_tool('builtin:send_file', {'channelTargetId':'work:explicit-native','filePath':${JSON.stringify(report)},'caption':'native file'})` }) },
        { type: 'function_call', call_id: 'direct', name: 'send_to_channel', arguments: JSON.stringify({ channelTargetId: 'work:explicit-direct', message: 'direct text' }) },
        { type: 'function_call', call_id: 'unified', name: 'call_tool', arguments: JSON.stringify({ toolId: 'builtin:send_to_channel', args: { channelTargetId: 'work:explicit-unified', message: 'unified text' } }) }
      ]
      else output = [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'WeWork combined final' }] },
        { type: 'image_generation_call', id: 'generated-fixture', status: 'completed', output_format: 'jpeg', result: image.toString('base64') }
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      return response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'fixture-' + index, output } }) + '\n\n')
    }
    webhooks.push(body); response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"errcode":0}')
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const address = `http://127.0.0.1:${peer.address().port}`
const sockets = new WebSocketServer({ server: peer, path: '/socket' })
sockets.on('connection', socket => {
  ws = socket
  socket.on('message', raw => {
    const frame = JSON.parse(raw.toString()); frames.push(frame)
    socket.send(JSON.stringify({ headers: frame.headers, errcode: 0,
      ...(frame.cmd === 'aibot_upload_media_init' ? { body: { upload_id: 'fixture-upload' } } : frame.cmd === 'aibot_upload_media_finish' ? { body: { media_id: 'fixture-media' } } : {}) }))
  })
})
const channels = { webui: {}, work: { type: 'wework', webhookUrl: address + '/legacy?key=fixture-key', allowedUsers: ['alice'], selfName: '企业机器人', custom: 'retained', channelProgress: { intervalMs: 30000 }, aibot: { stream: true, websocket: { enabled: true, botId: 'fixture-bot', secret: 'fixture-secret', url: address.replace('http:', 'ws:') + '/socket', heartbeatMs: 60000, reconnectMs: 100 } } } }
await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify({ url: host.origin + '/nested/chat', bot: { httpPort: host.port }, channels }))
await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: address, models: ['wire'], contextLimit: 100000, asyncCompact: false } } }))
await mkdir(join(host.work, 'memory'), { recursive: true }); await writeFile(join(host.work, 'memory/ONBOOT.md'), ' \n')
const api = async (method, path, body) => {
  const response = await fetch(host.origin + '/nested/chat' + path, { method, headers: { authorization: 'Bearer ' + host.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json() }
}
const inbound = (id, text) => ws.send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: id }, body: { msgid: id, aibotid: 'fixture-bot', chatid: 'wrk-chat', chattype: 'group', from: { userid: 'alice', name: 'Alice' }, msgtype: 'text', text: { content: text } } }))
const cards = id => frames.filter(frame => frame.cmd === 'aibot_respond_msg' && frame.headers.req_id === id)
try {
  await host.start()
  await until(() => frames.some(frame => frame.cmd === 'aibot_subscribe'), 'managed websocket subscription')
  const created = await api('POST', '/api/sessions', { agentId: 'main', sessionId: 'chat' }); assert.equal(created.status, 200)
  const id = created.body.sessionId, route = '/api/sessions/' + encodeURIComponent(id)
  const page = await host.openApp()
  await page.evaluate(() => { location.hash = 'setup' }); await page.waitForSelector('#setup-tab-config'); await page.click('#setup-tab-config')
  await page.waitForFunction(() => document.querySelector('#setup-panel-config').textContent.includes('work') && document.querySelector('#setup-panel-config').textContent.includes('Running'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Save config').click())
  await until(() => frames.filter(frame => frame.cmd === 'aibot_subscribe').length === 2, 'original Setup managed reload')
  const status = await api('GET', '/api/setup/status')
  assert(status.body.channels.find(channel => channel.channelId === 'work').running)
  assert(!status.body.capabilities.externalChannelMessage.includes('WeWork and QQ are not implemented'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Close')?.click())
  inbound('attach', '@企业机器人 /attach ' + id)
  await until(() => cards('attach').some(frame => frame.body.stream.content.includes('Attached to session')), 'actual callback attach')
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), id)
  inbound('first', 'busy-card-start 你好 🦊')
  await until(() => models.length === 1, 'provider in flight')
  inbound('second', 'late steering')
  await until(() => cards('second').length && cards('first').some(frame => frame.body.stream.finish), 'immediate busy card supersession')
  assert.equal(cards('first').at(-1).body.stream.content, '处理完成。')
  releaseFirst()
  await until(() => cards('second').some(frame => frame.body.stream.finish) && frames.some(frame => frame.cmd === 'aibot_send_msg' && frame.body.msgtype === 'image'), 'final card and generated image')
  const final = cards('second').at(-1).body.stream
  assert(final.finish)
  assert(final.content.includes('intermediate before steering'))
  assert(final.content.includes('working with explicit tools'))
  assert(final.content.includes('☑️ run_script'))
  assert(final.content.includes('☑️ send_to_channel'))
  assert(final.content.includes('☑️ call_tool'))
  assert(final.content.endsWith('WeWork combined final'))
  assert(!final.content.includes('Tools:'))
  assert(models[1].input.some(row => JSON.stringify(row).includes('late steering')))
  assert(models[2].input.some(row => row.type === 'function_call_output'))
  for (const [target, text] of [['explicit-native', 'native text'], ['explicit-direct', 'direct text'], ['explicit-unified', 'unified text']]) assert(frames.some(frame => frame.cmd === 'aibot_send_msg' && frame.body.chatid === target && frame.body.markdown?.content === text))
  const upload = frames.filter(frame => frame.cmd === 'aibot_upload_media_chunk')
  assert.deepEqual(upload.slice(0, 2).map(frame => frame.body.chunk_index), [0, 1])
  assert(frames.some(frame => frame.cmd === 'aibot_send_msg' && frame.body.chatid === 'explicit-native' && frame.body.file?.media_id === 'fixture-media'))
  const history = await api('GET', route + '/history')
  assert.equal(history.body.messages.filter(row => row.parts.some(part => part.text === 'WeWork combined final')).length, 1)
  assert(!JSON.stringify(history.body).includes('fw_'))
  await page.waitForFunction(() => document.body.textContent.includes('WeWork combined final'))
  assert.equal(webhooks.length, 0)
  assert.equal(errors.length, 0, errors.join('\n'))
  await host.stop()
  console.log(JSON.stringify({ qualified: 'original Setup reload/status, normal Main callback attach, busy latest-card provider continuation, native structured progress, direct/unified/native text and multi-chunk file tools, generated image and browser canonical final', modelRequests: models.length, frames: frames.length, liveAccounts: false }))
} catch (error) { console.error(host.output); throw error }
finally {
  releaseFirst(); await host.cleanup()
  for (const socket of sockets.clients) socket.terminate()
  await new Promise(done => sockets.close(done)); peer.closeAllConnections(); await new Promise(done => peer.close(done))
}
