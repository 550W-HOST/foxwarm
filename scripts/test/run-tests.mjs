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
  routineUnitGroups,
  standaloneSelftests,
} from './test-inventory.mjs'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const target = process.argv[2] || 'unit'
const validTargets = new Set(['inventory', 'unit', 'browser', 'all'])
if (!validTargets.has(target)) {
  console.error(`Usage: node scripts/test/run-tests.mjs <${[...validTargets].join('|')}>`)
  process.exit(2)
}

const inventory = loadTestInventory(repoRoot)
const unclassified = inventory.unclassified || []
const missingGroups = routineUnitGroups.filter(group => !(inventory[group]?.length))
if (unclassified.length || missingGroups.length) {
  if (unclassified.length) console.error(`Unclassified tests:\n${unclassified.map(file => `  ${file}`).join('\n')}`)
  if (missingGroups.length) console.error(`Empty required test groups: ${missingGroups.join(', ')}`)
  process.exit(1)
}

function printInventory() {
  console.log('Foxwarm test inventory')
  for (const [group, files] of Object.entries(inventory)) {
    const note = deferredGroups[group] ? ` — ${deferredGroups[group]}` : ''
    console.log(`${group.padEnd(20)} ${String(files.length).padStart(3)} file(s)${note}`)
  }
  console.log(`standalone-selftests ${String(standaloneSelftests.length).padStart(3)} executable(s)`)
}

if (target === 'inventory') {
  printInventory()
  process.exit(0)
}

const artifactParent = process.env.FOXWARM_TEST_ARTIFACT_DIR
  ? path.resolve(process.env.FOXWARM_TEST_ARTIFACT_DIR)
  : path.join(repoRoot, 'test', '.temp', 'test-runs')
