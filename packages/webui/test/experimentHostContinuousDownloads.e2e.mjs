// Real merged App, bounded original Archive, and native downloads on an owned prefixed .NET host.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const options = { env: {} }, host = await createHostFixture('continuous-downloads', options)
options.cwd = host.root
options.env = { FOXWARM_PUBLIC_BASE_URL: host.origin + '/nested/app', FOXWARM_EXPERIMENT_MONTY_BINARY: process.env.FOXWARM_EXPERIMENT_MONTY_BINARY }
options.publicRoot = host.origin + '/nested/app/#session/continuous-parent'
const requests = [], failures = [], pages = [], http = [], browserErrors = [], nativeRequests = [], signRequests = [], paused = [], requestFailures = []
const route = id => '/api/sessions/' + encodeURIComponent(id)
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) })
const peer = createServer(async (request, response) => {
  try {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    const text = JSON.stringify(body.input)
    let output
    if (text.includes('COMPACTION STARTED:')) {
      const prompt = body.input.filter(row => row.role === 'user').flatMap(row => row.content || []).map(part => part.text || '').join('\n')
      const segments = [...prompt.matchAll(/^Segment \d+: raw message candidates[^\n]*\n([\s\S]*?)(?=^Segment \d+:|^Review the older candidate items)/gm)]
      const blocks = segments.map(segment => {
        const ranges = [...segment[1].matchAll(/^- M#(\d+)(?:-#(\d+))?\s/gm)].map(match => [Number(match[1]), Number(match[2] || match[1])])
        assert(ranges.length)
        return { level: 1, sourceKind: 'message', sourceStart: ranges[0][0], sourceEnd: ranges.at(-1)[1], summary: 'Compacted original conversation remains in immutable Archive.' }
      })
      assert(blocks.length, prompt)
      output = [call('compact-plan', 'submit_compact_plan', { replaceAsBlocks: blocks })]
    } else if (text.includes('DELIVER-FILES') && !body.input.some(row => row.type === 'function_call_output')) {
      output = [call('direct-file', 'send_file', { filePath: join(host.work, 'report.png') }),
        call('nested-file', 'run_script', { code: "a = call_tool({'toolId':'builtin:send_file'}, {'filePath':'notes.pdf'})\nb = call_tool({'toolId':'builtin:send_file'}, {'filePath':'other.txt', 'sessionId':'other-target'})\nreturn {'nested': [a, b]}\n" }),
        call('failed-file', 'send_file', { filePath: join(host.work, 'absent.txt') })]
    } else output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: text.includes('DELIVER-FILES') ? 'DELIVERY-FINISHED' : 'LIVE-ORIGINAL-REPLY' }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'continuous-' + requests.length, output, usage: { input_tokens: 40, output_tokens: 4 } } }) + '\n\n')
  } catch (error) { failures.push(error.stack); response.writeHead(500); response.end(String(error)) }
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
const models = { default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}`, models: ['wire'], contextLimit: 100000, asyncCompact: false } } }
await writeFile(host.modelPath, JSON.stringify(models))
await mkdir(join(host.work, 'memory'), { recursive: true }); await writeFile(join(host.work, 'memory/ONBOOT.md'), ' \n')
const png = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 20, g: 110, b: 180, alpha: 1 } } }).png().toBuffer()
await writeFile(join(host.work, 'report.png'), png); await writeFile(join(host.work, 'notes.pdf'), 'original notes bytes'); await writeFile(join(host.work, 'other.txt'), 'not for this reply')
const seedOutput = execFileSync(process.execPath, [resolve('dotnet/continuous-history-fixture-ts.mjs'), host.data, join(host.work, 'report.png')], { encoding: 'utf8', env: { ...process.env, FOXWARM_TS_ROOT: resolve('.') } })
const seed = JSON.parse(seedOutput.split('\n').find(line => line.startsWith('CONTINUOUS_FIXTURE:')).slice('CONTINUOUS_FIXTURE:'.length))
const saved = async id => JSON.parse(await readFile(join(host.data, 'state/sessions', id + '.json'), 'utf8'))
async function done(id, final) { return until(async () => { const value = await saved(id); return !value.busy && value.history.some(row => row.parts?.some(part => part.text === final)) && value }, final) }
let page
try {
  await host.start()
  const original = (await host.api('GET', route(seed.parent) + '/history/continuous')).body
  assert.equal(original.messages.length, 100); assert.equal(original.lastSeq, 241)
  assert.equal((await host.api('GET', route('continuous-alias') + '/history/continuous')).body.lastSeq, 241)
  const fork = (await host.api('GET', route(seed.child) + '/history/continuous')).body
  assert.equal(fork.lastSeq, 242); assert(!JSON.stringify(fork.messages).includes('MUST-NOT-LEAK'))
  assert.equal((await host.api('POST', route(seed.parent) + '/message', { text: '/compact' })).status, 202)
  await until(async () => (await saved(seed.parent)).history.some(row => row.__meta?.contextBlock) && !(await saved(seed.parent)).busy, 'real compacted authority')
  const active = (await host.api('GET', route(seed.parent) + '/history')).body
  assert(active.messages.length < 100, 'compaction reduced active context, not original Archive')
  assert(!active.messages.some(row => row.parts?.some(part => part.inlineDataRef?.blobId === seed.image.blobId)), 'image is archived, not retained active context')
  page = await host.openApp(); await page.setViewport({ width: 1200, height: 900 })
  page.on('pageerror', error => browserErrors.push(error.message))
  page.on('requestfailed', request => requestFailures.push({ url: request.url(), error: request.failure() }))
  page.on('response', async response => {
    const url = new URL(response.url()); http.push({ path: url.pathname, status: response.status() })
    if (url.pathname.endsWith('/history/continuous')) { const body = await response.json().catch(() => null); if (body) pages.push({ url: url.toString(), body }) }
  })
  await page.evaluate(() => { localStorage.setItem('foxwarm_timeline_view_v1', 'conversation') })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.foxwarmTest?.switchToSession)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), seed.parent)
  await page.waitForSelector('[data-continuous-history]')
  await page.waitForSelector('[data-chat-message-anchor-key="seq-local-240"]')
  assert(await page.$eval('.foxwarm-chat-messages', element => getComputedStyle(element).overflowY !== 'hidden'))
  await page.evaluate(() => { const scroller = document.querySelector('.foxwarm-chat-messages'); scroller.scrollTop = 0; scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true })); scroller.dispatchEvent(new Event('scroll')) })
  await until(() => pages.some(value => new URL(value.url).searchParams.has('beforeSeq')), 'bounded earlier request from original App')
  assert(pages.every(value => value.body.messages.length <= 100))
  await page.waitForSelector('img[src*="/api/blobs/"]')
  await page.waitForFunction(() => [...document.querySelectorAll('img[src*="/api/blobs/"]')].some(img => img.naturalWidth === 3))
  // The original is still available behind the compacted active context, including its image.
  const imagePage = (await host.api('GET', route(seed.parent) + '/history/continuous?afterSeq=149')).body
  assert.equal(imagePage.messages[0].__meta.seq, 150); assert(imagePage.messages[0].parts.some(part => part.inlineDataRef?.apiPath?.startsWith('/blobs/')))
  const anchor = await page.evaluate(() => { const scroll = document.querySelector('.foxwarm-chat-messages'); scroll.scrollTop = scroll.scrollHeight / 2; scroll.dispatchEvent(new Event('scroll')); return [...scroll.querySelectorAll('[data-chat-message-anchor-key]')].find(el => el.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top)?.dataset.chatMessageAnchorKey })
  assert(anchor)
  assert.equal((await host.api('POST', route(seed.parent) + '/message', { text: 'LIVE-APPEND' })).status, 202); await done(seed.parent, 'LIVE-ORIGINAL-REPLY')
  await page.waitForFunction(() => document.body.innerText.includes('LIVE-ORIGINAL-REPLY') || !!document.querySelector('[data-continuous-history]'))
  const client = await page.createCDPSession(); await client.send('Network.enable')
  await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  assert.equal((await host.api('POST', route(seed.parent) + '/message', { text: 'RECONNECT-APPEND' })).status, 202)
  await until(async () => (await saved(seed.parent)).history.filter(row => row.parts?.some(part => part.text === 'LIVE-ORIGINAL-REPLY')).length === 2, 'offline live append committed')
  const reads = pages.length
  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await until(() => pages.length > reads, 'reconnected bounded Archive page')
  assert(pages.slice(reads).every(value => value.body.messages.length <= 100))
  // Switch away and back through the App's mounted Chat owner and restore its saved reading window.
  const parentPages = () => pages.filter(value => new URL(value.url).pathname.endsWith(route(seed.parent) + '/history/continuous'))
  const restoreReads = parentPages().length
  const savedAnchor = await page.evaluate(() => {
    const scroll = document.querySelector('.foxwarm-chat-messages'), top = scroll.getBoundingClientRect().top
    return [...scroll.querySelectorAll('[data-chat-message-anchor-key]')].find(element => element.getBoundingClientRect().bottom > top)?.dataset.chatMessageAnchorKey
  })
  assert(savedAnchor)
  const anchorSeq = Number(savedAnchor.match(/^seq-local-(\d+)$/)?.[1])
  assert(Number.isSafeInteger(anchorSeq) && anchorSeq > 0)
  const latestSeq = (await host.api('GET', route(seed.parent) + '/history')).body.latestSeq
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), seed.child)
  await page.waitForFunction(id => location.hash.includes(id) && document.querySelector('.foxwarm-chat-root')?.innerText.includes(id), {}, seed.child)
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), seed.parent)
  await page.waitForSelector('[data-continuous-history]')
  await page.waitForSelector(`[data-chat-message-anchor-key="${savedAnchor}"]`)
  // Preparation surrounds the saved row with two exclusive, bounded cursors.
  // The mounted owner then refreshes from the prepared suffix, not from latest or the Archive start.
  const beforeQuery = '?beforeSeq=' + (anchorSeq + 1), afterQuery = '?afterSeq=' + anchorSeq
  await until(() => [beforeQuery, afterQuery].every(query => parentPages().slice(restoreReads).some(value => new URL(value.url).search === query)), 'two restored-window preparation pages')
  const preparedPages = parentPages().slice(restoreReads)
  const earlier = preparedPages.find(value => new URL(value.url).search === beforeQuery).body
  const later = preparedPages.find(value => new URL(value.url).search === afterQuery).body
  assert.equal(earlier.lastSeq, anchorSeq)
  assert(earlier.messages.every(row => row.__meta.seq <= anchorSeq))
  assert(later.messages.every(row => row.__meta.seq > anchorSeq))
  const catchUpQuery = '?afterSeq=' + later.lastSeq
  await until(() => parentPages().slice(restoreReads).some(value => new URL(value.url).search === catchUpQuery), 'post-seed bounded catch-up')
  const restoredPages = parentPages().slice(restoreReads)
  assert.deepEqual(restoredPages.map(value => new URL(value.url).search).sort(), [beforeQuery, afterQuery, catchUpQuery].sort())
  const catchUp = restoredPages.find(value => new URL(value.url).search === catchUpQuery).body
  assert(catchUp.messages.every(row => row.__meta.seq > later.lastSeq))
  assert.equal(catchUp.lastSeq, latestSeq)
  assert.equal(catchUp.hasMore, false, 'the small committed suffix needs no automatic page drain')
  assert(pages.every(value => value.body.messages.length <= 100))
  assert.equal((await host.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'other-target' })).status, 200)
  assert.equal((await host.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'deliveries' })).status, 200)
  await page.evaluate(() => window.foxwarmTest.switchToSession('deliveries'))
  await page.waitForFunction(() => location.hash.includes('deliveries') && document.querySelector('.foxwarm-chat-root')?.innerText.includes('deliveries') && document.querySelector('.foxwarm-chat-root')?.dataset.chatConnectionState === 'connected')
  assert.equal((await host.api('POST', route('other-target') + '/message', { text: '/session unparent' })).status, 200)
  await page.evaluate(() => window.foxwarmTest.sendMessage('DELIVER-FILES'))
  const deliveryState = await done('deliveries', 'DELIVERY-FINISHED')
  const results = deliveryState.history.flatMap(row => row.parts || []).filter(part => part.functionResponse).map(part => part.functionResponse)
  const direct = results.find(value => value.tool_use_id === 'direct-file').response.fileDelivery
  const nested = results.find(value => value.tool_use_id === 'nested-file').response.result.nested
  assert.equal(direct.targetId, 'deliveries'); assert.equal(direct.fileName, 'report.png'); assert.equal(direct.mimeType, 'image/png'); assert.equal(direct.sizeBytes, png.length)
  assert.equal(nested[0].fileDelivery.fileName, 'notes.pdf'); assert.equal(nested[1].fileDelivery.targetId, 'other-target')
  assert(!results.find(value => value.tool_use_id === 'failed-file').response.fileDelivery)
  await page.waitForFunction(() => document.querySelectorAll('[data-delivery-id]').length === 2)
  assert.equal(await page.$('[aria-label="Download other.txt"]'), null)
  const downloads = join(host.root, 'downloads'); await mkdir(downloads)
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/download/sign', requestStage: 'Response' }, { urlPattern: '*/api/blobs/*/download', requestStage: 'Response' }, { urlPattern: '*signature=*', requestStage: 'Request' }] })
  client.on('Fetch.requestPaused', async event => {
    try {
      paused.push({ url: event.request.url, status: event.responseStatusCode })
      if (event.responseStatusCode) { signRequests.push(event.request.url); await client.send('Network.clearBrowserCookies') }
      else nativeRequests.push(event.request)
      await client.send('Fetch.continueRequest', { requestId: event.requestId })
    } catch (error) { failures.push(error.stack) }
  })
  async function nativeDownload(selector, name) {
    await page.setCookie({ name: 'foxwarm_token', value: host.token, url: host.origin + '/nested/app/' })
    await page.$eval(selector, element => element.click())
    await until(async () => (await readdir(downloads)).includes(name), 'cookie-less native ' + name)
    assert.equal((await page.cookies()).length, 0)
  }
  await nativeDownload('[aria-label="Download notes.pdf"]', 'notes.pdf')
  assert.equal(await readFile(join(downloads, 'notes.pdf'), 'utf8'), 'original notes bytes')
  await nativeDownload('[aria-label="Download report.png"]', 'report.png')
  assert.deepEqual(await readFile(join(downloads, 'report.png')), png)
  await page.setCookie({ name: 'foxwarm_token', value: host.token, url: host.origin + '/nested/app/' })
  await page.evaluate(id => window.foxwarmTest.switchToSession(id), seed.parent)
  await page.waitForSelector('.foxwarm-image-item img[src*="/api/blobs/"]')
  await page.waitForFunction(() => [...document.querySelectorAll('.foxwarm-image-item img')].some(img => img.naturalWidth === 3))
  await page.$eval('.foxwarm-image-item', element => element.click())
  await page.waitForSelector('[data-image-preview][open]')
  await page.waitForFunction(() => document.querySelector('[data-image-preview] img')?.naturalWidth === 3)
  await nativeDownload('[data-image-preview] [title="Download"]', 'Image 1')
  assert.deepEqual(await readFile(join(downloads, 'Image 1')), png)
  assert.equal(signRequests.length, 3)
  assert(signRequests.some(value => value.includes('/api/blobs/')))
  assert(nativeRequests.length >= 3); assert(nativeRequests.every(value => !Object.keys(value.headers).some(key => key.toLowerCase() === 'cookie')))
  assert(nativeRequests.every(value => new URL(value.url).pathname.startsWith('/nested/app/')))
  await client.send('Fetch.disable')
  assert.deepEqual(failures, []); assert.deepEqual(browserErrors, [])
  const requestCount = requests.length
  await host.stop(); await host.start()
  assert.equal(requests.length, requestCount, 'restart does not create provider work')
  const restoredOriginal = (await host.api('GET', route(seed.parent) + '/history/continuous?afterSeq=149')).body
  assert.equal(restoredOriginal.messages[0].__meta.seq, 150)
  assert(restoredOriginal.messages[0].parts.some(part => part.inlineDataRef?.blobId === seed.image.blobId))
  const restored = await saved('deliveries')
  assert.deepEqual(restored.history, deliveryState.history, 'direct/nested receipts survive actual host restart')
  const signedHead = await fetch(nativeRequests.at(-1).url, { method: 'HEAD' })
  assert.equal(signedHead.status, 200); assert.equal(Number(signedHead.headers.get('content-length')), png.length)
  await host.stop()
  console.log(JSON.stringify({ hostPids: host.hostPids, providerRequests: requests.length, boundedPages: pages.length, pageSizes: pages.map(value => value.body.messages.length), compacted: true, fork: seed.child, archivedImage: true, reconnect: true, directAndNestedReceipts: true, nativeCookieLess: nativeRequests.length, nestedPrefix: true, restartPersistence: true }))
} finally {
  if (page && process.env.FOXWARM_KEEP_E2E_ROOT === '1') await writeFile(join(host.root, 'browser.html'), await page.content()).catch(() => {})
  if (process.env.FOXWARM_KEEP_E2E_ROOT === '1') await writeFile(join(host.root, 'continuous-download-proof.json'), JSON.stringify({ requests, failures, pages, http, browserErrors, nativeRequests, signRequests, paused, requestFailures, hostPids: host.hostPids }, null, 2))
  await host.cleanup(); await new Promise(done => peer.close(done))
}
