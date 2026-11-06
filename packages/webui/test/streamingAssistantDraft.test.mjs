import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/streamingAssistantDraft.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { getStreamingCaptions, applyModelStreamEvent, applyModelStreamSnapshot, buildStreamingAssistantMessage, parseStreamingToolArguments, reconcileCommittedModelDraft, shouldClearDraftAfterHistory, shouldClearDraftForCommittedModel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const getStreamingReasoningTitle = draft => getStreamingCaptions(draft).filter(caption => caption.kind === 'reasoning').at(-1)?.text

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

test('a committed commentary range removes only its draft prefix and late events cannot resurrect it', () => {
  const draft = applyModelStreamSnapshot({
    streamId: 'partial', iteration: 0, sequence: 3, startedAt: 100, llmRequestId: 'one-request',
    reasoning: 'before\nafter', text: 'Drawing', toolCalls: [], parts: [
      { outputIndex: 0, kind: 'reasoning', summaryIndex: 0, text: 'before' },
      { outputIndex: 1, kind: 'text', contentIndex: 0, phase: 'commentary', text: 'Drawing' },
      { outputIndex: 2, kind: 'reasoning', summaryIndex: 0, text: 'after' },
    ],
  })
  const committed = { role: 'model', parts: [{ thinking: 'before' }, { text: 'Drawing', phase: 'commentary' }],
    __meta: { llmRequestId: 'one-request', llmSegment: { outputStart: 0, outputEndExclusive: 2, complete: false }, timestamp: 101 },
  }
  const remaining = reconcileCommittedModelDraft(draft, committed)
  assert.deepEqual(buildStreamingAssistantMessage(remaining).parts, [{ thinking: 'after' }])
  assert.equal(buildStreamingAssistantMessage(remaining).__meta.llmSegment.outputStart, 2)
  assert.equal(shouldClearDraftAfterHistory({ draftAtRequestStart: draft, currentDraft: remaining,
    hasNewerStreamEvent: false, snapshotMessages: [committed] }), false)
  const late = applyModelStreamEvent(remaining, { type: 'model-stream-update', streamVersion: 2,
    streamId: 'partial', sequenceStart: 4, sequence: 4,
    partDeltas: [{ outputIndex: 1, kind: 'text', contentIndex: 0, added: true, textDelta: { offset: 0, text: 'Wrong duplicate' } }],
  })
  assert.deepEqual(buildStreamingAssistantMessage(late).parts, [{ thinking: 'after' }])
  const final = { role: 'model', parts: [{ thinking: 'after' }], __meta: {
    llmRequestId: 'one-request', llmSegment: { outputStart: 2, outputEndExclusive: 3, complete: true }, timestamp: 102,
  } }
  assert.equal(reconcileCommittedModelDraft(late, final), null)
  const nextRequest = { ...late, llmRequestId: 'next-request' }
  assert.equal(reconcileCommittedModelDraft(nextRequest, final), nextRequest)
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


test('ordered empty reasoning items survive without inventing a loading-only reasoning part', () => {
  assert.equal(buildStreamingAssistantMessage({streamId:'empty',reasoning:'',text:'',toolCalls:[],parts:[]}),null)
  const message=buildStreamingAssistantMessage({streamId:'ordered-empty',reasoning:'',text:'',toolCalls:[],parts:[
    {outputIndex:0,kind:'reasoning',summaryIndex:0,text:''},
    {outputIndex:1,kind:'reasoning',summaryIndex:0,text:''},
    {outputIndex:2,kind:'text',text:'Final answer'},
  ]})
  assert.deepEqual(message.parts,[{thinking:''},{thinking:''},{text:'Final answer'}])
  assert.equal(message.__meta.usage,undefined)
})


test('live reasoning caption keeps complete headings across subsequent output and incomplete reasoning items', () => {
  let draft = applyModelStreamSnapshot({ streamId: 'headings', iteration: 1, sequence: 1, startedAt: 100,
    reasoning: '', text: '', toolCalls: [], parts: [
      { outputIndex: 0, kind: 'reasoning', summaryIndex: 0, text: '  **First heading**\nBody.' },
    ],
  })
  assert.equal(getStreamingReasoningTitle(draft), 'First heading')
  const nextSummary = '**Next heading'
  draft = applyModelStreamEvent(draft, { type: 'model-stream-update', streamVersion: 2, streamId: 'headings', sequence: 2,
    partDeltas: [{ outputIndex: 0, kind: 'reasoning', summaryIndex: 1, textDelta: { offset: 0, text: nextSummary } }],
  })
  assert.equal(getStreamingReasoningTitle(draft), 'First heading')
  draft = applyModelStreamEvent(draft, { type: 'model-stream-update', streamVersion: 2, streamId: 'headings', sequence: 3,
    partDeltas: [{ outputIndex: 0, kind: 'reasoning', summaryIndex: 1, textDelta: { offset: nextSummary.length, text: '**\nBody.' } }],
  })
  assert.equal(getStreamingReasoningTitle(draft), 'Next heading')
  for (const kind of ['text', 'tool-call', 'image-generation']) {
    assert.equal(getStreamingReasoningTitle({ ...draft, parts: [...draft.parts, { outputIndex: 1, kind }] }), 'Next heading')
  }
  assert.equal(getStreamingReasoningTitle({ ...draft, parts: [...draft.parts, { outputIndex: 1, kind: 'reasoning', text: '' }] }), 'Next heading')
  assert.equal(getStreamingReasoningTitle(applyModelStreamSnapshot(null)), undefined)
  assert.equal(getStreamingReasoningTitle(applyModelStreamEvent(draft, { type: 'model-stream-reset', streamId: 'new' })), undefined)
})

test('reasoning caption shares the card first-line rule and survives legacy body and tool output', () => {
  const draft = { streamId: 'legacy', reasoning: '**Title**\nBody.\n**Last title**\nBody.', text: '', toolCalls: [] }
  assert.equal(getStreamingReasoningTitle(draft), 'Last title')
  for (const reasoning of ['Plain reasoning', 'Plain first line\n**Later bold line**', '**Incomplete', '**Title** trailing prose']) {
    assert.equal(getStreamingReasoningTitle({ ...draft, reasoning }), undefined)
  }
  assert.equal(getStreamingReasoningTitle({ ...draft, text: 'Answer' }), 'Last title')
  assert.equal(getStreamingReasoningTitle({ ...draft, toolCalls: [{ index: 0, name: 'exec' }] }), 'Last title')
})


test('generated tool summaries wait for complete strings and decode escapes before the object is complete', () => {
  const summary = 'Inspect "quoted" paths, \\slashes,\nUnicode 雪 🦊'
  const encoded = JSON.stringify(summary)
  const caption = (name, argumentsText) => getStreamingCaptions({ streamId: 's', reasoning: '', text: '',
    toolCalls: [{ index: 0, id: 'call', name, arguments: argumentsText }],
  }).at(-1)?.text
  for (const name of ['exec', 'run_script']) {
    for (let end = 0; end < encoded.length; end++) {
      assert.equal(caption(name, '{"summary":' + encoded.slice(0, end)), undefined)
    }
    assert.equal(caption(name, '{"summary":' + encoded), summary)
    assert.equal(caption(name, '{"summary":' + encoded + ',"command":"unfinished'), summary)
    assert.equal(caption(name, '{"summary":"Unicode \\u96ea"'), 'Unicode 雪')
    assert.equal(caption(name, '{"command":' + JSON.stringify('echo {"summary":"wrong"}') + ',"summary":"right"'), 'right')
    for (const raw of ['{"command":"summary: wrong', '{"command":{"summary":"wrong"}', '{"other":[{"summary":"wrong"}]', '{"summary":"   "}', '{"summary":123}']) {
      assert.equal(caption(name, raw), undefined)
    }
  }
  for (const route of [
    { toolId: 'node:provider/worker/exec' }, { source: 'node', name: 'exec' },
    { toolId: 'builtin:run_script' }, { source: 'builtin', name: 'run_script' },
  ]) {
    const prefix = JSON.stringify(route).slice(0, -1)
    assert.equal(caption('call_tool', prefix + ',"args":{"summary":' + encoded + ',"code":"unfinished'), summary)
    // The wrapper string can still be streaming when its decoded inner summary string is complete.
    const argsJson = JSON.stringify('{"summary":' + encoded + ',"command":"unfinished')
    assert.equal(caption('call_tool', prefix + ',"argsJson":' + argsJson.slice(0, -1)), summary)
    assert.equal(caption('call_tool', JSON.stringify({ ...route, argsJson: JSON.stringify({ summary }) })), summary)
  }
  for (const route of [{toolId:'mcp:server/exec'}, {source:'mcp',name:'run_script'}, {name:'exec'}, {toolId:'builtin:read'}, {toolId:'mcp:server/exec',source:'node',name:'exec'}]) {
    assert.equal(caption('call_tool', JSON.stringify({...route,args:{summary}})),undefined)
  }
  for (const name of ['mcp:server/exec', 'server.exec', 'functions.exec', 'read']) {
    assert.equal(caption(name, JSON.stringify({summary})), undefined)
  }
})

test('caption candidates respect output order and the per-item first-line heading gate', () => {
  const draft = { streamId: 's', reasoning: '', text: '', toolCalls: [{ index: 1, id: 'call', name: 'exec', arguments: '{"summary":"Run checks"' }], parts: [
    {outputIndex:0,kind:'reasoning',summaryIndex:0,text:'**Earlier**\nBody.'},
    {outputIndex:1,kind:'tool-call'},
    {outputIndex:2,kind:'reasoning',summaryIndex:0,text:'**Incomplete'},
    {outputIndex:3,kind:'text',text:'Body output'},
  ] }
  assert.equal(getStreamingCaptions(draft).at(-1).text, 'Run checks')
  draft.parts[2].text = '**Latest**\nBody.'
  assert.equal(getStreamingCaptions(draft).at(-1).text, 'Latest')
  draft.parts[2].text = 'Plain first line\n**Not a heading caption**'
  assert.equal(getStreamingReasoningTitle(draft), 'Earlier')
})
