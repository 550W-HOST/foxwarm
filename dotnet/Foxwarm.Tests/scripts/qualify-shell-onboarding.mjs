#!/usr/bin/env node
// Production WebUI and current C# onboarding routes, with owned state and listener.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createHostFixture } from '../../../packages/webui/test/mainHostFixture.mjs'

let page
const fixture = await createHostFixture('shell-onboarding', { env: {} })
try {
  await writeFile(fixture.modelPath, JSON.stringify({ default: 'local', providers: { local: { providerType: 'openai-responses', baseUrl: 'http://127.0.0.1:1', models: ['wire'] } } }))
  await fixture.start()
  assert.equal((await fixture.api('POST', '/api/sessions', { agentId: 'main', sessionId: 'onboarding' })).status, 200)
  page = await fixture.openApp()
  page.on('pageerror', error => console.error('Browser error:', error.message))
  const creates = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/nodes/onboarding/create')) creates.push(request.url())
  })
  async function click(text) {
    const element = await page.evaluateHandle(label => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === label), text)
    assert(element.asElement(), 'Missing button: ' + text)
    await element.asElement().click()
    await element.dispose()
  }
  const command = () => page.$eval('[data-node-command]', element => element.textContent)
  await page.click('[data-workbench-status-bar] button[aria-label^="Nodes:"]')
  await page.waitForSelector('[data-workbench-status-popup] [aria-label="Node directory"]')
  await click('Open Nodes')
  await page.waitForSelector('[data-node-surface]')
  await click('New nodes')
  await page.waitForSelector('[role="dialog"][aria-labelledby="node-onboarding-title"]')
  await page.waitForFunction(() => !!document.querySelector('[aria-label="Reachable address"]')?.value)
  await click('Windows Shell')
  assert.equal(await page.$('[data-node-command]'), null)
  assert.equal(await page.$('input[name="node-authentication"]'), null)
  assert.equal(creates.length, 0)
  await page.$eval('[aria-label="Node name"]', input => { input.focus(); input.select() })
  await page.keyboard.type('windows-shell')
  await click('Create')
  await page.waitForSelector('[data-node-command]')
  const windowsShell = await command()
  assert(windowsShell.includes('/node/run-shell.ps1'))
  assert(windowsShell.startsWith('& ([ScriptBlock]::Create('))
  assert(windowsShell.includes(" -NodeId 'windows-shell'"))
  assert(windowsShell.includes(' -AuthToken '))
  assert(!windowsShell.includes('-Pairing '))
  await click('Linux Shell')
  const posix = await command()
  assert(posix.includes('/node/run-shell.sh'))
  assert(posix.includes(' | NODE_AUTH_TOKEN='))
  assert(posix.includes(' sh -s -- --host='))
  assert(!posix.includes(' -o '))
  await click('Windows CLI')
  const modes = await page.$$('input[name="node-authentication"]')
  await modes[1].click()
  const cli = await command()
  assert(cli.startsWith('& ([ScriptBlock]::Create('))
  assert(cli.includes('/node/run.ps1'))
  assert(cli.includes(" -NodeId 'windows-shell'"))
  assert(!cli.includes('-OutFile'))
  assert.equal(creates.length, 1)
  const nodes = (await fixture.api('GET', '/api/nodes')).body.nodes
  assert.equal(nodes.filter(node => node.id === 'windows-shell').length, 1)
  await page.keyboard.press('Escape')
  await click('New nodes')
  await page.waitForSelector('[data-node-command]')
  await click('Windows Shell')
  assert.equal(await page.$('[data-node-command]'), null)
  assert.equal(creates.length, 1)
  console.log('PASS: explicit Windows Shell creation, direct-only auth, shared identity across dialects, streamed commands, and credential discard on close')
} catch (error) {
  if (page) console.error('Visible page:', await page.evaluate(() => document.body.innerText))
  throw error
} finally {
  await fixture.cleanup()
}
