import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-processing-status-test-'))
const fixturePath = path.join(tempDir, 'fixture.tsx')
const bundledPath = path.join(tempDir, 'fixture.cjs')

await writeFile(fixturePath, `
  import { createElement } from 'react'
  import { renderToStaticMarkup } from 'react-dom/server'
  import ProcessingStatus, { QueuedMessageStatus } from ${JSON.stringify(path.join(webuiRoot, 'src/components/ProcessingStatus.tsx'))}

  export function renderProcessingStatus(props) {
    return renderToStaticMarkup(createElement('div', null,
      createElement(ProcessingStatus, props),
      createElement(QueuedMessageStatus, {count: props.sessionQueueLength, alignment: 'left', isMobile: props.isMobile, onRunQueued: props.onRunQueued})))
  }
`)

await esbuild.build({
  entryPoints: [fixturePath],
  outfile: bundledPath,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  jsx: 'automatic',
  nodePaths: [path.join(webuiRoot, 'node_modules')],
  logLevel: 'silent',
})

const { renderProcessingStatus } = await import(pathToFileURL(bundledPath).href)
const baseProps = {
  sessionBusy: false,
  sessionQueueLength: 0,
  turnIncomplete: false,
  loading: false,
  isMobile: false,
  onStop() {},
  onRunQueued() {},
  onContinue() {},
}
const render = props => renderProcessingStatus({ ...baseProps, ...props })
const activeRuntimeState = (state, extra = {}) => ({
  state,
  queueLength: 0,
  busy: state === 'requesting-model' || state === 'running-tool',
  ...extra,
})


test('model requests use the primary fox spinner and retain decorative captions', () => {
  const html = render({ sessionBusy: true, runtimeState: activeRuntimeState('requesting-model', { active: { phase: 'normal-turn' } }) })
  assert.match(html, /data-runtime-presentation="request"/)
  assert.match(html, /text-fw-accent/)
  assert.match(html, /data-fox-loader="spinner"/)
  assert.match(html, /data-fox-thinking-copy/)
  assert.doesNotMatch(html, />Stop<|>Continue</)
})

test('all tools use their real names, special ink and the working pose without decorative tool captions', () => {
  for (const name of ['exec', 'read', 'functions.exec', 'node:demo/exec', 'execute', 'exec_file']) {
    const html = render({ runtimeState: activeRuntimeState('running-tool', { tool: { name, index: 0, total: 2, executionNode: 'demo-node', startedAt: 1 } }) })
    assert.match(html, /data-runtime-presentation="tool"/)
    assert.match(html, /text-fw-special/)
    assert.match(html, /data-runtime-fox="tool"/)
    assert.match(html, /demo-node/)
    assert.match(html, /aria-haspopup="dialog"/)
    assert.doesNotMatch(html, /Working|data-fox-thinking-copy|data-processing-tool-tag/)
  }
})

test('compaction is an explicit maintenance pose and does not accidentally offer ordinary Stop', () => {
  const html = render({ sessionQueueLength: 2, runtimeState: activeRuntimeState('requesting-model', { active: { phase: 'compaction' } }) })
  assert.match(html, /data-runtime-presentation="compact"/)
  assert.match(html, /text-fw-accent/)
  assert.match(html, /data-runtime-fox="compact"/)
  assert.match(html, /Compacting context/)
  assert.match(html, /2 queued/)
  assert.doesNotMatch(html, /data-fox-thinking-copy|>Stop</)
})

test('waiting shows remaining dependencies, a sleeping fox and no Stop or Continue', () => {
  const html = render({ runtimeState: activeRuntimeState('waiting', { waiting: { waitId: 'demo', waitingFor: 'all-sessions', waitAllSessions: ['a','b'], satisfiedSessions: ['a'] } }) })
  assert.match(html, /Waiting for 1 session/)
  assert.match(html, /data-fox-loader="sleeping"/)
  assert.match(html, /text-fw-warning/)
  assert.doesNotMatch(html, />Stop<|>Continue<|data-fox-thinking-copy/)
})

