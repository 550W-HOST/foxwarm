import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-chat-optimistic-test-'))
const bundledPath = path.join(tempDir, 'chatOptimistic.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/utils/chatOptimistic.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { shouldAppendOptimisticMessage } = await import(pathToFileURL(bundledPath).href)

test('optimistic user messages are skipped while a session is busy or has queued work', () => {
  assert.equal(shouldAppendOptimisticMessage(false, 0), true)
  assert.equal(shouldAppendOptimisticMessage(true, 0), false)
  assert.equal(shouldAppendOptimisticMessage(false, 1), false)
  assert.equal(shouldAppendOptimisticMessage(true, 2), false)
})
