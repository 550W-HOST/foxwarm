import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const componentEntry = new URL('../src/components/GlobalUiSettingsMenu.tsx', import.meta.url).pathname
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page
let server
let fixtureUrl

async function buildFixtureBundle() {
  const source = `
    import React, { useEffect, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import GlobalUiSettingsMenu from ${JSON.stringify(componentEntry)}

    import Sidebar from ${JSON.stringify(new URL('../src/components/Sidebar.tsx', import.meta.url).pathname)}

    function SidebarFixture() {
      const [view, setView] = useState('session')
      const noop = () => {}
      return React.createElement('div', { style: { width: 'min(340px, 100vw)', height: '100dvh' } },
        React.createElement(Sidebar, {
          sessions: Array.from({ length: 50 }, (_, i) => ({ id: 'demo/s' + i, displayName: 'Session ' + i, messageCount: 2, lastMessageTime: 100-i, parentSessionId: null })),
          agents: [], currentSession: 'demo/s0', currentView: view,
          onSelectSession: noop, onSelectArchitecture: noop, onSelectSetup: () => setView('setup'),
          codePath: '/', codeNodeId: 'master', codeOpenInNewWindow: false, codeActive: false,
          nodeTargets: [], onRefreshNodeTargets: noop, onOpenCode: noop, onCodeNodeChange: noop,
          onCodePathChange: noop, onCodeOpenInNewWindowChange: noop, onCreateTerminalTab: noop,
          onCreateAgent: async () => {}, onCreateSession: async () => {}, onToggleCollapsed: noop,
          idleNotificationModes: {}, onToggleIdleNotificationMode: noop,
        })
      )
    }

    function Fixture() {
      const [anchorLeft, setAnchorLeft] = useState('640px')
      const [align, setAlign] = useState('end')
      useEffect(() => {
        window.settingsMenuFixture = {
          place(left, nextAlign = 'end') {
            setAnchorLeft(left)
            setAlign(nextAlign)
          },
        }
      }, [])

      return React.createElement(React.Fragment, null,
        React.createElement('div', { id: 'anchor', style: { position: 'absolute', top: '24px', left: anchorLeft } },
          React.createElement(GlobalUiSettingsMenu, {
            menuAlign: align,
            onOpenSetup() {},
          })
        ),
        React.createElement('button', { id: 'outside', type: 'button' }, 'Outside')
      )
    }

    createRoot(document.getElementById('root')).render(React.createElement(location.search === '?sidebar' ? SidebarFixture : Fixture))
  `
  const result = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'settings-menu-position-fixture.tsx' },
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

async function mountFixture(viewport) {
  await page.setViewport(viewport)
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.settingsMenuFixture)
}

async function placeAnchor(left, align = 'end') {
  await page.evaluate((next) => window.settingsMenuFixture.place(next.left, next.align), { left, align })
  await page.waitForFunction((expected) => document.getElementById('anchor').style.left === expected, {}, left)
}

async function openMenu() {
  await page.click('button[aria-label="Open UI settings"]')
  await page.waitForFunction(() => {
    const menu = document.querySelector('[data-global-ui-settings-menu]')
    return menu && getComputedStyle(menu).visibility === 'visible'
  })
}

