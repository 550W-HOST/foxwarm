import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const repoRoot = path.resolve(webuiRoot, '../..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-session-continuation-test-'))

async function loadClassifier(entryPath, name) {
  const bundledPath = path.join(tempDir, `${name}.mjs`)
  await esbuild.build({
    entryPoints: [entryPath],
    outfile: bundledPath,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  })
  return import(pathToFileURL(bundledPath).href)
}

const [webuiClassifier, serverClassifier] = await Promise.all([
  loadClassifier(path.join(webuiRoot, 'src/sessionContinuation.ts'), 'webui'),
  loadClassifier(path.join(repoRoot, 'src/sessionContinuation.ts'), 'server'),
])

const modelText = (text = 'done') => ({ role: 'model', parts: [{ text }] })
const userText = (text = 'please continue') => ({ role: 'user', parts: [{ text }] })
const compactCompleted = () => ({
  role: 'user',
  parts: [{ system: '<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="none" currentSessionId="fixture/main" />' }],
})
const llmRetry = () => ({
  role: 'model', modelVisible: false, parts: [{ text: 'provider failed' }], __meta: { noticeType: 'llm-retry' },
})
const displayOnly = (noticeType = 'btw') => ({
  role: 'model', modelVisible: false, parts: [{ text: 'display-only result' }], __meta: { noticeType },
})
const callMessage = (id, name, args = {}) => ({
  role: 'model', parts: [{ functionCall: { id, name, args } }],
})
const toolMessage = (id, name, response = { output: 'ok' }) => ({
  role: 'tool', parts: [{ functionResponse: { tool_use_id: id, name, response } }],
})

