import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const paneEntry = new URL('../src/components/WorkbenchPane.tsx', import.meta.url).pathname
const hostEntry = new URL('../src/components/WorkbenchContentHost.tsx', import.meta.url).pathname
let browser
let page
let server
let fixtureUrl

before(async () => {
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssFile = (await readdir(assets)).find(name => /^index-.*\.css$/.test(name))
  const css = await readFile(new URL(cssFile, assets), 'utf8')
  const source = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { DndContext } from '@dnd-kit/core'
    import WorkbenchPane from ${JSON.stringify(paneEntry)}
    import WorkbenchContentHost, { WorkbenchContentProvider, WorkbenchContentSlot, WorkbenchContentLayer } from ${JSON.stringify(hostEntry)}

    const tabs = [
      { id: 'broken-tab', type: 'chat', title: 'Broken' },
      { id: 'healthy-tab', type: 'chat', title: 'Healthy' },
    ]
    const healthyTab = [{ id: 'healthy-pane-tab', type: 'chat', title: 'Healthy pane' }]

    function Fixture() {
      const [activeTabId, setActiveTabId] = useState('broken-tab')
      const [recovered, setRecovered] = useState(false)
      const [closedTabs, setClosedTabs] = useState([])
      const [paneId, setPaneId] = useState('main-pane')
      window.moveBrokenTab = () => setPaneId('moved-pane')
      window.recoverBrokenTab = () => setRecovered(true)
      window.switchWorkbenchTab = (tabId) => setActiveTabId(tabId)
      window.closedTabs = closedTabs

      const common = {
        focused: true,
        canClosePane: false,
        onFocusPane: () => {},
        onSelectTab: setActiveTabId,
        onCloseTab: (tabId) => setClosedTabs(current => [...current, tabId]),
        onKeepTab: () => {},
        onMoveTabToNewWindow: () => {},
        canMoveTabToNewWindow: () => false,
        onCloseOtherTabs: () => {},
        onCloseAllTabs: () => {},
        onSplitRight: () => {},
        onSplitDown: () => {},
        onClosePane: () => {},
      }

      const activeTab = tabs.find(tab => tab.id === activeTabId)
      return React.createElement(DndContext, null,
        React.createElement(WorkbenchContentProvider, null,
          React.createElement('aside', { 'data-sidebar': true }, 'Sidebar remains available'),
          React.createElement('div', { style: { width: 500, height: 300 }, 'data-pane': 'main' }, React.createElement(WorkbenchPane, {
            ...common, paneId, tabs, activeTabId, collapseDirection: 'column', collapsed: false,
            contentSlot: React.createElement(WorkbenchContentSlot, { paneId, soleTab: false }),
          })),
          React.createElement('div', { style: { width: 500, height: 300 }, 'data-pane': 'healthy' }, React.createElement(WorkbenchPane, {
            ...common, paneId: 'healthy-pane', tabs: healthyTab, activeTabId: 'healthy-pane-tab', collapseDirection: 'column', collapsed: false,
            contentSlot: React.createElement(WorkbenchContentSlot, { paneId: 'healthy-pane', soleTab: true }),
          })),
          React.createElement(WorkbenchContentLayer, null,
            React.createElement(WorkbenchContentHost, {
              ...common, key: activeTabId, tab: activeTab, paneId, tabs, visible: true, collapseDirection: 'column',
              renderContent: () => {
                if (activeTabId === 'healthy-tab') return React.createElement('div', { 'data-healthy-content': true }, 'Healthy tab content')
                if (recovered) return React.createElement('div', { 'data-recovered-content': true }, 'Recovered broken tab')
                throw new Error('fixture render callback failure')
              },
            }),
            React.createElement(WorkbenchContentHost, {
              ...common, tab: healthyTab[0], paneId: 'healthy-pane', tabs: healthyTab, visible: true, collapseDirection: 'column',
              renderContent: () => React.createElement('div', { 'data-healthy-pane-content': true }, 'Healthy pane content'),
            }),
          ),
        ),
      )
    }

    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
  `
  const bundle = await build({
    stdin: { contents: source, resolveDir: new URL('..', import.meta.url).pathname, sourcefile: 'workbench-tab-error-boundary-fixture.tsx' },
    bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', write: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') }, logLevel: 'silent',
  })
  server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<html><head><style>${css}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fixtureUrl = `http://127.0.0.1:${server.address().port}`
  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  page = await browser.newPage()
})

after(async () => {
  await browser?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

test('tab render failures stay inside the tab, retry explicitly, reset by tab identity, and close through pane callbacks', async () => {
  await page.goto(fixtureUrl)
  await page.waitForFunction(() => document.querySelector('[data-workbench-content-pane="main-pane"]')?.textContent?.includes("This tab couldn't be displayed."))

  assert.match(await page.$eval('[data-sidebar]', element => element.textContent || ''), /Sidebar remains available/)
  assert.match(await page.$eval('[data-workbench-content-pane="healthy-pane"]', element => element.textContent || ''), /Healthy pane content/)
  assert.equal(await page.$$eval('[data-workbench-content-pane="main-pane"] button', buttons => buttons.filter(button => button.textContent === 'Retry').length), 1)
  assert.equal(await page.$$eval('[data-workbench-content-pane="main-pane"] button', buttons => buttons.filter(button => button.textContent === 'Close').length), 1)
  await page.click('[data-workbench-content-pane="main-pane"] button[aria-label="Close tab"]')
  await page.waitForFunction(() => window.closedTabs?.includes('broken-tab'))

  await page.evaluate(() => window.switchWorkbenchTab('healthy-tab'))
  await page.waitForSelector('[data-healthy-content]')
  assert.equal(await page.$('[data-recovered-content]'), null)

  await page.evaluate(() => window.switchWorkbenchTab('broken-tab'))
  await page.waitForFunction(() => document.querySelector('[data-workbench-content-pane="main-pane"]')?.textContent?.includes("This tab couldn't be displayed."))

  await page.evaluate(() => window.recoverBrokenTab())
  await page.evaluate(() => window.moveBrokenTab())
  await page.waitForFunction(() => document.querySelector('[data-workbench-content-pane="moved-pane"]')?.textContent?.includes("This tab couldn't be displayed."))
  assert.ok(await page.$('[data-sidebar]'), 'moving the failing content leaves the shell mounted')
  assert.equal(await page.$('[data-recovered-content]'), null, 'moving a repaired renderer does not reset the existing tab failure before Retry')
  await page.click('[data-workbench-content-pane="moved-pane"] button[aria-label="Retry tab"]')
  await page.waitForSelector('[data-recovered-content]')

})
