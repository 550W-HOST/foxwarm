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

    function Fixture() {
      const [anchorLeft, setAnchorLeft] = useState('640px')
      const [align, setAlign] = useState('end')
      const [themeMode, setThemeMode] = useState('auto')
      const [selectionCount, setSelectionCount] = useState(0)

      useEffect(() => {
        window.settingsMenuFixture = {
          place(left, nextAlign = 'end') {
            setAnchorLeft(left)
            setAlign(nextAlign)
          },
          selectionCount() { return selectionCount },
        }
      }, [selectionCount])

      return React.createElement(React.Fragment, null,
        React.createElement('div', { id: 'anchor', style: { position: 'absolute', top: '24px', left: anchorLeft } },
          React.createElement(GlobalUiSettingsMenu, {
            themeMode,
            onThemeChange(mode) { setThemeMode(mode); setSelectionCount(count => count + 1) },
            uiThemeStyle: 'default',
            onUiThemeStyleChange() {},
            sendKeyMode: 'modEnter',
            onSendKeyModeChange() {},
            groupTools: true,
            onGroupToolsChange() {},
            showUsageBadge: true,
            onShowUsageBadgeChange() {},
            instanceName: '',
            onInstanceNameChange() {},
            tabIcon: '',
            onTabIconChange() {},
            menuAlign: align,
            onOpenSetup() {},
          })
        ),
        React.createElement('button', { id: 'outside', type: 'button' }, 'Outside')
      )
    }

    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
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
  const beforeExpansion = await readGeometry()
  const renameButton = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Rename instance')))
  await renameButton.click()
  await page.waitForSelector('#webui-instance-name')
  const afterExpansion = await readGeometry()
  assert.ok(Math.abs(afterExpansion.menu.left - beforeExpansion.menu.left) <= 1)
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-global-ui-settings-menu]', { hidden: true })

  await openMenu()
  await page.click('#outside')
  await page.waitForSelector('[data-global-ui-settings-menu]', { hidden: true })

  await openMenu()
  const lightButton = await page.evaluateHandle(() => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === 'light'))
  await lightButton.click()
  await page.waitForSelector('[data-global-ui-settings-menu]', { hidden: true })
  assert.equal(await page.evaluate(() => window.settingsMenuFixture.selectionCount()), 1)
})