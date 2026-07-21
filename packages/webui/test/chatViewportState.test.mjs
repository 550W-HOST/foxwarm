import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function loadTypeScriptModule(relativePath) {
  const result = await build({
    entryPoints: [new URL(relativePath, import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  })
  const source = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

test('chat viewport state uses stable persisted message identities', async () => {
  const { getMessageStableKey, getMessageViewportAnchorKey } = await loadTypeScriptModule('../src/chatViewportState.ts')

  const seqMessage = { role: 'user', parts: [], __meta: { seq: 42, timestamp: 1000 } }
  const idMessage = { role: 'model', parts: [], __meta: { id: 'message-id', timestamp: 1001 } }
  const timestampMessage = { role: 'tool', parts: [], __meta: { timestamp: 1002 } }
  const temporaryMessage = { role: 'model', parts: [], __meta: { synthetic: 'streamingAssistantDraft', temporary: true, timestamp: Number.MAX_SAFE_INTEGER } }

  assert.equal(getMessageStableKey(seqMessage, 7), 'seq-local-42')
  assert.equal(getMessageViewportAnchorKey(seqMessage), 'seq-local-42')
  assert.equal(getMessageViewportAnchorKey(idMessage), 'id-message-id')
  assert.equal(getMessageViewportAnchorKey(timestampMessage), 'ts-1002')
  assert.equal(getMessageViewportAnchorKey(temporaryMessage), null)
  assert.equal(getMessageStableKey({ role: 'user', parts: [] }, 7), 'idx-7')
})

test('chat viewport state distinguishes bottom from a stable visible anchor', async () => {
  const { chooseChatViewportState } = await loadTypeScriptModule('../src/chatViewportState.ts')
  const anchors = [
    { messageKey: 'seq-local-4', top: 80, bottom: 140 },
    { messageKey: 'seq-local-5', top: 140, bottom: 240 },
  ]

  assert.deepEqual(chooseChatViewportState({
    scrollTop: 790,
    scrollHeight: 1200,
    clientHeight: 300,
    viewportTop: 100,
    viewportBottom: 400,
    anchors,
  }), { kind: 'bottom' })

  assert.deepEqual(chooseChatViewportState({
    scrollTop: 500,
    scrollHeight: 1200,
    clientHeight: 300,
    viewportTop: 100,
    viewportBottom: 400,
    anchors,
  }), { kind: 'anchor', messageKey: 'seq-local-4', offsetPx: -20 })
})

test('anchor correction is idempotent with or without native scroll anchoring', async () => {
  const { getChatViewportAnchorAdjustment } = await loadTypeScriptModule('../src/chatViewportState.ts')

  assert.equal(getChatViewportAnchorAdjustment(-20, -20), 0, 'native anchoring already preserved the row')
  assert.equal(getChatViewportAnchorAdjustment(880, -20), 900, 'JS restores an unadjusted 900px prepend')
  assert.equal(getChatViewportAnchorAdjustment(-20, -20), 0, 'reapplying the correction is a no-op')
})

test('chat viewport registry is isolated by canonical session id', async () => {
  const {
    clearStoredChatViewportStatesForTests,
    getStoredChatViewportState,
    storeChatViewportState,
  } = await loadTypeScriptModule('../src/chatViewportState.ts')

  clearStoredChatViewportStatesForTests()
  storeChatViewportState('agent/main', { kind: 'anchor', messageKey: 'seq-local-10', offsetPx: 12 })
  storeChatViewportState('agent/other', { kind: 'bottom' })

  assert.deepEqual(getStoredChatViewportState('agent/main'), { kind: 'anchor', messageKey: 'seq-local-10', offsetPx: 12 })
  assert.deepEqual(getStoredChatViewportState('agent/other'), { kind: 'bottom' })
  assert.equal(getStoredChatViewportState('main'), null)
})

test('streaming bottom follow latches explicit leave intent until a strict bottom rejoin', async () => {
  const { updateChatBottomFollow } = await loadTypeScriptModule('../src/chatViewportState.ts')

  assert.deepEqual(updateChatBottomFollow({
    following: true,
    pendingUserLeave: false,
    distanceFromBottom: 80,
  }), { following: true, pendingUserLeave: false }, 'token-driven growth does not look like user intent')

  const leaveAtBottom = updateChatBottomFollow({
    following: true,
    pendingUserLeave: false,
    distanceFromBottom: 0,
    userIntent: 'leave',
  })
  assert.deepEqual(leaveAtBottom, { following: false, pendingUserLeave: true })

  assert.deepEqual(updateChatBottomFollow({
    ...leaveAtBottom,
    distanceFromBottom: 0,
  }), { following: false, pendingUserLeave: true }, 'programmatic bottom scroll cannot erase pending user intent')

  const leftBottom = updateChatBottomFollow({
    ...leaveAtBottom,
    distanceFromBottom: 30,
  })
  assert.deepEqual(leftBottom, { following: false, pendingUserLeave: false })

  assert.deepEqual(updateChatBottomFollow({
    ...leftBottom,
    distanceFromBottom: 80,
  }), { following: false, pendingUserLeave: false }, 'near-bottom positions do not silently resume follow')

  assert.deepEqual(updateChatBottomFollow({
    ...leftBottom,
    distanceFromBottom: 3,
  }), { following: true, pendingUserLeave: false }, 'the actual bottom resumes follow')
})
