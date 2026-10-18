// Original Setup QR controls and normal Main/router/provider/tool paths against owned protocol peers.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const options = { normalStartup: true, env: { FOXWARM_BIND_ADDRESS: '127.0.0.1' } }
const host = await createHostFixture('matrix-weixin', options)
options.cwd = host.root
options.publicRoot = host.origin + '/nested/chat/'
const calls = [], models = [], errors = [], matrix = [], weixin = []
let serial = 0, qrPoll = 0
const jpeg = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#2060c0' } }).jpeg().toBuffer()
const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#2060c0' } }).png().toBuffer()
const peer = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks), url = new URL(request.url, 'http://fixture'), key = (request.headers.authorization || '').replace('Bearer ', '')
    const body = bytes.length && request.headers['content-type']?.includes('application/json') ? JSON.parse(bytes) : null
    calls.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key, headers: request.headers, body })
    const json = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (url.pathname === '/responses') {
      models.push(body)
      const input = JSON.stringify(body.input), outputs = body.input.filter(row => row.type === 'function_call_output')
      let output
      if (input.includes('native-delivery') && !outputs.length) output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '**Weixin** intermediate' }] }, { type: 'function_call', call_id: 'native-delivery', name: 'run_script', arguments: JSON.stringify({ code: "return call_tool('builtin:send_to_channel', {'channelTargetId':'matrix-b:!room:fixture','message':'native direct'})" }) }]
      else if (input.includes('missing-context') && !outputs.some(row => row.call_id === 'missing-send')) output = [{ type: 'function_call', call_id: 'missing-send', name: 'send_to_channel', arguments: JSON.stringify({ channelTargetId: 'weixin:owner', message: 'must fail after process restart' }) }]
      else {
        output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: input.includes('missing-context') ? 'missing-context reported' : input.includes('native-delivery') ? '**Weixin** final' : '**Matrix** final' }] }]
        if (input.includes('native-delivery')) output.push({ type: 'image_generation_call', id: 'generated-fixture', status: 'completed', output_format: 'jpeg', result: jpeg.toString('base64') })
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); return response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'response-' + models.length, output } }) + '\n\n')
    }
    if (url.pathname.endsWith('/versions')) return json({ versions: ['v1.11'], unstable_features: {} })
    if (url.pathname.endsWith('/pushrules/')) return json({ global: {} })
    if (url.pathname.endsWith('/capabilities')) return json({ capabilities: {} })
    if (url.pathname.endsWith('/filter')) return json({ filter_id: 'fixture-filter' })
    if (url.pathname.endsWith('/sync')) {
      let timer
      const flush = () => {
        if (response.destroyed) return
        const events = matrix.filter(item => item.key === key); for (const item of events) matrix.splice(matrix.indexOf(item), 1)
        const rooms = {}; for (const event of events) (rooms[event.room] ??= { timeline: { events: [] } }).timeline.events.push(event.event)
        json({ next_batch: 'cursor-' + (++serial), rooms: { join: rooms }, to_device: { events: [] } })
      }
      timer = setTimeout(flush, url.searchParams.has('since') ? 80 : 0); response.on('close', () => clearTimeout(timer)); return
    }
    if (url.pathname.includes('/send/')) return json({ event_id: '$out-' + (++serial) })
    if (url.pathname.includes('/typing/')) return json({})
    if (url.pathname.endsWith('/upload')) return json({ content_uri: 'mxc://fixture/generated' })
    if (url.pathname.endsWith('/getupdates')) {
      const timer = setTimeout(() => { const msgs = weixin.splice(0); if (!response.destroyed) json({ ret: 0, get_updates_buf: 'wx-' + (++serial), msgs }) }, 40)
      response.on('close', () => clearTimeout(timer)); return
    }
    if (url.pathname.endsWith('/sendmessage')) return json({ ret: 0 })
    if (url.pathname.endsWith('/get_bot_qrcode')) return json({ qrcode: 'synthetic-qr', qrcode_img_content: 'data:image/png;base64,' + png.toString('base64') })
    if (url.pathname.endsWith('/get_qrcode_status')) return json(++qrPoll === 1 ? { status: 'scaned' } : { status: 'confirmed', bot_token: 'confirmed-fixture', ilink_user_id: 'owner', baseurl: address })
    response.writeHead(404); response.end('{}')
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const address = `http://127.0.0.1:${peer.address().port}`
const configPath = join(host.data, 'state/config.yaml')
const config = { url: host.origin + '/nested/chat', bot: { httpPort: host.port }, llm: { maxOutput: 713 },
  channels: { webui: {}, 'matrix-a': { type: 'matrix', homeserver: address, accessToken: 'matrix-a', botUserId: '@bot:fixture', allowedUsers: ['@sender:fixture'] }, 'matrix-b': { type: 'matrix', homeserver: address, accessToken: 'matrix-b', botUserId: '@bot-b:fixture', allowedUsers: ['@sender:fixture'] }, weixin: { type: 'weixin', baseUrl: address, routeTag: 'fixture-route', loginBotType: '7', longPollTimeoutMs: 100, allowedUsers: ['retained-user'], custom: 'preserved' } },
  access: { identities: { scoped: { token: 'synthetic-scoped', surfaces: { webui: { sessions: ['chat'] } } } } } }
