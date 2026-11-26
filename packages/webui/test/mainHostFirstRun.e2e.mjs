import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { clickSaveModels, createHostFixture, openModelsYaml, until } from './mainHostFixture.mjs'

// First run shows only the Models step; its save creates `main` with its welcome and opens it
// at the start of the welcome in place of Setup, and the conversation follows the latest
// message once it moves on.
const raw = 'default: local/wire\nproviders:\n  local:\n    providerType: openai-completions\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: synthetic-provider-token\n    models: [wire]\n'

const viewport = page => page.$eval('.foxwarm-chat-messages', container => {
  const welcome = container.querySelector('[data-chat-message-anchor-key]')
  const box = container.getBoundingClientRect()
  return {
    distanceFromBottom: container.scrollHeight - container.scrollTop - container.clientHeight,
    welcomeTop: welcome ? welcome.getBoundingClientRect().top - box.top : null,
    rows: container.querySelectorAll('[data-chat-message-anchor-key]').length,
  }
})

test('first-run welcome opens at its start and later rows rejoin bottom follow', async () => {
  const fixture = await createHostFixture('first-run')
  try {
    await fixture.start()
    const page = await fixture.openApp()
    await page.setViewport({ width: 1280, height: 720 })
    // Nothing but the Models step is offered, so no Session can exist before the welcome.
    await page.waitForSelector('[data-first-run-surface] [data-setup-first-run]')
    assert.deepEqual(await page.evaluate(() => ({
      sidebar: !!document.querySelector('.foxwarm-sidebar-frame, .foxwarm-sidebar-panel'),
      startConversation: [...document.querySelectorAll('button, a')].some(element => element.textContent?.trim() === 'Start a conversation'),
      newSession: !!document.querySelector('button[aria-label="New session"], button[aria-label="New session options"]'),
      tabStrip: !!document.querySelector('[data-tab-id]'),
      setupRail: !!document.querySelector('#setup-tab-models'),
    })), { sidebar: false, startConversation: false, newSession: false, tabStrip: false, setupRail: false })
    await openModelsYaml(page)
    const editor = '[aria-label="Models YAML editor"] [role="textbox"]'
    await page.waitForSelector(editor); await page.focus(editor)
    await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control')
    await page.keyboard.sendCharacter(raw.replaceAll('\n', '\r\n'))
    await clickSaveModels(page)
    await until(async () => (await readFile(fixture.modelPath, 'utf8').catch(() => '')).replaceAll('\r\n', '\n') === raw, 'first-run Models saved')
    // The welcome replaces Setup: it is the active tab and Setup is closed.
    await page.waitForFunction(() => location.hash === '#tab/' + encodeURIComponent('chat:main')
      && document.querySelector('.foxwarm-chat-root')?.dataset.chatSessionId === 'main'
      && document.querySelector('.foxwarm-chat-messages [data-chat-message-anchor-key]'), { timeout: 15_000 })
    assert.equal(await page.$('[data-tab-id="system:setup"]'), null)
    assert.equal(await page.$('[data-first-run-surface]'), null)
    // A new installation sends with Enter in a browser that never chose a send key.
    await page.waitForFunction(() => {
      const placeholder = document.querySelector('.foxwarm-chat-root [data-placeholder]')?.getAttribute('data-placeholder') || ''
      return placeholder.endsWith(' · Enter to send')
    }, { timeout: 15_000 })
    assert.equal(await page.evaluate(() => localStorage.getItem('foxwarm_send_key_mode_v1')), null)
    await new Promise(resolve => setTimeout(resolve, 500))
    const opened = await viewport(page)
    assert.equal(opened.rows, 1, 'only the welcome is visible')
    assert.ok(opened.welcomeTop >= 0 && opened.welcomeTop <= 60, `welcome starts in view (top ${opened.welcomeTop})`)
    assert.ok(opened.distanceFromBottom > 100, 'the welcome is longer than the viewport and its end is below')
    assert.match(await page.$eval('.foxwarm-chat-messages', container => container.textContent), /Hi, I'm Foxwarm/)

    assert.equal((await fixture.api('POST', '/api/sessions/main/message', { text: 'Call me Ming.' })).status, 202)
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages')?.textContent.includes('Call me Ming.'), { timeout: 15_000 })
    await until(async () => (await viewport(page)).distanceFromBottom <= 2, 'conversation follows the latest message')

    // A Session that already has a conversation opens at the latest message as before.
    await page.reload({ waitUntil: 'networkidle0' })
    await page.evaluate(() => window.foxwarmTest.switchToSession('main'))
    await page.waitForFunction(() => document.querySelector('.foxwarm-chat-messages')?.textContent.includes('Call me Ming.'), { timeout: 15_000 })
    await until(async () => (await viewport(page)).distanceFromBottom <= 2, 'existing conversation opens at the bottom')
  } finally {
    await fixture.cleanup()
  }
})
