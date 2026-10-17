import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const webuiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('ChatTimeline no longer owns the LLM retry action', async () => {
  const source = await readFile(path.join(webuiRoot, 'src/components/ChatTimeline.tsx'), 'utf8')
  assert.doesNotMatch(source, /retryableLlmRetryNotice|onRetryLlmNotice|showRetryButton/)
  assert.doesNotMatch(source, />\s*Retry\s*</)
})

test('Chat status continuation sends only the public /continue command', async () => {
  const source = await readFile(path.join(webuiRoot, 'src/components/Chat.tsx'), 'utf8')
  assert.match(source, /sendSessionCommand\('\/continue'\)/)
  assert.doesNotMatch(source, /sendSessionCommand\('\/retry'\)/)
})