const cases = [
  { name: 'final model text is complete', messages: [userText(), modelText()], incomplete: false },
  { name: 'direct user message is incomplete', messages: [modelText(), userText()], incomplete: true },
  { name: 'non-compact system message is incomplete', messages: [modelText(), { role: 'user', parts: [{ system: '<foxwarm-system kind="event" type="trigger">wake</foxwarm-system>' }] }], incomplete: true },
  { name: 'compact marker over final model remains complete', messages: [userText(), modelText(), compactCompleted()], incomplete: false },
  { name: 'compact marker over user remains incomplete', messages: [modelText(), userText(), compactCompleted()], incomplete: true },
  { name: 'compact marker over dangling tool result remains incomplete', messages: [callMessage('read-1', 'read'), toolMessage('read-1', 'read'), compactCompleted()], incomplete: true },
  { name: 'llm retry notice is incomplete despite display-only visibility', messages: [userText(), llmRetry()], incomplete: true },
  { name: 'BTW notice is transparent over a complete model', messages: [userText(), modelText(), displayOnly()], incomplete: false },
  { name: 'BTW notice is transparent over an incomplete user message', messages: [modelText(), userText(), displayOnly()], incomplete: true },
  { name: 'dangling model tool call is incomplete', messages: [userText(), callMessage('read-2', 'read')], incomplete: true },
  { name: 'ordinary tool result awaits a model response', messages: [callMessage('read-3', 'read'), toolMessage('read-3', 'read')], incomplete: true },
  { name: 'empty model row is incomplete', messages: [userText(), { role: 'model', parts: [{ thinking: 'reasoning only' }] }], incomplete: true },
  { name: 'model text with unresolved tool call is incomplete', messages: [userText(), { role: 'model', parts: [{ text: 'working' }, { functionCall: { id: 'read-4', name: 'read', args: {} } }] }], incomplete: true },
  { name: 'successful bare wait is terminal completion', messages: [callMessage('wait-1', 'wait'), toolMessage('wait-1', 'wait')], incomplete: false },
  { name: 'successful reason-only wait is terminal completion', messages: [callMessage('wait-2', 'wait', { reason: 'finished' }), toolMessage('wait-2', 'wait')], incomplete: false },
  { name: 'screenshot-shaped effective bare wait is terminal completion', messages: [
    callMessage('wait-screenshot', 'wait', { reason: 'finished', timeoutSeconds: 0, waitAllSessions: [], waitExecIds: [] }),
    toolMessage('wait-screenshot', 'wait'),
  ], incomplete: false },
  { name: 'zero-timeout wait is effective bare', messages: [callMessage('wait-zero', 'wait', { timeoutSeconds: 0 }), toolMessage('wait-zero', 'wait')], incomplete: false },
  { name: 'empty session targets remain effective bare', messages: [callMessage('wait-empty-sessions', 'wait', { waitAllSessions: [] }), toolMessage('wait-empty-sessions', 'wait')], incomplete: false },
  { name: 'empty exec targets remain effective bare', messages: [callMessage('wait-empty-execs', 'wait', { waitExecIds: [] }), toolMessage('wait-empty-execs', 'wait')], incomplete: false },
  { name: 'parameterized wait needs a later continuation after waiting ends', messages: [callMessage('wait-3', 'wait', { timeoutSeconds: 30 }), toolMessage('wait-3', 'wait')], incomplete: true },
  { name: 'nonempty session targets remain parameterized', messages: [callMessage('wait-session-target', 'wait', { waitAllSessions: ['child'] }), toolMessage('wait-session-target', 'wait')], incomplete: true },
  { name: 'nonempty exec targets remain parameterized', messages: [callMessage('wait-exec-target', 'wait', { waitExecIds: ['exec-1'] }), toolMessage('wait-exec-target', 'wait')], incomplete: true },
  { name: 'null wait args remain conservative', messages: [callMessage('wait-null-args', 'wait', null), toolMessage('wait-null-args', 'wait')], incomplete: true },
  { name: 'null wait reason remains conservative', messages: [callMessage('wait-null-reason', 'wait', { reason: null }), toolMessage('wait-null-reason', 'wait')], incomplete: true },
  { name: 'numeric wait reason remains conservative', messages: [callMessage('wait-number-reason', 'wait', { reason: 42 }), toolMessage('wait-number-reason', 'wait')], incomplete: true },
  { name: 'unknown wait args remain conservative', messages: [callMessage('wait-unknown', 'wait', { poll: false }), toolMessage('wait-unknown', 'wait')], incomplete: true },
  { name: 'failed bare wait is incomplete', messages: [callMessage('wait-4', 'wait'), toolMessage('wait-4', 'wait', { error: 'wait failed' })], incomplete: true },
  { name: 'completed read sibling can coexist with a terminal wait', messages: [
    { role: 'model', parts: [{ functionCall: { id: 'wait-mixed', name: 'wait', args: {} } }, { functionCall: { id: 'read-mixed', name: 'read', args: {} } }] },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'wait-mixed', name: 'wait', response: { output: 'ok' } } }, { functionResponse: { tool_use_id: 'read-mixed', name: 'read', response: { output: 'ok' } } }] },
  ], incomplete: false },
  { name: 'missing sibling response leaves the terminal batch incomplete', messages: [
    { role: 'model', parts: [{ functionCall: { id: 'wait-missing', name: 'wait', args: {} } }, { functionCall: { id: 'read-missing', name: 'read', args: {} } }] },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'wait-missing', name: 'wait', response: { output: 'ok' } } }] },
  ], incomplete: true },
  { name: 'response name mismatch rejects an otherwise terminal ID match', messages: [
    callMessage('wait-name-mismatch', 'wait'),
    toolMessage('wait-name-mismatch', 'read'),
  ], incomplete: true },
  { name: 'response ID mismatch rejects an otherwise terminal name match', messages: [
    callMessage('wait-id-mismatch', 'wait'),
    toolMessage('different-id', 'wait'),
  ], incomplete: true },
  { name: 'duplicate response rejects a terminal batch', messages: [
    callMessage('wait-duplicate-response', 'wait'),
    { role: 'tool', parts: [
      { functionResponse: { tool_use_id: 'wait-duplicate-response', name: 'wait', response: { output: 'ok' } } },
      { functionResponse: { tool_use_id: 'wait-duplicate-response', name: 'wait', response: { output: 'duplicate' } } },
    ] },
  ], incomplete: true },
  { name: 'extra response rejects a terminal batch', messages: [
    callMessage('wait-extra-response', 'wait'),
    { role: 'tool', parts: [
      { functionResponse: { tool_use_id: 'wait-extra-response', name: 'wait', response: { output: 'ok' } } },
      { functionResponse: { tool_use_id: 'unknown-extra-response', name: 'read', response: { output: 'extra' } } },
    ] },
  ], incomplete: true },
  { name: 'duplicate call ID rejects a terminal batch', messages: [
    { role: 'model', parts: [
      { functionCall: { id: 'duplicate-call', name: 'wait', args: {} } },
      { functionCall: { id: 'duplicate-call', name: 'read', args: {} } },
    ] },
    { role: 'tool', parts: [
      { functionResponse: { tool_use_id: 'duplicate-call', name: 'wait', response: { output: 'ok' } } },
      { functionResponse: { tool_use_id: 'duplicate-call', name: 'read', response: { output: 'ok' } } },
    ] },
  ], incomplete: true },
  { name: 'failed ordinary sibling still completes a successful handoff terminal batch', messages: [
    { role: 'model', parts: [
      { functionCall: { id: 'read-before-handoff', name: 'read', args: {} } },
      { functionCall: { id: 'successful-handoff', name: 'send_to_session', args: { sessionId: 'child', message: 'go', waitAfterHandoff: true } } },
    ] },
    { role: 'tool', parts: [
      { functionResponse: { tool_use_id: 'read-before-handoff', name: 'read', response: { error: 'read failed' } } },
      { functionResponse: { tool_use_id: 'successful-handoff', name: 'send_to_session', response: { output: 'sent' } } },
    ] },
  ], incomplete: false },
  { name: 'an older terminal batch cannot complete the nearest ordinary batch', messages: [
    callMessage('old-terminal', 'wait'),
    toolMessage('old-terminal', 'wait'),
    callMessage('nearest-read', 'read'),
    toolMessage('nearest-read', 'read'),
  ], incomplete: true },
  { name: 'send_to_session waitAfterHandoff is terminal completion', messages: [callMessage('send-1', 'send_to_session', { sessionId: 'child', message: 'go', waitAfterHandoff: true }), toolMessage('send-1', 'send_to_session')], incomplete: false },
  { name: 'create_child_session waitAfterHandoff is terminal completion', messages: [callMessage('child-1', 'create_child_session', { suffix: 'child', message: 'go', waitAfterHandoff: true }), toolMessage('child-1', 'create_child_session')], incomplete: false },
  { name: 'handoff without waitAfterHandoff still needs a model response', messages: [callMessage('send-2', 'send_to_session', { sessionId: 'child', message: 'go' }), toolMessage('send-2', 'send_to_session')], incomplete: true },
  { name: 'optimistic client row never overrides committed completion', messages: [userText(), modelText(), { ...userText('optimistic'), __meta: { optimistic: true, temporary: true, clientMessageId: 'pending-1' } }], incomplete: false },
  { name: 'reconciled committed client row is an incomplete user turn', messages: [modelText(), { ...userText('committed'), __meta: { clientMessageId: 'client-1' } }], incomplete: true },
  { name: 'temporary local row is transparent over committed incompletion', messages: [modelText(), userText(), { role: 'model', parts: [{ text: 'temporary error' }], __meta: { temporary: true } }], incomplete: true },
]

for (const fixture of cases) {
  test(`server and WebUI classifiers agree: ${fixture.name}`, () => {
    assert.equal(serverClassifier.isSessionTurnIncomplete(fixture.messages), fixture.incomplete)
    assert.equal(webuiClassifier.isSessionTurnIncomplete(fixture.messages), fixture.incomplete)
  })
}

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
