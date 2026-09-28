import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'
import { startMockProvider } from './mock-provider.mjs'

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname)
const artifactRoot = path.resolve(process.env.FOXWARM_APP_E2E_ARTIFACT_DIR || path.join(repoRoot, 'test/.temp/app-e2e'))
const chromium = process.env.FOXWARM_E2E_CHROMIUM || '/usr/bin/chromium'
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const runRoot = path.join(artifactRoot, runId)
const dataRoot = path.join(runRoot, 'data')
const stateRoot = path.join(dataRoot, 'state')
const logsRoot = path.join(runRoot, 'logs')
const screenshotsRoot = path.join(runRoot, 'screenshots')
const token = 'synthetic-app-e2e-token'
const toolFile = path.join(runRoot, 'tool-work', 'roundtrip.txt')
// Targeted debugging runs: `FOXWARM_APP_E2E_FILES=a,b` or `restart:<file>` to
// restart the application before that file. The scripted provider still fails on
// unexpected requests, but the global request order is not enforced.
const selectedFiles = (process.env.FOXWARM_APP_E2E_FILES || '').split(',').map(value => value.trim()).filter(Boolean)
let provider
let appPort
let baseUrl
let appLog
let app
let currentTest
let diagnosticBrowser
let cleanupPromise
let receivedSignal
let failed = false
await fs.mkdir(path.dirname(toolFile), { recursive: true })
await fs.mkdir(logsRoot, { recursive: true })
await fs.mkdir(screenshotsRoot, { recursive: true })

const appendProviderLog = text => fs.appendFile(path.join(logsRoot, 'provider.log'), text)

function throwIfCancelled() {
  if (receivedSignal) throw new Error(`Full-application E2E cancelled by ${receivedSignal}`)
}

function sessionHistory(id, count, offset) {
  const repeated = 'synthetic content '.repeat(id.startsWith('core-compact-') ? 42 : 18)
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'model',
    parts: [{ text: `${id} message ${index + 1}\n${repeated}` }],
    __meta: { seq: index + 1, timestamp: 1_700_000_000_000 + offset + index },
  }))
}