await writeFile(configPath, JSON.stringify(config))
await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: address, models: ['wire'], contextLimit: 100000, asyncCompact: false } } }))
await mkdir(join(host.work, 'memory'), { recursive: true }); await writeFile(join(host.work, 'memory/ONBOOT.md'), ' \n')
const api = async (method, path, body, token = host.token) => {
  const response = await fetch(host.origin + '/nested/chat' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json() }
}
const sent = key => calls.filter(call => call.key === key && (call.path.includes('/send/') || call.path.endsWith('/sendmessage')))
const text = call => call.body?.body ?? call.body?.msg?.item_list?.[0]?.text_item?.text ?? ''
const pushMatrix = (key, text, sender = '@sender:fixture') => matrix.push({ key, room: '!room:fixture', event: { type: 'm.room.message', event_id: '$in-' + (++serial), sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: text } } })
const pushWeixin = text => weixin.push({ from_user_id: 'owner', context_token: 'owner-context', item_list: [{ type: 1, text_item: { text } }] })
try {
  await host.start()
  for (const token of ['', 'synthetic-scoped']) for (const action of ['start', 'wait']) assert.equal((await api('POST', '/api/setup/weixin/login/' + action, { sessionKey: 'fake' }, token)).status, token ? 403 : 401)
  assert(!calls.some(call => call.path.includes('qrcode')))
  const created = await api('POST', '/api/sessions', { agentId: 'main', sessionId: 'chat' }); assert.equal(created.status, 200)
  const id = created.body.sessionId, route = '/api/sessions/' + encodeURIComponent(id)
  const page = await host.openApp()
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-config'); await page.click('#setup-tab-config')
  await page.waitForSelector('[data-setup-config-last="weixin"]')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Start Weixin login').click())
  await page.waitForSelector('img[alt="Weixin login QR code"]')
  assert((await page.$eval('img[alt="Weixin login QR code"]', image => image.src)).startsWith('data:image/png;base64,'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Check login').click())
  await until(async () => JSON.parse(await readFile(configPath, 'utf8')).channels.weixin.token === 'confirmed-fixture', 'original Setup confirmation')
  const installed = JSON.parse(await readFile(configPath, 'utf8'))
  assert.deepEqual(installed.channels.weixin.allowedUsers, ['retained-user', 'owner']); assert.equal(installed.channels.weixin.custom, 'preserved'); assert.equal(installed.channels.weixin.enabled, true)
  assert.equal(installed.channels['matrix-a'].accessToken, 'matrix-a')
  await until(() => calls.filter(call => call.key === 'matrix-a' && call.path.endsWith('/versions')).length === 2, 'Setup reload all')
  const qr = calls.find(call => call.path.endsWith('/get_bot_qrcode')); assert.equal(qr.query.bot_type, '7'); assert.equal(qr.headers.skRouteTag ?? qr.headers.skroutetag, 'fixture-route'); assert.equal(qr.key, '')
  assert.equal(calls.find(call => call.path.endsWith('/get_qrcode_status')).headers['ilink-app-clientversion'], '1')
  pushMatrix('matrix-a', '/attach ' + id); pushMatrix('matrix-b', '/attach ' + id); pushWeixin('/attach ' + id)
  await until(() => ['matrix-a', 'matrix-b', 'confirmed-fixture'].every(key => sent(key).some(call => text(call).includes('Attached to session'))), 'actual platform attach')
  pushMatrix('matrix-b', '/channel mode send-only')
  await until(() => sent('matrix-b').some(call => text(call).includes('mode set')), 'send-only')
  pushMatrix('matrix-a', 'matrix ingress')
  await until(() => sent('matrix-a').some(call => text(call) === '**Matrix** final') && sent('confirmed-fixture').some(call => text(call) === '**Matrix** final'), 'automatic Matrix/Weixin delivery')
  assert(!sent('matrix-b').some(call => text(call) === '**Matrix** final'))
  const markup = sent('matrix-a').find(call => text(call) === '**Matrix** final'); assert.equal(markup.body.formatted_body, undefined)
  pushWeixin('native-delivery')
  await until(() => sent('matrix-b').some(call => text(call) === 'native direct') && sent('matrix-a').some(call => call.body.msgtype === 'm.image') && sent('confirmed-fixture').some(call => text(call) === '**Weixin** final'), 'provider native tool and generated image')
  assert(!sent('matrix-b').some(call => call.body.msgtype === 'm.image'))
  assert.equal(sent('matrix-a').find(call => text(call) === '**Weixin** intermediate').body.formatted_body, '<strong>Weixin</strong> intermediate')
  assert(calls.some(call => call.path.includes('/typing/') && call.body.typing === true && call.body.timeout === 3000))
  assert(!calls.some(call => call.path.endsWith('/sendtyping')))
  const history = await api('GET', route + '/history')
  assert.equal(history.body.messages.filter(row => row.role === 'model').filter(row => row.parts.some(part => part.text === '**Matrix** final')).length, 1)
  assert(history.body.messages.some(row => row.parts.some(part => part.inlineDataRef)))
  assert(models.some(body => JSON.stringify(body.input).includes('channelInstanceId=') && JSON.stringify(body.input).includes('matrix-a')))
  assert(models.some(body => body.input.some(row => row.type === 'function_call_output')))
  assert.equal((await api('GET', '/api/setup/status')).status, 200)
  await host.stop(); await host.start()
  assert.equal((await api('POST', route + '/message', { text: 'missing-context' })).status, 202)
  await until(async () => { const result = await api('GET', route + '/history'); return result.body.messages.some(row => row.parts.some(part => part.text === 'missing-context reported')) && result.body }, 'fresh Main missing context')
  const after = await api('GET', route + '/history')
  assert(JSON.stringify(after.body.messages).includes('No Weixin context token cached'))
  assert(!sent('confirmed-fixture').some(call => text(call) === 'must fail after process restart'))
  assert.equal(errors.length, 0, errors.join('\n'))
  await host.stop()
  console.log(JSON.stringify({ qualified: 'original Setup QR, authenticated prefixed routes, Matrix/Weixin ingress and automatic output, send-only/direct native delivery, generated image, reload-all and fresh-process context loss', modelRequests: models.length, protocolCalls: calls.length, liveAccounts: false }))
} catch (error) { console.error(host.output); throw error }
finally { await host.cleanup(); peer.closeAllConnections(); await new Promise(done => peer.close(done)) }
