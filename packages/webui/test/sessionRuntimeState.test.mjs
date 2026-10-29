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


test('human-readable summaries name the actual phase and keep idle quiet', () => {
  assert.equal(getRuntimeStateSummary(runtimeState('requesting-model')), 'Requesting model…')
  assert.equal(getRuntimeStateSummary(runtimeState('requesting-model', { active: { phase: 'compaction' } })), 'Compacting context…')
  assert.equal(getRuntimeStateSummary(undefined, true), 'Running…')
  assert.equal(getSessionRuntimeSummary({ busy: true }), 'Running…')
  assert.equal(getRuntimeStateSummary(runtimeState('idle')), 'idle')
})

test('summaries expose actual tools and pending dependencies rather than generic Working/Waiting', () => {
  assert.equal(getRuntimeStateSummary(runtimeState('running-tool', { tool: { name:'exec', index:1, total:3, startedAt:1 } })), 'Executing exec')
  assert.equal(getRuntimeStateSummary(runtimeState('running-tool', { tool: { name:'node', action:'list', startedAt:1 } })), 'Listing nodes')
  assert.equal(getRuntimeStateSummary(runtimeState('running-tool', { tool: { name:'read', target:'report.md', startedAt:1 } })), 'Reading report.md')
  assert.equal(getRuntimeStateSummary(runtimeState('waiting', { waiting:{waitId:'demo',waitingFor:'all-sessions',waitAllSessions:['one','two'],satisfiedSessions:['one']} })), 'Waiting for 1 session')
  assert.equal(getRuntimeStateSummary(runtimeState('waiting', { waiting:{waitId:'demo',waitingFor:'exec',waitExecIds:['job-a','job-b']} })), 'Waiting for 2 commands')
  assert.equal(getRuntimeStateSummary(runtimeState('waiting', { waiting:{waitId:'demo',waitingFor:'input',waitForInput:true} })), 'Waiting for input')
})

test('LLM failure is inactive and has one danger summary even during independent maintenance', async () => {
  const { isSessionRuntimeActive, getSessionRuntimeTone } = await import(pathToFileURL(bundledPath).href)
  const session = { busy: true, runtimeState: runtimeState('llm-failed', { compaction: { operationId: 'independent', phase: 'planning', background: true } }) }
  assert.equal(isSessionRuntimeActive(session), false)
  assert.equal(getSessionRuntimeTone(session), 'danger')
  assert.equal(getSessionRuntimeSummary(session), 'Request failed')
})


test('processing changes the idle summary without changing active or idle-notification classification', async () => {
  const { isSessionRuntimeActive, getSessionRuntimeTone } = await import(pathToFileURL(bundledPath).href)
  const session = { busy: false, runtimeState: runtimeState('idle', { processing: true }) }
  assert.equal(getSessionRuntimeSummary(session), 'Running…')
  assert.equal(getSessionRuntimeTone(session), 'muted')
  assert.equal(isSessionRuntimeActive(session), false)
  assert.equal(getRuntimeStateSummary(runtimeState('llm-failed', { processing: true })), 'Request failed')
  assert.equal(getRuntimeStateSummary(runtimeState('waiting', { processing: true })), 'Waiting')
})
