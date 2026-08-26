import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/architectureOperations.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const {
  filterArchitectureSessions,
  getArchitectureSessionNodeId,
  getArchitectureNodePreview,
  groupArchitectureSessionsByNode,
  matchesArchitectureStatus,
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const sessions = [
  { id: 'main/root', agent: 'main', currentNode: 'master', runtimeState: { state: 'requesting-model', queueLength: 0, busy: true } },
  { id: 'research/wait', displayName: 'Research', agent: 'research', currentNode: 'linux', runtimeState: { state: 'waiting', queueLength: 0, busy: false, waiting: { waitId: 'w', waitingFor: 'sessions' } } },
  { id: 'main/exec', agent: 'main', currentNode: 'master', runtimeState: { state: 'running-tool', queueLength: 2, busy: true, tool: { name: 'exec', executionNode: 'mac', startedAt: 1 } } },
  { id: 'isolated/job', agent: 'worker', isolated: true, currentNode: 'linux', model: 'provider/model' },
]

test('runtime tool placement overrides the session default node for topology lanes', () => {
  assert.equal(getArchitectureSessionNodeId(sessions[2]), 'mac')
  assert.equal(getArchitectureSessionNodeId(sessions[0]), 'master')
})

test('operational filters use canonical runtime state and queue length', () => {
  assert.equal(matchesArchitectureStatus(sessions[0], 'active'), true)
  assert.equal(matchesArchitectureStatus(sessions[1], 'waiting'), true)
  assert.equal(matchesArchitectureStatus(sessions[2], 'queued'), true)
  assert.equal(matchesArchitectureStatus(sessions[3], 'isolated'), true)
  assert.deepEqual(filterArchitectureSessions(sessions, 'active', '').map(item => item.id), ['main/root', 'main/exec'])
})

test('search covers session, agent, node, model, tool, and wait semantics', () => {
  assert.deepEqual(filterArchitectureSessions(sessions, 'all', 'Research').map(item => item.id), ['research/wait'])
  assert.deepEqual(filterArchitectureSessions(sessions, 'all', 'mac').map(item => item.id), ['main/exec'])
  assert.deepEqual(filterArchitectureSessions(sessions, 'all', 'provider/model').map(item => item.id), ['isolated/job'])
  assert.deepEqual(filterArchitectureSessions(sessions, 'all', 'exec').map(item => item.id), ['main/exec'])
  assert.deepEqual(filterArchitectureSessions(sessions, 'all', 'sessions').map(item => item.id), ['research/wait'])
})

test('sessions group into effective execution-node lanes without reordering rows', () => {
  const groups = groupArchitectureSessionsByNode(sessions)
  assert.deepEqual([...groups.keys()], ['master', 'linux', 'mac'])
  assert.deepEqual(groups.get('linux').map(item => item.id), ['research/wait', 'isolated/job'])
})

test('bounded node previews keep selected and active sessions visible before ordinary rows', () => {
  const rows = [
    { id: 'idle-1' }, { id: 'idle-2' }, { id: 'idle-3' },
    { id: 'active', runtimeState: { state: 'running-tool', queueLength: 0, busy: true, tool: { name: 'exec', startedAt: 1 } } },
    { id: 'selected' }, { id: 'idle-4' },
  ]
  assert.deepEqual(getArchitectureNodePreview(rows, new Set(['selected']), 3).map(item => item.id), [
    'selected', 'active', 'idle-1',
  ])
})