async function seedData() {
  const sessions = {}
  await fs.mkdir(path.join(stateRoot, 'sessions'), { recursive: true })
  const ids = ['main', 'app-e2e-long-a', 'app-e2e-long-b', 'core-compact-sync', 'core-compact-background', 'core-btw', ...Array.from({ length: 36 }, (_, index) => `app-e2e-list-${String(index + 1).padStart(2, '0')}`)]
  for (const [offset, id] of ids.entries()) {
    const count = id.includes('long') ? 140 : id.startsWith('core-compact-') ? 20 : 2
    const history = sessionHistory(id, count, offset * 1000)
    const cwd = id === 'app-e2e-list-01' ? path.join(runRoot, 'synthetic-cwd') : undefined
    const displayName = id === 'app-e2e-list-01' ? 'Synthetic named session' : undefined
    const model = id === 'core-compact-background' ? 'wsbg/mock-ws-bg' : id.startsWith('core-') ? 'ws/mock-ws' : undefined
    const promptCacheKey = id.startsWith('core-') ? `00000000-0000-4000-8000-${String(offset + 1).padStart(12, '0')}` : undefined
    const metadata = {
      id, agent: 'main', busy: false, queue: [], currentNode: 'master',
      ...(cwd ? { cwd } : {}),
      ...(displayName ? { displayName } : {}),
      ...(model ? { model, effort: 'none', promptCacheKey } : {}),
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      meta: { lastMessageTime: 1_700_000_000_000 + offset * 1000 + count, messageCount: count },
    }
    sessions[id] = metadata
    await fs.writeFile(path.join(stateRoot, 'sessions', `${id}.json`), JSON.stringify({
      sessionStateVersion: 1, history, persistentMemorySnapshot: 'Synthetic app E2E prompt.', queue: [], systemPromptFiles: [],
      historyVersion: 0, stats: metadata.stats, meta: metadata.meta, agent: 'main', busy: false,
      currentNode: 'master', ...(cwd ? { cwd } : {}), ...(displayName ? { displayName } : {}),
      ...(model ? { model, effort: 'none', promptCacheKey } : {}), nextMessageSeq: count + 1, lastAppliedMailboxId: 0,
    }, null, 2))
  }
  await fs.writeFile(path.join(stateRoot, 'sessions.json'), JSON.stringify({ sessions }, null, 2))
  await fs.writeFile(path.join(stateRoot, 'token'), token)
  await fs.writeFile(path.join(stateRoot, 'node_token'), 'synthetic-node-token')
  await fs.writeFile(path.join(stateRoot, 'mcp.json'), '{}')
  const memory = path.join(dataRoot, 'agents/main/memory')
  await fs.mkdir(memory, { recursive: true })
  for (const name of ['ONBOOT.md', 'BOOTSTRAP.md', 'MEMORY.md', 'SOUL.md', 'USER.md']) await fs.writeFile(path.join(memory, name), '')
  await fs.writeFile(path.join(dataRoot, 'agents/00_SYSTEM.md'), 'Synthetic full-application E2E system prompt.\n')
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

async function startApplication() {
  await seedData()
  throwIfCancelled()
  appPort = await reservePort()
  throwIfCancelled()
  baseUrl = `http://127.0.0.1:${appPort}`
  const providerDelayMs = process.env.FOXWARM_APP_E2E_PROVIDER_ALLOCATION_DELAY === '1' ? 2000 : 0
  if (providerDelayMs) console.log('APP_E2E_PROVIDER_ALLOCATION_PENDING')
  const createdProvider = await startMockProvider({ toolFile, log: appendProviderLog, readyDelayMs: providerDelayMs, enforceSequence: selectedFiles.length === 0 })
  if (receivedSignal) {
    await createdProvider.close()
    throwIfCancelled()
  }
  provider = createdProvider
  await fs.writeFile(path.join(stateRoot, 'config.yaml'), `bot:\n  name: synthetic-e2e\n  httpPort: ${appPort}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(path.join(stateRoot, 'mcp.json'))}\n`)
  throwIfCancelled()
  await fs.writeFile(path.join(stateRoot, 'models.yaml'), `default: responses/mock-responses\nproviders:\n  responses:\n    providerType: openai-responses\n    baseUrl: ${provider.baseUrl}/v1\n    apiKey: synthetic-provider-token\n    asyncCompact: false\n    effort:\n      allowed: [none]\n      default: none\n    models: [mock-responses]\n  chat:\n    providerType: openai-completions\n    baseUrl: ${provider.baseUrl}/v1\n    apiKey: synthetic-provider-token\n    asyncCompact: false\n    effort:\n      allowed: [none]\n      default: none\n    models: [mock-chat]\n  ws:\n    providerType: openai-ws\n    baseUrl: ${provider.baseUrl}/v1\n    apiKey: synthetic-provider-token\n    asyncCompact: false\n    effort:\n      allowed: [none]\n      default: none\n    models: [mock-ws]\n  wsbg:\n    providerType: openai-ws\n    baseUrl: ${provider.baseUrl}/v1\n    apiKey: synthetic-provider-token\n    asyncCompact: true\n    effort:\n      allowed: [none]\n      default: none\n    models: [mock-ws-bg]\n  images:\n    providerType: openai-responses\n    baseUrl: ${provider.baseUrl}/v1\n    apiKey: synthetic-provider-token\n    asyncCompact: false\n    effort:\n      allowed: [none]\n      default: none\n    imageGeneration:\n      enabled: true\n      outputFormat: png\n    models: [mock-image]\n`)
  throwIfCancelled()
  await spawnApplication('app.log')
}

async function spawnApplication(logName) {
  const createdAppLog = await fs.open(path.join(logsRoot, logName), 'w')
  if (receivedSignal) {
    await createdAppLog.close()
    throwIfCancelled()
  }
  appLog = createdAppLog
  throwIfCancelled()
  app = spawn(process.execPath, ['lib/index.js'], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      FOXWARM_DATA_DIR: dataRoot,
      FOXWARM_CONFIG_PATH: path.join(stateRoot, 'config.yaml'),
      MCP_CONFIG_PATH: path.join(stateRoot, 'mcp.json'),
      OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GOOGLE_API_KEY: '', GEMINI_API_KEY: '',
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1,::1',
    },
    stdio: ['ignore', appLog.fd, appLog.fd],
  })
  if (receivedSignal) {
    await stopOwnedProcess(app)
    throwIfCancelled()
  }
}

// Restart the application against the same data root so a scenario can prove
// that persisted content survives a real process restart. The port comes from
// the written config file, so the existing base URL stays valid.
async function restartApplication() {
  await stopOwnedProcess(app)
  app = undefined
  if (appLog) {
    await appLog.close().catch(() => {})
    appLog = undefined
  }
  await spawnApplication('app-restart.log')
  await waitForReady(baseUrl)
}

function stopProcess(child, signal = 'SIGTERM') {
  if (!child) return
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    } else process.kill(-child.pid, signal)
  } catch {}
}

async function stopOwnedProcess(child) {
  if (!child) return
  stopProcess(child)
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ])
  }
  stopProcess(child, 'SIGKILL')
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ])
  }
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    await stopOwnedProcess(currentTest)
    await stopOwnedProcess(app)
    if (diagnosticBrowser) await diagnosticBrowser.close().catch(() => {})
    if (appLog) await appLog.close().catch(() => {})
    if (provider) await Promise.race([provider.close(), new Promise(resolve => setTimeout(resolve, 5000))]).catch(() => {})
  })().finally(() => { cleanupPromise = undefined })
  return cleanupPromise
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!receivedSignal) {
      receivedSignal = signal
      failed = true
      void cleanup()
      return
    }
    stopProcess(currentTest, 'SIGKILL')
    stopProcess(app, 'SIGKILL')
  })
}

