import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import puppeteer from 'puppeteer-core'
import { webuiReactAliases } from './reactRendererAliases.mjs'

const chromiumPath = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const componentEntry = fileURLToPath(new URL('../src/components/AgentCreationMenu.tsx', import.meta.url))
const themeEntry = fileURLToPath(new URL('../src/theme/index.ts', import.meta.url))
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const assetsDirectory = new URL('../dist/assets/', import.meta.url)

let browser
let page
let server
let fixtureUrl
let runtimeState = { available: true, reason: null }
let runtimeStatus = 200
let runtimeGate = null
let runtimeRequests = []

const initialAgents = [
  { id: 'main' },
  { id: 'research' },
  { id: 'design-review-with-a-deliberately-long-agent-name' },
  { id: 'release_ops' },
]

async function buildFixtureBundle() {
  const source = `
    import React, { useEffect, useState } from 'react'
    import { createRoot } from 'react-dom/client'
    import AgentCreationMenu from ${JSON.stringify(componentEntry)}
    import { initializeThemeRuntime, setThemeSelection } from ${JSON.stringify(themeEntry)}

    initializeThemeRuntime()
    window.fixtureCalls = []
    window.fixtureBehavior = { agent: 'success', session: 'success' }

    function waitForFixtureResolution(kind) {
      return new Promise((resolve, reject) => {
        window.fixturePending = { kind, resolve, reject }
      })
    }

    function Fixture() {
      const [agents, setAgents] = useState(${JSON.stringify(initialAgents)})
      useEffect(() => {
        window.fixture = {
          setAgents,
          setTheme: setThemeSelection,
          resetCalls() { window.fixtureCalls = [] },
          setBehavior(kind, behavior) { window.fixtureBehavior[kind] = behavior },
          resolvePending() { window.fixturePending?.resolve(); window.fixturePending = null },
        }
      }, [])

      const onCreateAgent = async (agentId, settings) => {
        window.fixtureCalls.push({ type: 'agent', agentId, ...settings })
        const behavior = window.fixtureBehavior.agent
        if (behavior === 'error') throw new Error('Agent request failed')
        if (behavior === 'pending') await waitForFixtureResolution('agent')
      }
      const onCreateSession = async (agentId, sessionId, runtime) => {
        window.fixtureCalls.push({ type: 'session', agentId, sessionId: sessionId ?? null, runtime })
        const behavior = window.fixtureBehavior.session
        if (behavior === 'error') throw new Error('Session request failed')
        if (behavior === 'pending') await waitForFixtureResolution('session')
      }

      return React.createElement('main', { className: 'min-h-screen bg-fw-canvas p-6 text-fw-text' },
        React.createElement('section', { className: 'w-[320px] max-w-full rounded-xl border border-fw-border bg-fw-surface p-4 shadow-sm' },
          React.createElement('div', { className: 'flex items-center justify-between gap-2' },
            React.createElement('div', null,
              React.createElement('div', { className: 'text-xs uppercase tracking-[0.18em] text-fw-text-muted' }, 'Workspace'),
              React.createElement('h1', { className: 'mt-1 text-lg font-semibold text-fw-text-strong' }, 'Agents')
            ),
            React.createElement(AgentCreationMenu, {
              agents,
              currentAgent: 'research',
              compact: true,
              onCreateAgent,
              onCreateSession,
            })
          ),
          React.createElement('p', { className: 'mt-4 text-sm text-fw-text-muted' }, 'Owned sidebar fixture.')
        )
      )
    }

    createRoot(document.getElementById('root')).render(React.createElement(Fixture))
  `
  const result = await build({
    absWorkingDir: packageRoot,
    stdin: { contents: source, loader: 'tsx', resolveDir: packageRoot, sourcefile: 'agent-creation-menu-fixture.tsx' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    alias: webuiReactAliases,
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

async function clickButtonByText(text) {
  const handle = await page.evaluateHandle((label) => {
    return [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === label) || null
  }, text)
  const element = handle.asElement()
  assert.ok(element, `button ${JSON.stringify(text)} should exist`)
  await element.click()
  await handle.dispose()
}

async function openSessionDialog() {
  await page.click('button[aria-label="New session"]')
  await page.waitForSelector('[role="dialog"]')
  await page.waitForFunction(() => document.querySelector('#creation-dialog-title')?.textContent === 'New session')
}

async function resetFixture() {
  runtimeState = { available: true, reason: null }
  runtimeStatus = 200
  runtimeGate = null
  runtimeRequests = []
  await page.setViewport({ width: 1100, height: 760, deviceScaleFactor: 1, isMobile: false, hasTouch: false })
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.fixture)
}

before(async () => {
  const assetNames = await readdir(assetsDirectory)
  const cssAsset = assetNames.find(name => /^index-.*\.css$/.test(name))
  assert.ok(cssAsset, 'build packages/webui before running the Agent creation browser test')
  const css = await readFile(new URL(cssAsset, assetsDirectory), 'utf8')
  const bundle = await buildFixtureBundle()

  server = createServer(async (request, response) => {
    if (request.url.endsWith('/api/nodes')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ nodes: [{ id: 'build-box', displayName: 'Build box', online: true }] }))
      return
    }
    if (request.url.endsWith('/api/setup/status')) {
      runtimeRequests.push(request.url)
      if (runtimeGate) await runtimeGate
      response.writeHead(runtimeStatus, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ capabilities: { claudeCode: runtimeState } }))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><style>html,body{margin:0;min-height:100%;overflow-x:hidden}</style></head><body><div id="root"></div><script>${bundle}</script></body></html>`)
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

test('the shared plus opens New session directly and submits the selected Agent tag', async () => {
  await resetFixture()
  await openSessionDialog()

  assert.equal(await page.$('[role="menu"]'), null)
  assert.equal(await page.$eval('button[title="research"]', button => button.getAttribute('aria-pressed')), 'true')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('placeholder')?.startsWith('Random ID')), true)

  await page.click('button[title="main"]')
  await page.type('input[placeholder^="Random ID"]', 'planned-session')
  await clickButtonByText('Create')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [
    { type: 'session', agentId: 'main', sessionId: 'planned-session', runtime: 'foxwarm' },
  ])

  await openSessionDialog()
  await clickButtonByText('Create')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls.at(-1)), {
    type: 'session', agentId: 'research', sessionId: null, runtime: 'foxwarm',
  })
})

test('New agent stays in one modal and cancel returns to the preserved session draft', async () => {
  await resetFixture()
  await openSessionDialog()
  await page.click('button[title="release_ops"]')
  await page.type('input[placeholder^="Random ID"]', 'keep-this-draft')
  await page.click('button[aria-label="New agent"]')
  await page.waitForFunction(() => document.querySelector('#creation-dialog-title')?.textContent === 'New agent')
  await page.waitForFunction(() => document.activeElement?.getAttribute('placeholder') === 'my-agent')

  assert.equal(await page.$$eval('[role="dialog"]', dialogs => dialogs.length), 1)
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('placeholder')), 'my-agent')

  await clickButtonByText('Cancel')
  await page.waitForFunction(() => document.querySelector('#creation-dialog-title')?.textContent === 'New session')
  assert.equal(await page.$eval('input[placeholder^="Random ID"]', input => input.value), 'keep-this-draft')
  assert.equal(await page.$eval('button[title="release_ops"]', button => button.getAttribute('aria-pressed')), 'true')

  await page.click('button[aria-label="New agent"]')
  await page.type('input[placeholder="my-agent"]', 'new_workspace')
  await page.select('select[data-agent-settings-inherit]', 'main')
  await clickButtonByText('Create')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [
    { type: 'agent', agentId: 'new_workspace', inheritAgent: 'main', defaultNode: null, defaultCwd: null, isolatedNode: null },
  ])
})

test('New agent uses the shared Agent settings: start location, and isolation that decides the Node', async () => {
  await resetFixture()
  await openSessionDialog()
  await page.click('button[aria-label="New agent"]')
  await page.waitForSelector('[data-agent-settings]')
  assert.equal(await page.$eval('[data-agent-settings-isolation-section]', details => details.open), false, 'isolation starts collapsed')
  await page.waitForSelector('select[data-agent-default-node] option[value="build-box"]')
  assert.equal(await page.$eval('select[data-agent-default-node] option[value=""]', option => option.textContent), 'master (default)')
  assert.equal(await page.$eval('input[data-agent-default-cwd]', input => input.placeholder), 'Absolute path on master')
  await page.type('input[placeholder="my-agent"]', 'builder')
  await page.select('select[data-agent-default-node]', 'build-box')
  assert.equal(await page.$eval('input[data-agent-default-cwd]', input => input.placeholder), 'Absolute path on Build box')
  await page.type('input[data-agent-default-cwd]', ' /srv/build ')

  await page.click('[data-agent-settings-isolation-section] summary')
  await page.select('select[data-agent-settings-isolation]', 'build-box')
  assert.equal(await page.$eval('select[data-agent-default-node]', select => select.disabled), true, 'isolation sets the Node')
  await page.select('select[data-agent-settings-isolation]', '')
  assert.equal(await page.$eval('select[data-agent-default-node]', select => [select.disabled, select.value].join()), 'false,build-box')

  await clickButtonByText('Create')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [
    { type: 'agent', agentId: 'builder', inheritAgent: null, defaultNode: 'build-box', defaultCwd: '/srv/build', isolatedNode: null },
  ])

  // New session names where the selected Agent starts.
  await page.evaluate(() => window.fixture.setAgents([
    { id: 'main' },
    { id: 'research', defaultNode: 'build-box', defaultCwd: '/srv/research' },
    { id: 'release_ops', isolated: true, isolatedNode: 'build-box', defaultCwd: '/srv/ops' },
    { id: 'notes', defaultCwd: '/srv/notes' },
  ]))
  await openSessionDialog()
  await page.waitForFunction(() => document.querySelector('[data-creation-start-location]')?.textContent === 'Starts on Build box · /srv/research')
  await page.click('button[title="main"]')
  assert.equal(await page.$('[data-creation-start-location]'), null, 'no line without placement settings')
  await page.click('button[title="release_ops"]')
  assert.equal(await page.$eval('[data-creation-start-location]', line => line.textContent), 'Starts on Build box', 'the working directory belongs to the default Node only')
  await page.click('button[title="notes"]')
  assert.equal(await page.$eval('[data-creation-start-location]', line => line.textContent), 'Starts on master · /srv/notes')
})

test('validation, request errors, and pending creation remain visible and keyboard-safe', async () => {
  await resetFixture()
  await openSessionDialog()
  await page.type('input[placeholder^="Random ID"]', 'contains/slash')
  await clickButtonByText('Create')
  assert.match(await page.$eval('[role="alert"]', alert => alert.textContent || ''), /cannot contain/)

  await page.evaluate(() => window.fixture.setBehavior('session', 'error'))
  await page.$eval('input[placeholder^="Random ID"]', input => { input.value = '' })
  await page.focus('input[placeholder^="Random ID"]')
  await page.keyboard.type('retry-me')
  await clickButtonByText('Create')
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent === 'Session request failed')

  await page.evaluate(() => window.fixture.setBehavior('session', 'pending'))
  await clickButtonByText('Create')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Creating…'))
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Cancel')?.disabled), true)
  await page.keyboard.press('Escape')
  assert.ok(await page.$('[role="dialog"]'))
  await page.evaluate(() => window.fixture.resolvePending())
  await page.waitForSelector('[role="dialog"]', { hidden: true })
})

test('empty Agent state focuses the accessible plus and still reaches New agent', async () => {
  await resetFixture()
  await page.evaluate(() => window.fixture.setAgents([]))
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('button[title="main"]'))
  await openSessionDialog()

  assert.match(await page.$eval('[role="dialog"]', dialog => dialog.textContent || ''), /No agents yet/)
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'New agent')
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'New agent')
  assert.equal(await page.$eval('button[type="submit"]', button => button.disabled), true)

  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('#creation-dialog-title')?.textContent === 'New agent')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('#creation-dialog-title')?.textContent === 'New session')
  assert.match(await page.$eval('[role="dialog"]', dialog => dialog.textContent || ''), /No agents yet/)
})

test('Agent tags wrap without horizontal overflow across themes and narrow screens', async () => {
  await resetFixture()
  await page.setViewport({ width: 320, height: 420, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
  await page.evaluate(() => window.fixture.setAgents([
    { id: 'main' },
    { id: 'research-and-prototyping' },
    { id: 'design-review-with-a-deliberately-long-agent-name-that-must-not-overflow' },
    { id: 'release_ops' },
    { id: 'documentation' },
    { id: 'frontend' },
    { id: 'backend' },
    { id: 'browser-tests' },
    { id: 'release-validation' },
    { id: 'security-review' },
    { id: 'customer-support' },
    { id: 'infrastructure' },
  ]))
  await openSessionDialog()

  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    const tags = [...dialog.querySelectorAll('fieldset button')]
    const tops = tags.map(tag => Math.round(tag.getBoundingClientRect().top))
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
      dialogScrolls: dialog.scrollHeight > dialog.clientHeight && getComputedStyle(dialog).overflowY === 'auto',
      rowCount: new Set(tops).size,
      plusIsLast: tags.at(-1)?.getAttribute('aria-label') === 'New agent',
    }
  })
  assert.equal(geometry.documentOverflow, 0)
  assert.ok(geometry.dialogOverflow <= 1)
  assert.equal(geometry.dialogScrolls, true)
  assert.ok(geometry.rowCount > 1)
  assert.equal(geometry.plusIsLast, true)

  for (const themeId of ['foxwarm.default', 'foxwarm.550a']) {
    for (const colorMode of ['light', 'dark']) {
      await page.evaluate(({ themeId, colorMode }) => window.fixture.setTheme({ themeId, colorMode }), { themeId, colorMode })
      const appearance = await page.$eval('button[aria-pressed="true"]', button => ({
        background: getComputedStyle(button).backgroundColor,
        border: getComputedStyle(button).borderColor,
        color: getComputedStyle(button).color,
      }))
      assert.notEqual(appearance.background, 'rgba(0, 0, 0, 0)')
      assert.notEqual(appearance.border, appearance.color)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true)
    }
  }
})


test('creation carries the chosen runtime and each new dialog defaults back to Foxwarm', async () => {
  await resetFixture()
  await openSessionDialog()
  assert.equal(await page.$eval('select[aria-label="Session runtime"]', select => select.value), 'foxwarm')
  await page.waitForFunction(() => !document.querySelector('option[value="claude-code"]')?.disabled)
  await page.select('select[aria-label="Session runtime"]', 'claude-code')
  await clickButtonByText('Create')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls.at(-1)), { type: 'session', agentId: 'research', sessionId: null, runtime: 'claude-code' })
  await openSessionDialog()
  assert.equal(await page.$eval('select[aria-label="Session runtime"]', select => select.value), 'foxwarm')
})


test('unavailable launchers are disabled with the server reason while Foxwarm creation stays usable', async () => {
  await resetFixture()
  runtimeState = { available: false, reason: 'Install the configured launcher on Main.' }
  await openSessionDialog()
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Install the configured launcher'))
  assert.equal(await page.$eval('option[value="claude-code"]', option => option.disabled), true)
  assert.match(await page.$eval('option[value="claude-code"]', option => option.textContent), /unavailable/)
  await clickButtonByText('Create')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.equal(await page.evaluate(() => window.fixtureCalls.at(-1).runtime), 'foxwarm')

  runtimeState = { available: true, reason: null }
  await openSessionDialog()
  await page.waitForFunction(() => !document.querySelector('option[value="claude-code"]')?.disabled)
  assert.equal(runtimeRequests.length, 2, 'reopening checks changed launcher state')
})

test('loading, failed requests and absent capability data never enable Claude Code', async () => {
  await resetFixture()
  let release
  runtimeGate = new Promise(resolve => { release = resolve })
  await openSessionDialog()
  assert.equal(await page.$eval('option[value="claude-code"]', option => option.disabled), true)
  assert.match(await page.$eval('option[value="claude-code"]', option => option.textContent), /checking/)
  runtimeStatus = 503
  release()
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Could not check'))
  assert.equal(await page.$eval('option[value="claude-code"]', option => option.disabled), true)
  await page.keyboard.press('Escape')
  runtimeGate = null
  runtimeStatus = 200
  runtimeState = undefined
  await openSessionDialog()
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('Could not check'))
  assert.equal(await page.$eval('option[value="claude-code"]', option => option.disabled), true)
  await clickButtonByText('Create')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.equal(await page.evaluate(() => window.fixtureCalls.at(-1).runtime), 'foxwarm')
})

test('availability requests respect the deployment base path', async () => {
  await resetFixture()
  await page.goto(fixtureUrl + '/preview/', { waitUntil: 'load' })
  await page.waitForFunction(() => !!window.fixture)
  await openSessionDialog()
  await page.waitForFunction(() => !document.querySelector('option[value="claude-code"]')?.disabled)
  assert.equal(runtimeRequests.at(-1), '/preview/api/setup/status')
})


test('returning from New agent rechecks a selected Claude runtime and prevents unavailable submission', async () => {
  await resetFixture()
  await openSessionDialog()
  await page.waitForFunction(() => !document.querySelector('option[value="claude-code"]')?.disabled)
  await page.select('select[aria-label="Session runtime"]', 'claude-code')
  await page.click('button[aria-label="New agent"]')
  runtimeState = { available: false, reason: 'The launcher is no longer installed.' }
  await clickButtonByText('Cancel')
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes('no longer installed'))
  assert.equal(await page.$eval('select[aria-label="Session runtime"]', select => select.value), 'claude-code')
  assert.equal(await page.$eval('[role="dialog"] button[type="submit"]', button => button.disabled), true)
  await page.focus('input[placeholder^="Random ID"]')
  await page.keyboard.press('Enter')
  assert.deepEqual(await page.evaluate(() => window.fixtureCalls), [])
  await page.select('select[aria-label="Session runtime"]', 'foxwarm')
  await clickButtonByText('Create')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  assert.equal(await page.evaluate(() => window.fixtureCalls.at(-1).runtime), 'foxwarm')
})
