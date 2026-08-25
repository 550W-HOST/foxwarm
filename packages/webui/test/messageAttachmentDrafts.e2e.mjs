import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { fileURLToPath } from 'node:url'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const composerEntry = fileURLToPath(new URL('../src/components/ChatComposer.tsx', import.meta.url))
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-message-attachment-drafts-e2e-'))
const firstPath = path.join(tempDir, 'first.txt')
const secondPath = path.join(tempDir, 'second.txt')
const bPath = path.join(tempDir, 'session-b.txt')
let browser
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import ChatComposer from ${JSON.stringify(composerEntry)}

    window.sentPayloads = []
    window.acceptSends = true
    window.deferSends = false
    const pendingSendResolvers = []
    window.resolvePendingSend = () => pendingSendResolvers.shift()?.()
    window.fetch = async (input) => {
      if (String(input).includes('/commands')) {
        return new Response(JSON.stringify({ commands: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('{}', { status: 404 })
    }

    function Fixture() {
      const [sessionId, setSessionId] = useState('fixture/a')
      return React.createElement(React.Fragment, null,
        React.createElement('button', { type: 'button', 'data-session': 'a', onClick: () => setSessionId('fixture/a') }, 'Session A'),
        React.createElement('button', { type: 'button', 'data-session': 'b', onClick: () => setSessionId('fixture/b') }, 'Session B'),
        React.createElement('div', { 'data-active-session': sessionId }, sessionId),
        React.createElement(ChatComposer, {
          sessionId,
          sessionMissing: false,
          loading: false,
          asrAvailable: false,
          modelOptions: [],
          onChangeModel: async () => {},
          onChangeChildModel: async () => {},
          onChangeEffort: async () => {},
          onChangeChildEffort: async () => {},
          onRefreshModels: async () => {},
          onOpenModelSettings: () => {},
          onSend: async payload => {
            window.sentPayloads.push({ sessionId, names: payload.attachments.map(file => file.name) })
            if (window.deferSends) await new Promise(resolve => pendingSendResolvers.push(resolve))
            return window.acceptSends
          },
          onTranscribeAudio: async () => ({ text: '', status: 200, rawLength: 0, textLength: 0, responsePreview: '' }),
          onCreateStreamingTranscriber: async () => ({ sendAudioChunk() {}, stop() {}, cancel() {} }),
        }),
      )
    }

    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: packageDir, sourcefile: 'message-attachment-drafts-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

async function attachmentNames(page) {
  return page.$$eval('.foxwarm-attachment-chip span', elements => elements.map(element => element.textContent))
}

before(async () => {
  await Promise.all([
    writeFile(firstPath, 'first'),
    writeFile(secondPath, 'second'),
    writeFile(bPath, 'session b'),
  ])
  const bundle = await buildFixtureBundle()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
  await rm(tempDir, { recursive: true, force: true })
})

test('message attachments survive A to B to A and clear only on remove or accepted send', async () => {
  const page = await browser.newPage()
  await page.goto(fixtureUrl, { waitUntil: 'load' })

  await page.type('textarea', 'draft text for session A')
  await page.$eval('textarea', textarea => {
    const transfer = new DataTransfer()
    const pastedFile = new File(['synthetic image bytes'], 'pasted-shot.png', { type: 'image/png' })
    transfer.items.add(pastedFile)
    textarea.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }))
  })
  await page.waitForFunction(() => document.body.textContent.includes('pasted-shot.png'))

  await page.click('[data-session="b"]')
  await page.waitForFunction(() => (
    document.querySelector('[data-active-session]')?.textContent === 'fixture/b'
    && document.querySelectorAll('.foxwarm-attachment-chip').length === 0
    && document.querySelector('textarea')?.value === ''
  ))
  assert.deepEqual(await attachmentNames(page), [])

  await (await page.$('#file-upload')).uploadFile(bPath)
  await page.waitForFunction(() => document.body.textContent.includes('session-b.txt'))

  await page.click('[data-session="a"]')
  await page.waitForFunction(() => (
    document.querySelector('[data-active-session]')?.textContent === 'fixture/a'
    && document.body.textContent.includes('pasted-shot.png')
    && document.querySelector('textarea')?.value === 'draft text for session A'
  ))
  assert.deepEqual(await attachmentNames(page), ['pasted-shot.png'])

  await page.click('button[title="Remove attachment"]')
  await page.waitForFunction(() => !document.body.textContent.includes('pasted-shot.png'))
  await page.click('[data-session="b"]')
  await page.click('[data-session="a"]')
  await page.waitForFunction(() => (
    document.querySelector('[data-active-session]')?.textContent === 'fixture/a'
    && document.querySelectorAll('.foxwarm-attachment-chip').length === 0
    && document.querySelector('textarea')?.value === 'draft text for session A'
  ))
  assert.deepEqual(await attachmentNames(page), [])

  await (await page.$('#file-upload')).uploadFile(firstPath)
  await page.waitForFunction(() => document.body.textContent.includes('first.txt'))
  await page.click('[data-session="b"]')
  await page.waitForFunction(() => document.body.textContent.includes('session-b.txt'))
  await page.click('[data-session="a"]')
  await page.waitForFunction(() => document.body.textContent.includes('first.txt'))
  assert.deepEqual(await attachmentNames(page), ['first.txt'])
  await page.click('button[title="Remove attachment"]')
  await page.waitForFunction(() => !document.body.textContent.includes('first.txt'))

  await (await page.$('#file-upload')).uploadFile(secondPath)
  await page.waitForFunction(() => document.body.textContent.includes('second.txt'))
  await page.evaluate(() => { window.acceptSends = false })
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.sentPayloads.length === 1)
  assert.deepEqual(await page.evaluate(() => window.sentPayloads), [{ sessionId: 'fixture/a', names: ['second.txt'] }])
  assert.deepEqual(await attachmentNames(page), ['second.txt'])

  await page.evaluate(() => { window.acceptSends = true })
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.sentPayloads.length === 2)
  assert.deepEqual(await attachmentNames(page), [])

  await page.click('[data-session="b"]')
  await page.waitForFunction(() => document.body.textContent.includes('session-b.txt'))
  assert.deepEqual(await attachmentNames(page), ['session-b.txt'])

  await page.click('[data-session="a"]')
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-attachment-chip').length === 0)
  await (await page.$('#file-upload')).uploadFile(firstPath)
  await page.evaluate(() => { window.deferSends = true })
  await page.click('button[aria-label="Send message"]')
  await page.waitForFunction(() => window.sentPayloads.length === 3)
  await page.click('[data-session="b"]')
  await page.waitForFunction(() => document.body.textContent.includes('session-b.txt'))
  await page.evaluate(() => window.resolvePendingSend())
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.deepEqual(await attachmentNames(page), ['session-b.txt'])

  await page.click('[data-session="a"]')
  await page.waitForFunction(() => document.querySelectorAll('.foxwarm-attachment-chip').length === 0)
  await page.close()
})