test('interrupted and failed idle turns have static poses and permission-gated Continue', () => {
  const interrupted = render({ turnIncomplete: true, runtimeState: activeRuntimeState('idle') })
  assert.match(interrupted, /data-runtime-presentation="interrupted"/)
  assert.match(interrupted, />Continue</)
  assert.doesNotMatch(interrupted, /data-animated="true"/)
  const failed = render({ turnIncomplete: true, runtimeState: activeRuntimeState('idle'), failure: { title: 'Request failed', details: 'Connection closed' } })
  assert.match(failed, /data-runtime-presentation="error"/)
  assert.match(failed, /text-fw-danger/)
  const restricted = render({ turnIncomplete: true, runtimeState: activeRuntimeState('idle'), onContinue: undefined })
  assert.doesNotMatch(restricted, />Continue</)
})

test('idle is quiet, canonical state overrides legacy busy, and queued work remains separate', () => {
  const idle = render({ sessionBusy: true, runtimeState: activeRuntimeState('idle'), sessionQueueLength: 2 })
  assert.doesNotMatch(idle, /data-processing-runtime-state/)
  assert.match(idle, /2 queued/)
  assert.match(idle, />Run queued</)
  const unknown = render({ sessionBusy: true })
  assert.match(unknown, /data-runtime-presentation="unknown"/)
  assert.doesNotMatch(unknown, /data-fox-thinking-copy/)
})

test('submission, retry and stop request phases are explicit and do not look like ordinary thinking', () => {
  const sending = render({ loading: true })
  assert.match(sending, /Sending/)
  assert.match(render({loading:true,runtimeState:activeRuntimeState('running-tool',{tool:{name:'exec',startedAt:1}})}), /data-runtime-presentation="tool"/)
  assert.doesNotMatch(sending, /data-fox-thinking-copy/)
  const stopping = render({ pendingControl: 'stop', runtimeState: activeRuntimeState('running-tool') })
  assert.match(stopping, /data-runtime-presentation="stopping"/)
  assert.match(stopping, /Stopping/)
  const retry = render({ runtimeState: activeRuntimeState('requesting-model', { retry: { attempt: 1, nextAttempt: 2, maxAttempts: 6, retryAt: Date.now()+60000 } }) })
  assert.match(retry, /data-runtime-presentation="retry"/)
  assert.match(retry, /2\/6/)
  assert.doesNotMatch(retry, /data-fox-thinking-copy/)
})

test('successful control feedback is silent; failed or no-op controls stay out of chat history', () => {
  assert.doesNotMatch(render({controlFeedback:{action:'stop',status:'accepted',message:'Stop requested'}}), /data-control-feedback/)
  const failed = render({controlFeedback:{action:'stop',status:'error',message:'Action not confirmed',details:'Connection interrupted'}})
  assert.match(failed, /data-control-feedback/)
  assert.match(failed, /role="alert"/)
  assert.match(failed, /<details/)
  assert.doesNotMatch(failed, /Stop signal sent|in-flight LLM/)
})

test('settled LLM failure remains an explicit static outcome with eligible Continue and independent queue controls', () => {
  const props = { runtimeState: activeRuntimeState('llm-failed'), turnIncomplete: true, failure: { title: 'Unrelated old diagnostic' }, sessionQueueLength: 2 }
  const failed = render(props)
  assert.match(failed, /data-processing-runtime-state="llm-failed"/)
  assert.match(failed, /data-runtime-presentation="error"/)
  assert.match(failed, /Request failed/)
  assert.match(failed, /text-fw-danger/)
  assert.match(failed, />Continue</)
  assert.match(failed, />Run queued</)
  assert.doesNotMatch(failed, /Unrelated old diagnostic|data-animated="true"|data-fox-thinking-copy|>Stop</)
  assert.doesNotMatch(render({ ...props, onContinue: undefined }), />Continue</)
  assert.doesNotMatch(render({ ...props, turnIncomplete: false }), />Continue</)
  assert.match(render({ ...props, pendingControl: 'continue' }), /Continuing/)
})
