#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  compiledPath,
  deferredGroups,
  loadTestInventory,
  nativeMainSmoke,
  routineUnitGroups,
  referenceGroups,
  standaloneSelftests,
} from './test-inventory.mjs'
import { parseTestResultCounts } from './test-result-counts.mjs'
import testEnvironment from './test-process-env.cjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
// A failed Chromium fixture gets the original attempt plus exactly eight retries.
// Keep this runner-local: retries do not apply to preparation, other groups, or shards.
const BROWSER_FIXTURE_RETRY_COUNT = 8
const target = process.argv[2] || 'unit'
const validTargets = new Set(['inventory', 'unit', 'reference', 'managed', 'published', 'browser', 'app', 'native', 'all'])
let shard = null
let browserWorkers = 1
const options = new Set()
for (const argument of process.argv.slice(3)) {
  const match = /^(--shard|--workers)=(.+)$/.exec(argument)
  if (target !== 'browser' || !match || options.has(match[1])) {
    console.error(`Invalid test option: ${argument}. Browser options: --shard=INDEX/TOTAL --workers=COUNT`)
    process.exit(2)
  }
  options.add(match[1])
  const positive = value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
  if (match[1] === '--shard') {
    const parts = match[2].split('/')
    if (parts.length !== 2 || !parts.every(positive) || Number(parts[0]) > Number(parts[1])) {
      console.error('Invalid browser shard; use INDEX/TOTAL with 1 <= INDEX <= TOTAL.')
      process.exit(2)
    }
    shard = { index: Number(parts[0]), total: Number(parts[1]) }
  } else {
    if (!positive(match[2])) {
      console.error('Invalid browser worker count; use a positive integer.')
      process.exit(2)
    }
    browserWorkers = Number(match[2])
  }
}
if (!validTargets.has(target)) {
  console.error(`Usage: node scripts/test/run-tests.mjs <${[...validTargets].join('|')}> [--shard=INDEX/TOTAL] [--workers=COUNT]`)
  process.exit(2)
}

if (target === 'native' && !fs.statSync(process.env.FOXWARM_TEST_MAIN_EXECUTABLE || '', { throwIfNoEntry: false })?.isFile()) {
  console.error('test:native requires FOXWARM_TEST_MAIN_EXECUTABLE to name a published Main executable.')
  process.exit(2)
}

const inventory = loadTestInventory(repoRoot)
const unclassified = inventory.unclassified || []
const missingGroups = [...routineUnitGroups, ...referenceGroups].filter(group => !(inventory[group]?.length))
if (unclassified.length || missingGroups.length) {
  if (unclassified.length) console.error(`Unclassified tests:\n${unclassified.map(file => `  ${file}`).join('\n')}`)
  if (missingGroups.length) console.error(`Empty required test groups: ${missingGroups.join(', ')}`)
  process.exit(1)
}

const browserFiles = (inventory['webui-browser'] || []).filter((_, index) => !shard || index % shard.total === shard.index - 1)
const browserSelection = target === 'browser' || target === 'all'
  ? { shard, workers: browserWorkers, files: browserFiles }
  : undefined

function printInventory() {
  console.log('Foxwarm test inventory')
  for (const [group, files] of Object.entries(inventory)) {
    const note = deferredGroups[group] ? ` — ${deferredGroups[group]}` : ''
    console.log(`${group.padEnd(20)} ${String(files.length).padStart(3)} file(s)${note}`)
  }
  console.log(`standalone-selftests ${String(standaloneSelftests.length).padStart(3)} executable(s) — Retired Main programs; explicit test:reference only.`)
}

if (target === 'inventory') {
  printInventory()
  process.exit(0)
}

const artifactParent = process.env.FOXWARM_TEST_ARTIFACT_DIR
  ? path.resolve(process.env.FOXWARM_TEST_ARTIFACT_DIR)
  : path.join(repoRoot, 'test', '.temp', 'test-runs')
