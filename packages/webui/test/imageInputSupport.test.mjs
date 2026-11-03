import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-image-input-test-'))
const bundledPath = path.join(tempDir, 'imageInputSupport.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/imageInputSupport.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { modelLacksImageInput, shouldShowImageInputHint } = await import(pathToFileURL(bundledPath).href)

const models = [
  { key: 'text', imageInput: false },
  { key: 'vision', imageInput: true },
  { key: 'older' },
]

test('only an explicit false model flag marks the model as text-only', () => {
  assert.equal(modelLacksImageInput(models, 'text'), true)
  assert.equal(modelLacksImageInput(models, 'vision'), false)
  assert.equal(modelLacksImageInput(models, 'older'), false)
  assert.equal(modelLacksImageInput(models, 'missing'), false)
  assert.equal(modelLacksImageInput(models, undefined), false)
})

test('the hint appears for image attachments on a text-only model', () => {
  const image = { mimeType: 'image/png' }
  const upper = { mimeType: 'IMAGE/HEIC' }
  const document = { mimeType: 'application/pdf' }
  assert.equal(shouldShowImageInputHint(models, 'text', [document, image]), true)
  assert.equal(shouldShowImageInputHint(models, 'text', [upper]), true)
  assert.equal(shouldShowImageInputHint(models, 'text', [document]), false)
  assert.equal(shouldShowImageInputHint(models, 'text', []), false)
  assert.equal(shouldShowImageInputHint(models, 'vision', [image]), false)
  assert.equal(shouldShowImageInputHint(models, 'older', [image]), false)
})
