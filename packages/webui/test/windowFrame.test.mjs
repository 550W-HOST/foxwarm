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
const windows = { left: 0, right: 144, top: 48, width: 1280 }
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

const plan = (fields) => ({ inBand: true, top: 0, left: 0, right: 0, banded: false, ...fields })

test('rows clear only the control zones they actually intersect', () => {
  // Windows: the sidebar column only reports that it is in the band; the right-most strip reserves overlap + gap.
  assert.deepEqual(frame.frameRowLayout(box(0, 0, 256, 800), windows, 'column'), plan({}))
  assert.deepEqual(frame.frameRowLayout(box(269, 7, 1004, 42), windows, 'inline'), plan({ right: 1273 - 1136 + frame.FRAME_DRAG_GAP }))
  assert.deepEqual(frame.frameRowLayout(box(269, 7, 500, 42), windows, 'inline'), plan({}))
  // macOS: the sidebar column's brand row steps right of the lights in CSS, so the column reserves nothing;
  // a strip under the lights' right edge steps right of them.
  assert.deepEqual(frame.frameRowLayout(box(0, 0, 256, 800), macos, 'column'), plan({}))
  assert.deepEqual(frame.frameRowLayout(box(61, 7, 1212, 42), macos, 'inline'), plan({ left: 17 + frame.FRAME_DRAG_GAP }))
  // Rows below the band and full screen (no zones) reserve nothing.
  assert.deepEqual(frame.frameRowLayout(box(269, 400, 1004, 42), windows, 'inline'), plan({ inBand: false }))
  assert.deepEqual(frame.frameRowLayout(box(0, 0, 256, 800), { left: 0, right: 0, top: 0, width: 1280 }, 'column'), plan({ inBand: false }))
})

test('an inline row too narrow for its content beside the controls moves below a band as tall as the controls', () => {
  // A 250 px corner pane: the reservation leaves 66 px, less than one tab plus the pane controls.
  assert.deepEqual(frame.frameRowLayout(box(1023, 6, 250, 42), windows, 'inline', 230), plan({ top: 42, banded: true }))
  // A wide corner pane keeps its tabs beside the reservation; they scroll before the row bands.
  const wide = 1273 - 1136 + frame.FRAME_DRAG_GAP
  assert.deepEqual(frame.frameRowLayout(box(673, 6, 600, 42), windows, 'inline', 230), plan({ right: wide }))
  // The threshold compares the width left beside the reservation with the declared minimum.
  assert.equal(frame.frameRowLayout(box(1273 - 230 - wide, 6, 230 + wide, 42), windows, 'inline', 230).banded, false)
  assert.equal(frame.frameRowLayout(box(1273 - 229 - wide, 6, 229 + wide, 42), windows, 'inline', 230).banded, true)
  // Rows clear of the zones and rows without a declared minimum never band.
  assert.equal(frame.frameRowLayout(box(269, 7, 200, 42), windows, 'inline', 230).banded, false)
  assert.equal(frame.frameRowLayout(box(1023, 6, 250, 42), windows, 'inline').banded, false)
  // macOS: a narrow first pane under the lights bands too, below the lights' height.
  assert.deepEqual(frame.frameRowLayout(box(61, 7, 200, 42), macos, 'inline', 230), plan({ top: 31, banded: true }))
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
