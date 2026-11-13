import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-window-frame-test-'))
await esbuild.build({ entryPoints: [path.join(webuiRoot, 'src/windowFrame.ts')], outfile: path.join(tempDir, 'windowFrame.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' })
const frame = await import(pathToFileURL(path.join(tempDir, 'windowFrame.mjs')).href)
test.after(() => rm(tempDir, { recursive: true, force: true }))

const box = (x, y, w, h) => ({ left: x, top: y, right: x + w, bottom: y + h })
const windows = { left: 0, right: 138, top: 32, width: 1280 }
const macos = { left: 78, right: 0, top: 38, width: 1280 }

test('host frame state accepts only the two Desktop platforms and normalizes insets and state tokens', () => {
  assert.equal(frame.readHostFrame(undefined), null)
  assert.equal(frame.readHostFrame({ platform: 'linux', left: 0, right: 0, top: 30 }), null)
  assert.deepEqual(frame.readHostFrame({ platform: 'windows', left: -4, right: 138, top: Number.NaN, state: ['maximized', 'Bad Token', 7] }),
    { platform: 'windows', left: 0, right: 138, top: 0, state: ['maximized'] })
  assert.deepEqual(frame.readHostFrame({ platform: 'macos', left: 78, right: 0, top: 38 }), { platform: 'macos', left: 78, right: 0, top: 38, state: [] })
})

test('rectangle subtraction leaves the uncovered bands of the base', () => {
  const base = { x: 0, y: 0, w: 100, h: 40 }
  assert.deepEqual(frame.subtractRect(base, { x: 200, y: 0, w: 10, h: 10 }), [base])
  assert.deepEqual(frame.subtractRect(base, { x: -10, y: -10, w: 200, h: 200 }), [])
  const parts = frame.subtractRect(base, { x: 40, y: 10, w: 20, h: 20 })
  assert.deepEqual(parts, [
    { x: 0, y: 0, w: 100, h: 10 },
    { x: 0, y: 30, w: 100, h: 10 },
    { x: 0, y: 10, w: 40, h: 20 },
    { x: 60, y: 10, w: 40, h: 20 },
  ])
  assert.equal(parts.reduce((sum, r) => sum + r.w * r.h, 0), 100 * 40 - 20 * 20)
})

test('rows clear only the control zones they actually intersect', () => {
  // Windows: the sidebar is never under the caption buttons; the right-most strip reserves overlap + gap.
  assert.deepEqual(frame.frameRowLayout(box(6, 6, 256, 788), windows, 'stack'), { inBand: true, top: 0, left: 0, right: 0 })
  assert.deepEqual(frame.frameRowLayout(box(269, 7, 1004, 42), windows, 'inline'), { inBand: true, top: 0, left: 0, right: 1273 - 1142 + frame.FRAME_DRAG_GAP })
  assert.deepEqual(frame.frameRowLayout(box(269, 7, 500, 42), windows, 'inline'), { inBand: true, top: 0, left: 0, right: 0 })
  // macOS: the sidebar moves below the lights; a strip under the lights' right edge steps right of them.
  assert.deepEqual(frame.frameRowLayout(box(6, 6, 256, 788), macos, 'stack'), { inBand: true, top: 32, left: 0, right: 0 })
  assert.deepEqual(frame.frameRowLayout(box(61, 7, 1212, 42), macos, 'inline'), { inBand: true, top: 0, left: 17 + frame.FRAME_DRAG_GAP, right: 0 })
  // Rows below the band and full screen (no zones) reserve nothing.
  assert.deepEqual(frame.frameRowLayout(box(269, 400, 1004, 42), windows, 'inline'), { inBand: false, top: 0, left: 0, right: 0 })
  assert.deepEqual(frame.frameRowLayout(box(6, 6, 256, 788), { left: 0, right: 0, top: 0, width: 1280 }, 'stack'), { inBand: false, top: 0, left: 0, right: 0 })
})

test('edge fills reach only the edges a surface nearly touches, top fill first with its corners', () => {
  // Sidebar band inside a 6 px gutter and 1 px border: top fill takes the left corner, then the left fill.
  assert.deepEqual(frame.frameEdgeFillCandidates({ x: 7, y: 7, w: 254, h: 12 }, 1280), [
    [{ x: 0, y: 0, w: 261, h: 7 }, { x: 7, y: 0, w: 254, h: 7 }],
    [{ x: 0, y: 7, w: 7, h: 12 }],
  ])
  // Gap beside the caption buttons: up and right.
  assert.deepEqual(frame.frameEdgeFillCandidates({ x: 1102, y: 7, w: 171, h: 42 }, 1280), [
    [{ x: 1102, y: 0, w: 178, h: 7 }, { x: 1102, y: 0, w: 171, h: 7 }],
    [{ x: 1273, y: 7, w: 7, h: 42 }],
  ])
  // Already at the edge, or too far from it: nothing.
  assert.deepEqual(frame.frameEdgeFillCandidates({ x: 0, y: 0, w: 700, h: 32 }, 700), [])
  assert.deepEqual(frame.frameEdgeFillCandidates({ x: 300, y: 60, w: 100, h: 30 }, 1280), [])
})