const runId = `${target}${shard ? `-shard-${shard.index}-of-${shard.total}` : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const runBase = path.join(artifactParent, runId)
await fsp.mkdir(path.join(runBase, 'logs'), { recursive: true })
await fsp.writeFile(path.join(runBase, 'inventory.json'), `${JSON.stringify({ inventory, standaloneSelftests, browserSelection }, null, 2)}\n`)
const shortTempBase = path.join(os.tmpdir(), `fw-${process.pid}`)
await fsp.rm(shortTempBase, { recursive: true, force: true })
await fsp.mkdir(shortTempBase, { recursive: true })

const preloadUrl = pathToFileURL(path.join(scriptDir, 'test-process-env.mjs')).href
const baseEnv = {
  ...testEnvironment.isolatedApplicationEnv(path.join(runBase, 'data')),
  FOXWARM_TEST_PROCESS_ROOT: '',
  FOXWARM_TEST_RUN_ROOT: runBase,
  FOXWARM_TEST_TEMP_ROOT: shortTempBase,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import=${preloadUrl}`.trim(),
}

function requireFiles(files, label) {
  const missing = files.filter(file => !fs.existsSync(path.join(repoRoot, file)))
  if (missing.length) throw new Error(`${label} requires a current build; missing:\n${missing.join('\n')}`)
  return files
}

function nodeTestStep(name, files, { concurrency, timeoutMs = 180_000 } = {}) {
  return {
    name,
    command: process.execPath,
    args: ['--test', ...(concurrency ? [`--test-concurrency=${concurrency}`] : []), ...files],
    timeoutMs,
  }
}

function directStep(name, command, args, timeoutMs = 180_000, env = {}) {
  return { name, command, args, timeoutMs, env }
}

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size))
}

function managedGroup() {
  return {
    name: 'managed',
    steps: [
      { ...directStep('restore', 'dotnet', ['restore', 'dotnet/Foxwarm.sln'], 600_000), prepareDependencies: true },
      // Includes the build and serial suite; a complete CI invocation already takes nearly 20 minutes.
      directStep('dotnet', 'dotnet', ['test', 'dotnet/Foxwarm.sln', '--no-restore', '--logger', 'console;verbosity=minimal'], 1_800_000),
    ],
    env: { FOXWARM_TS_ROOT: repoRoot },
  }
}

function publishedGroup() {
  const payload = path.join(runBase, 'published-core')
  return {
    name: 'published-core',
    steps: [
      directStep('publish', 'dotnet', ['publish', 'dotnet/Foxwarm/Foxwarm.csproj', '-c', 'Release', '--self-contained', 'false', '-o', payload], 600_000),
      directStep('multica-bin', process.execPath, ['--test', '--test-name-pattern=^public package bin ', 'scripts/multicaBridge.test.js'], 30_000),
      directStep('original-app', process.execPath, ['packages/webui/test/publishedCore.e2e.mjs'], 240_000),
    ],
    env: {
      FOXWARM_PUBLISHED_CORE: payload,
      FOXWARM_CHROMIUM: findChromium(),
      FOXWARM_TEST_KEEP_SYSTEM_TMP: '1',
    },
  }
}

function unitGroups() {
  const bootstrap = requireFiles(inventory['node-bootstrap'].map(compiledPath), 'Node bootstrap tests')
  const helpers = requireFiles(inventory['runtime-helpers'].map(compiledPath), 'runtime helper tests')
  const shared = requireFiles(inventory.shared.map(compiledPath), 'shared tests')
  const cli = requireFiles(inventory['cli-node'].map(compiledPath), 'CLI Node tests')
  const browserNode = requireFiles(inventory['browser-node'], 'browser Node tests')
  const scripts = requireFiles(inventory.scripts, 'script tests')
  const skillNode = requireFiles(inventory['skill-node'], 'skill Node tests')
  const webui = requireFiles(inventory['webui-unit'], 'WebUI unit tests')
  const python = requireFiles(inventory.python, 'Python tests')
  return [
    { name: 'node-bootstrap', steps: [nodeTestStep('node-bootstrap', bootstrap, { concurrency: 2, timeoutMs: 240_000 })] },
    { name: 'runtime-helpers', steps: [nodeTestStep('runtime-helpers', helpers, { concurrency: 2 })] },
    { name: 'shared', steps: [nodeTestStep('shared', shared, { concurrency: 4, timeoutMs: 240_000 })] },
    { name: 'cli-node', steps: [nodeTestStep('cli-node', cli, { concurrency: 4, timeoutMs: 180_000 })] },
    { name: 'browser-node', steps: [nodeTestStep('browser-node', browserNode, { concurrency: 2, timeoutMs: 120_000 })] },
    { name: 'scripts', steps: [nodeTestStep('scripts', scripts, { concurrency: 4, timeoutMs: 180_000 })] },
    { name: 'skill-node', steps: [nodeTestStep('skill-node', skillNode, { concurrency: 1, timeoutMs: 120_000 })] },
    {
      name: 'vscode-web',
      restoreVscodeDist: true,
      steps: [directStep('vscode-web', 'npm', ['--prefix', 'packages/vscode-web', 'test'], 300_000)],
    },
    { name: 'webui-unit', steps: [nodeTestStep('webui-unit', webui, { concurrency: 8, timeoutMs: 180_000 })] },
    {
      name: 'python',
      steps: python.map(file => directStep(path.basename(file), 'python3', [file], 180_000)),
    },
  ]
}