async function readGeometry() {
  return page.evaluate(() => {
    const menu = document.querySelector('[data-global-ui-settings-menu]').getBoundingClientRect()
    const button = document.querySelector('button[aria-label="Open UI settings"]').getBoundingClientRect()
    return {
      menu: { left: menu.left, right: menu.right, width: menu.width },
      button: { left: button.left, right: button.right },
      viewportWidth: document.documentElement.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

async function waitForClampedMenu() {
  await page.waitForFunction(() => {
    const menu = document.querySelector('[data-global-ui-settings-menu]')?.getBoundingClientRect()
    return menu && menu.left >= 7.5 && menu.right <= document.documentElement.clientWidth - 7.5
  })
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the settings-menu browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()

  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body{margin:0!important;max-width:none!important;overflow-x:auto!important}body{min-height:100vh}#outside{position:absolute;left:8px;bottom:8px}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
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

test('desktop keeps preferred end alignment when there is enough space', async () => {
  await mountFixture({ width: 1200, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await placeAnchor('640px')
  await openMenu()
  const geometry = await readGeometry()
  assert.ok(Math.abs(geometry.menu.right - geometry.button.right) <= 1)
  assert.equal(geometry.documentOverflow, 0)
})

test('desktop clamps an end-aligned menu rightward when its trigger is near the left viewport edge', async () => {
  await mountFixture({ width: 1200, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await placeAnchor('4px')
  await openMenu()
  await waitForClampedMenu()
  const geometry = await readGeometry()
  assert.ok(geometry.menu.left >= 7.5)
  assert.ok(geometry.menu.right <= geometry.viewportWidth - 7.5)
  assert.equal(geometry.documentOverflow, 0)
})

test('viewport resize and start alignment clamp both horizontal edges', async () => {
  await mountFixture({ width: 900, height: 760, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await placeAnchor('40vw')
  await openMenu()
  let geometry = await readGeometry()
  assert.ok(Math.abs(geometry.menu.right - geometry.button.right) <= 1)

  await page.setViewport({ width: 320, height: 760, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await waitForClampedMenu()
  geometry = await readGeometry()
  assert.ok(geometry.menu.left >= 7.5)
  assert.ok(geometry.menu.right <= geometry.viewportWidth - 7.5)
  assert.equal(geometry.documentOverflow, 0)

  await page.keyboard.press('Escape')
  await placeAnchor('300px', 'start')
  await openMenu()
  await waitForClampedMenu()
  geometry = await readGeometry()
  assert.ok(geometry.menu.right <= geometry.viewportWidth - 7.5)
  assert.equal(geometry.documentOverflow, 0)
})

test('mobile and Code-embedded sidebar widths keep the whole menu inside a gutter', async () => {
  await mountFixture({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 })
  await placeAnchor('4px')
  await openMenu()
  await waitForClampedMenu()
  let geometry = await readGeometry()
  assert.ok(geometry.menu.left >= 7.5)
  assert.ok(geometry.menu.right <= 382.5)
  assert.equal(geometry.documentOverflow, 0)

  const client = await page.createCDPSession()
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 })
  await page.waitForFunction(() => window.visualViewport && window.visualViewport.width < 250)
  await page.waitForFunction(() => {
    const menu = document.querySelector('[data-global-ui-settings-menu]')?.getBoundingClientRect()
    const viewport = window.visualViewport
    return menu && viewport && menu.left >= viewport.offsetLeft + 7.5 && menu.right <= viewport.offsetLeft + viewport.width - 7.5
  })
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })

  await page.keyboard.press('Escape')
  await page.setViewport({ width: 240, height: 800, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await placeAnchor('188px')
  await openMenu()
  await waitForClampedMenu()
  geometry = await readGeometry()
  assert.ok(geometry.menu.left >= 7.5)
  assert.ok(geometry.menu.right <= 232.5)
  assert.ok(geometry.menu.width <= 224.5)
  assert.equal(geometry.documentOverflow, 0)
})

test('Escape, outside click, and menu-item selection retain their dismissal behavior', async () => {
  await mountFixture({ width: 900, height: 760, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await placeAnchor('500px')
  await openMenu()
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-global-ui-settings-menu]', { hidden: true })

  await openMenu()
  await page.click('#outside')
  await page.waitForSelector('[data-global-ui-settings-menu]', { hidden: true })

  await openMenu()
  const lightButton = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'light'))
  await lightButton.click()
  await page.waitForSelector('[data-global-ui-settings-menu]', { hidden: true })
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('foxwarm_theme_selection_v2')).colorMode), 'light')
})

test('global UI settings keeps only the Auto, Light, and Dark color-mode controls', async () => {
  await mountFixture({ width: 900, height: 760, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await openMenu()
  assert.equal(await page.$('select[aria-label="Theme"]'), null)
  assert.equal(await page.$('button::-p-text(Import)'), null)
  const text = await page.$eval('[data-global-ui-settings-menu]', menu => menu.textContent || '')
  for (const movedLabel of ['Input', 'Chat', 'Group tools', 'Show minimap', 'Rename instance', 'tab icon']) {
    assert.equal(text.includes(movedLabel), false, `${movedLabel} is not duplicated in global settings`)
  }
  assert.deepEqual(await page.$$eval('[data-global-ui-settings-menu] button', buttons => buttons.map(button => button.textContent?.trim()).filter(text => ['auto', 'light', 'dark'].includes(text?.toLowerCase() || '')).map(text => text?.toLowerCase())), ['auto', 'light', 'dark'])
})


test('sidebar Settings lives in a fixed footer and opens upward on desktop and touch', async () => {
  for (const mobile of [false, true]) {
    await page.setViewport({ width: mobile ? 320 : 1000, height: mobile ? 480 : 700, isMobile: mobile, hasTouch: mobile })
    await page.goto(fixtureUrl + '?sidebar', { waitUntil: 'load' })
    const trigger = '[data-sidebar-footer] button[aria-label="Open UI settings"]'
    await page.waitForSelector(trigger)
    assert.equal(await page.$$eval('button[aria-label="Open UI settings"]', els => els.length), 1)
    const topBefore = await page.$eval(trigger, e => e.getBoundingClientRect().top)
    await page.$eval('[data-session-list-scroll-container]', e => { e.scrollTop = e.scrollHeight })
    assert.equal(await page.$eval(trigger, e => e.getBoundingClientRect().top), topBefore)
    assert.equal(await page.$eval('[data-sidebar-footer]', e => e.closest('[data-session-list-scroll-container]') === null), true)
    await page.focus(trigger)
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-global-ui-settings-menu]')).visibility === 'visible')
    const geometry = await page.evaluate(() => {
      const menu = document.querySelector('[data-global-ui-settings-menu]').getBoundingClientRect()
      const trigger = document.querySelector('[data-sidebar-footer] button').getBoundingClientRect()
      return { top: menu.top, bottom: menu.bottom, left: menu.left, right: menu.right, triggerTop: trigger.top, triggerBottom: trigger.bottom, height: innerHeight, width: innerWidth }
    })
    assert.ok(geometry.top >= 7.5 && geometry.bottom < geometry.triggerTop)
    assert.ok(geometry.left >= 7.5 && geometry.right <= geometry.width - 7.5)
    assert.ok(geometry.triggerBottom <= geometry.height && geometry.triggerBottom >= geometry.height - 12)
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('[data-global-ui-settings-menu]')), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.$('[data-global-ui-settings-menu]'), null)
    assert.equal(await page.$eval(trigger, e => e === document.activeElement), true)
    if (mobile) await page.tap(trigger)
    else await page.click(trigger)
    await page.waitForSelector('[data-global-ui-settings-menu]')
    await page.$$eval('[data-global-ui-settings-menu] button', buttons => buttons.find(e => e.textContent.includes('WebUI: Open setup')).click())
    assert.equal(await page.$eval(trigger, e => e.getAttribute('aria-pressed')), 'true')
    await page.click(trigger)
    assert.ok(await page.$('[data-global-ui-settings-menu]'))
    assert.equal(await page.$$eval('[data-global-ui-settings-menu] button', buttons => buttons.some(e => e.textContent.includes('WebUI: reload'))), true)
    await page.$$eval('[data-global-ui-settings-menu] button', buttons => buttons.find(e => e.textContent === 'dark').click())
    assert.equal(await page.$('[data-global-ui-settings-menu]'), null)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true)
    await page.click(trigger)
    await page.click('h1')
    assert.equal(await page.$('[data-global-ui-settings-menu]'), null)
  }
})
