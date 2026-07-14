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
} = await import(pathToFileURL(bundledPath).href)

test('embedded Code starts once and then reuses the running frame', () => {
  assert.equal(planCodeOpen(false, false), 'start-embedded')
  assert.equal(planCodeOpen(true, false), 'reuse-embedded')
  assert.equal(planCodeOpen(true, true), 'new-window')
  assert.equal(planCodeOpen(true, false, true), 'new-window')
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

test('tool Code paths keep native text styling and only add link affordance', async () => {
  const source = await readFile(path.join(webuiRoot, 'src/components/ToolTimelineItems.tsx'), 'utf8')
  const start = source.indexOf('const ToolCodePath')
  const end = source.indexOf('const isLegacyDiffToolName', start)
  const component = start >= 0 && end > start ? source.slice(start, end) : ''
  assert.match(component, /hover:underline cursor-pointer/)
  assert.doesNotMatch(component, /Code2|text-blue|dark:text-blue|h-3|w-3/)
})
