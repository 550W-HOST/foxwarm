import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-retry-notice-test-'))
const bundledPath = path.join(tempDir, 'retryNotice.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/retryNotice.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { getRetryableLlmRetryNotice } = await import(pathToFileURL(bundledPath).href)

const retryNotice = (seq, final = true) => ({
  role: 'model',
  parts: [{ text: `retry notice ${seq}` }],
  modelVisible: false,
  __meta: { seq, noticeType: 'llm-retry', retry: { final } },
})

test('last LLM retry notice is retryable while the session is idle', () => {
  const notice = retryNotice(2)
  assert.equal(getRetryableLlmRetryNotice([
    { role: 'user', parts: [{ text: 'request' }], __meta: { seq: 1 } },
    notice,
  ], false), notice)
})

test('last LLM retry notice is not retryable while the session is busy', () => {
  assert.equal(getRetryableLlmRetryNotice([retryNotice(1)], true), null)
})

test('historical LLM retry notice is not retryable when a later message exists', () => {
  assert.equal(getRetryableLlmRetryNotice([
    retryNotice(1),
    { role: 'user', parts: [{ text: 'later input' }], __meta: { seq: 2 } },
  ], false), null)
})

test('non-final LLM retry notice left last after a stopped turn is retryable', () => {
  const stoppedNotice = retryNotice(1, false)
  assert.equal(getRetryableLlmRetryNotice([stoppedNotice], false), stoppedNotice)
})
