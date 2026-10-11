import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'

const paneEntry = new URL('../src/components/WorkbenchPane.tsx', import.meta.url).pathname
let browser
let page
let server
let fixtureUrl

before(async () => {
  const source = `
    import React, { useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import { DndContext } from '@dnd-kit/core'
    import WorkbenchPane from ${JSON.stringify(paneEntry)}

    const tabs = [
      { id: 'broken-tab', type: 'chat', title: 'Broken' },
      { id: 'healthy-tab', type: 'chat', title: 'Healthy' },
    ]
    const healthyTab = [{ id: 'healthy-pane-tab', type: 'chat', title: 'Healthy pane' }]

    function Fixture() {
      const [activeTabId, setActiveTabId] = useState('broken-tab')
      const [recovered, setRecovered] = useState(false)
      const [closedTabs, setClosedTabs] = useState([])
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

      return React.createElement(DndContext, null,
        React.createElement('aside', { 'data-sidebar': true }, 'Sidebar remains available'),
        React.createElement('div', { 'data-pane': 'main' }, React.createElement(WorkbenchPane, {
          ...common,
          paneId: 'main-pane',
          tabs,
          activeTabId,
          hideTabStrip: false,
          renderContent: () => {
            if (activeTabId === 'healthy-tab') return React.createElement('div', { 'data-healthy-content': true }, 'Healthy tab content')
            if (recovered) return React.createElement('div', { 'data-recovered-content': true }, 'Recovered broken tab')
            throw new Error('fixture render callback failure')
          },
        })),
        React.createElement('div', { 'data-pane': 'healthy' }, React.createElement(WorkbenchPane, {
          ...common,
          paneId: 'healthy-pane',
          tabs: healthyTab,
          activeTabId: 'healthy-pane-tab',
          hideTabStrip: true,
          renderContent: () => React.createElement('div', { 'data-healthy-pane-content': true }, 'Healthy pane content'),
        })),
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
    response.end(`<html><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`)
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
  await page.waitForFunction(() => document.querySelector('[data-pane="main"]')?.textContent?.includes("This tab couldn't be displayed."))

  assert.match(await page.$eval('[data-sidebar]', element => element.textContent || ''), /Sidebar remains available/)
  assert.match(await page.$eval('[data-pane="healthy"]', element => element.textContent || ''), /Healthy pane content/)
  assert.equal(await page.$$eval('[data-pane="main"] button', buttons => buttons.filter(button => button.textContent === 'Retry').length), 1)
  assert.equal(await page.$$eval('[data-pane="main"] button', buttons => buttons.filter(button => button.textContent === 'Close').length), 1)
  await page.click('[data-pane="main"] button[aria-label="Close tab"]')
  await page.waitForFunction(() => window.closedTabs?.includes('broken-tab'))

  await page.evaluate(() => window.switchWorkbenchTab('healthy-tab'))
  await page.waitForSelector('[data-healthy-content]')
  assert.equal(await page.$('[data-recovered-content]'), null)

  await page.evaluate(() => window.switchWorkbenchTab('broken-tab'))
  await page.waitForFunction(() => document.querySelector('[data-pane="main"]')?.textContent?.includes("This tab couldn't be displayed."))

  await page.evaluate(() => window.recoverBrokenTab())
  await page.click('[data-pane="main"] button[aria-label="Retry tab"]')
  await page.waitForSelector('[data-recovered-content]')

})
