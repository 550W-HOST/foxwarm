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
  advanceHistorySeqFrontier,
  buildOptimisticUserMessage,
  decideHistoryReconciliation,
  mergeHistorySnapshot,
  reconcileHistoryMessage,
} = await import(pathToFileURL(bundledPath).href)

test('history frontier transitions distinguish contiguous append, gap catch-up, and full rewrite', () => {
  assert.deepEqual(advanceHistorySeqFrontier(1, 2), { latestSeq: 2, gapDetected: false })
  assert.deepEqual(advanceHistorySeqFrontier(1, 3), { latestSeq: 1, gapDetected: true })
  const base = {
    fullHistoryLoaded: true,
    serverMessageCount: 2,
    representedMessageCount: 2,
    serverHistoryVersion: 4,
    representedHistoryVersion: 4,
    hasTrustedFrontier: true,
    queueRefreshNeeded: false,
    gapDetected: false,
  }
  assert.equal(decideHistoryReconciliation(base), 'none')
  assert.equal(decideHistoryReconciliation({ ...base, gapDetected: true }), 'after')
  assert.equal(decideHistoryReconciliation({ ...base, serverHistoryVersion: 5 }), 'full')
  assert.equal(decideHistoryReconciliation({ ...base, serverMessageCount: 1 }), 'full')
})

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

test('a missing seq recovered after a later realtime row is inserted in canonical order', () => {
  const first = { role: 'user', parts: [{ text: 'first' }], __meta: { seq: 1, timestamp: 10 } }
  const third = { role: 'model', parts: [{ text: 'third' }], __meta: { seq: 3, timestamp: 30 } }
  const second = { role: 'user', parts: [{ text: 'second' }], __meta: { seq: 2, timestamp: 20 } }
  const recovered = reconcileHistoryMessage([first, third], second)
  assert.deepEqual(recovered.map(message => message.__meta.seq), [1, 2, 3])
})

test('browser-local command responses survive refresh in their existing slot but not remount', () => {
  const before = { role: 'user', parts: [{ text: 'before' }], __meta: { seq: 1, timestamp: 10 } }
  const commandResponse = {
    role: 'assistant',
    parts: [{ text: 'temporary status' }],
    __meta: { temporary: true, isCommandResponse: true, timestamp: 15 },
  }
  const after = { role: 'model', parts: [{ text: 'after' }], __meta: { seq: 2, timestamp: 20 } }

  const refreshed = mergeHistorySnapshot({
    snapshot: [before, after],
    concurrentMessages: [],
    currentMessages: [before, commandResponse, after],
    pendingClientMessageIds: new Set(),
  })
  assert.deepEqual(refreshed.map(message => message.parts[0].text), ['before', 'temporary status', 'after'])

  const delayedInitial = mergeHistorySnapshot({
    snapshot: [before],
    concurrentMessages: [commandResponse],
    currentMessages: [commandResponse],
    pendingClientMessageIds: new Set(),
  })
  assert.deepEqual(delayedInitial.map(message => message.parts[0].text), ['before', 'temporary status'])

  const remounted = mergeHistorySnapshot({
    snapshot: [before, after],
    concurrentMessages: [],
    currentMessages: [],
    pendingClientMessageIds: new Set(),
  })
  assert.deepEqual(remounted.map(message => message.parts[0].text), ['before', 'after'])
})
