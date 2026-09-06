import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const menuEntry = new URL('../src/components/SessionUiSettingsMenu.tsx', import.meta.url).pathname
const timelineEntry = new URL('../src/components/ChatTimeline.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)
let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React, { useEffect } from 'react'
    import { createRoot } from 'react-dom/client'
    import SessionUiSettingsMenu from ${JSON.stringify(menuEntry)}
    import ChatTimeline from ${JSON.stringify(timelineEntry)}
    import { useChatPreferences } from ${JSON.stringify(new URL('../src/chatPreferences.ts', import.meta.url).pathname)}

    const directText = '<foxwarm-message type="channel">\\nuser body\\n</foxwarm-message>\\n<foxwarm-metadata kind="group-message" mentioned="true" />\\n<foxwarm-file name="notes.txt" mime="text/plain" />\\n<foxwarm-image name="photo.png" />'
    const messages = [
      { role: 'user', parts: [{ text: directText }], __meta: { seq: 1 } },
      { role: 'user', parts: [{ system: '<foxwarm-system kind="time" time="2026-09-06 08:00:00 +0000" />' }, { text: 'optimistic body' }], __meta: { clientMessageId: 'optimistic-1' } },
      { role: 'user', parts: [{ text: '<foxwarm-system kind="event" type="wait-timeout">\\nold system body\\n</foxwarm-system>' }], __meta: { seq: 2 } },
      { role: 'model', parts: [{ text: 'assistant selection sentinel' }], __meta: { seq: 3 } },
    ]

    function Fixture() {
      const preferences = useChatPreferences()
      const { sendKeyMode, setSendKeyMode, groupTools, setGroupTools, showUsageBadge, setShowUsageBadge, showUserMessageMetadata: showMetadata, setShowUserMessageMetadata: setShowMetadata } = preferences
      useEffect(() => { window.chatSettingsFixture = { ...preferences, showMetadata } }, [preferences, showMetadata])
      return React.createElement('div', { className: 'foxwarm-chat-root', style: { width: '100%', minWidth: 0, overflow: 'hidden' } },
        React.createElement('header', { style: { display: 'flex', justifyContent: 'flex-end', padding: '8px' } },
          React.createElement(SessionUiSettingsMenu, {
            sendKeyMode, onSendKeyModeChange: setSendKeyMode,
            groupTools, onGroupToolsChange: setGroupTools,
            showUsageBadge, onShowUsageBadgeChange: setShowUsageBadge,
            showUserMessageMetadata: showMetadata, onShowUserMessageMetadataChange: setShowMetadata,
            onOpenDebugInfo() {},
          })
        ),
        React.createElement('main', null,
          React.createElement(ChatTimeline, {
            sessionId: 'fixture/main', messages, isMobile: window.innerWidth < 768,
            groupTools, showUsageBadge, showUserMessageMetadata: showMetadata,
          })
        )
      )
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'chat-settings-placement-fixture.tsx' },
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

async function mountFixture(width = 900) {
  await page.setViewport({ width, height: 720, isMobile: width < 768, hasTouch: width < 768, deviceScaleFactor: 1 })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.chatSettingsFixture)
}

async function openMenu() {
  await page.click('button[aria-label="Open session options"]')
  await page.waitForSelector('[data-session-ui-settings-menu]')
}

