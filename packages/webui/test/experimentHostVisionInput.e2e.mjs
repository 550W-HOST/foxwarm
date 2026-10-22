// Original browser File ingress through the changed managed upload/preparation/provider owners.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { createHostFixture, until } from './experimentHostFixture.mjs'
import { writeModelFixture } from './experimentModelFixture.mjs'
let browserPage
const fixture = await createHostFixture('vision-input', { env: {}, onPage: page => { browserPage = page; page.on('pageerror', error => console.error('Page error:', error));  } }), records = [], uploads = []
const sources = {
  small: await sharp({ create: { width: 3, height: 2, channels: 3, background: 'red' } }).png().toBuffer(),
  overBytes: await sharp({ create: { width: 4096, height: 3072, channels: 3, background: 'red' } }).png({ compressionLevel: 0 }).toBuffer(),
  overPixels: await sharp({ create: { width: 8193, height: 8193, channels: 3, background: 'blue' }, limitInputPixels: false }).png().toBuffer(),
}
sources.overTiff = await sharp(sources.overPixels, { limitInputPixels: false }).tiff({ compression: 'deflate' }).toBuffer()
const extension = name => name === 'overTiff' ? '.tif' : '.png'
assert(sources.overBytes.length > 32 * 1024 * 1024)
await mkdir(join(fixture.work, 'memory'), { recursive: true }); await writeFile(join(fixture.work, 'memory', 'ONBOOT.md'), ' \n')
const peer = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk
  records.push(JSON.parse(raw))
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'vision-input', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'VISION-INPUT-DONE' }] }], usage: { input_tokens: 80, output_tokens: 3 } } }) + '\n\n')
})
peer.listen(0, '127.0.0.1'); await once(peer, 'listening')
await writeModelFixture(fixture.data, { default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: `http://127.0.0.1:${peer.address().port}/v1`, apiKey: 'synthetic-vision-input', models: ['wire'] } } })
await writeFile(join(fixture.data, 'state/config.yaml'), (await readFile(join(fixture.data, 'state/config.yaml'), 'utf8')) + 'access:\n  identities:\n    alice:\n      token: synthetic-vision-alice\n      surfaces:\n        webui:\n          sessions: [main]\n')
const files = []
for (const [name, bytes] of Object.entries(sources)) { const path = join(fixture.root, name + extension(name)); await writeFile(path, bytes); files.push(path) }
try {
  await fixture.start(); assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'main' })).status, 200); const page = await fixture.openApp('synthetic-vision-alice')
  page.on('response', async response => { if (new URL(response.url()).pathname === '/api/upload') uploads.push({ status: response.status(), url: response.url(), body: await response.json() }) })
  await page.type('[role="textbox"][aria-label="Message"]', 'VISION-INPUT ')
  await (await page.$('#file-upload')).uploadFile(...files)
  await until(() => page.$$eval('.foxwarm-composer-attachment-chip', nodes => nodes.length === 4), 'four original attachments')
  await page.click('button[aria-label="Send message"]')
  await until(async () => {
    const state = JSON.parse(await readFile(join(fixture.data, 'state/sessions/main.json'), 'utf8'))
    return !state.busy && state.history.some(row => row.parts?.some(part => part.text === 'VISION-INPUT-DONE')) && state
  }, 'real vision-input turn')
  assert.equal(uploads.length, 4)
  for (const upload of uploads) { assert.equal(upload.status, 200); assert.equal(new URL(upload.url).searchParams.get('sessionId'), 'main') }
  const state = JSON.parse(await readFile(join(fixture.data, 'state/sessions/main.json'), 'utf8'))
  const parts = state.history.filter(row => row.role === 'user').flatMap(row => row.parts)
  const refs = parts.filter(part => part.inlineDataRef)
  assert.equal(refs.length, 1)
  assert.equal(refs[0].inlineDataRef.width, 3)
  assert.equal(refs[0].inlineDataRef.height, 2)
  const fileTags = parts.filter(part => part.text?.startsWith('<foxwarm-file '))
  assert.equal(fileTags.length, 3)
  for (const part of parts.filter(part => /^<foxwarm-(?:file|image) /.test(part.text || ''))) {
    const name = /name="([^"]+)"/.exec(part.text)[1]
    const source = Object.keys(sources).find(key => name.endsWith(key + extension(key)))
    const saved = /path="([^"]+)"/.exec(part.text)[1]
    assert(saved.startsWith(join(fixture.work, '.temp/channel-files/webui/')))
    assert.deepEqual(await readFile(saved), sources[source])
    assert(part.text.includes('node="master"'))
  }
  assert.equal(records.length, 1)
  const request = JSON.stringify(records[0])
  assert.equal((request.match(/"type":"input_image"/g) || []).length, 1)
  assert(request.includes('foxwarm-file'))
  assert(!request.includes('inlineDataRef'))
  assert(request.length < 200000)
  assert.deepEqual(Buffer.from(await (await fetch(fixture.origin + '/api/blobs/' + refs[0].inlineDataRef.blobId, { headers: { authorization: 'Bearer ' + fixture.token } })).arrayBuffer()), sources.small)
  const archive = fixture.sql('SELECT message_json FROM archive_messages WHERE session_id=?', ['main'])
  assert(archive.length > 0)
  assert(archive.some(row => row[0].includes(refs[0].inlineDataRef.blobId)))
  await fixture.stop()
  console.log('Original App -> managed scoped-query uploads -> exact original files, oversized file-only parts, one canonical raster and one provider image passed.')
} catch (error) { console.error(fixture.output); console.error(await browserPage?.evaluate(() => document.body.innerText)); throw error }
finally { await fixture.cleanup(); peer.close(); await once(peer, 'close') }
