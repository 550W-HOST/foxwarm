import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'

export const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
export async function until(check, label, timeout = 22000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = await check(); if (result) return result; await sleep(25) }
  throw new Error('Timed out: ' + label)
}
export async function saveModelsInOriginalApp(page, raw, modelPath) {
  await page.evaluate(() => { location.hash = 'setup' })
  await page.waitForSelector('#setup-tab-models'); await page.click('#setup-tab-models')
  const editor = '[aria-label="Models YAML editor"] [role="textbox"]'
  await page.waitForSelector(editor); await page.focus(editor)
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control')
  await page.keyboard.sendCharacter(raw.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Save models')?.click())
  await until(async () => (await readFile(modelPath, 'utf8').catch(() => '')).replaceAll('\r\n', '\n') === raw.replaceAll('\r\n', '\n'), 'original Models saved')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Close'))
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Close')?.click())
  await page.waitForSelector('.foxwarm-model-selector-trigger')
}
export async function createHostFixture(name) {
  const root = await mkdtemp(join(tmpdir(), 'foxwarm-' + name + '-')), data = join(root, 'data'), work = join(root, 'work')
  await mkdir(join(data, 'state'), { recursive: true }); await mkdir(work)
  await writeFile(join(data, 'state/config.yaml'), 'llm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n')
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening')
  const port = socket.address().port; await new Promise(done => socket.close(done))
  const token = 'synthetic-' + name + '-api', origin = `http://127.0.0.1:${port}`, modelPath = join(data, 'state/models.yaml')
  let host, browser, page; const hostPids = []
  async function api(method, path, body) {
    const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  async function start() {
    const child = spawn(join(process.env.DOTNET_ROOT, 'dotnet'), [resolve('dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FOXWARM_DATA_DIR: data, FOXWARM_EXPERIMENT_TOOL_ROOT: work, FOXWARM_EXPERIMENT_PORT: String(port), FOXWARM_EXPERIMENT_API_TOKEN: token, FOXWARM_EXPERIMENT_WEBUI_DIST: resolve('packages/webui/dist') }
    })
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-20000) })
    host = { child, get output() { return output } }; hostPids.push(child.pid)
    await until(async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(output); try { return (await api('GET', '/health')).status === 200 } catch { return false } }, 'host ready')
  }
  async function openApp() {
    browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'], userDataDir: join(root, 'browser') })
    page = await browser.newPage(); await page.goto(origin, { waitUntil: 'networkidle0' })
    await page.waitForSelector('input[type="password"]'); await page.type('input[type="password"]', token); await page.click('button[type="submit"]')
    await page.waitForSelector('.foxwarm-chat-root'); return page
  }
  async function save(config) {
    const raw = typeof config === 'string' ? config : JSON.stringify(config, null, 2) + '\n'
    assert.equal((await api('POST', '/api/setup/models', { yaml: raw })).status, 200)
    assert.equal(await readFile(modelPath, 'utf8'), raw)
  }
  async function stop() {
    assert.equal((await api('POST', '/admin/shutdown')).status, 202)
    const code = host.child.exitCode ?? await Promise.race([once(host.child, 'exit').then(([code]) => code), sleep(12000).then(() => 'timeout')])
    assert.equal(code, 0, host.output)
  }
  const sql = (statement, parameters = []) => JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))', join(data, 'state/archive-store.sqlite'), statement, JSON.stringify(parameters)], { encoding: 'utf8' }))
  async function cleanup() {
    if (browser) await browser.close().catch(() => {})
    if (host && host.child.exitCode === null && host.child.signalCode === null) { const exited = once(host.child, 'exit').catch(() => {}); host.child.kill('SIGKILL'); await exited }
    if (process.env.FOXWARM_KEEP_E2E_ROOT !== '1') await rm(root, { recursive: true, force: true }); else console.log('Retained owned root: ' + root)
  }
  return { root, data, work, modelPath, origin, api, start, openApp, save, stop, sql, cleanup, hostPids, get output() { return host?.output } }
}