function referenceTestGroups() {
  const backend = requireFiles(inventory['reference-backend'].map(compiledPath), 'reference backend tests')
  const isolation = requireFiles(inventory['reference-isolation'], 'reference isolation tests')
  requireFiles(standaloneSelftests, 'standalone selftests')
  const vectorFailure = backend.find(file => file.endsWith('/vector.indexFailure.test.js'))
  const shards = chunks(backend.filter(file => file !== vectorFailure), 8)
  return [
    {
      name: 'reference-backend',
      // The async logger regression clears this setting in its own child.
      env: { FOXWARM_SYNC_FILE_LOG: process.env.FOXWARM_SYNC_FILE_LOG ?? '1' },
      steps: [
        ...shards.map((files, index) => nodeTestStep(`backend-${String(index + 1).padStart(2, '0')}`, files, { concurrency: 8, timeoutMs: 600_000 })),
        ...(vectorFailure ? [nodeTestStep('vector.indexFailure', [vectorFailure], { timeoutMs: 120_000 })] : []),
      ],
    },
    { name: 'reference-isolation', steps: [nodeTestStep('reference-isolation', isolation, { timeoutMs: 240_000 })] },
    {
      name: 'standalone-selftests',
      steps: standaloneSelftests.map(file => directStep(path.basename(file, '.js'), process.execPath, [file], 240_000)),
    },
  ]
}

function findChromium() {
  const configured = process.env.FOXWARM_E2E_CHROMIUM
  const candidates = [configured, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  const selected = candidates.find(candidate => candidate && fs.existsSync(candidate))
  if (!selected) throw new Error('Set FOXWARM_E2E_CHROMIUM to a Chromium executable.')
  return selected
}

function browserGroup() {
  const chromium = findChromium()
  const files = requireFiles(browserFiles, 'WebUI browser fixtures')
  console.log(`Browser selection: ${shard ? `shard ${shard.index}/${shard.total}` : 'all files'}, ${files.length}/${inventory['webui-browser'].length} files, ${browserWorkers} worker(s)`)
  return {
    name: 'webui-browser',
    concurrency: browserWorkers,
    stepArtifacts: true,
    retryBrowserFixtures: true,
    steps: [
      // Cold Code assets plus the serial managed builds take nearly ten minutes in CI.
      { ...directStep('prepare', process.execPath, ['scripts/test/prepare-browser.mjs'], 900_000), prepareDependencies: true },
      ...files.map(file => ({
        ...nodeTestStep(path.basename(file), [file], {
          concurrency: 1,
          // Workbench exercises many complete application mounts and navigation paths. Its serial tests take
          // about 340 s on a CI runner and a loaded shard is a few percent slower, so the budget is about twice that.
          timeoutMs: path.basename(file) === 'workbenchPreview.e2e.mjs' ? 720_000 : 240_000,
        }),
        // This fixture rebuilds the WebUI dist consumed by its peers.
        exclusive: path.basename(file) === 'setupModels.e2e.mjs',
        browserFixture: true,
      })),
    ],
    env: {
      FOXWARM_E2E_BROWSER: 'chromium',
      FOXWARM_E2E_CHROMIUM: chromium,
      FOXWARM_CHROMIUM: chromium,
      FOXWARM_E2E_SCREENSHOT_DIR: path.join(runBase, 'screenshots'),
      FOXWARM_TEST_KEEP_SYSTEM_TMP: '1',
    },
  }
}

function appGroup() {
  return {
    name: 'app-browser',
    steps: [directStep('full-application', process.execPath, ['test/app-e2e/run-app-e2e.mjs'], 1_200_000, {
      FOXWARM_APP_E2E_ARTIFACT_DIR: path.join(runBase, 'app-e2e'),
      FOXWARM_E2E_CHROMIUM: findChromium(),
      FOXWARM_TEST_KEEP_SYSTEM_TMP: '1',
    })],
  }
}

// The bounded smoke selection against a published Main executable, such as a
// NativeAOT publication. The full-application harness and these fixtures launch
// FOXWARM_TEST_MAIN_EXECUTABLE instead of managed Main; they need no managed
// fixture preparation or Code workbench assets.
function nativeGroups() {
  const executable = process.env.FOXWARM_TEST_MAIN_EXECUTABLE
  const chromium = findChromium()
  const files = requireFiles(nativeMainSmoke, 'native Main fixtures')
  console.log(`Native Main: ${executable}; ${files.length} browser fixture(s) after the full application`)
  return [appGroup(), {
    name: 'native-browser',
    concurrency: 2,
    stepArtifacts: true,
    retryBrowserFixtures: true,
    steps: files.map(file => ({
      ...nodeTestStep(path.basename(file), [file], { concurrency: 1, timeoutMs: 240_000 }),
      browserFixture: true,
    })),
    env: {
      FOXWARM_E2E_BROWSER: 'chromium',
      FOXWARM_E2E_CHROMIUM: chromium,
      FOXWARM_CHROMIUM: chromium,
      FOXWARM_E2E_SCREENSHOT_DIR: path.join(runBase, 'screenshots'),
      FOXWARM_TEST_KEEP_SYSTEM_TMP: '1',
    },
  }]
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return []
  const result = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) result.push(...walkFiles(full))
    else result.push(full)
  }
  return result
}

