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
await fs.mkdir(path.dirname(toolFile), { recursive: true })
await fs.mkdir(logsRoot, { recursive: true })
await fs.mkdir(screenshotsRoot, { recursive: true })

const appendProviderLog = text => fs.appendFile(path.join(logsRoot, 'provider.log'), text)
const provider = await startMockProvider({ toolFile, log: appendProviderLog })

function sessionHistory(id, count, offset) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'model',
    parts: [{ text: `${id} message ${index + 1}\n${'synthetic content '.repeat(18)}` }],
    __meta: { seq: index + 1, timestamp: 1_700_000_000_000 + offset + index },
  }))
}

async function seedData() {
  const sessions = {}
  await fs.mkdir(path.join(stateRoot, 'sessions'), { recursive: true })
  const ids = ['main', 'app-e2e-long-a', 'app-e2e-long-b', ...Array.from({ length: 36 }, (_, index) => `app-e2e-list-${String(index + 1).padStart(2, '0')}`)]
  for (const [offset, id] of ids.entries()) {
    const count = id.includes('long') ? 140 : 2
    const history = sessionHistory(id, count, offset * 1000)
    const cwd = id === 'app-e2e-list-01' ? path.join(runRoot, 'synthetic-cwd') : undefined
    const displayName = id === 'app-e2e-list-01' ? 'Synthetic named session' : undefined
    const metadata = {
      id, agent: 'main', busy: false, queue: [], currentNode: 'master',
      ...(cwd ? { cwd } : {}),
      ...(displayName ? { displayName } : {}),
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      meta: { lastMessageTime: 1_700_000_000_000 + offset * 1000 + count, messageCount: count },
    }
    sessions[id] = metadata
    await fs.writeFile(path.join(stateRoot, 'sessions', `${id}.json`), JSON.stringify({
      sessionStateVersion: 1, history, persistentMemorySnapshot: 'Synthetic app E2E prompt.', queue: [], systemPromptFiles: [],
      historyVersion: 0, stats: metadata.stats, meta: metadata.meta, agent: 'main', busy: false,
      currentNode: 'master', ...(cwd ? { cwd } : {}), ...(displayName ? { displayName } : {}), nextMessageSeq: count + 1, lastAppliedMailboxId: 0,
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

await seedData()
const appPort = await reservePort()
await fs.writeFile(path.join(stateRoot, 'config.yaml'), `bot:\n  name: synthetic-e2e\n  httpPort: ${appPort}\n  enableWebUI: true\n  enableTrigger: false\nvector: false\nvectorMaintenance: false\nsessionWorkers: false\ndbWorkers: false\nhandoffConfirmation: false\nchannels: {}\npaths:\n  mcpConfigPath: ${JSON.stringify(path.join(stateRoot, 'mcp.json'))}\n`)
await fs.writeFile(path.join(stateRoot, 'models.yaml'), `default: responses/mock-responses\nproviders:\n  responses:\n    providerType: openai-responses\n    baseUrl: ${provider.baseUrl}/v1\n    apiKey: synthetic-provider-token\n    asyncCompact: false\n    effort:\n      allowed: [none]\n      default: none\n    models: [mock-responses]\n  chat:\n    providerType: openai-completions\n    baseUrl: ${provider.baseUrl}/v1\n    apiKey: synthetic-provider-token\n    asyncCompact: false\n    effort:\n      allowed: [none]\n      default: none\n    models: [mock-chat]\n`)

const appLog = await fs.open(path.join(logsRoot, 'app.log'), 'w')
const app = spawn(process.execPath, ['lib/index.js'], {
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

function stopProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal) } catch {}
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
  const browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
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
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { stopProcess(child); setTimeout(() => stopProcess(child, 'SIGKILL'), 3000).unref() }, 300_000)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 1, signal }) })
    child.once('error', error => { clearTimeout(timer); resolve({ code: 1, error }) })
  })
  await new Promise(resolve => log.end(resolve))
  if (result.code !== 0) {
    await diagnosticScreenshot(baseUrl, `failure-${label}`).catch(() => {})
    throw new Error(`${file} failed with code ${result.code}${result.signal ? ` signal ${result.signal}` : ''}`)
  }
}

const baseUrl = `http://127.0.0.1:${appPort}`
let failed = false
try {
  await waitForReady(baseUrl)
  const files = [
    'test/app-e2e/core.e2e.mjs',
    'packages/webui/test/lazyTimelineRestore.e2e.mjs',
    'packages/webui/test/scrollState.e2e.mjs',
    'packages/webui/test/sessionHeader.e2e.mjs',
    'packages/webui/test/sessionListDrag.e2e.mjs',
    'packages/webui/test/sessionListLiveRefresh.e2e.mjs',
    'packages/webui/test/systemTabs.e2e.mjs',
  ]
  for (const file of files) await runTestFile(file, baseUrl)
  provider.assertConsumed()
  assert.equal(app.exitCode, null, 'Foxwarm app exited before tests completed')
} catch (error) {
  failed = true
  console.error(error?.stack || error)
} finally {
  stopProcess(app)
  await Promise.race([
    new Promise(resolve => app.once('exit', resolve)),
    new Promise(resolve => setTimeout(() => { stopProcess(app, 'SIGKILL'); resolve() }, 10_000)),
  ])
  await appLog.close()
  await provider.close()
}

console.log(`Full-application E2E artifacts: ${path.relative(repoRoot, runRoot)}`)
if (failed) process.exitCode = 1
