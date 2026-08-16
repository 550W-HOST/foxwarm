import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-attachment-preview-test-'))
const bundledPath = path.join(tempDir, 'attachmentPreview.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/utils/attachmentPreview.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { appendOptimisticAttachmentTag } = await import(pathToFileURL(bundledPath).href)

test('optimistic attachment previews use one-line foxwarm tags without temporary paths', () => {
  assert.equal(
    appendOptimisticAttachmentTag('caption', { filename: '中文测试.txt', mimeType: 'text/plain' }),
    'caption\n\n<foxwarm-file name="中文测试.txt" mime="text/plain" />',
  )
  assert.equal(
    appendOptimisticAttachmentTag('', { filename: 'photo.png', mimeType: 'image/png' }),
    '<foxwarm-image name="photo.png" />',
  )
})

test('optimistic attachment previews escape XML attributes and remain single-line descriptors', () => {
  const text = appendOptimisticAttachmentTag('', {
    filename: 'a"<&\n\u0001.txt',
    mimeType: 'text/plain"<&\nnext',
  })
  assert.equal(text, '<foxwarm-file name="a&quot;&lt;&amp; .txt" mime="text/plain&quot;&lt;&amp; next" />')
  assert.equal(text.split('\n').length, 1)
  assert.doesNotMatch(text, /\b(?:node|path)=/)
})