const runId = `${target}-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
const runBase = path.join(artifactParent, runId)
await fsp.mkdir(path.join(runBase, 'logs'), { recursive: true })
await fsp.writeFile(path.join(runBase, 'inventory.json'), `${JSON.stringify({ inventory, standaloneSelftests }, null, 2)}\n`)
const shortTempBase = path.join(os.tmpdir(), `fw-${process.pid}`)
await fsp.rm(shortTempBase, { recursive: true, force: true })
await fsp.mkdir(shortTempBase, { recursive: true })

const preloadUrl = pathToFileURL(path.join(scriptDir, 'test-process-env.mjs')).href
const baseEnv = {
  ...process.env,
  FOXWARM_TEST_RUN_ROOT: runBase,
  FOXWARM_TEST_REPO_ROOT: repoRoot,
  FOXWARM_TEST_TEMP_ROOT: shortTempBase,
  OPENAI_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  GOOGLE_API_KEY: '',
  GEMINI_API_KEY: '',
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  NO_PROXY: 'localhost,127.0.0.1,::1',
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

function unitGroups() {
  const backend = requireFiles(inventory.backend.map(compiledPath), 'backend tests')
  const shared = requireFiles(inventory.shared.map(compiledPath), 'shared tests')
  const cli = requireFiles(inventory['cli-node'].map(compiledPath), 'CLI Node tests')
  const sandbox = requireFiles(inventory['sandbox-node'].map(compiledPath), 'sandbox tests')
  const browserNode = requireFiles(inventory['browser-node'], 'browser Node tests')
  const scripts = requireFiles(inventory.scripts, 'script tests')
  const skillNode = requireFiles(inventory['skill-node'], 'skill Node tests')
  const webui = requireFiles(inventory['webui-unit'], 'WebUI unit tests')
  const python = requireFiles(inventory.python, 'Python tests')
  requireFiles(standaloneSelftests, 'standalone selftests')
  return [
    {
      name: 'backend',
      parallel: 8,
      steps: backend.map(file => nodeTestStep(path.relative(repoRoot, file), [file], { timeoutMs: 600_000 })),
    },
    { name: 'shared', steps: [nodeTestStep('shared', shared, { concurrency: 4, timeoutMs: 240_000 })] },
    { name: 'cli-node', steps: [nodeTestStep('cli-node', cli, { concurrency: 4, timeoutMs: 180_000 })] },
    { name: 'sandbox-node', steps: [nodeTestStep('sandbox-node', sandbox, { concurrency: 2, timeoutMs: 180_000 })] },
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
    {
      name: 'standalone-selftests',
      steps: standaloneSelftests.map(file => {
        const key = path.basename(file, '.js')
        const processRoot = path.join(runBase, 'selftests', key)
        return directStep(key, process.execPath, [file], 240_000, {
          FOXWARM_DATA_DIR: path.join(processRoot, 'data'),
          TMPDIR: path.join(processRoot, 'tmp'),
          TMP: path.join(processRoot, 'tmp'),
          TEMP: path.join(processRoot, 'tmp'),
        })
      }),
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
  const files = requireFiles(inventory['webui-browser'], 'WebUI browser fixtures')
  return {
    name: 'webui-browser',
    steps: files.map(file => nodeTestStep(path.basename(file), [file], { concurrency: 1, timeoutMs: 240_000 })),
    env: {
      FOXWARM_E2E_BROWSER: 'chromium',
      FOXWARM_E2E_CHROMIUM: chromium,
      FOXWARM_E2E_SCREENSHOT_DIR: path.join(runBase, 'screenshots'),
      FOXWARM_TEST_KEEP_SYSTEM_TMP: '1',
    },
  }
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
  const env = { ...baseEnv, ...(group.env || {}), ...(step.env || {}) }
  for (const key of ['FOXWARM_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP']) {
    if (step.env?.[key]) await fsp.mkdir(step.env[key], { recursive: true })
  }
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
      resolve({ code: 1, timedOut, counts: parseTapCounts(captured) })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      activeChildren.delete(child)
      resolve({ code: code ?? (signal ? 1 : 0), signal, timedOut, counts: parseTapCounts(captured) })
    })
  })
}

function parseTapCounts(output) {
  const counts = {}
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, 'gm'))]
    if (matches.length) counts[key] = Number(matches.at(-1)[1])
  }
  return Object.keys(counts).length ? counts : null
}

const groups = [
  ...(target === 'unit' || target === 'all' ? unitGroups() : []),
  ...(target === 'browser' || target === 'all' ? [browserGroup()] : []),
]
const summary = []
for (const group of groups) {
  const restore = group.restoreVscodeDist ? await snapshotVscodeDist() : null
  let groupCode = 0
  try {
    if (group.parallel) {
      const logDir = path.join(runBase, 'logs', group.name)
      await fsp.mkdir(logDir, { recursive: true })
      let nextStep = 0
      await Promise.all(Array.from({ length: Math.min(group.parallel, group.steps.length) }, async () => {
        while (!interrupted) {
          const stepIndex = nextStep++
          if (stepIndex >= group.steps.length) return
          const step = group.steps[stepIndex]
          const safeName = step.name.replace(/[^A-Za-z0-9_.-]+/g, '-')
          const log = fs.createWriteStream(path.join(logDir, `${String(stepIndex + 1).padStart(3, '0')}-${safeName}.log`), { flags: 'w' })
          try {
            const result = await runStep(group, step, log)
            summary.push({ order: stepIndex, group: group.name, step: step.name, ...result })
            if (result.code !== 0) groupCode = result.code
          } finally {
            await new Promise(resolve => log.end(resolve))
          }
        }
      }))
    } else {
      const log = fs.createWriteStream(path.join(runBase, 'logs', `${group.name}.log`), { flags: 'w' })
      try {
        for (const [stepIndex, step] of group.steps.entries()) {
          const result = await runStep(group, step, log)
          summary.push({ order: stepIndex, group: group.name, step: step.name, ...result })
          if (result.code !== 0) groupCode = result.code
          if (interrupted) break
        }
      } finally {
        await new Promise(resolve => log.end(resolve))
      }
    }
  } finally {
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
process.exit(interrupted || summary.some(item => item.code !== 0) ? 1 : 0)
