import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import testEnvironment from '../../../scripts/test/test-process-env.cjs'
import { waitForWebUiReady } from './webuiReadiness.mjs'

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
export async function createHostFixture(name, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'foxwarm-' + name + '-')), data = join(root, 'data'), work = join(data, 'agents', 'main')
  await mkdir(join(data, 'state'), { recursive: true }); await mkdir(work, { recursive: true })
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening')
  const port = socket.address().port; await new Promise(done => socket.close(done))
  await writeFile(join(data, 'state/config.yaml'), `bot:\n  httpPort: ${port}\nllm:\n  maxOutput: 713\n  compactKeepPercent: 0.3\n`)
  const token = 'synthetic-' + name + '-api', origin = `http://127.0.0.1:${port}`, modelPath = join(data, 'state/models.yaml')
  await writeFile(join(data, 'state/token'), token)
  let host, browser, page, ownedListener = false; const hostPids = []
  async function api(method, path, body) {
    assert(ownedListener && host?.child.exitCode === null && host.child.signalCode === null, 'Fixture API requires its own bound live child.')
    const response = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  async function start() {
    const startup = { ...testEnvironment.isolatedApplicationEnv(data), ...(options.env || {}), FOXWARM_DATA_DIR: data, }
    if (options.normalStartup) delete startup.FOXWARM_EXPERIMENT_API_TOKEN
    else startup.FOXWARM_EXPERIMENT_API_TOKEN = token
    ownedListener = false
    const source = options.runtime === 'source'
    const child = spawn(source ? process.execPath : join(process.env.DOTNET_ROOT, 'dotnet'), [resolve(source ? 'lib/index.js' : 'dotnet/Foxwarm/bin/Debug/net10.0/Foxwarm.dll')], {
      stdio: ['ignore', 'pipe', 'pipe'], ...(options.cwd ? { cwd: options.cwd } : {}), env: startup
    })
    let output = ''
    host = { child, get output() { return output } }; hostPids.push(child.pid)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Owned listener did not bind: ' + output)), 20000)
      const finish = error => { clearTimeout(timeout); child.removeListener('exit', exited); error ? reject(error) : resolve() }
      const exited = code => finish(new Error('Owned host exited before binding: ' + code + ': ' + output))
      child.once('exit', exited); child.once('error', finish)
      const observe = bytes => {
        output = (output + bytes).slice(-20000)
        const bound = source && output.includes('HTTP server started') ? origin : /^Main HTTP listening: ([^\r\n]+)\r?\n/m.exec(output)?.[1]
        if (bound) {
          if (bound !== (source ? origin : `http://0.0.0.0:${port}`) || child.exitCode !== null || child.signalCode !== null) finish(new Error('Owned listener address does not match fixture: ' + bound))
          else { ownedListener = true; finish() }
        }
      }
      child.stdout.on('data', observe); child.stderr.on('data', observe)
    })
    if (source) await until(async () => (await api('GET', '/api/nodes')).status === 200, 'Source routes ready')
    else { const health = await api('GET', '/health'); assert.equal(health.status, 200); assert.equal(health.body?.status, 'ready') }
  }
  async function openApp(credential = token) {
    browser = await puppeteer.launch({ executablePath: process.env.FOXWARM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', ...(options.chromeArgs || [])], userDataDir: join(root, 'browser') })
    page = await browser.newPage(); options.onPage?.(page); await page.goto(options.publicRoot || origin, { waitUntil: 'networkidle0' })
    await page.waitForSelector('input[type="password"]'); await page.type('input[type="password"]', credential); await page.click('button[type="submit"]')
    await page.waitForFunction(() => !!window.foxwarmTest?.switchToSession)
    await waitForWebUiReady(page); return page
  }
  async function save(config) {
    const raw = typeof config === 'string' ? config : JSON.stringify(config, null, 2) + '\n'
    assert.equal((await api('POST', '/api/setup/models', { yaml: raw })).status, 200)
    assert.equal(await readFile(modelPath, 'utf8'), raw)
  }
  async function waitForExit() {
    let timeout
    try {
      const [code, signal] = host.child.exitCode !== null || host.child.signalCode !== null
        ? [host.child.exitCode, host.child.signalCode]
        : await Promise.race([once(host.child, 'exit'), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Owned host did not exit: ' + host.output)), options.stopTimeout ?? 12000) })])
      return { code, signal }
    } finally { clearTimeout(timeout) }
  }
  function signalStop() {
    assert(ownedListener && host?.child.exitCode === null && host.child.signalCode === null, 'Fixture shutdown requires its own live child.')
    host.child.kill('SIGTERM')
  }
  async function stop(afterAdmission) {
    if (options.runtime === 'source') signalStop()
    else assert.equal((await api('POST', '/admin/shutdown')).status, 202)
    await afterAdmission?.()
    assert.deepEqual(await waitForExit(), { code: 0, signal: null }, host.output)
  }
  const sql = (statement, parameters = []) => JSON.parse(execFileSync('python3', ['-c', 'import sqlite3,json,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute(sys.argv[2],json.loads(sys.argv[3])).fetchall()))', join(data, 'state/archive-store.sqlite'), statement, JSON.stringify(parameters)], { encoding: 'utf8' }))
  async function crash() {
    if (host && host.child.exitCode === null && host.child.signalCode === null) { const exited = once(host.child, 'exit').catch(() => {}); host.child.kill('SIGKILL'); await exited }
  }
  async function cleanup() {
    if (browser) await browser.close().catch(() => {})
    await crash()
    if (process.env.FOXWARM_KEEP_E2E_ROOT !== '1') await rm(root, { recursive: true, force: true }); else console.log('Retained owned root: ' + root)
  }
  return { root, data, work, modelPath, origin, token, port, api, start, openApp, save, stop, signalStop, waitForExit, crash, sql, cleanup, hostPids, get output() { return host?.output } }
}
