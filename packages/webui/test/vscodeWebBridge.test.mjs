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
  resolveToolCodeFileTarget,
  resolveSessionCodeTarget,

  readCodeWorkspaceNodePreference,
  writeCodeWorkspaceNodePreference,
} = await import(pathToFileURL(bundledPath).href)

test('Code paths normalize absolute POSIX paths', () => {
  assert.equal(normalizeCodePath('/app/./packages/../src/'), '/app/src')
  assert.equal(normalizeCodePath('relative/path'), null)
})

test('new Code windows use their Node persistent workspace', () => {
  const url = makeVscodeWebUrl('/proxy/api', 'https://example.test', { nodeId: 'master', path: '/app/src' })
  assert.equal(url.pathname, '/proxy/vscode-web/')
  assert.equal(url.searchParams.get('initialFolderUri'), 'foxwarm://node+master/app/src')
})

test('Code workspace URLs preserve remote node identity', () => {
  const url = makeVscodeWebUrl('/api', 'https://example.test', { nodeId: 'worker-a', path: '/srv/project' })
  assert.equal(url.searchParams.get('initialFolderUri'), 'foxwarm://node+worker-a/srv/project')
})

test('embedded Code starts from a persistent workspace URL', () => {
  const url = makeVscodeWebUrl('/api', 'https://example.test', { nodeId: 'master', path: '/app' })
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
  assert.equal(url.searchParams.get('initialFolderUri'), 'foxwarm://node+master/app')
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
  assert.match(component, /aria-label=\{`Open \$\{displayPath\} in Code`\}/)
  assert.match(component, /<Code2 size=\{13\} aria-hidden="true"/)
  assert.match(component, /onOpenCodeFile\?\.\(displayPath, lines, target\)/)
  assert.match(component, /<span[^>]*className=\{pathClass\}>\{displayPath\}<\/span>/)
  assert.doesNotMatch(component, /role="button"|tabIndex=/)
  assert.doesNotMatch(component, /hover:underline cursor-pointer|text-blue|dark:text-blue/)
})


test('Windows drive paths use the same Code URI while preserving relative resolution and drive roots', () => {
  const root = resolveSessionCodeTarget('master', 'W:\\')
  assert.deepEqual(root, { nodeId: 'master', path: '/W:' })
  assert.equal(makeVscodeWebUrl('/api', 'https://example.test', root).searchParams.get('initialFolderUri'), 'foxwarm://node+master/W%3A')
  assert.equal(normalizeCodePath('/W:/'), '/W:')
  assert.deepEqual(resolveToolCodeFileTarget('sub\\file.txt', 'master', 'W:\\'), {
    kind: 'openFile', nodeId: 'master', path: '/W:/sub/file.txt',
  })
  assert.equal(normalizeCodePath('w:\\work space\\file.txt'), '/W:/work space/file.txt')
  assert.equal(normalizeCodePath('W:/../file.txt'), '/W:/file.txt')
  assert.equal(normalizeCodePath('W:relative'), null)
  assert.equal(normalizeCodePath('\\\\server\\share'), null)
  assert.deepEqual(resolveToolCodeFileTarget('sub\\file.txt', 'master', 'w:\\work'), {
    kind: 'openFile', nodeId: 'master', path: '/W:/work/sub/file.txt',
  })
  assert.deepEqual(resolveToolCodeFileTarget('w:\\file.txt', 'master', '/elsewhere'), {
    kind: 'openFile', nodeId: 'master', path: '/W:/file.txt',
  })
})

test('Provider-qualified workspace and tool targets retain their Node through encoded Code URLs', () => {
  const target = { nodeId: 'development/worker:one', path: '/workspace' }
  const url = makeVscodeWebUrl('/proxy/api', 'https://example.test', target)
  assert.equal(url.searchParams.get('initialFolderUri'), 'foxwarm://node+development%2Fworker%3Aone/workspace')
  assert.deepEqual(resolveToolCodeFileTarget('/workspace/file.ts', target.nodeId), {
    kind: 'openFile', nodeId: target.nodeId, path: '/workspace/file.ts',
  })
})


test('native leading-character identities stay native in Code targets and workspace preferences', () => {
  for (const nodeId of ['_native-review', '-legacy-native', '.legacy-code']) {
    let stored = nodeId
    const storage = { getItem: () => stored, setItem: (_key, value) => { stored = value } }
    assert.equal(readCodeWorkspaceNodePreference(storage), nodeId)
    assert.equal(writeCodeWorkspaceNodePreference(storage, nodeId), nodeId)
    assert.equal(stored, nodeId)
    assert.deepEqual(resolveToolCodeFileTarget('/workspace/file.ts', nodeId), {
      kind: 'openFile', nodeId, path: '/workspace/file.ts',
    })
    const url = makeVscodeWebUrl('/proxy/api', 'https://example.test', { nodeId, path: '/workspace' })
    assert.equal(url.searchParams.get('initialFolderUri'), `foxwarm://node+${nodeId}/workspace`)
  }
})

test('per-Node bridge queues initial requests and only accepts its own exact-origin frame', async () => {
  const bridgePath = path.join(tempDir, 'frame.mjs')
  await esbuild.build({ entryPoints: [path.join(webuiRoot, 'src/components/VscodeWebFrameHost.tsx')], outfile: bridgePath, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' })
  const { createCodeFrame } = await import(pathToFileURL(bridgePath).href)
  globalThis.window = { location: { origin: 'https://example.test' }, setTimeout, clearTimeout }
  const frames = [createCodeFrame('/master'), createCodeFrame('/remote')]
  const sent = [[], []]
  frames.forEach((frame, index) => { frame.iframeRef.current = { contentWindow: { postMessage: (...args) => sent[index].push(args) } } })
  const pending = frames.map((frame, index) => frame.request({ kind: 'addFolder', nodeId: index ? 'remote' : 'master', path: '/project' }))
  const ready = { channel: 'foxwarm-code-bridge', version: 1, type: 'ready' }
  frames[0].receive({ origin: 'https://other.test', source: frames[0].iframeRef.current.contentWindow, data: ready }, () => {})
  frames[0].receive({ origin: window.location.origin, source: frames[1].iframeRef.current.contentWindow, data: ready }, () => {})
  assert.deepEqual(sent, [[], []])
  frames.forEach((frame, index) => {
    frame.receive({ origin: window.location.origin, source: frame.iframeRef.current.contentWindow, data: ready }, () => {})
    assert.equal(sent[index][0][0].request.nodeId, index ? 'remote' : 'master')
  })
  const cancelled = assert.rejects(pending[0], /closed/)
  frames[0].dispose()
  frames[1].receive({ origin: window.location.origin, source: frames[1].iframeRef.current.contentWindow, data: { ...ready, type: 'response', requestId: sent[1][0][0].requestId, ok: true, result: 'remote opened' } }, () => {})
  assert.equal(await pending[1], 'remote opened')
  await cancelled
  frames[1].dispose()
  delete globalThis.window
})
