import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import puppeteer from 'puppeteer-core'
import { createHostFixture, until } from './experimentHostFixture.mjs'

const fixture = await createHostFixture('app-config')
const initialRaw = (origin, prefix = '/preview') => `# preserve this comment\nurl: ${origin}${prefix}\nbot:\n  enableWebUI: true\n  customBotField: retained\nllm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n  compactThresholdPercent: 0.85\nnodeProviders:\n  retained:\n    type: executable\n    command: /bin/echo\nvector: false\nmcpInbound:\n  enabled: false\nchannels:\n  webui:\n    type: webui\n    enabled: true\n  weixin:\n    type: weixin\n    enabled: true\n    token: saved-token\n    customChannelField: keep-me\n  mystery:\n    type: future-chat\n    enabled: true\n`

let page
let browser
try {
  const raw = initialRaw(fixture.origin)
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
  assert.equal(statusBefore.body.capabilities.managedChannels, false)
  assert.equal(statusBefore.body.channels.find(channel => channel.channelId === 'webui').running, true)
  for (const id of ['weixin', 'mystery']) {
    const channel = statusBefore.body.channels.find(item => item.channelId === id)
    assert.equal(channel.running, false)
    assert.equal(channel.managed, false)
    assert.match(channel.lastError, /External chat channels are unavailable/)
  }

  const invalid = await api('/api/setup/config', 'POST', { yaml: raw.replace('compactKeepPercent: 0.3', 'compactKeepPercent: 2') })
  assert.equal(invalid.status, 400, JSON.stringify(invalid))
  assert.equal(await readFile(`${fixture.data}/state/config.yaml`, 'utf8'), raw)

  const savedRaw = raw.replace('customBotField: retained', 'customBotField: retained\n  newUnknownField: preserved')
  const saved = await api('/api/setup/config', 'POST', { yaml: savedRaw })
  assert.equal(saved.status, 200, JSON.stringify(saved))
  assert.equal(saved.body.reload.available, false)
  assert.deepEqual(saved.body.reload.started, [])
  assert.deepEqual(saved.body.reload.stopped, [])
  assert.equal(await readFile(`${fixture.data}/state/config.yaml`, 'utf8'), savedRaw)
  const statusAfter = await api('/api/setup/status')
  assert.equal(statusAfter.body.config.rawYaml, savedRaw)

  const channelSave = await api('/api/setup/channels', 'POST', {
    channels: {
      webui: { type: 'webui', enabled: true },
      weixin: { type: 'weixin', enabled: true, token: 'saved-token', unknown: 'retained' },
    },
  })
  assert.equal(channelSave.status, 200, JSON.stringify(channelSave))
  const channelRaw = await readFile(`${fixture.data}/state/config.yaml`, 'utf8')
  assert.equal((channelRaw.match(/^channels:/gm) || []).length, 1)
  assert.match(channelRaw, /newUnknownField: preserved/)
  assert.match(channelRaw, /unknown: retained/)

  browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: `${fixture.root}/browser` })
  page = await browser.newPage()
  await page.goto(`${fixture.origin}/preview/`, { waitUntil: 'networkidle0' })
  await page.waitForSelector('input[type="password"]')
  await page.type('input[type="password"]', fixture.token)
  await page.click('button[type="submit"]')
  await page.waitForSelector('.foxwarm-chat-root')
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-config')
  await page.click('#setup-tab-config')
  assert.match(await page.evaluate(() => document.body.innerText), /External chat channels are unavailable on this server\./)
  assert.equal(await page.$eval('body', body => body.innerText.includes('Start Weixin login')), false)
  const editor = '[aria-label="Application config YAML editor"] [role="textbox"]'
  await page.waitForSelector(editor)
  await page.evaluate(({ value }) => {
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /(?:\/|^)monaco-editor(?:-[^/]+)?\.js(?:\?|$)/.test(new URL(name).pathname))
    return import(moduleUrl).then(imported => {
      const monaco = imported.a ?? imported.default ?? imported
      const model = monaco.editor.getEditors().find(candidate => candidate.getModel()?.uri.toString() === 'inmemory://foxwarm/setup/foxwarm-config.yaml')?.getModel()
      if (!model) throw new Error('Monaco app-config model not found')
      model.setValue(value)
    })
  }, { value: channelRaw })
  await new Promise(resolve => setTimeout(resolve, 500))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Save config')?.click())
  await until(async () => Boolean(await page.$eval('[data-save-feedback="config"]', node => node.textContent?.includes('Configuration saved')).catch(() => false)), 'UI config save', 10000).catch(async error => {
    const debug = await page.evaluate(() => ({
      buttons: [...document.querySelectorAll('button')].map(button => ({ text: button.textContent?.trim(), disabled: button.disabled })),
      feedback: document.querySelector('[data-save-feedback="config"]')?.textContent || null,
      error: document.body.innerText.slice(-1000),
    }))
    throw new Error(`${error.message}: ${JSON.stringify(debug)}`)
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#setup-tab-config')

  const restartRaw = channelRaw.replace(`${fixture.origin}/preview`, `${fixture.origin}/next`)
  const restartSave = await api('/api/setup/config', 'POST', { yaml: restartRaw })
  assert.equal(restartSave.status, 200, JSON.stringify(restartSave))
  await fixture.stop()
  const restarted = await fixture.start().then(() => true)
  assert.equal(restarted, true)
  const nextApi = (path, method = 'GET', body) => fetch(`${fixture.origin}/next${path}`, {
    method,
    headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async response => ({ status: response.status, body: await response.json().catch(() => ({})) }))
  const oldPrefix = await api('/api/setup/status')
  assert.notEqual(oldPrefix.status, 200, JSON.stringify(oldPrefix))
  const newPrefix = await nextApi('/api/setup/status')
  assert.equal(newPrefix.status, 200, JSON.stringify(newPrefix))
  assert.equal(newPrefix.body.config.rawYaml, restartRaw)

  console.log(JSON.stringify({ result: 'ok', rawPreserved: true, invalidUnchanged: true, channelSectionPreserved: true, unavailableChannels: true, uiSave: true, restartPrefix: true }))
} finally {
  if (browser) await browser.close().catch(() => {})
  await fixture.cleanup()
}
