import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/processingCaption.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', jsx: 'automatic' })
const { getCaptionSegment, isCaptionInputBoundary, selectProcessingCaption } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

let seq = 0
const meta = (extra = {}) => ({ seq: ++seq, timestamp: seq * 10, ...extra })
const user = (text, extra) => ({ role: 'user', parts: [{ text }], __meta: meta(extra) })
const system = (system, extra) => ({ role: 'user', parts: [{ system }], __meta: meta(extra) })
const model = (parts, extra) => ({ role: 'model', parts, __meta: meta(extra) })
const exec = (id, summary, name = 'exec') => ({ functionCall: { id, name, args: { summary, command: 'true' } } })
const result = id => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name: 'exec', response: { output: 'ok' } } }], __meta: meta() })
const requesting = (streamId) => ({ state: 'requesting-model', busy: true, queueLength: 0, ...(streamId ? { active: { phase: 'normal-turn', streamId } } : {}) })
const running = tool => ({ state: 'running-tool', busy: true, queueLength: 0, tool: { startedAt: 1, ...tool } })
const caption = (history, { draft = null, runtime = requesting(), mode = 'conversation' } = {}) => selectProcessingCaption(getCaptionSegment(history), draft, runtime, mode)
const draftWith = (streamId, toolArgs, extra = {}) => ({ streamId, reasoning: '', text: '', toolCalls: [{ index: 0, id: 'live', name: 'exec', arguments: toolArgs }], ...extra })

test('a segment starts with no caption and keeps the last displayable item until a newer one', () => {
  const history = [user('Start')]
  assert.equal(caption(history), undefined)
  history.push(model([{ thinking: '**Planning the change**\nBody.' }, { text: 'Body output' }, exec('a', 'Doing A')]))
  assert.equal(caption(history), 'Doing A')
  assert.equal(caption(history, { runtime: running({ id: 'a', name: 'exec', source: 'node', argsPreview: 'Doing A' }) }), 'Doing A')
  history.push(result('a'))
  assert.equal(caption(history), 'Doing A', 'retained after execution into the next request')
  history.push(model([{ thinking: 'Plain reasoning without a heading' }, { text: 'Intermediate text' }]))
  history.push(model([{ thinking: '**Incomplete later heading' }]))
  assert.equal(caption(history), 'Doing A', 'body output and ineligible reasoning do not replace it')
  history.push(model([{ thinking: '**Reading the results**\nBody.' }]))
  assert.equal(caption(history), 'Reading the results')
  assert.equal(caption(history, { mode: 'detailed' }), 'Doing A')
  assert.equal(caption(history, { mode: 'grouped' }), 'Doing A')
})

test('every delivered input opens a new segment while runtime bookkeeping does not', () => {
  const base = [user('Start'), model([exec('a', 'Doing A')]), result('a')]
  for (const input of [
    user('Correction'),
    system('<foxwarm-message type="inter-agent" sourceSessionId="peer/one">\nPeer report\n</foxwarm-message>'),
    system('<foxwarm-system kind="event" type="exec-completed">\nBackground command finished\n</foxwarm-system>'),
    system('<foxwarm-message type="task" taskId="t1" event="completed">\nTask done\n</foxwarm-message>'),
  ]) {
    assert.equal(isCaptionInputBoundary(input), true, JSON.stringify(input.parts))
    assert.equal(caption([...base, input]), undefined)
    assert.equal(caption([...base, input, model([exec('b', 'Doing B')])]), 'Doing B')
  }
  for (const bookkeeping of [
    system('<foxwarm-system kind="task-reminder">Remember the task</foxwarm-system>', { taskReminder: true }),
    system('<foxwarm-system kind="session-boundary" event="compact-completed" />'),
    system('<foxwarm-system kind="session-settings-changed" model="next" />'),
    user('Queued but not delivered', { queuedPreview: true }),
    user('Pending send', { optimistic: true }),
    { role: 'user', parts: [{ functionResponse: { tool_use_id: 'a', name: 'exec', response: {} } }], __meta: meta() },
    model([{ text: 'Retry notice' }], { noticeType: 'llm-retry' }),
  ]) {
    assert.equal(isCaptionInputBoundary(bookkeeping), false, JSON.stringify(bookkeeping))
    assert.equal(caption([...base, bookkeeping]), 'Doing A')
  }
  // Summaries before a context block are not live evidence.
  assert.equal(caption([...base, { role: 'user', parts: [{ text: '[CTX-BLOCK 1]' }], __meta: meta({ contextBlock: { id: 1, level: 1, rawStartSeq: 1, rawEndSeq: 3 } }) }]), undefined)
})