async function clickMenuLabel(label) {
  await page.evaluate(expected => {
    const buttons = [...document.querySelectorAll('[data-session-ui-settings-menu] button')]
    const button = buttons.find(candidate => candidate.textContent?.trim() === expected)
      || buttons.find(candidate => candidate.textContent?.includes(expected))
    if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing menu button: ${expected}`)
    button.click()
  }, label)
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the chat settings browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body{margin:0;overflow-x:hidden}main{padding:0 16px 16px}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server?.close(resolve))
})

test('user metadata defaults hidden while bodies, attachment tags, and old system cards remain visible', async () => {
  await mountFixture()
  assert.notEqual(await page.evaluate(() => localStorage.getItem('foxwarm_show_user_message_metadata_v1')), 'true')
  const text = await page.$eval('main', element => element.textContent || '')
  assert.equal(text.includes('<foxwarm-message'), false)
  assert.equal(text.includes('<foxwarm-metadata'), false)
  assert.equal(text.includes('user body'), true)
  assert.equal(text.includes('optimistic body'), true)
  assert.equal(text.includes('<foxwarm-file name="notes.txt"'), true)
  assert.equal(text.includes('<foxwarm-image name="photo.png"'), true)
  assert.equal(await page.$$eval('[data-system-message-card]', cards => cards.length), 1)
  assert.equal((await page.$eval('[data-system-message-card]', card => card.textContent || '')).includes('wait-timeout'), true)
})

test('session menu owns Input and Chat settings and persists the metadata toggle', async () => {
  await mountFixture()
  await openMenu()
  const menuText = await page.$eval('[data-session-ui-settings-menu]', menu => menu.textContent || '')
  for (const label of ['Input', 'Chat', 'Group tools', 'Show usage badges', 'Show minimap', 'Show user message metadata', 'debug info']) {
    assert.equal(menuText.includes(label), true, `${label} is present`)
  }
  await page.evaluate(() => {
    const textNode = [...document.querySelectorAll('.foxwarm-assistant-message-markdown *')]
      .flatMap(element => [...element.childNodes])
      .find(node => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('assistant selection sentinel'))
    if (!textNode) throw new Error('Assistant sentinel text was not rendered')
    const range = document.createRange()
    range.selectNodeContents(textNode)
    const selection = getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    window.selectedSentinelNode = textNode
  })
  await clickMenuLabel('Show user message metadata')
  await page.waitForFunction(() => localStorage.getItem('foxwarm_show_user_message_metadata_v1') === 'true')
  assert.deepEqual(await page.evaluate(() => ({
    text: getSelection()?.toString(),
    sameNode: window.selectedSentinelNode?.isConnected && getSelection()?.anchorNode === window.selectedSentinelNode,
  })), { text: 'assistant selection sentinel', sameNode: true })
  assert.equal((await page.$eval('main', element => element.textContent || '')).includes('<foxwarm-message type="channel">'), true)
  assert.equal((await page.$eval('main', element => element.textContent || '')).includes('<foxwarm-system kind="time"'), true)
  await clickMenuLabel('Enter')
  await page.waitForFunction(() => localStorage.getItem('foxwarm_send_key_mode_v1') === 'enter')
  await clickMenuLabel('Group tools')
  await page.waitForFunction(() => localStorage.getItem('foxwarm_group_tools_v1') === 'true')
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => !!window.chatSettingsFixture?.showMetadata)
  assert.equal((await page.$eval('main', element => element.textContent || '')).includes('<foxwarm-message type="channel">'), true)
})

test('session menu preserves the minimap re-enable invariant and fits mobile', async () => {
  await mountFixture(390)
  await page.evaluate(() => {
    localStorage.setItem('foxwarm.contextScrollbar.showScrollbar', 'false')
    localStorage.setItem('foxwarm.contextScrollbar.showMinimap', 'false')
  })
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => !!window.chatSettingsFixture)
  await openMenu()
  const geometry = await page.$eval('[data-session-ui-settings-menu]', menu => {
    const rect = menu.getBoundingClientRect()
    return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth }
  })
  assert.ok(geometry.left >= 7.5)
  assert.ok(geometry.right <= geometry.viewport - 7.5)
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-session-ui-settings-menu] button')].find(button => button.textContent?.includes('Show minimap'))?.disabled), true)
  assert.deepEqual(await page.evaluate(() => ({ scrollbar: localStorage.getItem('foxwarm.contextScrollbar.showScrollbar'), minimap: localStorage.getItem('foxwarm.contextScrollbar.showMinimap') })), { scrollbar: 'false', minimap: 'true' })
})

test('session menu clamps inside a narrow left split pane instead of clipping past its edge', async () => {
  await mountFixture(1000)
  await page.$eval('.foxwarm-chat-root', root => {
    root.style.width = '210px'
  })
  await openMenu()
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('.foxwarm-chat-root').getBoundingClientRect()
    const menu = document.querySelector('[data-session-ui-settings-menu]').getBoundingClientRect()
    return { rootLeft: root.left, rootRight: root.right, menuLeft: menu.left, menuRight: menu.right, menuWidth: menu.width }
  })
  assert.ok(geometry.menuLeft >= geometry.rootLeft + 7.5)
  assert.ok(geometry.menuRight <= geometry.rootRight - 7.5)
  assert.ok(geometry.menuWidth <= 194.5)
})

test('outer and embedded Chat roots synchronize all relocated preferences in both directions', async () => {
  await mountFixture()
  await page.evaluate(() => {
    for (const key of ['foxwarm_send_key_mode_v1', 'foxwarm_group_tools_v1', 'foxwarm_show_usage_badge_v1', 'foxwarm_show_user_message_metadata_v1']) localStorage.removeItem(key)
  })
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => !!window.chatSettingsFixture)
  await page.evaluate(src => {
    const iframe = document.createElement('iframe')
    iframe.id = 'embedded-preferences'
    iframe.src = src
    iframe.style.cssText = 'width:420px;height:640px;border:0'
    document.body.appendChild(iframe)
  }, fixtureUrl)
  const embeddedFrame = await page.waitForFrame(frame => frame.parentFrame() === page.mainFrame() && frame.url().startsWith(fixtureUrl))
  await embeddedFrame.waitForFunction(() => !!window.chatSettingsFixture)

  await openMenu()
  await clickMenuLabel('Enter')
  await clickMenuLabel('Group tools')
  await embeddedFrame.waitForFunction(() => window.chatSettingsFixture?.sendKeyMode === 'enter' && window.chatSettingsFixture?.groupTools === true)

  await embeddedFrame.$eval('button[aria-label="Open session options"]', button => button.click())
  await embeddedFrame.waitForSelector('[data-session-ui-settings-menu]')
  await embeddedFrame.evaluate(() => {
    const buttons = [...document.querySelectorAll('[data-session-ui-settings-menu] button')]
    for (const label of ['Show usage badges', 'Show user message metadata']) {
      const button = buttons.find(candidate => candidate.textContent?.trim() === label)
      if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing embedded menu button: ${label}`)
      button.click()
    }
  })
  await page.waitForFunction(() => window.chatSettingsFixture?.showUsageBadge === false && window.chatSettingsFixture?.showUserMessageMetadata === true)
  assert.deepEqual(await page.evaluate(() => ({
    sendKeyMode: window.chatSettingsFixture.sendKeyMode,
    groupTools: window.chatSettingsFixture.groupTools,
    showUsageBadge: window.chatSettingsFixture.showUsageBadge,
    showUserMessageMetadata: window.chatSettingsFixture.showUserMessageMetadata,
  })), { sendKeyMode: 'enter', groupTools: true, showUsageBadge: false, showUserMessageMetadata: true })
})