async function waitForReady(baseUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(`Foxwarm app exited during startup with code ${app.exitCode}`)
    try {
      const response = await fetch(`${baseUrl}/api/setup/status`, { headers: { Authorization: `Bearer ${token}` } })
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Foxwarm app did not become ready within 30 seconds')
}

async function diagnosticScreenshot(baseUrl, label) {
  const pendingBrowser = puppeteer.launch({ executablePath: chromium, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    .then(browser => ({ browser }), error => ({ error }))
  if (process.env.FOXWARM_APP_E2E_DIAGNOSTIC_ALLOCATION_DELAY === '1') {
    console.log('APP_E2E_DIAGNOSTIC_ALLOCATION_PENDING')
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  const launched = await pendingBrowser
  if (launched.error) {
    throwIfCancelled()
    throw launched.error
  }
  const browser = launched.browser
  if (receivedSignal) {
    await browser.close()
    throwIfCancelled()
  }
  diagnosticBrowser = browser
  const page = await browser.newPage()
  const consoleLines = []
  page.on('console', message => consoleLines.push(`${message.type()}: ${message.text()}`))
  page.on('pageerror', error => consoleLines.push(`pageerror: ${error.stack || error.message}`))
  try {
    await page.goto(`${baseUrl}/#token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2', timeout: 20_000 })
    await page.screenshot({ path: path.join(screenshotsRoot, `${label}.png`), fullPage: true })
  } finally {
    await fs.writeFile(path.join(logsRoot, `${label}-browser-console.log`), consoleLines.join('\n'))
    await browser.close()
    if (diagnosticBrowser === browser) diagnosticBrowser = undefined
  }
}

async function runTestFile(file, baseUrl) {
  const label = path.basename(file).replace(/[^A-Za-z0-9_.-]+/g, '-')
  const logPath = path.join(logsRoot, `${label}.log`)
  const log = createWriteStream(logPath, { flags: 'w' })
  const child = spawn(process.execPath, ['--test', file], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      FOXWARM_E2E_URL: baseUrl,
      FOXWARM_E2E_TOKEN_FILE: path.join(stateRoot, 'token'),
      FOXWARM_E2E_DATA_DIR: dataRoot,
      FOXWARM_E2E_PROVIDER_URL: provider.baseUrl,
      FOXWARM_E2E_TOOL_FILE: toolFile,
      FOXWARM_E2E_ARTIFACT_DIR: runRoot,
      FOXWARM_E2E_CHROMIUM: chromium,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  currentTest = child
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { stopProcess(child); setTimeout(() => stopProcess(child, 'SIGKILL'), 3000).unref() }, 300_000)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 1, signal }) })
    child.once('error', error => { clearTimeout(timer); resolve({ code: 1, error }) })
  })
  await new Promise(resolve => log.end(resolve))
  if (currentTest === child) currentTest = undefined
  if (result.code !== 0) {
    if (!receivedSignal) await diagnosticScreenshot(baseUrl, `failure-${label}`).catch(() => {})
    throw new Error(`${file} failed with code ${result.code}${result.signal ? ` signal ${result.signal}` : ''}`)
  }
}

try {
  await startApplication()
  await waitForReady(baseUrl)
  if (process.env.FOXWARM_APP_E2E_DIAGNOSTIC_ALLOCATION_DELAY === '1') {
    await diagnosticScreenshot(baseUrl, 'allocation-probe')
  }
  const files = selectedFiles.length > 0
    ? selectedFiles.map(value => value.startsWith('restart:')
      ? { file: value.slice('restart:'.length), restartBefore: true }
      : value)
    : process.env.FOXWARM_APP_E2E_CORE_ONLY === '1'
    ? ['test/app-e2e/core.e2e.mjs']
    : [
      'test/app-e2e/core.e2e.mjs',
      'packages/webui/test/lazyTimelineRestore.e2e.mjs',
      'packages/webui/test/scrollState.e2e.mjs',
      'packages/webui/test/sessionHeader.e2e.mjs',
      'packages/webui/test/sessionListDrag.e2e.mjs',
      'packages/webui/test/sessionListLiveRefresh.e2e.mjs',
      'packages/webui/test/systemTabs.e2e.mjs',
      'test/app-e2e/imageGeneration.e2e.mjs',
      // Runs after a real application restart against the same data root.
      { file: 'test/app-e2e/imageGenerationRestart.e2e.mjs', restartBefore: true },
    ]
  for (const entry of files) {
    const file = typeof entry === 'string' ? entry : entry.file
    if (receivedSignal) throw new Error(`Full-application E2E cancelled by ${receivedSignal}`)
    if (typeof entry !== 'string' && entry.restartBefore) {
      console.log('APP_E2E_RESTART_PENDING')
      await restartApplication()
      console.log('APP_E2E_RESTART_READY')
    }
    await runTestFile(file, baseUrl)
  }
  provider.assertConsumed()
  assert.equal(app.exitCode, null, 'Foxwarm app exited before tests completed')
} catch (error) {
  failed = true
  if (!receivedSignal) console.error(error?.stack || error)
} finally {
  await cleanup()
}

console.log(`Full-application E2E artifacts: ${path.relative(repoRoot, runRoot)}`)
if (receivedSignal) process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143
else if (failed) process.exitCode = 1
