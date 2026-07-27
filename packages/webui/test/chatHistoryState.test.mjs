import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-chat-history-state-test-'))
const bundledPath = path.join(tempDir, 'chatHistoryState.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/chatHistoryState.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const {
  buildOptimisticUserMessage,
  mergeHistorySnapshot,
  reconcileHistoryMessage,
} = await import(pathToFileURL(bundledPath).href)

const optimistic = (id, text, timestamp) => buildOptimisticUserMessage({
  clientMessageId: id,
  parts: [{ text }],
  timestamp,
})
const persisted = (id, text, seq, timestamp) => ({
  role: 'user',
  parts: [{ text }],
  __meta: { clientMessageId: id, seq, timestamp },
})

test('rapid optimistic A/B messages reconcile in their own slots', () => {
  let messages = [optimistic('send-a', 'A', 10), optimistic('send-b', 'B', 11)]
  messages = reconcileHistoryMessage(messages, persisted('send-a', 'A', 1, 12))
  messages = reconcileHistoryMessage(messages, persisted('send-b', 'B', 2, 13))

  assert.deepEqual(messages.map(message => message.parts[0].text), ['A', 'B'])
  assert.deepEqual(messages.map(message => message.__meta.seq), [1, 2])
  assert.equal(messages.some(message => message.__meta.optimistic), false)
})

test('identical optimistic messages reconcile by client identity rather than text', () => {
  let messages = [optimistic('same-a', 'same', 10), optimistic('same-b', 'same', 11)]
  messages = reconcileHistoryMessage(messages, persisted('same-b', 'same', 2, 13))

  assert.equal(messages[0].__meta.clientMessageId, 'same-a')
  assert.equal(messages[0].__meta.optimistic, true)
  assert.equal(messages[1].__meta.clientMessageId, 'same-b')
  assert.equal(messages[1].__meta.seq, 2)
})

test('a delayed history snapshot replays newer SSE messages and pending optimistic rows', () => {
  const currentMessages = [
    { role: 'user', parts: [{ text: 'old' }], __meta: { seq: 1, timestamp: 10 } },
    { role: 'model', parts: [{ text: 'new SSE answer' }], __meta: { seq: 2, timestamp: 20 } },
    optimistic('pending-c', 'C', 30),
  ]
  const merged = mergeHistorySnapshot({
    snapshot: [{ role: 'user', parts: [{ text: 'old' }], __meta: { seq: 1, timestamp: 10 } }],
    concurrentMessages: [currentMessages[1]],
    currentMessages,
    pendingClientMessageIds: new Set(['pending-c']),
  })

  assert.deepEqual(merged.map(message => message.parts[0].text), ['old', 'new SSE answer', 'C'])
})

test('stable seq messages are not dropped merely because a legacy timestamp collides', () => {
  const first = { role: 'user', parts: [{ text: 'first' }], __meta: { seq: 1, timestamp: 10 } }
  const second = { role: 'model', parts: [{ text: 'second' }], __meta: { seq: 2, timestamp: 10 } }
  assert.equal(reconcileHistoryMessage([first], second).length, 2)

  const duplicateLegacy = { role: 'model', parts: [{ text: 'legacy duplicate' }], __meta: { timestamp: 10 } }
  assert.strictEqual(reconcileHistoryMessage([first], duplicateLegacy)[0], first)
  assert.equal(reconcileHistoryMessage([first], duplicateLegacy).length, 1)
})
