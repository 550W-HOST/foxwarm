import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-model-options-loader-test-'))
const bundledPath = path.join(tempDir, 'modelOptionsLoader.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/modelOptionsLoader.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { createLatestRequestGate, loadPageOnce, runLatestModelOptionsRequest } = await import(pathToFileURL(bundledPath).href)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function stateHarness() {
  const state = { options: [], error: null, loading: false }
  const updates = []
  return {
    state,
    updates,
    update(patch) {
      Object.assign(state, patch)
      updates.push({ ...patch })
    },
  }
}

test('a delayed older success cannot replace newer model options or clear its loading state', async () => {
  const gate = createLatestRequestGate()
  const harness = stateHarness()
  const older = deferred()
  const newer = deferred()
  const olderRun = runLatestModelOptionsRequest(gate, () => older.promise, harness.update)
  const newerRun = runLatestModelOptionsRequest(gate, () => newer.promise, harness.update)

  newer.resolve([{ key: 'new/model' }])
  await newerRun
  older.resolve([{ key: 'old/model' }])
  await olderRun

  assert.deepEqual(harness.state, { options: [{ key: 'new/model' }], error: null, loading: false })
  assert.equal(harness.updates.filter((update) => update.loading === false).length, 1)
})

test('a stale older failure cannot erase a newer successful model list or publish an error', async () => {
  const gate = createLatestRequestGate()
  const harness = stateHarness()
  const older = deferred()
  const newer = deferred()
  const olderRun = runLatestModelOptionsRequest(gate, () => older.promise, harness.update)
  const newerRun = runLatestModelOptionsRequest(gate, () => newer.promise, harness.update)

  newer.resolve([{ key: 'new/model' }])
  await newerRun
  older.reject(new Error('stale request failed'))
  await olderRun

  assert.deepEqual(harness.state, { options: [{ key: 'new/model' }], error: null, loading: false })
  assert.equal(harness.updates.some((update) => update.error === 'stale request failed'), false)
})

test('page-lifetime loads share one parsed result across concurrent and later consumers', async () => {
  let requests = 0
  const pending = deferred()
  const first = loadPageOnce('models-success', async () => {
    requests += 1
    return pending.promise
  })
  const second = loadPageOnce('models-success', async () => {
    requests += 1
    return [{ key: 'unexpected' }]
  })
  await Promise.resolve()
  assert.equal(requests, 1)
  pending.resolve([{ key: 'shared/model' }])
  assert.deepEqual(await first, [{ key: 'shared/model' }])
  assert.deepEqual(await second, [{ key: 'shared/model' }])
  assert.deepEqual(await loadPageOnce('models-success', async () => [{ key: 'later' }]), [{ key: 'shared/model' }])
  assert.equal(requests, 1)
})

test('page-lifetime loads cache failures and a fresh module lifetime starts empty', async () => {
  let failedRequests = 0
  const request = () => {
    failedRequests += 1
    return Promise.reject(new Error('cached failure'))
  }
  await assert.rejects(loadPageOnce('models-failure', request), /cached failure/)
  await assert.rejects(loadPageOnce('models-failure', request), /cached failure/)
  assert.equal(failedRequests, 1)

  const fresh = await import(`${pathToFileURL(bundledPath).href}?fresh-page=1`)
  let freshRequests = 0
  assert.deepEqual(await fresh.loadPageOnce('models-failure', async () => {
    freshRequests += 1
    return [{ key: 'fresh/model' }]
  }), [{ key: 'fresh/model' }])
  assert.equal(freshRequests, 1)
})
