import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/streamingAssistantDraft.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { applyModelStreamEvent, applyModelStreamSnapshot, buildStreamingAssistantMessage, parseStreamingToolArguments, shouldClearDraftAfterHistory, shouldClearDraftForCommittedModel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('synthetic assistant messages retain the canonical request identity for render reconciliation', () => {
  const message = buildStreamingAssistantMessage({
    streamId: 'stream-1',
    iteration: 2,
    llmRequestId: 'request-1',
    reasoning: '',
    text: 'streamed answer',
    toolCalls: [],
  })

  assert.equal(message.__meta.llmRequestId, 'request-1')
  assert.equal(message.__meta.synthetic, 'streamingAssistantDraft')
})

test('version 2 stream events accumulate text and partial tool arguments', () => {
  let draft = applyModelStreamEvent(null, { type: 'model-stream-reset', streamId: 's', iteration: 1 })
  draft = applyModelStreamEvent(draft, {
    type: 'model-stream-update', streamVersion: 2, streamId: 's', sequence: 1,
    reasoningDelta: { offset: 0, text: 'think' }, textDelta: { offset: 0, text: 'hel' },
    toolCallDeltas: [{ index: 0, id: 'c', name: 'read', argumentsDelta: { offset: 0, text: '{"file' } }],
  })
  draft = applyModelStreamEvent(draft, {
    type: 'model-stream-update', streamVersion: 2, streamId: 's', sequence: 2,
    textDelta: { offset: 3, text: 'lo' },
    toolCallDeltas: [{ index: 0, argumentsDelta: { offset: 6, text: 'Path":"x"}' } }],
  })
  assert.equal(draft.reasoning, 'think')
  assert.equal(draft.text, 'hello')
  assert.equal(draft.toolCalls[0].arguments, '{"filePath":"x"}')
  assert.deepEqual(parseStreamingToolArguments(draft.toolCalls[0].arguments), { filePath: 'x' })
})

test('legacy cumulative events remain compatible', () => {
  const draft = applyModelStreamEvent(null, {
    type: 'model-stream-update', streamId: 'legacy', text: 'complete',
    toolCalls: [{ index: 0, id: 'c', name: 'exec' }],
  })
  assert.equal(draft.text, 'complete')
  assert.equal(draft.toolCalls[0].name, 'exec')
})

test('Responses ordered slices keep separate reasoning items around commentary and image progress', () => {
  let draft = applyModelStreamEvent(null, {
    type: 'model-stream-reset', streamVersion: 2, streamId: 'ordered', sequenceStart: 1, sequence: 1,
    startedAt: 100, llmRequestId: 'request-ordered',
  })
  draft = applyModelStreamEvent(draft, {
    type: 'model-stream-update', streamVersion: 2, streamId: 'ordered', sequenceStart: 2, sequence: 3,
    partDeltas: [
      { outputIndex: 0, kind: 'reasoning', summaryIndex: 0, added: true, textDelta: { offset: 0, text: 'first' } },
      { outputIndex: 0, kind: 'reasoning', summaryIndex: 1, added: true, textDelta: { offset: 0, text: 'second' } },
      { outputIndex: 1, kind: 'text', contentIndex: 0, added: true, phase: 'commentary', textDelta: { offset: 0, text: 'Drawing' } },
    ],
    reasoningDelta: { offset: 0, text: 'first\nsecond' }, textDelta: { offset: 0, text: 'Drawing' },
  })
  const joined = applyModelStreamSnapshot({ streamId: 'ordered', iteration: 0, sequence: 3,
    startedAt: 100, llmRequestId: 'request-ordered', reasoning: draft.reasoning, text: draft.text,
    toolCalls: [], parts: draft.parts })
  const covered = applyModelStreamEvent(joined, {
    type: 'model-stream-update', streamVersion: 2, streamId: 'ordered', sequenceStart: 2, sequence: 3,
    partDeltas: [{ outputIndex: 1, kind: 'text', contentIndex: 0, textDelta: { offset: 0, text: 'Wrong duplicate' } }],
  })
  assert.equal(covered, joined)
  draft = applyModelStreamEvent(joined, {
    type: 'model-stream-update', streamVersion: 2, streamId: 'ordered', sequenceStart: 4, sequence: 5,
    partDeltas: [
      { outputIndex: 2, kind: 'image-generation', added: true, status: 'in_progress' },
      { outputIndex: 3, kind: 'reasoning', summaryIndex: 0, added: true, textDelta: { offset: 0, text: 'third' } },
      { outputIndex: 4, kind: 'tool-call', added: true },
    ],
    toolCallDeltas: [{ index: 4, id: 'call', name: 'read', argumentsDelta: { offset: 0, text: '{"path":"x"}' } }],
  })
  assert.equal(draft.incompletePrefix, false)
  assert.deepEqual(buildStreamingAssistantMessage(draft).parts, [
    { thinking: 'first\nsecond' }, { text: 'Drawing', phase: 'commentary' },
    { system: 'Generating image…' }, { thinking: 'third' },
    { functionCall: { id: 'call', name: 'read', args: { path: 'x' } } },
  ])
  assert.equal(shouldClearDraftForCommittedModel(draft, 101), true)
  assert.equal(shouldClearDraftAfterHistory({ draftAtRequestStart: draft, currentDraft: draft,
    hasNewerStreamEvent: false, snapshotMessages: [{ role: 'model', parts: [{ text: 'Drawing' }], __meta: { llmRequestId: 'request-ordered' } }],
  }), true)
})

test('midstream delta subscription is marked incomplete instead of presented as a full prefix', () => {
  const draft = applyModelStreamEvent(null, {
    type: 'model-stream-update', streamVersion: 2, streamId: 's', sequence: 4,
    textDelta: { offset: 12, text: 'tail' },
  })
  assert.equal(draft.text, 'tail')
  assert.equal(draft.incompletePrefix, true)
})

test('bootstrap snapshot ignores a covered pending delta and applies the next sequence', () => {
  let draft = applyModelStreamSnapshot({ streamId: 's', iteration: 1, sequence: 2, reasoning: '', text: 'hello', toolCalls: [] })
  draft = applyModelStreamEvent(draft, { type: 'model-stream-update', streamVersion: 2, streamId: 's', sequence: 2, textDelta: { offset: 3, text: 'lo' } })
  assert.equal(draft.text, 'hello')
  draft = applyModelStreamEvent(draft, { type: 'model-stream-update', streamVersion: 2, streamId: 's', sequence: 3, textDelta: { offset: 5, text: '!' } })
  assert.equal(draft.text, 'hello!')
})

test('snapshot seq1 accepts a coalesced contiguous seq2..3 range without a false gap', () => {
  let draft = applyModelStreamSnapshot({ streamId: 's', iteration: 1, sequence: 1, startedAt: 100, reasoning: '', text: 'a', toolCalls: [] })
  draft = applyModelStreamEvent(draft, {
    type: 'model-stream-update', streamVersion: 2, streamId: 's', sequenceStart: 2, sequence: 3, startedAt: 100,
    textDelta: { offset: 1, text: 'bc' },
  })
  assert.equal(draft.text, 'abc')
  assert.notEqual(draft.incompletePrefix, true)
})

test('the next raw frame after a presentation failure marks a real sequence gap even with a valid offset', () => {
  let draft = applyModelStreamSnapshot({ streamId: 's', iteration: 1, sequence: 1, startedAt: 100, reasoning: '', text: 'a', toolCalls: [] })
  draft = applyModelStreamEvent(draft, {
    type: 'model-stream-update', streamVersion: 2, streamId: 's', sequenceStart: 3, sequence: 3, startedAt: 100,
    textDelta: { offset: 1, text: 'c' },
  })
  assert.equal(draft.text, 'ac')
  assert.equal(draft.incompletePrefix, true)
})

test('a snapshot watermark inside a merged range rewrites safely and advances to its end', () => {
  let draft = applyModelStreamSnapshot({ streamId: 's', iteration: 1, sequence: 2, startedAt: 100, reasoning: '', text: 'ab', toolCalls: [] })
  draft = applyModelStreamEvent(draft, {
    type: 'model-stream-update', streamVersion: 2, streamId: 's', sequenceStart: 2, sequence: 3, startedAt: 100,
    textDelta: { offset: 1, text: 'bc' },
  })
  assert.equal(draft.text, 'abc')
  assert.equal(draft.sequence, 3)
  assert.notEqual(draft.incompletePrefix, true)
})

test('an explicit no-draft reconnect snapshot clears stale transient state', () => {
  assert.equal(applyModelStreamSnapshot(null), null)
})

test('a buffered older commit cannot clear a newer bootstrap draft', () => {
  const draft = applyModelStreamSnapshot({ streamId: 'new', iteration: 2, sequence: 1, startedAt: 200, reasoning: '', text: 'new draft', toolCalls: [] })
  assert.equal(shouldClearDraftForCommittedModel(draft, 150), false)
  assert.equal(shouldClearDraftForCommittedModel(draft, 250), true)
})

test('live reset uses server startedAt, so browser clock skew cannot retain the current commit', () => {
  const originalNow = Date.now
  Date.now = () => 999_999
  try {
    const draft = applyModelStreamEvent(null, {
      type: 'model-stream-reset', streamVersion: 2, streamId: 's', sequenceStart: 1, sequence: 1, startedAt: 1_000,
    })
    assert.equal(draft.startedAt, 1_000)
    assert.equal(shouldClearDraftForCommittedModel(draft, 900), false)
    assert.equal(shouldClearDraftForCommittedModel(draft, 1_100), true)
  } finally {
    Date.now = originalNow
  }
})

test('Chat-like live start keeps reset ownership across a history response before the first update', () => {
  let current = null
  current = applyModelStreamEvent(current, {
    type: 'model-stream-reset', streamVersion: 2, streamId: 'live',
    sequenceStart: 1, sequence: 1, startedAt: 1_000,
  })
  const draftAtHistoryStart = current
  assert.equal(shouldClearDraftAfterHistory({
    draftAtRequestStart: draftAtHistoryStart,
    currentDraft: current,
    hasNewerStreamEvent: false,
    snapshotMessages: [],
  }), false)
  current = applyModelStreamEvent(current, {
    type: 'model-stream-update', streamVersion: 2, streamId: 'live',
    sequenceStart: 2, sequence: 2, startedAt: 1_000,
    reasoningDelta: { offset: 0, text: 'thinking' },
    textDelta: { offset: 0, text: 'first token' },
    toolCallDeltas: [{ index: 0, id: 'call', name: 'read' }],
  })
  assert.equal(current.incompletePrefix, false)
  assert.equal(current.text, 'first token')
})

test('authoritative history clears an active draft when its canonical provider model row covers the generation', () => {
  const draft = applyModelStreamSnapshot({ streamId: 's', iteration: 1, sequence: 3, startedAt: 1_000, llmRequestId: 'request-B', reasoning: '', text: 'done', toolCalls: [] })
  assert.equal(shouldClearDraftAfterHistory({
    draftAtRequestStart: draft,
    currentDraft: draft,
    hasNewerStreamEvent: false,
    snapshotMessages: [{ role: 'model', parts: [{ text: 'done' }], __meta: { timestamp: 1_000, llmRequestId: 'request-B' } }],
  }), true)
})

test('display-only or updateExisting model rows cannot prove canonical draft coverage', () => {
  const draft = applyModelStreamSnapshot({ streamId: 's', iteration: 1, sequence: 3, startedAt: 1_000, llmRequestId: 'request-B', reasoning: '', text: 'working', toolCalls: [] })
  for (const message of [
    { role: 'model', modelVisible: false, parts: [{ text: 'Retrying' }], __meta: { timestamp: 1_000, llmRequestId: 'request-B' } },
    { role: 'model', parts: [{ text: 'display update' }], __meta: { timestamp: 1_000, llmRequestId: 'request-B', updateExisting: true } },
  ]) {
    assert.equal(shouldClearDraftAfterHistory({
      draftAtRequestStart: draft,
      currentDraft: draft,
      hasNewerStreamEvent: false,
      snapshotMessages: [message],
    }), false)
  }
})

test('an old history request cannot clear a newer reset generation', () => {
  const oldDraft = applyModelStreamSnapshot({ streamId: 's', iteration: 1, sequence: 3, startedAt: 1_000, llmRequestId: 'request-B', reasoning: '', text: 'old', toolCalls: [] })
  const newDraft = applyModelStreamEvent(oldDraft, {
    type: 'model-stream-reset', streamVersion: 2, streamId: 's', sequenceStart: 4, sequence: 4, startedAt: 1_000, llmRequestId: 'request-C',
  })
  assert.equal(shouldClearDraftAfterHistory({
    draftAtRequestStart: oldDraft,
    currentDraft: newDraft,
    hasNewerStreamEvent: true,
    snapshotMessages: [{ role: 'model', parts: [{ text: 'old' }], __meta: { timestamp: 1_000, llmRequestId: 'request-B' } }],
  }), false)
})

test('a canonical provider model tool-call row covers the active draft', () => {
  const draft = applyModelStreamSnapshot({
    streamId: 's', iteration: 1, sequence: 3, startedAt: 1_000, reasoning: '', text: '',
    llmRequestId: 'request-B',
    toolCalls: [{ index: 0, id: 'call', name: 'read', arguments: '{"filePath":"x"}' }],
  })
  assert.equal(shouldClearDraftAfterHistory({
    draftAtRequestStart: draft,
    currentDraft: draft,
    hasNewerStreamEvent: false,
    snapshotMessages: [{
      role: 'model',
      parts: [{ functionCall: { id: 'call', name: 'read', args: { filePath: 'x' } } }],
      __meta: { timestamp: 1_000, llmRequestId: 'request-B' },
    }],
  }), true)
})

test('same-millisecond history from request A cannot clear request B, while exact B can', () => {
  const draft = applyModelStreamSnapshot({ streamId: 's', iteration: 2, sequence: 1, startedAt: 1_000, llmRequestId: 'request-B', reasoning: '', text: 'B', toolCalls: [] })
  const decide = (llmRequestId) => shouldClearDraftAfterHistory({
    draftAtRequestStart: draft,
    currentDraft: draft,
    hasNewerStreamEvent: false,
    snapshotMessages: [{ role: 'model', parts: [{ text: llmRequestId }], __meta: { timestamp: 1_000, llmRequestId } }],
  })
  assert.equal(decide('request-A'), false)
  assert.equal(decide('request-B'), true)
})

test('a draft without llmRequestId is conservative during history correction', () => {
  const draft = applyModelStreamSnapshot({ streamId: 'legacy', iteration: 1, sequence: 1, startedAt: 1_000, reasoning: '', text: 'legacy', toolCalls: [] })
  assert.equal(shouldClearDraftAfterHistory({
    draftAtRequestStart: draft,
    currentDraft: draft,
    hasNewerStreamEvent: false,
    snapshotMessages: [{ role: 'model', parts: [{ text: 'row' }], __meta: { timestamp: 1_100, llmRequestId: 'request-X' } }],
  }), false)
})

test('invalid partial JSON remains readable raw text', () => {
  assert.equal(parseStreamingToolArguments('{"file'), '{"file')
})
