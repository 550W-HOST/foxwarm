// Real generic App capture/PCM transport against an owned scripted service;
// scripted transcripts are protocol evidence, not model inference qualification.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import express from 'express'
import multer from 'multer'
import { WebSocketServer } from 'ws'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'

const statusResponses = []
const options = { env: {} }, owned = await createHostFixture('asr', options)
const key = 'synthetic-service-key-not-browser-transport', failures = [], browserErrors = [], modelRequests = [], recordings = [], asrRequests = []
let mode = 'normal', healthy = true, streamingSupported = true, healthRequests = 0, postRequests = 0, upgrades = 0, page
await mkdir(join(owned.root, 'home')); await mkdir(join(owned.root, 'spool'))
await mkdir(join(owned.work, 'memory')); await writeFile(join(owned.work, 'memory/ONBOOT.md'), ' \n')
const wav = Buffer.alloc(44 + 16000 * 2)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
for (let sample = 0; sample < 16000; sample++) wav.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 440 / 16000) * 9000), 44 + sample * 2)
const audioPath = join(owned.root, 'capture.wav'); await writeFile(audioPath, wav)
const serviceApp = express(), upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })
serviceApp.use((request, response, next) => { assert.equal(request.headers.authorization, 'Bearer ' + key); assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.origin, undefined); next() })
serviceApp.get('/health', (request, response) => { healthRequests++; response.json({ ok: healthy, streamingSupported, credential: key, privatePath: '/service-private-path' }) })
serviceApp.post('/transcribe', upload.single('audio'), (request, response) => {
  postRequests++; const audio = request.file.buffer
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF'); assert.equal(audio.readUInt16LE(22), 1); assert.equal(audio.readUInt32LE(24), 16000); assert.equal(audio.readUInt16LE(34), 16); assert(audio.readUInt32LE(40) > 0)
  response.json({ text: 'decoded-scripted-final', privatePath: '/service-private-path', credential: key })
})
const service = createServer(serviceApp), sockets = new WebSocketServer({ noServer: true })
service.on('upgrade', (request, socket, head) => {
  assert.equal(request.url, '/ws/stream'); assert.equal(request.headers.authorization, 'Bearer ' + key); assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.origin, undefined)
  sockets.handleUpgrade(request, socket, head, peer => sockets.emit('connection', peer))
})
sockets.on('connection', socket => {
  const record = { mode, bytes: 0, nonzero: 0, started: false, ready: false, partial: false, closed: false, context: '' }; recordings.push(record)
  const send = value => socket.send(JSON.stringify(value))
  socket.on('close', () => { record.closed = true }); socket.on('error', () => {})
  socket.on('message', (bytes, binary) => {
    try {
      if (binary) {
        assert(record.ready); assert.equal(bytes.length % 2, 0); record.bytes += bytes.length
        for (let offset = 0; offset < bytes.length; offset += 2) if (bytes.readInt16LE(offset) !== 0) record.nonzero++
        if (!record.partial) {
          record.partial = true
          if (record.mode === 'normal') { send({ type: 'partial', text: 'long dictated thought' }); send({ type: 'partial', text: 'short' }); send({ type: 'partial', text: 'short' }) }
          else send({ type: 'partial', text: ' retained' })
          if (record.mode === 'error') send({ type: 'error', error: key + '/service-private-path' })
          if (record.mode === 'abrupt') socket.terminate()
        }
        return
      }
      const input = JSON.parse(bytes.toString())
      if (input.type === 'start') {
        record.started = true; record.context = input.context || ''; assert(!Object.hasOwn(input, 'key')); assert(record.context.length <= 2400)
        if (record.mode === 'pending') return
        record.ready = true; send({ type: 'ready', credential: key })
      }
      if (input.type === 'stop') { setTimeout(() => { if (socket.readyState === 1) send({ type: 'final', text: record.mode === 'empty' ? '' : 'spoken final', privatePath: '/service-private-path', credential: key }) }, 100) }
    } catch (error) { failures.push(error.stack); socket.terminate() }
  })
})
service.listen(0, '127.0.0.1'); await once(service, 'listening')
const serviceUrl = 'http://127.0.0.1:' + service.address().port
const model = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk
  modelRequests.push(JSON.parse(raw)); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'voice-' + modelRequests.length, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SPEECH-MESSAGE-DONE' }] }], usage: { input_tokens: 10, output_tokens: 3 } } }) + '\n\n')
})
model.listen(0, '127.0.0.1'); await once(model, 'listening')
await writeModelFixture(owned.data, { default: 'a', providers: { a: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:' + model.address().port, models: ['wire'], contextLimit: 20000 } } })
const cert = join(owned.root, 'proxy.crt'), certKey = join(owned.root, 'proxy.key')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', certKey, '-out', cert], { stdio: 'ignore' })
const prefix = '/published/main/'
const proxy = createTlsServer({ key: await readFile(certKey), cert: await readFile(cert) }, (request, response) => {
  if (!request.url.startsWith(prefix)) { response.writeHead(404); response.end(); return }
  const upstream = httpRequest(owned.origin + '/' + request.url.slice(prefix.length), { method: request.method, headers: { ...request.headers, host: new URL(owned.origin).host } }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
  upstream.on('error', error => response.destroy(error)); request.pipe(upstream)
})
proxy.on('upgrade', (request, socket, head) => {
  if (!request.url.startsWith(prefix)) { socket.destroy(); return }
  upgrades++; const upstream = httpRequest(owned.origin + '/' + request.url.slice(prefix.length), { headers: { ...request.headers, host: new URL(owned.origin).host } })
  upstream.on('upgrade', (response, peer, initial) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n')
    if (head.length) peer.write(head); if (initial.length) socket.write(initial); socket.pipe(peer); peer.pipe(socket)
    socket.on('error', () => peer.destroy()); peer.on('error', () => socket.destroy()); socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy())
  }); upstream.on('response', response => socket.end('HTTP/1.1 ' + response.statusCode + ' Rejected\r\nContent-Length: 0\r\n\r\n')); upstream.on('error', () => socket.destroy()); upstream.end()
})
proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
options.publicRoot = 'https://127.0.0.1:' + proxy.address().port + prefix; options.normalStartup = true; options.cwd = owned.root
options.env = { HOME: join(owned.root, 'home'), ASPNETCORE_TEMP: join(owned.root, 'spool'), FOXWARM_CONFIG_PATH: join(owned.data, 'state/config.yaml'), FOXWARM_PUBLIC_BASE_URL: options.publicRoot }
options.chromeArgs = ['--ignore-certificate-errors', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + audioPath]
await writeFile(join(owned.data, 'state/token'), owned.token, { mode: 0o600 })
const appConfig = enabled => 'bot:\n  httpPort: ' + owned.port + '\nllm:\n  maxOutput: 713\nasrService:\n  enabled: ' + enabled + '\n  url: ' + serviceUrl + '\n  key: ' + key + '\n'
await writeFile(options.env.FOXWARM_CONFIG_PATH, appConfig(true))
options.onPage = current => {
  page = current; current.on('pageerror', error => browserErrors.push(error.message))
  current.on('response', async response => { if (new URL(response.url()).pathname.endsWith('/api/asr/status')) statusResponses.push(await response.json()) })
  current.on('request', request => { if (request.url().includes('/api/asr/')) asrRequests.push(request.url()) })
  void current.evaluateOnNewDocument(() => {
    window.voiceStreams = []; window.voiceSockets = []
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async options => { const stream = await get(options); window.voiceStreams.push(stream); return stream }
    const Native = window.WebSocket
    window.WebSocket = class extends Native { constructor(...args) { super(...args); if (String(args[0]).includes('/api/asr/stream')) window.voiceSockets.push(this) } }
  })
}
const editor = '[role="textbox"][aria-label="Message"]', start = 'button[aria-label="Start recording"]', stop = 'button[aria-label="Stop recording and transcribe"]'
const text = () => page.$eval(editor, element => element.textContent)
const idle = () => page.waitForFunction(() => document.querySelector('[role="textbox"][aria-label="Message"]')?.contentEditable === 'true' && !!document.querySelector('button[aria-label="Start recording"]'))
const ended = () => page.waitForFunction(() => window.voiceStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))
async function begin(next) { mode = next; const index = recordings.length; await page.click(start); await until(() => recordings[index]?.started, 'real upstream start'); return recordings[index] }
try {
  await owned.start(); page = await owned.openApp(); await page.waitForSelector(start)
  // Stable actual decoded final POST is qualified before this fixture's WS use.
  const post = await page.evaluate(async bytes => { const form = new FormData(); form.append('audio', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'synthetic.wav'); const response = await fetch('api/asr/transcribe', { method: 'POST', body: form }); return { status: response.status, body: await response.json() } }, Array.from(wav))
  assert.equal(post.status, 200); assert.equal(post.body.text, 'decoded-scripted-final'); assert(!JSON.stringify(post.body).includes(key)); assert.equal(postRequests, 1)
  await page.type(editor, 'before after'); await page.evaluate(() => { const editor = document.querySelector('[role="textbox"][aria-label="Message"]'), node = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT).nextNode(), range = document.createRange(); range.setStart(node, 7); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); editor.focus() })
  const normal = await begin('normal'); await until(async () => await text() === 'before shortafter', 'short/repeated actual partial'); assert(normal.nonzero > 0); assert(normal.bytes > 0); assert(normal.context.includes('before after'))
  assert.equal(await page.$eval(editor, element => element.contentEditable), 'false'); assert(await page.$('button[aria-label="Send message"]:disabled'))
  await page.click(stop); await idle(); assert.equal(await text(), 'before spoken finalafter'); await ended()
  await page.focus(editor); await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); assert.equal(await text(), 'before after'); await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control'); assert.equal(await text(), 'before spoken finalafter')
  await page.click('button[aria-label="Send message"]'); await until(() => modelRequests.length === 1, 'ordinary send provider'); await page.waitForFunction(() => document.body.innerText.includes('SPEECH-MESSAGE-DONE'))
  assert(modelRequests[0].input.some(row => row.role === 'user' && row.content?.some(part => part.text === 'before spoken finalafter')))
  for (const next of ['empty', 'error', 'abrupt']) {
    await page.type(editor, next); const record = await begin(next); await until(() => record.partial, 'actual partial before terminal')
    if (next === 'empty') await page.click(stop)
    await idle(); await ended(); assert.equal(await text(), next + ' retained')
    if (next !== 'empty') { const alert = await page.$eval('[role="alert"]', element => element.textContent); assert(!alert.includes(key)); assert(!alert.includes('/service-private-path')) }
    await page.focus(editor); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace')
  }
  const pending = await begin('pending'); await page.click(stop); await idle(); await ended(); await until(() => pending.closed, 'pre-ready stop closes actual upstream'); assert.equal(pending.bytes, 0)
  const switched = await begin('pending'); const child = await owned.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'voice-next' }); assert.equal(child.status, 200)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), child.body.sessionId); await idle(); await ended(); await until(() => switched.closed, 'Session switch closes pre-ready upstream'); assert.equal(switched.bytes, 0); assert.equal(await text(), '')
  const pressure = await begin('normal')
  await page.evaluate(() => Object.defineProperty(window.voiceSockets.at(-1), 'bufferedAmount', { get: () => 2 * 1024 * 1024 + 1 }))
  await idle(); await ended(); assert((await page.$eval('[role="alert"]', element => element.textContent)).trim().length > 0); await until(() => pressure.closed, 'buffer-pressure abort'); assert.equal(pressure.bytes, 0)
  assert.equal(healthRequests, 1, 'one page-lifetime status Promise across recordings/Sessions')
  streamingSupported = false; await page.reload({ waitUntil: 'networkidle0' }); assert.equal(await page.$(start), null); assert.equal(statusResponses.at(-1).available, true); assert.equal(statusResponses.at(-1).streamingSupported, false)
  healthy = false; await page.reload({ waitUntil: 'networkidle0' }); assert.equal(await page.$(start), null); assert.equal(healthRequests, 3)
  await writeFile(options.env.FOXWARM_CONFIG_PATH, appConfig(false)); await owned.stop(); const count = healthRequests; await owned.start(); await page.reload({ waitUntil: 'networkidle0' }); assert.equal(await page.$(start), null); assert.equal(healthRequests, count, 'disabled captured ASR does not probe')
  assert(asrRequests.every(url => url.startsWith(options.publicRoot) && !url.includes(key))); assert.deepEqual(failures, []); assert.deepEqual(browserErrors, []); await owned.stop(); assert.deepEqual(await readdir(join(owned.root, 'spool')), [])
  console.log(JSON.stringify({ status: 'passed', decodedFinalPosts: postRequests, pcmBytes: recordings.reduce((sum, record) => sum + record.bytes, 0), nonzeroSamples: recordings.reduce((sum, record) => sum + record.nonzero, 0), recordings: recordings.length, healthRequests, modelRequests: modelRequests.length, upgrades, browserErrors, inferenceQualified: false }))
} catch (error) { console.error(owned.output); console.error(JSON.stringify({ recordings, failures, browserErrors })); throw error }
finally { await owned.cleanup(); for (const socket of sockets.clients) socket.terminate(); sockets.close(); for (const server of [proxy, service, model]) { server.closeAllConnections?.(); await new Promise(done => server.close(done)) } }
