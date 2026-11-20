import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-viewport-height-test-'))
await esbuild.build({ entryPoints: [path.join(webuiRoot, 'src/viewportHeight.ts')], outfile: path.join(tempDir, 'viewportHeight.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' })
const { appViewportMetrics } = await import(pathToFileURL(path.join(tempDir, 'viewportHeight.mjs')).href)
test.after(() => rm(tempDir, { recursive: true, force: true }))

test('a visual viewport that only differs by rounding keeps the 100dvh default', () => {
  assert.deepEqual(appViewportMetrics({ height: 721.6, offsetTop: 0 }, 722), { height: null, topOffset: 0 })
  assert.deepEqual(appViewportMetrics({ height: 648, offsetTop: 0 }, 648), { height: null, topOffset: 0 })
  assert.deepEqual(appViewportMetrics({ height: 462.857, offsetTop: 0 }, 463), { height: null, topOffset: 0 })
  assert.deepEqual(appViewportMetrics(null, 800), { height: null, topOffset: 0 })
})

test('a shrunken or shifted visual viewport pins the shell to the visible area', () => {
  assert.deepEqual(appViewportMetrics({ height: 400.4, offsetTop: 0 }, 800), { height: 400, topOffset: 0 })
  assert.deepEqual(appViewportMetrics({ height: 800, offsetTop: 32.4 }, 800), { height: 800, topOffset: 32 })
  assert.deepEqual(appViewportMetrics({ height: 540, offsetTop: 12 }, 852), { height: 540, topOffset: 12 })
})