async function snapshotVscodeDist() {
  const roots = fs.readdirSync(path.join(repoRoot, 'packages', 'vscode-web'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('foxwarm-'))
    .map(entry => path.join(repoRoot, 'packages', 'vscode-web', entry.name, 'dist'))
  const files = roots.flatMap(walkFiles)
  const bytes = new Map(await Promise.all(files.map(async file => [file, await fsp.readFile(file)])))
  return async () => {
    const after = roots.flatMap(walkFiles)
    for (const file of after) if (!bytes.has(file)) await fsp.rm(file, { force: true })
    for (const [file, content] of bytes) {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, content)
    }
  }
}

const activeChildren = new Set()
let stopping = false
let interrupted = false
function stopActive(signal = 'SIGTERM') {
  for (const child of activeChildren) stopChild(child, signal)
}
function stopChild(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {}
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    interrupted = true
    stopActive('SIGTERM')
    setTimeout(() => stopActive('SIGKILL'), 5_000).unref()
  })
}

async function runStep(group, step, log) {
  console.log(`\n[test:${group.name}] ${step.name}`)
  log.write(`\n[test:${group.name}] ${step.name}\n`)
  // Dependency acquisition keeps the caller's SDK/feed/proxy settings. Test execution
  // always receives owned application paths, cleared credentials and closed proxies.
  const env = { ...(step.prepareDependencies ? process.env : baseEnv), ...(group.env || {}), ...(step.env || {}) }
  return await new Promise(resolve => {
    const child = spawn(step.command, step.args, { cwd: repoRoot, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    activeChildren.add(child)
    let captured = ''
    const forward = chunk => { captured += chunk; process.stdout.write(chunk); log.write(chunk) }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    let timedOut = false
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      console.error(`[test:${group.name}] timed out after ${step.timeoutMs}ms`)
      stopChild(child, 'SIGTERM')
      killTimer = setTimeout(() => stopChild(child, 'SIGKILL'), 5_000)
      killTimer.unref()
    }, step.timeoutMs)
    child.on('error', error => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      activeChildren.delete(child)
      log.write(`${error.stack || error}\n`)
      resolve({ code: 1, timedOut, interrupted, counts: parseTestResultCounts(captured) })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      activeChildren.delete(child)
      resolve({ code: timedOut || interrupted ? 1 : (code ?? (signal ? 1 : 0)), signal, timedOut, interrupted, counts: parseTestResultCounts(captured) })
    })
  })
}

