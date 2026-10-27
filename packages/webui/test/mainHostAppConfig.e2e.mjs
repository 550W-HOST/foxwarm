import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { createHostFixture, until } from './mainHostFixture.mjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

const fixture = await createHostFixture('app-config')
const initialRaw = (origin, port, prefix = '/preview') => `# preserve this comment\nurl: ${origin}${prefix}\nbot:\n  httpPort: ${port}\n  enableWebUI: true\n  customBotField: retained\nllm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n  compactThresholdPercent: 0.85\nnodeProviders:\n  retained:\n    type: executable\n    command: /bin/echo\nvector: false\naccess:\n  identities: {}\nchannels:\n  webui:\n    type: webui\n    enabled: true\n  weixin:\n    type: weixin\n    enabled: false\n    token: saved-token\n    customChannelField: keep-me\n  mystery:\n    type: future-chat\n    enabled: true\n`

let page
let browser
try {
  const raw = initialRaw(fixture.origin, fixture.port)
  await writeFile(`${fixture.data}/state/config.yaml`, raw)
  await fixture.start()
  const api = (path, method = 'GET', body) => fetch(`${fixture.origin}/preview${path}`, {
    method,
    headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async response => ({ status: response.status, body: await response.json().catch(() => ({})) }))

  const statusBefore = await api('/api/setup/status')
  assert.equal(statusBefore.status, 200, JSON.stringify(statusBefore))
  assert.equal(statusBefore.body.config.rawYaml, raw)
  assert.equal(statusBefore.body.capabilities.managedChannels, true)
  assert.equal(statusBefore.body.channels.find(channel => channel.channelId === 'webui').running, true)
  const weixin = statusBefore.body.channels.find(channel => channel.channelId === 'weixin')
  assert.equal(weixin.running, false); assert.equal(weixin.managed, true); assert.equal(weixin.enabled, false)
  assert.equal(weixin.configured, true)
  const mystery = statusBefore.body.channels.find(channel => channel.channelId === 'mystery')
  assert.equal(mystery.running, false); assert.equal(mystery.managed, false)
  assert.match(mystery.lastError, /Adapter is not implemented/)

  const invalids = [
    raw.replace('type: executable', 'type: docker-worktree'),
    raw.replace('compactKeepPercent: 0.3', 'compactKeepPercent: 2'),
    raw.replace('command: /bin/echo', 'command: null'),
    raw.replace('command: /bin/echo', 'timeoutSeconds: null\n    command: /bin/echo'),
    raw.replace('access:\n  identities: {}', 'access:\n  identities: { a: { token: synthetic, surfaces: {} } }'),
    raw.replace('access:\n  identities: {}', 'access:\n  identities: { a: { token: duplicate, surfaces: {mcp: {}} }, b: { token: duplicate, surfaces: {mcp: {}} } }'),
    raw.replace('vector: false', 'vector: null'),
    raw.replace(`${fixture.origin}/preview`, 'http://bad\\host/preview'),
  ]
  for (const candidate of invalids) {
    const invalid = await api('/api/setup/config', 'POST', { yaml: candidate })
    assert.equal(invalid.status, 400, JSON.stringify(invalid))
    assert.equal(await readFile(`${fixture.data}/state/config.yaml`, 'utf8'), raw)
  }
  const conflictRaw = raw.replace('  webui:\n    type: webui', '  webui:\n    type: telegram')
  const conflictSave = await api('/api/setup/config', 'POST', { yaml: conflictRaw })
  assert.equal(conflictSave.status, 200, JSON.stringify(conflictSave))
  const conflictStatus = await api('/api/setup/status')
  const conflictRows = conflictStatus.body.channels.filter(channel => channel.channelId === 'webui')
  assert.equal(conflictRows.length, 1)
  assert.equal(conflictRows[0].type, 'webui')
  assert.equal(conflictRows[0].running, true)
  assert.equal(conflictRows[0].managed, false)
  assert.equal(conflictStatus.body.channels.some(channel => channel.channelId === 'main-webui'), false)
  const conflictRestore = await api('/api/setup/config', 'POST', { yaml: raw })
  assert.equal(conflictRestore.status, 200, JSON.stringify(conflictRestore))

  const legacyIgnored = raw.replace('vector: false\n', '').replace('compactThresholdPercent: 0.85', 'compactThresholdPercent: 0.85\n  ollamaBaseUrl: 42')
  const legacySave = await api('/api/setup/config', 'POST', { yaml: legacyIgnored })
  assert.equal(legacySave.status, 200, JSON.stringify(legacySave))
  assert.equal(await readFile(`${fixture.data}/state/config.yaml`, 'utf8'), legacyIgnored)
  const restore = await api('/api/setup/config', 'POST', { yaml: raw })
  assert.equal(restore.status, 200, JSON.stringify(restore))

  const savedRaw = raw.replace('customBotField: retained', 'customBotField: retained\n  newUnknownField: preserved')
  const saved = await api('/api/setup/config', 'POST', { yaml: savedRaw })
  assert.equal(saved.status, 200, JSON.stringify(saved))
  assert.equal(saved.body.saved, true)
  assert.equal(saved.body.target, 'config')
  assert.deepEqual(saved.body.applied, ['access.identities', 'access.surfaces.mcp', 'channels'])
  assert.deepEqual(saved.body.notApplied, ['channels.mystery'])
  assert(saved.body.restartRequired.includes('bot'))
  assert.equal(saved.body.reload.available, true)
  assert.deepEqual(saved.body.reload.started, [])
  assert.deepEqual(saved.body.reload.stopped, [])
  assert.equal(await readFile(`${fixture.data}/state/config.yaml`, 'utf8'), savedRaw)
  const statusAfter = await api('/api/setup/status')
  assert.equal(statusAfter.body.config.rawYaml, savedRaw)

  const channelRaw = savedRaw

  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: `${fixture.root}/browser` })
  page = await browser.newPage()
  await page.goto(`${fixture.origin}/preview/`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('input[type="password"]')
  await page.type('input[type="password"]', fixture.token)
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
  await waitForWebUiReady(page)
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-config')
  await page.click('#setup-tab-config')
  const editor = '[aria-label="Application config YAML editor"] [role="textbox"]'
  await page.waitForSelector(editor, { visible: true })
  assert.equal(await page.$eval('body', body => body.innerText.includes('External chat channels are unavailable on this server.')), false)
  assert.equal(await page.$eval('body', body => body.innerText.includes('Start Weixin login')), true)
  const uiRaw = channelRaw.replace('customChannelField: keep-me', 'customChannelField: ui-edited')
  await page.focus(editor)
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control')
  await page.keyboard.sendCharacter(uiRaw.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))
  await new Promise(resolve => setTimeout(resolve, 500))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Save config')?.click())
  await until(async () => Boolean(await page.$eval('[data-save-feedback="config"]', node => node.getAttribute('role') === 'status' && node.textContent?.trim()).catch(() => false)), 'UI config save', 10000).catch(async error => {
    const debug = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll('button')].map(button => ({ text: button.textContent?.trim(), disabled: button.disabled })),
      feedback: document.querySelector('[data-save-feedback="config"]')?.textContent || null,
      error: document.body.innerText.slice(-1000),
    }))
    throw new Error(`${error.message}: ${JSON.stringify(debug)}`)
  })
  const originalSetupFeedback = await page.$eval('[data-save-feedback="config"]', node => node.textContent)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#setup-tab-config')
  const afterUiRaw = await readFile(`${fixture.data}/state/config.yaml`, 'utf8')
  assert.equal(afterUiRaw, uiRaw)
  const afterUiStatus = await api('/api/setup/status')
  assert.equal(afterUiStatus.body.config.rawYaml, uiRaw)

  const restartRaw = uiRaw.replace(`${fixture.origin}/preview`, `${fixture.origin}/next`)
  const nextApi = (path, method = 'GET', body) => fetch(`${fixture.origin}/next${path}`, {
    method,
    headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async response => ({ status: response.status, body: await response.json().catch(() => ({})) }))
  const restartSave = await api('/api/setup/config', 'POST', { yaml: restartRaw })
  assert.equal(restartSave.status, 200, JSON.stringify(restartSave))
  const oldBeforeRestart = await api('/api/setup/status')
  assert.equal(oldBeforeRestart.status, 200, JSON.stringify(oldBeforeRestart))
  const nextBeforeRestart = await nextApi('/api/setup/status')
  assert.notEqual(nextBeforeRestart.status, 200, JSON.stringify(nextBeforeRestart))
  await fixture.stop()
  const restarted = await fixture.start().then(() => true)
  assert.equal(restarted, true)
  const oldPrefix = await api('/api/setup/status')
  assert.notEqual(oldPrefix.status, 200, JSON.stringify(oldPrefix))
  const newPrefix = await nextApi('/api/setup/status')
  assert.equal(newPrefix.status, 200, JSON.stringify(newPrefix))
  assert.equal(newPrefix.body.config.rawYaml, restartRaw)

  const outcome = response => ({
    saved: response.saved, target: response.target, applied: response.applied,
    notApplied: response.notApplied, restartRequired: response.restartRequired,
  })
  console.log(JSON.stringify({
    result: 'ok', rawPreserved: true, invalidUnchanged: true,
    managedChannelsAvailable: true, disabledConfiguredChannel: true, unknownAdapterReported: true, uiSave: true, originalSetupFeedback,
    configOutcome: outcome(saved.body), restartPrefix: true,
  }))
} finally {
  if (browser) await browser.close().catch(() => {})
  await fixture.cleanup()
}
