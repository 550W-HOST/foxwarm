import { appE2eRuntime } from './runtime.mjs'
import { waitForWebUiReady } from '../../packages/webui/test/webuiReadiness.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const { baseUrl, tokenFile } = appE2eRuntime()
const token = (await fs.readFile(tokenFile, 'utf8')).trim()
let sessionId = 'app-e2e-long-a'
async function api(suffix, init = {}) {
  const response = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}${suffix}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  assert.equal(response.ok, true, `${suffix}: ${response.status}`)
  return response.json()
}

test('Conversation honors real delete and clear commands across paging, remount and reload', { timeout: 90_000 }, async () => {
  // Own a fork so the scenario does not clear another harness scenario's seed.
  sessionId = (await api('/fork', { method: 'POST', body: JSON.stringify({ suffix: 'conversation-history' }) })).newSessionId
  const forkRows = (await api('/history')).messages
  const forkNotices = forkRows.filter(message => message.__meta.seq > 140).length
  if (forkNotices) await api('/message', { method: 'POST', body: JSON.stringify({ text: `/delete-messages -${forkNotices}` }) })
  const archiveHighWater = (await api('/history/continuous')).messages.at(-1).__meta.seq
  const browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  const page = await browser.newPage()
  try {
    await page.setViewport({ width: 1440, height: 900 })
    await page.evaluateOnNewDocument(() => localStorage.setItem('foxwarm_timeline_view_v1', 'conversation'))
    await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2' })
    await waitForWebUiReady(page)
    const open = async () => {
      await page.evaluate(id => window.foxwarmTest.switchToSession(id), sessionId)
      await page.waitForSelector('[role="textbox"][aria-label="Message"]')
    }
    const send = async text => {
      await page.click('[role="textbox"][aria-label="Message"]')
      await page.type('[role="textbox"][aria-label="Message"]', text)
      await page.click('[aria-label="Send message"]')
    }
    const rows = () => page.$$eval('[data-chat-message-anchor-key]', elements => elements.map(element => element.getAttribute('data-chat-message-anchor-key')))
    await open()
    await page.waitForSelector('[data-chat-message-anchor-key="seq-local-140"]')
    await send('/delete-messages -1')
    await page.waitForFunction(() => document.body.textContent.includes('Deleted 1 messages'))
    await page.waitForFunction(() => !document.querySelector('[data-chat-message-anchor-key="seq-local-140"]'))
    assert.equal((await api('/history')).messages.at(-1).__meta.seq, 139)
    const archivedAfterDelete = (await api('/history/continuous')).messages
    assert.equal(archivedAfterDelete.at(-1).__meta.seq, archiveHighWater)
    assert.ok(archivedAfterDelete.some(message => message.__meta.seq === 140), 'immutable Archive still contains deleted original')

    // Exercise an actual older page, then reconcile/remount the same session.
    await page.waitForFunction(() => document.querySelector('[data-continuous-history] button') && !document.querySelector('[data-continuous-history] button').disabled)
    await page.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
      container.scrollTop = 5
      container.dispatchEvent(new Event('scroll'))
    })
    await page.waitForSelector('[data-chat-message-anchor-key="seq-local-1"]')
    assert.equal((await rows()).includes('seq-local-140'), false)
    await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-root')?.textContent.includes('session main'))
    await open()
    await page.waitForSelector('[data-chat-message-anchor-key="seq-local-139"]')
    assert.equal((await rows()).includes('seq-local-140'), false)
    await page.reload({ waitUntil: 'networkidle2' })
    await waitForWebUiReady(page)
    await open()
    await page.waitForSelector('[data-chat-message-anchor-key="seq-local-139"]')
    assert.equal((await rows()).includes('seq-local-140'), false)

    await send('/delete-messages 1')
    await page.waitForFunction(() => document.body.textContent.includes('Remaining: 138'))
    assert.equal((await api('/history')).messages[0].__meta.seq, 2)
    await page.waitForFunction(() => document.querySelector('[data-continuous-history] button') && !document.querySelector('[data-continuous-history] button').disabled)
    await page.evaluate(() => {
      const container = document.querySelector('.foxwarm-chat-messages')
      container.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }))
      container.scrollTop = 5
      container.dispatchEvent(new Event('scroll'))
    })
    await page.waitForSelector('[data-chat-message-anchor-key="seq-local-2"]')
    await page.waitForFunction(() => !document.querySelector('[data-chat-message-anchor-key="seq-local-1"]'))
    assert.equal((await rows()).includes('seq-local-1'), false, 'oldest deletion is not a new Archive boundary')

    await send('/session clear')
    await page.waitForFunction(() => document.body.textContent.includes('Session cleared.'))
    await page.waitForFunction(() => !document.querySelector('[data-chat-message-anchor-key^="seq-local-"]'))
    assert.deepEqual((await api('/history')).messages, [])
    assert.equal((await api('/history/continuous')).messages.at(-1).__meta.seq, archiveHighWater)
    await page.reload({ waitUntil: 'networkidle2' })
    await waitForWebUiReady(page)
    await open()
    await page.waitForFunction(() => !document.querySelector('[data-continuous-history]')?.textContent.includes('Loading'))
    assert.deepEqual(await rows(), [], 'reload cannot reconstruct cleared active history from Archive')
    await send('APP_E2E_AFTER_STOP new conversation after clear')
    await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('after stop complete'))
    // The timeline also renders the live draft; wait for the owner to commit
    // and release before treating the answer's presence as durable history.
    await page.waitForFunction(async id => {
      const response = await fetch(`./api/sessions/${encodeURIComponent(id)}/state`)
      if (!response.ok) return false
      return (await response.json()).session?.busy === false
    }, { timeout: 20_000 }, sessionId)
    const active = (await api('/history')).messages
    assert.equal(active.length, 2)
    assert.ok(active.every(message => message.__meta.seq > archiveHighWater))
    assert.equal((await rows()).some(key => Number(key.replace('seq-local-', '')) <= archiveHighWater), false)
    await page.reload({ waitUntil: 'networkidle2' })
    await waitForWebUiReady(page)
    await open()
    await page.waitForFunction(() => document.querySelector('[data-chat-timeline="committed"]')?.textContent.includes('after stop complete'))
    assert.equal((await rows()).some(key => Number(key.replace('seq-local-', '')) <= archiveHighWater), false)
    if (process.env.FOXWARM_E2E_ARTIFACT_DIR) await page.screenshot({ path: path.join(process.env.FOXWARM_E2E_ARTIFACT_DIR, 'conversation-after-clear.png') })
  } catch (error) {
    console.error('Conversation DOM diagnostics', await page.evaluate(() => ({ history: document.querySelector('[data-continuous-history]')?.textContent, rows: [...document.querySelectorAll('[data-chat-message-anchor-key]')].map(node => node.dataset.chatMessageAnchorKey) })))
    throw error
  } finally {
    await browser.close()
    await api('', { method: 'DELETE' })
  }
})