const groups = [
  ...(target === 'managed' || target === 'unit' || target === 'all' ? [managedGroup()] : []),
  ...(target === 'published' || target === 'all' ? [publishedGroup()] : []),
  ...(target === 'unit' || target === 'all' ? unitGroups() : []),
  ...(target === 'reference' ? referenceTestGroups() : []),
  ...(target === 'browser' || target === 'all' ? [browserGroup()] : []),
  ...(target === 'app' || target === 'all' ? [appGroup()] : []),
  ...(target === 'native' ? nativeGroups() : []),
]
const summary = []
for (const group of groups) {
  const restore = group.restoreVscodeDist ? await snapshotVscodeDist() : null
  let groupCode = 0
  let preparationFailed = false
  const logDirectory = path.join(runBase, 'logs', group.name)
  if (group.stepArtifacts) await fsp.mkdir(logDirectory, { recursive: true })
  const groupLog = group.stepArtifacts ? null : fs.createWriteStream(path.join(runBase, 'logs', `${group.name}.log`), { flags: 'w' })
  async function executeStep(order) {
    const original = group.steps[order]
    const retryable = group.retryBrowserFixtures && original.browserFixture
    const attempts = retryable ? BROWSER_FIXTURE_RETRY_COUNT + 1 : 1
    let allRetriesPassed = true
    for (let attempt = 0; attempt < attempts && !interrupted; attempt++) {
      const step = { ...original }
      const suffix = retryable && attempt > 0 ? `.retry-${attempt}` : ''
      const logName = `${step.name}${suffix}.log`
      const log = groupLog || fs.createWriteStream(path.join(logDirectory, logName), { flags: 'w' })
      if (group.stepArtifacts && !step.prepareDependencies) {
        const screenshots = path.join(runBase, 'screenshots', `${step.name}${suffix}`)
        await fsp.mkdir(screenshots, { recursive: true })
        step.env = {
          ...step.env,
          FOXWARM_E2E_SCREENSHOT_DIR: screenshots,
          ...(retryable ? { FOXWARM_BROWSER_FIXTURE_ATTEMPT: String(attempt) } : {}),
        }
      }
      const started = Date.now()
      try {
        const result = await runStep(group, step, log)
        summary.push({
          order,
          group: group.name,
          step: step.name,
          attempt,
          retry: attempt > 0,
          durationMs: Date.now() - started,
          ...result,
        })
        if (result.code === 0) {
          if (attempt === 0) return
          // A retry only recovers the fixture after every retry has passed.
          // Continue running the remaining attempts even after a pass.
        } else {
          if (attempt > 0) allRetriesPassed = false
          if (!retryable) {
            groupCode = result.code
            if (step.prepareDependencies) preparationFailed = true
          }
        }
        if (!retryable && result.code !== 0) return
      } finally {
        if (!groupLog) await new Promise(resolve => log.end(resolve))
      }
    }
    if (retryable) {
      const effectiveCode = !interrupted && allRetriesPassed ? 0 : 1
      for (const row of summary) {
        if (row.group === group.name && row.order === order) row.effectiveCode = effectiveCode
      }
      if (effectiveCode !== 0) groupCode = effectiveCode
    }
  }
  try {
    // Preparation and shared-output writers are barriers; independent files
    // between them share a bounded queue without changing their own test order.
    for (let start = 0; start < group.steps.length && !interrupted && !preparationFailed;) {
      const exclusive = step => step.prepareDependencies || step.exclusive
      let end = start + 1
      if (!exclusive(group.steps[start])) {
        while (end < group.steps.length && !exclusive(group.steps[end])) end++
      }
      let next = start
      await Promise.all(Array.from({ length: Math.min(group.concurrency || 1, end - start) }, async () => {
        while (next < end && !interrupted) await executeStep(next++)
      }))
      start = end
    }
  } finally {
    if (groupLog) await new Promise(resolve => groupLog.end(resolve))
    if (restore) await restore()
  }
  console.log(`[test:${group.name}] ${groupCode === 0 ? 'passed' : 'failed'}`)
  if (interrupted) break
}
summary.sort((a, b) => groups.findIndex(group => group.name === a.group) - groups.findIndex(group => group.name === b.group) || a.order - b.order)
await fsp.writeFile(path.join(runBase, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
for (const group of [...new Set(summary.map(item => item.group))]) {
  const counted = summary.filter(item => item.group === group && item.counts)
  if (!counted.length) continue
  const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
    .map(key => [key, counted.reduce((sum, item) => sum + (item.counts[key] || 0), 0)]))
  console.log(`[test:${group}] totals ${Object.entries(totals).map(([key, value]) => `${key}=${value}`).join(' ')}`)
}
printInventory()
console.log(`Test artifacts: ${path.relative(repoRoot, runBase)}`)
await fsp.rm(shortTempBase, { recursive: true, force: true })
process.exit(interrupted || summary.some(item => (item.effectiveCode ?? item.code) !== 0) ? 1 : 0)
