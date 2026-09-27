import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-guest-browser-'))
process.env.FOXWARM_DATA_DIR = dataRoot
const require = createRequire(import.meta.url)
const { HttpServer, setHttpServer } = require('../../../lib/httpServer.js')
const { WebUIChannel } = require('../../../lib/channels/webuiChannel.js')
const sessionManager = require('../../../lib/sessionManager.js')
const { createWebUiGuestToken } = require('../../../lib/webuiGuestTokens.js')
const { putImageBlob } = require('../../../lib/imageBlobs.js')
const sharp = require('sharp')

// The test owns its disposable HTTP server and data directory, never the shared test instance.
test('guest role mounts bound chat without admin/popup surfaces and can send a message', async () => {
  let browser
  let server
  let channel
  const bound = `guest/browser_bound_${Date.now()}`
  const second = `guest/browser_second_${Date.now()}`
  const unbound = `guest/browser_unbound_${Date.now()}`
  const received = []
  try {
    await sessionManager.loadSessions()
    await sessionManager.createEmptySession(bound)
    await sessionManager.createEmptySession(second)
    await sessionManager.createEmptySession(unbound)
    await sessionManager.appendSessionMessage(bound, { role: 'model', parts: [{ text: 'Bound history sentinel' }], __meta: { timestamp: Date.now() } })
    const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#2255cc' } }).png().toBuffer()
    const imageRef = await putImageBlob({ buffer: image, mimeType: 'image/png', imageId: 'guest-browser-image' })
    await sessionManager.appendSessionMessage(bound, { role: 'model', parts: [{ inlineDataRef: imageRef }], __meta: { timestamp: Date.now() } })
    await sessionManager.appendSessionMessage(second, { role: 'model', parts: [{ text: 'Second bound history sentinel' }], __meta: { timestamp: Date.now() } })
    await sessionManager.appendSessionMessage(unbound, { role: 'model', parts: [{ text: 'Private history sentinel' }], __meta: { timestamp: Date.now() } })
    const { token } = await createWebUiGuestToken({ sessionIds: [bound, second] })
    const port = 39000 + Math.floor(Math.random() * 1000)
    server = new HttpServer(port, 'admin-browser-fixture')
    setHttpServer(server)
    channel = new WebUIChannel({ token: 'admin-browser-fixture', enableTrigger: false, router: { handleMessage: async (_ctx, message) => { received.push(message) } } })
    await server.start()
    browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const page = await browser.newPage()
    await page.setCookie({ name: 'foxwarm_token', value: token, url: `http://127.0.0.1:${port}/` })
    await page.goto(`http://127.0.0.1:${port}/?foxwarmPopup=setup&foxwarmPopupVersion=1`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-webui-role="guest"]', { timeout: 15_000 })
    for (let attempt = 0; attempt < 30 && !channel.realtimeHub.hasSessionSubscribers(bound); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(channel.realtimeHub.hasSessionSubscribers(bound), true, 'guest Chat owns a real multiplexed realtime subscription')
    await page.waitForFunction(() => document.body.textContent?.includes('Bound history sentinel'), { timeout: 15_000 })
    assert.equal(await page.evaluate(() => document.body.textContent?.includes('Private history sentinel')), false)
    await page.waitForFunction(() => {
      const image = document.querySelector('.foxwarm-image-item img')
      return image?.complete && image.naturalWidth > 0
    }, { timeout: 10_000 })
    assert.equal(await page.$('[data-foxwarm-popup-root="setup"]'), null)
    assert.equal(await page.$('[data-model-actions="true"]'), null)
    assert.equal(await page.$('[aria-label="Open terminal"]'), null)
    assert.equal(await page.$('[aria-label="Open debug info"]'), null)
    assert.equal(await page.$('[aria-label="Session list"]'), null)
    const editor = await page.$('[contenteditable="true"]')
    assert.ok(editor, 'guest can use the ordinary chat composer')
    await editor.click()
    await editor.type('Hello from guest browser')
    await page.click('[aria-label="Send message"]')
    await page.waitForFunction(() => document.querySelector('[contenteditable="true"]')?.textContent === '', { timeout: 10_000 })
    assert.equal(received.length, 1)
    assert.equal(received[0].parts.some(part => part.text?.includes('Hello from guest browser')), true)
    const forbidden = await page.evaluate(async id => (await fetch(`/api/sessions/${encodeURIComponent(id)}/history`)).status, unbound)
    assert.equal(forbidden, 403)
    await page.select('[aria-label="Guest session"]', second)
    await page.waitForFunction(() => document.body.textContent?.includes('Second bound history sentinel'), { timeout: 10_000 })
    assert.equal(await page.evaluate(() => document.body.textContent?.includes('Private history sentinel')), false)
    for (let attempt = 0; attempt < 30 && !channel.realtimeHub.hasSessionSubscribers(second); attempt++) await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(channel.realtimeHub.hasSessionSubscribers(second), true)
    assert.equal(channel.realtimeHub.hasSessionSubscribers(unbound), false)
    const adminPage = await browser.newPage()
    await adminPage.setCookie({ name: 'foxwarm_token', value: 'admin-browser-fixture', url: `http://127.0.0.1:${port}/` })
    await adminPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
    await adminPage.waitForFunction(() => document.body.textContent?.includes('Setup') || document.body.textContent?.includes('Sessions'), { timeout: 10_000 })
    assert.equal(await adminPage.$('[data-webui-role="guest"]'), null)
    const adminApi = await adminPage.evaluate(async () => ({
      role: (await (await fetch('/api/auth/session')).json()).role,
      sessions: (await (await fetch('/api/sessions')).json()).sessions.map(entry => entry.id),
    }))
    assert.equal(adminApi.role, 'admin')
    assert.equal(adminApi.sessions.includes(unbound), true, 'administrator catalog remains unfiltered')
  } finally {
    await browser?.close()
    await channel?.stop()
    await server?.stop()
    setHttpServer(null)
    await sessionManager.deleteSession(bound).catch(() => {})
    await sessionManager.deleteSession(second).catch(() => {})
    await sessionManager.deleteSession(unbound).catch(() => {})
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
})
