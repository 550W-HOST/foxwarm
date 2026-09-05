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
  import ProcessingStatus from ${JSON.stringify(path.join(webuiRoot, 'src/components/ProcessingStatus.tsx'))}

  export function renderProcessingStatus(props) {
    return renderToStaticMarkup(createElement(ProcessingStatus, props))
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

test('thinking status is blue and animated, with active queue continuation and controls', () => {
  const html = render({
    sessionBusy: true,
    sessionQueueLength: 2,
    runtimeState: activeRuntimeState('requesting-model', { active: { phase: 'compaction' } }),
  })

  assert.match(html, /data-processing-runtime-state="requesting-model"/)
  assert.match(html, /bg-fw-accent-surface/)
  assert.match(html, /Thinking\.\.\. · compaction • 2 queued messages will be inserted after this model response/)
  assert.equal((html.match(/animate-bounce/g) || []).length, 3)
  assert.match(html, />Stop<\/button>/)
  assert.match(html, />Run queued<\/button>/)
  assert.doesNotMatch(html, />Continue<\/button>/)
})

test('running-tool status is purple and uses tool-call queue continuation', () => {
  const html = render({
    sessionBusy: true,
    sessionQueueLength: 1,
    runtimeState: activeRuntimeState('running-tool', {
      tool: { name: 'exec', index: 1, total: 4, startedAt: 1 },
    }),
  })

  assert.match(html, /data-processing-runtime-state="running-tool"/)
  assert.match(html, /bg-fw-special-surface/)
  assert.match(html, /tool: exec 2\/4 • 1 queued message will be inserted after this tool call/)
  assert.equal((html.match(/animate-bounce/g) || []).length, 3)
  assert.match(html, />Stop<\/button>/)
  assert.match(html, />Run queued<\/button>/)
})

test('waiting status is amber with one static dot, resume copy, and no Stop action', () => {
  const html = render({
    sessionBusy: false,
    sessionQueueLength: 2,
    runtimeState: activeRuntimeState('waiting', {
      waiting: { waitId: 'children', waitingFor: 'all-sessions', waitAllSessions: ['a', 'b'], satisfiedSessions: ['a'] },
    }),
  })

  assert.match(html, /data-processing-runtime-state="waiting"/)
  assert.match(html, /bg-fw-warning-surface/)
  assert.match(html, /data-processing-status-dot="static"/)
  assert.doesNotMatch(html, /animate-bounce/)
  assert.match(html, /waiting: sessions 1\/2 • 2 queued messages will be inserted when this session resumes/)
  assert.doesNotMatch(html, />Stop<\/button>/)
  assert.match(html, />Run queued<\/button>/)
  assert.doesNotMatch(html, />Continue<\/button>/)
})

test('idle interrupted status has one static dot and Continue only, with queued actions preserved', () => {
  const interrupted = render({
    turnIncomplete: true,
    runtimeState: activeRuntimeState('idle'),
  })
  assert.match(interrupted, /data-processing-runtime-state="interrupted"/)
  assert.match(interrupted, /Turn interrupted/)
  assert.match(interrupted, />Continue<\/button>/)
  assert.doesNotMatch(interrupted, />Stop<\/button>|>Run queued<\/button>|animate-bounce/)
  assert.equal((interrupted.match(/data-processing-status-dot="static"/g) || []).length, 1)

  const withQueue = render({
    turnIncomplete: true,
    sessionQueueLength: 2,
    runtimeState: activeRuntimeState('idle'),
  })
  assert.match(withQueue, /Turn interrupted • 2 queued messages pending/)
  assert.match(withQueue, />Continue<\/button>/)
  assert.match(withQueue, />Run queued<\/button>/)
})

test('idle queue keeps its pending action and canonical idle overrides legacy busy', () => {
  const queuedHtml = render({ sessionQueueLength: 1, runtimeState: activeRuntimeState('idle') })
  assert.match(queuedHtml, /1 queued message pending/)
  assert.match(queuedHtml, />Run queued<\/button>/)
  assert.doesNotMatch(queuedHtml, /data-processing-runtime-state/)
  assert.doesNotMatch(queuedHtml, /thinking/)
  assert.doesNotMatch(queuedHtml, />Stop<\/button>/)

  const canonicalIdleHtml = render({ sessionBusy: true, runtimeState: activeRuntimeState('idle') })
  assert.equal(canonicalIdleHtml, '')

  const legacyBusyHtml = render({ sessionBusy: true })
  assert.match(legacyBusyHtml, /data-processing-runtime-state="requesting-model"/)
  assert.match(legacyBusyHtml, /Thinking\.\.\./)
  assert.match(legacyBusyHtml, />Stop<\/button>/)
})

test('loading indicator still takes precedence over runtime status', () => {
  const html = render({
    sessionBusy: true,
    loading: true,
    runtimeState: activeRuntimeState('running-tool', { tool: { name: 'exec', startedAt: 1 } }),
  })

  assert.doesNotMatch(html, /data-processing-runtime-state/)
  assert.doesNotMatch(html, /tool: exec/)
  assert.equal((html.match(/animate-bounce/g) || []).length, 3)
  assert.match(html, /bg-fw-text-subtle/)
})
