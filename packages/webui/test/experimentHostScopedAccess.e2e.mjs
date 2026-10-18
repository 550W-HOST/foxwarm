// Normal .NET Main, original restricted App, live configuration, and held transport/effect boundaries.
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir, rm, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import WebSocket from 'ws'
import sharp from 'sharp'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const options = { normalStartup: true, env: {} }, host = await createHostFixture('scoped-access', options)
options.cwd = host.root
options.publicRoot = host.origin + '/nested/app/'
const route = id => '/api/sessions/' + encodeURIComponent(id)
const segment = id => 'id_' + Buffer.from(id).toString('base64url')
const requests = [], errors = [], sockets = [], streams = [], browserErrors = [], scopedRequests = []
let releaseAdmitted, enteredAdmitted, browser, aliceToken = 'synthetic-alice-1'
let candidatePath = join(host.work, 'candidate.yaml')
const admitted = new Promise(done => { enteredAdmitted = done })
const release = new Promise(done => { releaseAdmitted = done })
const final = text => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), text = JSON.stringify(body.input); requests.push(body)
    let output
    if (text.includes('COMPACTION STARTED:')) {
      const prompt = body.input.filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const segments = [...prompt.matchAll(/^Segment \d+: raw message candidates[^\n]*\n([\s\S]*?)(?=^Segment \d+:|^Review the older candidate items)/gm)]
      const blocks = segments.map(segment => {
        const ranges = [...segment[1].matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])])
        assert(ranges.length)
        return { level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Original records remain in effective Archive.' }
      })
      assert(blocks.length); output = [call('compact-plan', 'submit_compact_plan', { replaceAsBlocks: blocks })]
    } else if (text.includes('INSTALL-ACCESS') && !body.input.some(row => row.type === 'function_call_output')) {
      output = [call('install-access', 'set_config', { target: 'config', filePath: candidatePath })]
    } else {
      if (text.includes('ADMITTED-HOLD')) { enteredAdmitted(); await release }
      output = final(text.includes('INSTALL-ACCESS') ? 'INSTALL-DONE' : text.includes('ADMITTED-HOLD') ? 'ADMITTED-DONE' : 'SCOPED-REPLY')
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'scoped-' + requests.length, output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { errors.push(error.stack); response.destroy() }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeFile(host.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], contextLimit: 100000, asyncCompact: false } } }))
await mkdir(join(host.work, 'memory'), { recursive: true }); await writeFile(join(host.work, 'memory/ONBOOT.md'), ' \n'); await writeFile(join(host.work, 'memory/MEMORY.md'), 'PRIVATE-PROMPT-SNAPSHOT')
const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 20, g: 110, b: 180, alpha: 1 } } }).png().toBuffer()
await writeFile(join(host.work, 'reference.png'), png)
await writeFile(join(host.work, 'unreferenced.png'), await sharp({ create: { width: 2, height: 3, channels: 4, background: { r: 180, g: 20, b: 110, alpha: 1 } } }).png().toBuffer())
const seeded = execFileSync(process.execPath, [resolve('dotnet/continuous-history-fixture-ts.mjs'), host.data, join(host.work, 'reference.png'), join(host.work, 'unreferenced.png')], { encoding: 'utf8', env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') } })
const seed = JSON.parse(seeded.split('\n').find(line => line.startsWith('CONTINUOUS_FIXTURE:')).slice('CONTINUOUS_FIXTURE:'.length))
const config = (token = aliceToken, extra = {}) => ({
  url: host.origin + '/nested/app', bot: { httpPort: host.port }, llm: { maxOutput: 713, compactKeepPercent: 0.3 }, channels: { webui: {} },
  access: { identities: { alice: { token, surfaces: { webui: { sessions: ['continuous-alias', 'chat'] }, mcp: {} } }, bob: { token: 'synthetic-bob', surfaces: { webui: { sessions: ['main/*'] } } }, ...extra } },
})
let current = config()
await writeFile(join(host.data, 'state/config.yaml'), JSON.stringify(current))
const exists = path => access(path).then(() => true, () => false)
const faults = join(host.data, 'state/experiment-faults'); await mkdir(faults)
const saved = async id => JSON.parse(await readFile(join(host.data, 'state/sessions', id + '.json'), 'utf8'))
async function api(token, method, path, body) {
  const response = await fetch(host.origin + '/nested/app' + path, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const admin = (method, path, body) => api(host.token, method, path, body)
const alice = (method, path, body) => api(aliceToken, method, path, body)
const bob = (method, path, body) => api('synthetic-bob', method, path, body)
async function install(next) {
  const raw = '# retained access candidate\r\n' + JSON.stringify(next, null, 2) + '\r\n'
  const result = await admin('POST', '/api/setup/config', { yaml: raw })
  assert.equal(result.status, 200, JSON.stringify(result)); assert.deepEqual(result.body.applied, ['access.identities', 'access.surfaces.mcp']); assert.deepEqual(result.body.notApplied, ['channels']); assert(!result.body.restartRequired.some(value => value.startsWith('access')))
  assert.equal(await readFile(join(host.data, 'state/config.yaml'), 'utf8'), raw); current = next
  return result
}
async function rotate() { aliceToken = 'synthetic-alice-' + (Number(aliceToken.split('-').at(-1)) + 1); await install(config()) }
async function ws(token, id) {
  const socket = new WebSocket(host.origin.replace('http:', 'ws:') + '/nested/app/api/webui/stream', { headers: { authorization: 'Bearer ' + token } })
  const result = { socket, frames: [], closed: false }; sockets.push(result)
  socket.on('message', raw => result.frames.push(JSON.parse(String(raw)))); socket.on('close', () => { result.closed = true }); socket.on('error', () => {})
  await once(socket, 'open'); socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: false, sessionListIds: [], sessionIds: [id] }))
  return result
}
async function sse(token, id) {
  const controller = new AbortController(), response = await fetch(host.origin + '/nested/app' + route(id) + '/stream', { headers: { authorization: 'Bearer ' + token }, signal: controller.signal })
  assert.equal(response.status, 200)
  const state = { text: '', closed: false, controller }; streams.push(state)
  state.reading = (async () => { try { for await (const bytes of response.body) state.text += new TextDecoder().decode(bytes) } catch {} finally { state.closed = true } })()
  await until(() => state.text.includes('session-state'), 'SSE state')
  return state
}
async function upload(token, id, filename = 'owned.txt', bytes = Buffer.from('owned attachment')) {
  const form = new FormData(); if (id) form.append('sessionId', id); form.append('file', new Blob([bytes]), filename)
  const response = await fetch(host.origin + '/nested/app/api/upload', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: form })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
function heldBody(path, token, type, bodyPrefix) {
  let finish
  const result = { closed: false, status: null, done: new Promise(done => { finish = done }) }
  const request = httpRequest(host.origin + '/nested/app' + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': type, 'content-length': Buffer.byteLength(bodyPrefix) + 50000 } }, response => { result.status = response.statusCode; response.resume() })
  request.on('error', () => {}); request.on('close', () => { result.closed = true; finish() }); request.flushHeaders(); request.write(bodyPrefix); result.request = request
  return result
}
async function complete(id, marker) { return until(async () => { const value = await admin('GET', route(id) + '/history'); return !value.body.session.busy && value.body.messages.some(row => row.parts?.some(part => part.text === marker)) && value.body }, marker) }
try {
  await host.start()
  assert.equal((await admin('POST', '/api/sessions', { agentId: 'main', sessionId: 'chat' })).status, 200)
  const adminCookie = await fetch(host.origin + '/nested/app/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: host.token }) })
  assert(adminCookie.headers.get('set-cookie').toLowerCase().includes('httponly')); assert(!adminCookie.headers.get('set-cookie').includes(host.token))
  const scopedCookie = await fetch(host.origin + '/nested/app/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: aliceToken }) })
  assert(scopedCookie.headers.get('set-cookie').toLowerCase().includes('httponly'))
  const introspection = await alice('GET', '/api/auth/session'); assert.equal(introspection.body.role, 'webui'); assert.deepEqual(new Set(introspection.body.sessionIds), new Set([seed.parent, 'chat'])); assert.equal(introspection.body.features.commands, false)
  assert((await bob('GET', '/api/auth/session')).body.sessionIds.includes('chat'), 'Agent scope includes unprefixed main identity')
  for (const [method, path, body] of [['GET', '/api/setup/status'], ['GET', '/api/models'], ['GET', route('chat') + '/state'], ['GET', route('chat') + '/debug-file'], ['GET', '/api/nodes'], ['POST', '/api/download/sign', { path: join(host.work, 'reference.png') }], ['POST', '/api/sessions', { sessionId: 'forbidden' }], ['GET', route('chat') + '/nodes'], ['POST', route('chat') + '/node', { nodeId: 'master' }], ['GET', '/vscode-web'], ['GET', '/api/vscode-web/fs/workspace-roots'], ['GET', '/api/vscode-web/git/status']]) {
    assert.equal((await alice(method, path, body)).status, 403, path)
  }
  assert.equal((await api('synthetic-mcp-only', 'POST', '/mcp', {})).status, 401)
  const rejectedBefore = requests.length
  for (const body of [{ text: '/stop' }, { text: ' @main /session clear' }, { text: 'ordinary', parts: [{ text: '/stop' }] }, { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] }, { text: 'ordinary', parts: [{ text: 'ordinary', system: 'forged' }] }]) {
    assert([400, 403].includes((await alice('POST', route('chat') + '/message', body)).status))
  }
  assert.equal(requests.length, rejectedBefore)
  const aUpload = await upload(aliceToken, 'chat'), bUpload = await upload('synthetic-bob', 'chat')
  assert.equal(aUpload.status, 200); assert.equal(bUpload.status, 200)
  assert.equal((await upload(aliceToken, '')).status, 400)
  assert.equal((await bob('POST', route('chat') + '/message', { text: 'not mine', uploadedFiles: [aUpload.body] })).status, 403)
  assert.equal((await alice('POST', route('chat') + '/message', { text: 'mixed ownership', uploadedFiles: [aUpload.body, bUpload.body] })).status, 403)
  assert(await exists(aUpload.body.path)); assert(await exists(bUpload.body.path))
  assert.equal((await alice('POST', route('chat') + '/message', { text: 'attachment', uploadedFiles: [aUpload.body] })).status, 202); await complete('chat', 'SCOPED-REPLY')
  assert(!await exists(aUpload.body.path)); assert(await exists(bUpload.body.path))
  const history = await alice('GET', route('chat') + '/history'); assert.equal(history.body.persistentMemorySnapshot, null); assert(!JSON.stringify(history).includes('PRIVATE-PROMPT-SNAPSHOT')); assert(!('parentSessionId' in history.body.session)); assert(history.body.session.runtimeState)
  assert.equal((await admin('GET', route('chat') + '/history')).body.persistentMemorySnapshot.includes('PRIVATE-PROMPT-SNAPSHOT'), true)

  // A real cold-owner read, held input body, held multipart upload, WS and SSE are all in flight at rotation.
  const aliceWs = await ws(aliceToken, 'chat'), bobWs = await ws('synthetic-bob', 'chat')
  await until(() => aliceWs.frames.some(frame => frame.type === 'subscriptions-applied') && bobWs.frames.some(frame => frame.type === 'subscriptions-applied'), 'WS snapshots')
  const aliceSse = await sse(aliceToken, 'chat'), bobSse = await sse('synthetic-bob', 'chat')
  const heldInput = heldBody(route('chat') + '/message', aliceToken, 'application/json', '{"text":"NEVER-ADMITTED')
  const heldUpload = heldBody('/api/upload', aliceToken, 'multipart/form-data; boundary=held', '--held\r\nContent-Disposition: form-data; name="sessionId"\r\n\r\nchat\r\n--held\r\nContent-Disposition: form-data; name="file"; filename="held.txt"\r\nContent-Type: text/plain\r\n\r\npartial')
  // The original parent remains cold: no earlier successful request admitted it.
  const marker = join(faults, segment(seed.parent) + '.admission-hold'); await writeFile(marker, 'hold')
  const heldHistory = alice('GET', route(seed.parent) + '/history').then(value => ({ value }), error => ({ error: error.message }))
  await until(() => exists(marker + '.reached'), 'cold history owner barrier')
  const oldToken = aliceToken; await rotate(); await rm(marker)
  await until(() => aliceWs.closed && aliceSse.closed && heldInput.closed && heldUpload.closed, 'selective transport and body revocation')
  assert(!bobWs.closed); assert(!bobSse.closed); assert((await heldHistory).error)
  bobWs.socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 2, sessionListActive: false, sessionListIds: [], sessionIds: ['chat'] }))
  await until(() => bobWs.frames.some(frame => frame.type === 'subscriptions-applied' && frame.revision === 2), 'unrelated WS remains functional')
  assert.equal((await api(oldToken, 'GET', '/api/auth/session')).status, 401)
  assert.equal((await bob('GET', '/api/auth/session')).status, 200)
  assert.equal((await bob('POST', route(seed.parent) + '/message', { text: 'wrong session', uploadedFiles: [bUpload.body] })).status, 403)
  assert(!JSON.stringify(requests).includes('NEVER-ADMITTED'))
  assert(await exists(bUpload.body.path), 'unrelated staged upload survives rotation')

  // An unrelated surface edit must not reset a live browser or its upload owner.
  const stableWs = await ws(aliceToken, 'chat'); await until(() => stableWs.frames.some(frame => frame.type === 'subscriptions-applied'), 'stable WS')
  const stableUpload = await upload(aliceToken, 'chat')
  const webUiOnly = config(); delete webUiOnly.access.identities.alice.surfaces.mcp
  const webUiOnlyResult = await admin('POST', '/api/setup/config', { yaml: JSON.stringify(webUiOnly) }); assert.equal(webUiOnlyResult.status, 200)
  assert(!stableWs.closed); assert(await exists(stableUpload.body.path)); assert.equal((await alice('GET', '/api/auth/session')).status, 200)
  await install(config())
  const forbiddenWs = await ws(aliceToken, 'chat'); forbiddenWs.socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 2, sessionListActive: true, sessionListIds: ['main'], sessionIds: ['chat'] }))
  await until(() => forbiddenWs.closed, 'catalog subscription rejection'); assert(!forbiddenWs.frames.some(frame => frame.type.startsWith('session-list-')))
  const logsWs = await ws(aliceToken, 'chat'); logsWs.socket.send(JSON.stringify({ type: 'set-subscriptions', revision: 2, sessionListActive: false, sessionListIds: [], sessionIds: ['chat'], logs: { id: 'forbidden-log-view' } }))
  await until(() => logsWs.closed, 'log subscription rejection'); assert(!logsWs.frames.some(frame => frame.type.startsWith('logs-')))

  // Exact aliases follow moves; Agent scopes follow actual membership and close stale streams.
  const movingSse = await sse('synthetic-bob', seed.parent)
  assert.equal((await admin('POST', '/api/agents', { agentId: 'team' })).status, 201)
  assert.equal((await admin('POST', route(seed.parent) + '/message', { text: '/session move team/moved' })).status, 200)
  await until(() => movingSse.closed, 'stale canonical SSE closes after move')
  assert.equal((await alice('GET', route('continuous-alias') + '/history')).status, 200)
  assert.equal((await bob('GET', route('team/moved') + '/history')).status, 403)
  assert.equal((await admin('POST', '/api/sessions', { agentId: 'main', sessionId: 'future' })).status, 200)
  assert((await bob('GET', '/api/sessions')).body.sessions.some(row => row.id === 'future'))
  assert((await alice('GET', '/api/sessions')).body.sessions.every(row => Object.keys(row).every(key => ['id', 'displayName', 'busy'].includes(key))))

  // Actual committed effective Archive reference, active reference, unrelated blob, and independent grants.
  const moved = 'team/moved'
  assert.equal((await alice('GET', route(moved) + '/blobs/' + seed.unreferenced.blobId + '?archiveSeq=150')).status, 403)
  assert.equal((await alice('POST', route(moved) + '/blobs/' + seed.unreferenced.blobId + '/download', { archiveSeq: '150' })).status, 403)
  assert.equal((await alice('GET', route(moved) + '/blobs/' + seed.image.blobId)).status, 200)
  const activeGrant = await alice('POST', route(moved) + '/blobs/' + seed.image.blobId + '/download', { filename: 'active.png' }); assert.equal(activeGrant.status, 200)
  assert.equal((await admin('POST', route(moved) + '/message', { text: '/compact' })).status, 202)
  await until(async () => !(await saved(moved)).busy && (await saved(moved)).history.some(row => row.__meta?.contextBlock), 'actual compacted authority')
  assert.equal((await alice('GET', route(moved) + '/blobs/' + seed.image.blobId)).status, 403)
  assert.equal((await alice('GET', route(moved) + '/blobs/' + seed.image.blobId + '?archiveSeq=150')).status, 200)
  assert.equal((await alice('GET', route(moved) + '/blobs/' + seed.image.blobId + '?archiveSeq=999999')).status, 403)
  assert.equal((await alice('GET', '/api/blobs/' + seed.image.blobId)).status, 403)
  const archive = await alice('GET', route(moved) + '/history/continuous?afterSeq=149'); assert(archive.body.messages[0].parts.some(part => part.inlineDataRef?.apiPath?.includes('?archiveSeq=150')))
  const grant = await alice('POST', route(moved) + '/blobs/' + seed.image.blobId + '/download', { archiveSeq: '150', filename: 'archive.png' }); assert.equal(grant.status, 200)
  const signed = new URL(grant.body.url, host.origin + '/nested/app' + route(moved) + '/blobs/').href
  await rotate()
  const native = await fetch(signed); assert.equal(native.status, 200); assert.deepEqual(Buffer.from(await native.arrayBuffer()), png)
  const head = await fetch(signed, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), png.length)
  const wrongSession = signed.replace(encodeURIComponent(moved), 'chat'); assert.equal((await fetch(wrongSession)).status, 401)
  assert.equal((await alice('GET', route(moved) + '/blobs/' + seed.image.blobId + '?archiveSeq=150&signature=bad')).status, 200)

  // Already-admitted input is not cancelled or replayed by browser credential revocation.
  assert.equal((await alice('POST', route('chat') + '/message', { text: 'ADMITTED-HOLD' })).status, 202)
  await admitted; await rotate(); releaseAdmitted(); await complete('chat', 'ADMITTED-DONE')
  assert.equal((await saved('chat')).history.filter(row => JSON.stringify(row).includes('ADMITTED-HOLD')).length, 1)
  for (const stage of ['before-copy', 'after-copy']) {
    const attachment = await upload(aliceToken, 'chat', stage + '.txt', Buffer.from(stage))
    const marker = join(faults, segment('chat') + '.upload-' + stage + '-hold'); await writeFile(marker, 'hold')
    const sending = alice('POST', route('chat') + '/message', { text: 'NEVER-' + stage, uploadedFiles: [attachment.body] }).then(value => ({ value }), error => ({ error: error.message }))
    await until(() => exists(marker + '.reached'), 'attachment ' + stage + ' barrier')
    const directory = join(host.work, '.temp/channel-files/webui')
    const before = (await readdir(directory)).filter(name => name.endsWith(stage + '.txt'))
    assert.equal(before.length, stage === 'after-copy' ? 1 : 0)
    await rotate(); await rm(marker); await sending
    assert(!await exists(attachment.body.path)); assert.equal((await readdir(directory)).filter(name => name.endsWith(stage + '.txt')).length, stage === 'after-copy' ? 1 : 0)
    assert(!(await saved('chat')).history.some(row => JSON.stringify(row).includes('NEVER-' + stage)))
  }

  // Same serialized installer through a real model set_config call, not a second configuration API.
  await writeFile(candidatePath, JSON.stringify(config(aliceToken, { declared: { token: 'synthetic-mcp-only', surfaces: { mcp: {} } } })))
  assert.equal((await admin('POST', '/api/sessions', { agentId: 'main', sessionId: 'installer' })).status, 200)
  assert.equal((await admin('POST', route('installer') + '/message', { text: 'INSTALL-ACCESS' })).status, 202)
  const installed = await complete('installer', 'INSTALL-DONE')
  const installation = installed.messages.flatMap(row => row.parts).find(part => part.functionResponse?.tool_use_id === 'install-access').functionResponse.response
  assert(JSON.stringify(installation).includes('access.identities')); assert(JSON.stringify(installation).includes('access.surfaces.mcp'))
  assert.equal((await api('synthetic-mcp-only', 'GET', '/api/auth/session')).status, 401)
  assert.notEqual((await api('synthetic-mcp-only', 'POST', '/mcp', {})).status, 200)
  assert.equal((await admin('POST', route('chat') + '/message', { text: '/stop', controlRequestId: 'admin-stop-selected' })).status, 200)
  assert(!bobWs.closed); assert(!bobSse.closed)
  assert(bobWs.frames.some(frame => JSON.stringify(frame).includes('ADMITTED-DONE'))); assert(bobSse.text.includes('ADMITTED-DONE'))

  // Original App chooses the restricted root even when a management hash is requested.
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.createBrowserContext(), page = await context.newPage()
  page.on('pageerror', error => browserErrors.push(error.message)); page.on('request', request => { if (new URL(request.url()).pathname.includes('/api/')) scopedRequests.push(new URL(request.url()).pathname) })
  await page.goto(host.origin + '/nested/app/#setup', { waitUntil: 'networkidle0' }); await page.waitForSelector('input[type="password"]'); await page.type('input[type="password"]', aliceToken); await page.click('button[type="submit"]')
  await page.waitForSelector('[data-webui-role="webui"] .foxwarm-chat-root')
  assert.equal(await page.$('#setup-tab-config'), null); assert.equal(await page.$('.foxwarm-model-selector-trigger'), null)
  await page.select('select[aria-label="Session"]', moved)
  await page.evaluate(() => { localStorage.setItem('foxwarm_timeline_view_v1', 'conversation') }); await page.reload({ waitUntil: 'domcontentloaded' })
  await page.select('select[aria-label="Session"]', moved)
  await page.waitForSelector('[data-continuous-history]')
  await page.evaluate(() => { const element = document.querySelector('.foxwarm-chat-messages'); element.scrollTop = 0; element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true })); element.dispatchEvent(new Event('scroll')) })
  await page.waitForFunction(() => [...document.querySelectorAll('img')].some(image => image.src.includes('/blobs/') && image.naturalWidth === 3))
  const downloads = join(host.root, 'scoped-native-downloads'); await mkdir(downloads)
  const cdp = await page.createCDPSession(); await cdp.send('Network.enable')
  await context.setDownloadBehavior({ policy: 'allow', downloadPath: downloads })
  let scopedNative = false, signedInApp = false
  const nativeEvidence = []
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/sessions/*/blobs/*/download', requestStage: 'Response' }, { urlPattern: '*signature=*', requestStage: 'Request' }] })
  cdp.on('Fetch.requestPaused', async event => {
    try {
      nativeEvidence.push({ url: event.request.url, status: event.responseStatusCode })
      if (event.responseStatusCode) { signedInApp = true; await cdp.send('Network.clearBrowserCookies') }
      else { scopedNative = true; assert(!Object.keys(event.request.headers).some(key => key.toLowerCase() === 'cookie')) }
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId })
    } catch (error) { errors.push(error.stack) }
  })
  await page.$eval('.foxwarm-image-item', element => element.click())
  await page.waitForSelector('[data-image-preview][open]')
  await page.$eval('[data-image-preview] [title="Download"]', element => element.click())
  await until(() => exists(join(downloads, 'Image 1')), 'original scoped native cookie-less download').catch(async error => { throw new Error(error.message + ': ' + JSON.stringify({ nativeEvidence, files: await readdir(downloads), alerts: await page.evaluate(() => [...document.querySelectorAll('[role=alert]')].map(node => node.textContent)) })) })
  assert.deepEqual(await readFile(join(downloads, 'Image 1')), png); assert(signedInApp && scopedNative)
  await cdp.send('Fetch.disable')
  assert(!scopedRequests.some(path => /\/(?:models|commands|nodes|setup|code)(?:\/|$)/.test(path)), JSON.stringify(scopedRequests))
  assert.deepEqual(browserErrors, []); assert.deepEqual(errors, [])
  await context.close()
  const administrator = await host.openApp()
  await administrator.waitForSelector('.foxwarm-model-selector-trigger')
  assert.equal(await administrator.$('[data-webui-role="webui"]'), null)
  await host.stop()
  console.log(JSON.stringify({ normalHost: true, hostPids: host.hostPids, originalRestrictedApp: true, scopedNativeCookieLess: true, distinctIdentities: true, setupAndToolInstall: true, exactAndAgentMoves: true, activeAndCommittedArchiveImages: true, signedHeadAfterRotation: true, heldHttpWsSseUploadInput: true, admittedEffectsRetained: true, savedFileEffectsRetained: true, scopedRequests: scopedRequests.length, providerRequests: requests.length }))
} finally {
  releaseAdmitted()
  for (const stream of streams) stream.controller.abort()
  for (const { socket } of sockets) socket.terminate()
  if (browser) await browser.close().catch(() => {})
  for (const name of await readdir(faults).catch(() => [])) if (name.endsWith('-hold')) await rm(join(faults, name), { force: true })
  await host.cleanup(); await new Promise(done => peer.close(done))
}
