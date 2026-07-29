import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-webui-vscode-bridge-test-'))
const bundledPath = path.join(tempDir, 'vscodeWeb.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/vscodeWeb.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const {
  makeVscodeWebUrl,
  normalizeCodePath,
  planCodeOpen,
  resolveToolCodeFileTarget,
  selectCodeFrameStarted,
} = await import(pathToFileURL(bundledPath).href)

test('embedded Code starts once and then reuses the running frame', () => {
  assert.equal(planCodeOpen(false, false), 'start-embedded')
  assert.equal(planCodeOpen(true, false), 'reuse-embedded')
  assert.equal(planCodeOpen(true, true), 'new-window')
  assert.equal(planCodeOpen(true, false, true), 'new-window')
})

test('restored Code frame starts only when visible and persists until explicit close', () => {
  assert.equal(selectCodeFrameStarted(false, ['chat', null]), false, 'an inactive restored Code tab stays unloaded')
  assert.equal(selectCodeFrameStarted(false, ['vscode'], { workbenchVisible: false }), false, 'a logically active restored tab stays unloaded while the mobile list hides the workbench')
  assert.equal(selectCodeFrameStarted(false, ['chat', 'vscode']), true, 'Code starts when active in any pane')
  assert.equal(selectCodeFrameStarted(true, ['chat', 'terminal']), true, 'switching away preserves a started frame')
  assert.equal(selectCodeFrameStarted(true, ['vscode'], { workbenchVisible: false }), true, 'hiding the workbench after start preserves the frame')
  assert.equal(selectCodeFrameStarted(true, ['vscode'], { explicitlyClosed: true }), false, 'explicit close destroys a started frame')
})

test('Code paths normalize absolute POSIX paths', () => {
  assert.equal(normalizeCodePath('/app/./packages/../src/'), '/app/src')
  assert.equal(normalizeCodePath('relative/path'), null)
})

test('new Code windows retain initial folder URL behavior', () => {
  const url = makeVscodeWebUrl('/proxy/api', 'https://example.test', { nodeId: 'master', path: '/app/src' })
  assert.equal(url.pathname, '/proxy/vscode-web/')
  assert.equal(url.searchParams.get('folderUri'), 'foxwarm://node+master/app/src')
})

test('Code workspace URLs preserve remote node identity', () => {
  const url = makeVscodeWebUrl('/api', 'https://example.test', { nodeId: 'worker-a', path: '/srv/project' })
  assert.equal(url.searchParams.get('folderUri'), 'foxwarm://node+worker-a/srv/project')
})

test('embedded Code starts from a persistent workspace URL', () => {
  const url = makeVscodeWebUrl('/api', 'https://example.test', { nodeId: 'master', path: '/app' }, { embedded: true })
  assert.equal(url.searchParams.get('embedded'), 'true')
  assert.equal(url.searchParams.get('initialFolderUri'), 'foxwarm://node+master/app')
  assert.equal(url.searchParams.has('folderUri'), false)
})

test('tool file paths resolve for valid local or remote nodes with absolute path or cwd', () => {
  assert.deepEqual(resolveToolCodeFileTarget('src/index.ts', 'master', '/app', { startLine: 4, endLine: 8 }), {
    kind: 'openFile',
    nodeId: 'master',
    path: '/app/src/index.ts',
    startLine: 4,
    endLine: 8,
  })
  assert.deepEqual(resolveToolCodeFileTarget('src/index.ts', 'worker-a', '/app'), {
    kind: 'openFile', nodeId: 'worker-a', path: '/app/src/index.ts',
  })
  assert.equal(resolveToolCodeFileTarget('src/index.ts', 'master', undefined), null)
  assert.equal(resolveToolCodeFileTarget('~/secret', 'master', '/app'), null)
})

test('new-tab file targets are encoded as startup URL parameters', () => {
  const request = resolveToolCodeFileTarget('/app/src/index.ts', 'master', '/app', { startLine: 7 })
  assert.ok(request)
  const url = makeVscodeWebUrl('/api', 'https://example.test', { nodeId: 'master', path: '/app' }, { openFile: request })
  assert.equal(url.searchParams.get('folderUri'), 'foxwarm://node+master/app')
  assert.equal(url.searchParams.get('openFilePath'), '/app/src/index.ts')
  assert.equal(url.searchParams.get('openFileNodeId'), 'master')
  assert.equal(url.searchParams.get('startLine'), '7')
})

test('new-tab commit targets are encoded as typed startup URL parameters', () => {
  const target = { nodeId: 'worker-a', path: '/repo', commitId: '85ad4d1b' }
  const url = makeVscodeWebUrl('/api', 'https://example.test', target, { openCommit: target })
  assert.equal(url.searchParams.get('embedded'), 'true')
  assert.equal(url.searchParams.get('initialFolderUri'), null)
  assert.equal(url.searchParams.get('openCommitPath'), '/repo')
  assert.equal(url.searchParams.get('openCommitNodeId'), 'worker-a')
  assert.equal(url.searchParams.get('openCommitId'), '85ad4d1b')
})

test('tool Code paths keep plain text and expose only an adjacent native icon action', async () => {
  const source = await readFile(path.join(webuiRoot, 'src/components/ToolTimelineItems.tsx'), 'utf8')
  const start = source.indexOf('const ToolCodePath')
  const end = source.indexOf('const isLegacyDiffToolName', start)
  const component = start >= 0 && end > start ? source.slice(start, end) : ''
  assert.match(component, /<button/)
  assert.match(component, /type="button"/)
  assert.match(component, /foxwarm-tool-code-open/)
  assert.match(component, /aria-label=\{`Open \$\{filePath\} in Code`\}/)
  assert.match(component, /<Code2 size=\{13\} aria-hidden="true"/)
  assert.match(component, /onOpenCodeFile\(filePath, lines\)/)
  assert.match(component, /<span className=\{pathClass\}>\{filePath\}<\/span>/)
  assert.doesNotMatch(component, /role="button"|tabIndex=/)
  assert.doesNotMatch(component, /hover:underline cursor-pointer|text-blue|dark:text-blue/)
})
