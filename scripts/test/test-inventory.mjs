import { execFileSync } from 'node:child_process'
import path from 'node:path'

// Both the full harness and per-scenario npm scripts use an owned application.
// Raw invocation of these scenario files fails before reading an installation token.
export const appRuntimeE2e = [
  'packages/webui/test/lazyTimelineRestore.e2e.mjs',
  'packages/webui/test/scrollState.e2e.mjs',
  'packages/webui/test/sessionHeader.e2e.mjs',
  'packages/webui/test/sessionListDrag.e2e.mjs',
  'packages/webui/test/sessionListLiveRefresh.e2e.mjs',
  'packages/webui/test/systemTabs.e2e.mjs',
]

export const standaloneSelftests = [
  'lib/selftest/queueDrainSelfTest.js',
  'lib/selftest/toolLoopStallSelfTest.js',
]

// Driven by test/app-e2e/run-app-e2e.mjs with a live application and a scripted
// provider, so they are never run standalone by the routine unit groups.
export const appHarnessE2e = [
  'test/app-e2e/core.e2e.mjs',
  'test/app-e2e/logs.e2e.mjs',
  'test/app-e2e/artifacts.e2e.mjs',
  'test/app-e2e/imageGeneration.e2e.mjs',
  'test/app-e2e/imageGenerationRestart.e2e.mjs',
]

const testLike = /(?:\.test\.(?:ts|js|mjs|cjs)|\.e2e\.mjs|\/test_[^/]+\.py)$/

const manualGroups = new Map([
  ['test/managedSessionLiveSmoke.js', 'manual-smoke'],
  ['test/pushOnlyBroadcastSmoke.js', 'manual-smoke'],
  ['test/sessionMetadataSafetySmoke.js', 'manual-smoke'],
  ['test/stopAbortSmoke.js', 'manual-smoke'],
  ['test/toolscriptPhase1Smoke.js', 'manual-smoke'],
  ['test/llmToolSerializationTest.js', 'manual-regression'],
  ['test/toolscriptSkillAgentTrial.js', 'manual-skill-trial'],
  ['packages/android-node/test.py', 'manual-hardware-smoke'],
])

function normalize(value) {
  return value.split(path.sep).join('/')
}

function classify(file) {
  if (manualGroups.has(file)) return manualGroups.get(file)
  if (file.startsWith('dotnet/Foxwarm.Tests/') && file.endsWith('.cs')) return 'managed'
  if (!testLike.test(file)) return null
  if (file === 'packages/webui/test/publishedCore.e2e.mjs') return 'managed-delivery'
  if (/^(?:lib|packages\/[^/]+\/dist)\/.*\.test\.js$/.test(file)) return 'generated-test-artifact'
  if (/^src\/.*\.test\.ts$/.test(file)) return 'backend'
  if (/^packages\/shared\/src\/.*\.test\.ts$/.test(file)) return 'shared'
  if (/^packages\/cli-node\/src\/.*\.test\.ts$/.test(file)) return 'cli-node'
  if (/^packages\/browser-node\/test\/.*\.test\.mjs$/.test(file)) return 'browser-node'
  if (/^packages\/android-node\/test_[^/]+\.py$/.test(file)) return 'python'
  if (/^docs\/code-index\/scripts\/tests\/test_[^/]+\.py$/.test(file)) return 'python'
  if (/^scripts\/.*\.test\.(?:js|mjs)$/.test(file)) return 'scripts'
  if (/^skills\/.*\/tests\/test_[^/]+\.py$/.test(file)) return 'python'
  if (/^skills\/.*\.test\.js$/.test(file)) return 'skill-node'
  if (/^packages\/vscode-web\/.*\/test\/.*\.test\.mjs$/.test(file)
    || /^packages\/vscode-web\/test\/.*\.test\.mjs$/.test(file)) return 'vscode-web'
  if (file === 'packages/vscode-web/test/yamlSchema.e2e.mjs') return 'vscode-assets-e2e'
  if (/^packages\/webui\/test\/.*\.test\.mjs$/.test(file)) return 'webui-unit'
  if (/^packages\/webui\/test\/.*\.e2e\.mjs$/.test(file)) {
    return appRuntimeE2e.includes(file) ? 'app-browser' : 'webui-browser'
  }
  if (appHarnessE2e.includes(file)) return 'app-browser'
  if (/^website\/tests\//.test(file)) return 'website-owned'
  return 'unclassified'
}

export function loadTestInventory(repoRoot) {
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split(/\r?\n/)
    .map(normalize)
    .filter(Boolean)
  const groups = new Map()
  for (const file of tracked) {
    const group = classify(file)
    if (!group) continue
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(file)
  }
  for (const files of groups.values()) files.sort()
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

export function compiledPath(file) {
  if (file.startsWith('src/') && file.endsWith('.ts')) return `lib/${file.slice(4, -3)}.js`
  const packageMatch = file.match(/^packages\/(shared|cli-node)\/src\/(.*)\.ts$/)
  if (packageMatch) return `packages/${packageMatch[1]}/dist/${packageMatch[2]}.js`
  return file
}

export const routineUnitGroups = [
  'backend',
  'shared',
  'cli-node',
  'browser-node',
  'scripts',
  'skill-node',
  'vscode-web',
  'webui-unit',
  'python',
]

export const deferredGroups = {
  'managed': 'Compiled and executed by dotnet test through test:managed or test:unit.',
  'managed-delivery': 'Complete owned publish and original App proof through test:published.',
  'generated-test-artifact': 'Covered through its classified source test.',
  'vscode-assets-e2e': 'Requires prepared VS Code and YAML extension assets.',
  'website-owned': 'Owned by the website test workflow.',
  'manual-smoke': 'Stateful standalone smoke checks; run only with an explicitly assigned disposable environment.',
  'manual-regression': 'Standalone historical regression script; not part of the routine runner.',
  'manual-skill-trial': 'Historical interactive trial; isolated state but no maintained synthetic provider fixture.',
  'manual-hardware-smoke': 'Live-device smoke driver; requires explicitly assigned Android hardware and is never routine CI.',
}
