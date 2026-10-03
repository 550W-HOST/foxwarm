// Real original-composer images, official SDK content and all current Main protocols.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, mkdir, symlink, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { WebSocketServer } from 'ws'
import { createHostFixture, until, sleep } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
const options = { env: {} }, fixture = await createHostFixture('input-images', options), records = [], failures = [], sockets = [], frames = [], counts = new Map()
const home = join(fixture.root, 'home'); await mkdir(home); options.env.HOME = home; options.cwd = fixture.root
const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 200, g: 20, b: 90, alpha: 1 } } }).png().toBuffer(), imagePath = join(fixture.work, 'pixel.png')
await writeFile(imagePath, png); await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory/ONBOOT.md'), ' \n')
await writeFile(join(fixture.data, 'state/mcp.json'), JSON.stringify({ servers: { image: { transport: 'stdio', command: process.execPath, args: [resolve(import.meta.dirname, 'experimentHostImages.peer.mjs'), fixture.root, imagePath], timeoutSeconds: 20, enable: true } } }))
const route = id => '/api/sessions/' + encodeURIComponent(id), authority = id => readFile(join(fixture.data, 'state/sessions', id + '.json'), 'utf8').then(JSON.parse)
let releaseHold; const held = new Promise(resolve => { releaseHold = resolve })
const calls = key => [{ id: key + '-read', name: 'read', args: { filePath: imagePath } }, { id: key + '-sdk', name: 'call_tool', args: { toolId: 'mcp:image/image', args: { corrupt: key === 'corrupt', carrier: key === 'carrier' } } }]
const responseCalls = key => calls(key).map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }))
const final = key => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'DONE-IMAGES-' + key }] }]
const textOf = body => JSON.stringify(body)
function decide(body, full = body.input || body.messages) {
  const key = [...textOf(full).matchAll(/IMAGES:([a-z-]+)/g)].at(-1)?.[1]; assert(key, 'Owned image task'); const n = (counts.get(key) || 0) + 1; counts.set(key, n); return { key, tools: n === 1 && !key.includes('next') }
}
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), plan = decide(body), protocol = request.url.includes('/c/') ? 'completions' : request.url.includes('/a/') ? 'anthropic' : 'responses'
    records.push({ protocol, body, key: plan.key });
    if (plan.key === 'retry-next' && counts.get(plan.key) === 1) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Synthetic retry image failure' })); return }
    if (plan.key === 'hold-next') await held;
    if (protocol === 'anthropic') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'anthropic-image', type: 'message', role: 'assistant', model: 'wire', content: plan.tools ? calls(plan.key).map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })) : [{ type: 'text', text: 'DONE-IMAGES-' + plan.key }], stop_reason: plan.tools ? 'tool_use' : 'end_turn', usage: { input_tokens: 70, output_tokens: 3 } })); return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (protocol === 'responses') response.write('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'http-image-' + records.length, status: 'completed', output: plan.tools ? responseCalls(plan.key) : final(plan.key), usage: { input_tokens: 70, output_tokens: 3 } } }) + '\n\n')
    else response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: plan.tools ? { role: 'assistant', tool_calls: calls(plan.key).map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { role: 'assistant', content: 'DONE-IMAGES-' + plan.key }, finish_reason: plan.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 70, completion_tokens: 3, total_tokens: 73 } }) + '\n\ndata: [DONE]\n\n')
    response.end()
  } catch (error) { failures.push(error.stack); response.destroy() }
})
const wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 0 } })
peer.on('upgrade', (request, socket, head) => wsServer.handleUpgrade(request, socket, head, ws => wsServer.emit('connection', ws)))
wsServer.on('connection', ws => {
  sockets.push(ws); const states = new Map()
  ws.on('message', raw => {
    try {
      const body = JSON.parse(raw), full = [...(body.previous_response_id ? states.get(body.previous_response_id) : []), ...body.input], plan = decide(body, full)
      records.push({ protocol: 'ws', body, full, key: plan.key }); const output = plan.tools ? responseCalls(plan.key) : final(plan.key), id = 'ws-image-' + records.length
      states.set(id, [...full, ...output]); ws.send(JSON.stringify({ type: 'response.completed', response: { id, status: 'completed', output, usage: { input_tokens: 70, output_tokens: 3 } } }))
    } catch (error) { failures.push(error.stack); ws.terminate() }
  })
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening'); const base = 'http://127.0.0.1:' + peer.address().port
await writeModelFixture(fixture.data, { default: 'r', providers: { r: { providerType: 'openai-responses', baseUrl: base + '/r', models: ['wire'], contextLimit: 20000 }, c: { providerType: 'openai-completions', baseUrl: base + '/c', models: ['wire'], contextLimit: 20000 }, a: { providerType: 'anthropic', baseUrl: base + '/a', models: ['wire'], contextLimit: 20000 }, w: { providerType: 'openai-ws', baseUrl: base + '/w', models: ['wire'], contextLimit: 20000 } } })
const headers = { authorization: 'Bearer synthetic-input-images-api' }
async function upload(bytes, name = 'uploaded.png', mime = 'image/png') { const form = new FormData(); form.append('file', new Blob([bytes], { type: mime }), name); const response = await fetch(fixture.origin + '/api/upload', { method: 'POST', headers, body: form }); return { status: response.status, body: await response.json() } }
async function done(id, key) { await until(async () => { const state = await authority(id); return !state.busy && state.history.some(row => row.parts?.some(part => part.text === 'DONE-IMAGES-' + key)) }, key) }
function imageRefs(state) { return state.history.flatMap(row => row.parts || []).filter(part => part.inlineDataRef) }
try {
  await fixture.start(); const page = await fixture.openApp(); page.on('framenavigated', () => {}); page.on('response', async response => { if (response.url().endsWith('/api/upload')) frames.push({ upload: await response.json() }) })
  const devtools = await page.createCDPSession(); await devtools.send('Network.enable'); devtools.on('Network.webSocketFrameReceived', frame => frames.push({ realtime: frame.response.payloadData }))
  await page.type('[role="textbox"][aria-label="Message"]', 'IMAGES:responses ')
  await page.$eval('#file-upload', (input, data) => { const transfer = new DataTransfer(); transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'original.png', { type: 'image/png' })); Object.defineProperty(input, 'files', { configurable: true, value: transfer.files }); input.dispatchEvent(new Event('change', { bubbles: true })) }, png.toString('base64'))
  await page.waitForSelector('.foxwarm-composer-attachment-chip'); await page.click('button[aria-label="Send message"]'); await done('main', 'responses')
  await page.waitForSelector('.foxwarm-image-item img'); assert.equal(await page.$eval('.foxwarm-image-item img', image => image.naturalWidth), 3)
  const initial = await authority('main'), ref = imageRefs(initial)[0].inlineDataRef; assert(ref.blobId); assert(!JSON.stringify(initial).includes(png.toString('base64')))
  const blobUrl = fixture.origin + '/api/blobs/' + ref.blobId, blob = await fetch(blobUrl, { headers }); assert.equal(blob.status, 200); assert.equal(blob.headers.get('content-type'), 'image/png'); assert.equal(blob.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await blob.arrayBuffer()), png)
  assert.equal((await fetch(blobUrl)).status, 401); assert.equal((await fetch(blobUrl, { headers: { ...headers, 'if-none-match': blob.headers.get('etag') } })).status, 304)
  assert.equal((await fetch(fixture.origin + '/api/blobs/not-a-blob', { headers })).status, 400)
  assert.equal((await upload('not generic', 'document.txt', 'text/plain')).status, 400); assert.equal((await upload('not generic', 'document.txt', '')).status, 400)
  assert.equal((await fixture.api('POST', route('main') + '/message', { text: 'not sent', uploadedFiles: [{ path: imagePath, filename: 'host.png', mimeType: 'image/png' }] })).status, 400)
  const staged = await upload(png); assert.equal(staged.status, 200); const outside = join(fixture.root, 'outside.png'); await writeFile(outside, png); const alias = join(fixture.data, 'state/webui-uploads/escape.png'); await symlink(outside, alias)
  assert.equal((await fixture.api('POST', route('main') + '/message', { text: 'not sent', uploadedFiles: [{ path: alias, mimeType: 'image/png' }] })).status, 400)
  for (const [provider, key] of [['c', 'completions'], ['a', 'anthropic'], ['w', 'websocket']]) {
    const id = 'image-' + key; assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200); assert.equal((await fixture.api('POST', route(id) + '/model', { model: provider })).status, 200)
    const item = key === 'completions' ? staged : await upload(png); assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'IMAGES:' + key, uploadedFiles: [item.body] })).status, 202); await done(id, key)
    assert.equal((await fixture.api('POST', route(id) + '/message', { text: 'IMAGES:' + key + '-next' })).status, 202); await done(id, key + '-next')
    assert(!JSON.stringify(await authority(id)).includes(png.toString('base64')))
  }
  const heic = await readFile(resolve('src/testFixtures/synthetic-alpha-3x2.heic')), heicUpload = await upload(heic, 'input.heic', ''); assert.equal(heicUpload.status, 200)
  assert.equal((await fixture.api('POST', route('main') + '/message', { text: 'IMAGES:heic-next', uploadedFiles: [heicUpload.body] })).status, 202); await done('main', 'heic-next')
  const heicRef = imageRefs(await authority('main')).at(-1).inlineDataRef, heicBlob = await fetch(fixture.origin + '/api/blobs/' + heicRef.blobId, { headers }); assert.equal(heicBlob.headers.get('content-type'), 'application/octet-stream'); assert(heicBlob.headers.get('content-disposition').includes('attachment')); assert.deepEqual(Buffer.from(await heicBlob.arrayBuffer()), heic)
  assert.equal((await fixture.api('POST', route('main') + '/message', { text: 'IMAGES:corrupt' })).status, 202); await done('main', 'corrupt')
  const corruptRow = (await authority('main')).history.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'corrupt-sdk')); assert(corruptRow.parts.some(part => part.functionResponse?.response?.error?.type === 'image_materialization_failed')); assert(!JSON.stringify(corruptRow).includes(Buffer.from('not a PNG raster').toString('base64')))
  assert.equal((await fixture.api('POST', route('main') + '/message', { text: 'IMAGES:carrier' })).status, 202); await done('main', 'carrier')
  const carrierRow = (await authority('main')).history.find(row => row.parts?.some(part => part.functionResponse?.tool_use_id === 'carrier-sdk')); assert.equal(carrierRow.parts.filter(part => part.toolUseId === 'carrier-sdk' && part.inlineDataRef).length, 1); assert(!JSON.stringify(carrierRow).includes(png.toString('base64'))); assert(!carrierRow.parts.some(part => part.functionResponse?.response?.outputTruncated))
  for (const id of ['image-retry', 'image-queue']) assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: id })).status, 200)
  const retryImage = await upload(png); assert.equal((await fixture.api('POST', route('image-retry') + '/message', { text: 'IMAGES:retry-next', uploadedFiles: [retryImage.body] })).status, 202); await done('image-retry', 'retry-next')
  const attempts = records.filter(record => record.key === 'retry-next'); assert.equal(attempts.length, 2); for (const attempt of attempts) assert.equal(JSON.stringify(attempt.body).split(png.toString('base64')).length - 1, 1)
  assert.equal((await fixture.api('POST', route('image-queue') + '/message', { text: 'IMAGES:hold-next' })).status, 202); await until(() => records.some(record => record.key === 'hold-next'), 'held actual request')
  const queueImage = await upload(png); assert.equal((await fixture.api('POST', route('image-queue') + '/message', { text: 'IMAGES:queue-next', uploadedFiles: [queueImage.body] })).status, 202)
  const queued = await authority('image-queue'); assert(queued.busy); assert(queued.queue.some(item => item.parts?.some(part => part.inlineDataRef))); assert(!JSON.stringify(queued.queue).includes(png.toString('base64')))
  assert.equal((await fixture.api('POST', route('image-queue') + '/stop', {})).status, 200); releaseHold(); await until(async () => !(await authority('image-queue')).busy, 'Stop image queue')
  assert.equal((await fixture.api('POST', route('image-queue') + '/message', { text: '/continue' })).status, 200); await done('image-queue', 'queue-next'); assert(!JSON.stringify(await authority('image-queue')).includes(png.toString('base64')))
  for (const record of records) { assert(!JSON.stringify(record.body).includes('inlineDataRef')); assert(!JSON.stringify(record.body).includes('__providerImage')); assert(!JSON.stringify(record.body).includes('resolvedPaths')); }
  assert(records.some(record => record.protocol === 'ws' && record.body.previous_response_id && !JSON.stringify(record.body.input).includes('data:image/png')))
  assert(records.some(record => record.protocol === 'completions' && record.body.messages.some(item => item.role === 'user' && Array.isArray(item.content) && item.content.some(part => part.type === 'image_url'))))
  assert(records.some(record => record.protocol === 'anthropic' && record.body.messages.some(item => JSON.stringify(item.content).includes('"type":"image"'))))
  const history = await fixture.api('GET', route('main') + '/history'); assert(!JSON.stringify(history.body).includes(png.toString('base64'))); assert(!frames.some(frame => frame.realtime?.includes(png.toString('base64'))))
  const first = initial.history.find(row => row.parts?.some(part => part.inlineDataRef)); const archive = await fixture.api('GET', route('main') + '/archive/messages/' + first.__meta.seq); assert.equal(archive.status, 200); assert(!JSON.stringify(archive.body).includes(png.toString('base64'))); assert(archive.body.messageJson.includes('/blobs/'))
  const count = records.length; await fixture.stop(); await fixture.start(); await sleep(150); assert.equal(records.length, count); assert.deepEqual(Buffer.from(await (await fetch(blobUrl, { headers })).arrayBuffer()), png); await fixture.stop(); assert.deepEqual(failures, [])
  console.log(JSON.stringify({ root: fixture.root, home, hosts: fixture.hostPids, requests: records.length, originalComposer: true, nativeRead: true, officialSdkImages: true, protocols: [...new Set(records.map(record => record.protocol))], authenticatedBlob: true, stagingGuard: true, heic: true, referenceOnly: true, wsPrefix: true }))
} finally { releaseHold(); await writeFile(join(fixture.root, 'image-proof.json'), JSON.stringify({ records, frames, failures, home, hosts: fixture.hostPids }, null, 2)).catch(() => {}); await fixture.cleanup(); for (const ws of sockets) ws.terminate(); wsServer.close(); await new Promise(done => peer.close(done)) }