test('committed and streaming sources join in output order with the live draft newest', () => {
  const history = [user('Start'), model([{ thinking: '**Committed heading**\nBody.' }], { llmRequestId: 'r1', llmSegment: { outputStart: 0, outputEndExclusive: 1, complete: false } })]
  assert.equal(caption(history), 'Committed heading')
  const textOnly = { streamId: 'r1', reasoning: '', text: 'Body', toolCalls: [] }
  assert.equal(caption(history, { draft: textOnly, runtime: requesting('r1') }), 'Committed heading', 'a draft without captions keeps the committed one')
  const partial = draftWith('r1', '{"summary":"Generated summ')
  assert.equal(caption(history, { draft: partial, runtime: requesting('r1') }), 'Committed heading', 'incomplete summary strings are not displayable')
  const complete = draftWith('r1', '{"summary":"Generated summary","command":"unfinished')
  assert.equal(caption(history, { draft: complete, runtime: requesting('r1') }), 'Generated summary')
  assert.equal(caption(history, { draft: complete, runtime: requesting('other') }), 'Committed heading', 'a draft from another stream is ignored')
  assert.equal(caption(history, { draft: { ...complete, startedAt: 1 } }), 'Committed heading', 'a draft that predates the latest input is ignored')
  const reasoningDraft = { streamId: 'r1', reasoning: '**Streaming heading**\nBody.', text: '', toolCalls: [] }
  assert.equal(caption(history, { draft: reasoningDraft }), 'Streaming heading')
  assert.equal(caption(history, { draft: reasoningDraft, mode: 'detailed' }), undefined)
  // Supported call_tool routing, run_script and escaped arguments come from committed args like the stream.
  assert.equal(caption([user('x'), model([{ functionCall: { id: 'c', name: 'call_tool', args: { toolId: 'node:worker/exec', args: { summary: 'Routed' } } } }])]), 'Routed')
  assert.equal(caption([user('x'), model([exec('s', 'Script', 'run_script')])]), 'Script')
  for (const call of [
    { id: 'm', name: 'call_tool', args: { toolId: 'mcp:server/exec', args: { summary: 'MCP' } } },
    { id: 'n', name: 'functions.exec', args: { summary: 'Namespaced' } },
    { id: 'r', name: 'read', args: { filePath: 'file' } },
  ]) assert.equal(caption([user('x'), model([{ functionCall: call }])]), undefined, call.name)
})

test('a running tool marks the current position and supplies a summary only where history has none', () => {
  const history = [user('Start'), model([exec('a', 'Doing A'), { functionCall: { id: 'r', name: 'read', args: { filePath: 'x' } } }, exec('b', 'Doing B')])]
  assert.equal(caption(history), 'Doing B', 'generation ends with the last summary')
  assert.equal(caption(history, { runtime: running({ id: 'a', name: 'exec', source: 'node', argsPreview: 'Doing A' }) }), 'Doing A')
  assert.equal(caption(history, { runtime: running({ id: 'r', name: 'read', source: 'node', argsPreview: 'x' }) }), 'Doing A')
  assert.equal(caption(history, { runtime: running({ id: 'b', name: 'exec', source: 'node', argsPreview: 'Doing B' }) }), 'Doing B')
  const ctl = [user('Start'), model([exec('a', 'Doing A'), { functionCall: { id: 'k', name: 'ctl', args: { command: 'tool call node:w/exec' } } }])]
  assert.equal(caption(ctl, { runtime: running({ id: 'k', name: 'exec', source: 'node', argsPreview: 'Resolved preview' }) }), 'Resolved preview')
  assert.equal(caption(ctl, { runtime: running({ id: 'k', name: 'exec', source: 'mcp', argsPreview: 'MCP preview' }) }), 'Doing A')
  assert.equal(caption([user('Start')], { runtime: running({ name: 'run_script', source: 'builtin', argsPreview: 'Only runtime' }) }), 'Only runtime')
  assert.equal(caption([user('Start')], { runtime: running({ name: 'exec', source: 'node', argsPreview: '   ' }) }), undefined)
})
