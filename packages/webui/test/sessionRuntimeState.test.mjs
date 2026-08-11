import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-runtime-state-test-'))
const bundledPath = path.join(tempDir, 'sessionRuntimeState.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/sessionRuntimeState.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const {
  getRuntimeStateSummary,
  getSessionRuntimeSummary,
} = await import(pathToFileURL(bundledPath).href)

const runtimeState = (state, extra = {}) => ({
  state,
  queueLength: 0,
  busy: state === 'requesting-model' || state === 'running-tool',
  ...extra,
})

test('runtime summaries call requesting-model thinking and retain non-normal phase detail', () => {
  assert.equal(getRuntimeStateSummary(runtimeState('requesting-model')), 'thinking')
  assert.equal(getRuntimeStateSummary(runtimeState('requesting-model', { active: { phase: 'normal-turn' } })), 'thinking')
  assert.equal(getRuntimeStateSummary(runtimeState('requesting-model', { active: { phase: 'compaction' } })), 'thinking · compaction')
  assert.equal(getRuntimeStateSummary(undefined, true), 'thinking')
  assert.equal(getSessionRuntimeSummary({ busy: true }), 'thinking')
})

test('runtime summaries preserve tool batch, waiting details, and idle', () => {
  assert.equal(getRuntimeStateSummary(runtimeState('running-tool', {
    tool: { name: 'exec', index: 1, total: 3, startedAt: 1 },
  })), 'tool: exec 2/3')
  assert.equal(getRuntimeStateSummary(runtimeState('waiting', {
    waiting: {
      waitId: 'sessions',
      waitingFor: 'sessions',
      waitAllSessions: ['one', 'two'],
      satisfiedSessions: ['one'],
    },
  })), 'waiting: sessions 1/2')
  assert.equal(getRuntimeStateSummary(runtimeState('waiting', {
    waiting: { waitId: 'exec', waitingFor: 'exec', waitExecIds: ['job-a', 'job-b'] },
  })), 'waiting: exec 2')
  assert.equal(getRuntimeStateSummary(runtimeState('waiting', {
    waiting: { waitId: 'timer', waitingFor: 'timer', timeoutSeconds: 30 },
  })), 'waiting: timer 30s')
  assert.equal(getRuntimeStateSummary(runtimeState('idle')), 'idle')
})
