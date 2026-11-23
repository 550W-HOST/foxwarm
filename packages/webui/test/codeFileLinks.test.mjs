import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const outfile = path.join(await mkdtemp(path.join(tmpdir(), 'foxwarm-code-file-links-')), 'codeFileLinks.mjs')
await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/codeFileLinks.ts')],
  outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent',
})
const { parseFileLinkHref, resolveFileLink, linkBaseAfter, computeLinkBases, decodeLinkBase } = await import(pathToFileURL(outfile).href)

test('file link destinations: schemeless paths and file URLs, with line suffixes', () => {
  assert.deepEqual(parseFileLinkHref('src/app.ts'), { path: 'src/app.ts' })
  assert.deepEqual(parseFileLinkHref('./src/app.ts#L10'), { path: './src/app.ts', startLine: 10 })
  assert.deepEqual(parseFileLinkHref('/work/a.ts#L10-L20'), { path: '/work/a.ts', startLine: 10, endLine: 20 })
  assert.deepEqual(parseFileLinkHref('/work/a.ts#L10-20'), { path: '/work/a.ts', startLine: 10, endLine: 20 })
  assert.deepEqual(parseFileLinkHref('/work/a.ts#section'), { path: '/work/a.ts' })
  assert.deepEqual(parseFileLinkHref('src/app.ts:42'), { path: 'src/app.ts', startLine: 42 })
  assert.deepEqual(parseFileLinkHref('README.md:7'), { path: 'README.md', startLine: 7 })
  assert.deepEqual(parseFileLinkHref('src/app.ts:42:5'), { path: 'src/app.ts', startLine: 42 })
  assert.deepEqual(parseFileLinkHref('src/app.ts:10-12'), { path: 'src/app.ts', startLine: 10, endLine: 12 })
  assert.deepEqual(parseFileLinkHref('my%20file.txt'), { path: 'my file.txt' })
  assert.deepEqual(parseFileLinkHref('docs/'), { path: 'docs/' })
  assert.deepEqual(parseFileLinkHref('file:///work/a.ts'), { path: '/work/a.ts' })
  assert.deepEqual(parseFileLinkHref('file://localhost/work/a%20b.ts#L3'), { path: '/work/a b.ts', startLine: 3 })
  assert.deepEqual(parseFileLinkHref('file:///C:/work/a.ts'), { path: 'C:/work/a.ts' })
  assert.deepEqual(parseFileLinkHref('C:\\work\\a.ts:3'), { path: 'C:\\work\\a.ts', startLine: 3 })
  for (const other of ['https://example.com/a', 'mailto:a@example.com', 'javascript:alert(1)', 'vscode://x', '#heading', '//host/x', '?q=1', '', 'file://server/share/a']) {
    assert.equal(parseFileLinkHref(other), null, other)
  }
})

test('resolution uses the base Node and cwd; relative paths need a known cwd', () => {
  const base = { nodeId: 'dev/box', cwd: '/work' }
  assert.equal(resolveFileLink('https://example.com', base), undefined)
  assert.deepEqual(resolveFileLink('src/a.ts#L3', base), { kind: 'openFile', nodeId: 'dev/box', path: '/work/src/a.ts', startLine: 3 })
  assert.deepEqual(resolveFileLink('../other/b.ts', base), { kind: 'openFile', nodeId: 'dev/box', path: '/other/b.ts' })
  assert.deepEqual(resolveFileLink('/etc/hosts', { nodeId: 'master' }), { kind: 'openFile', nodeId: 'master', path: '/etc/hosts' })
  assert.equal(resolveFileLink('src/a.ts', { nodeId: 'master' }), null)
  assert.equal(resolveFileLink('/etc/hosts', undefined), null)
  assert.equal(resolveFileLink('~/notes.md', base), null)
  assert.deepEqual(resolveFileLink('src\\a.ts', { nodeId: 'win', cwd: 'W:\\repo' }), { kind: 'openFile', nodeId: 'win', path: '/W:/repo/src/a.ts' })
})

test('link bases come from the persisted placement, the call Node, or an older call’s own metadata', () => {
  const response = meta => ({ tool_use_id: 'x', name: 'x', response: {}, __meta: meta })
  assert.deepEqual(linkBaseAfter(response({ target: { source: 'node', node: 'n1' }, placementAfter: { node: 'n1', cwd: '/w' } })), { nodeId: 'n1', cwd: '/w' })
  // A call on another Node: its Node, but the Session cwd belongs to a different Node.
  assert.deepEqual(linkBaseAfter(response({ target: { source: 'node', node: 'other' }, placementAfter: { node: 'n1', cwd: '/w' } })), { nodeId: 'other' })
  // A builtin call reports the Session placement after it (for example after a Node selection).
  assert.deepEqual(linkBaseAfter(response({ target: { source: 'builtin', node: 'master' }, placementAfter: { node: 'n2', cwd: '/x' } })), { nodeId: 'n2', cwd: '/x' })
  // Older history.
  assert.equal(linkBaseAfter(response({ target: { source: 'builtin', node: 'master' } })), undefined)
  assert.equal(linkBaseAfter({ tool_use_id: 'x', name: 'x', response: {} }), undefined)
  assert.deepEqual(linkBaseAfter(response({ exec: { nodeId: 'n1', cwd: '/a', sessionCwd: '/a', finalCwd: '/a/b' } })), { nodeId: 'n1', cwd: '/a/b' })
  assert.deepEqual(linkBaseAfter(response({ exec: { nodeId: 'n1', cwd: '/a', sessionCwd: '/s' } })), { nodeId: 'n1', cwd: '/s' })
  assert.deepEqual(linkBaseAfter(response({ resolvedPaths: [{ raw: './src/a.ts', resolved: '/repo/src/a.ts', nodeId: 'n1' }] })), { nodeId: 'n1', cwd: '/repo' })
  assert.deepEqual(linkBaseAfter(response({ resolvedPaths: [{ raw: '/abs/a.ts', resolved: '/abs/a.ts', nodeId: 'n1' }] })), { nodeId: 'n1' })
  assert.deepEqual(linkBaseAfter(response({ resolvedPaths: [{ raw: '../a.ts', resolved: '/a.ts', nodeId: 'n1' }] })), { nodeId: 'n1' })
})

test('each model message takes the most recent recorded base before it', () => {
  const tool = meta => ({ role: 'tool', parts: [{ functionResponse: { tool_use_id: 't', name: 'exec', response: {}, __meta: meta } }] })
  const first = { role: 'model', parts: [{ text: 'before' }] }
  const second = { role: 'model', parts: [{ text: 'after exec' }] }
  const third = { role: 'model', parts: [{ text: 'after old builtin' }] }
  const fourth = { role: 'model', parts: [{ text: 'after node select' }] }
  const bases = computeLinkBases([
    first,
    tool({ target: { source: 'node', node: 'n1' }, placementAfter: { node: 'n1', cwd: '/w' } }),
    second,
    tool({ target: { source: 'builtin', node: 'master' } }),
    third,
    tool({ target: { source: 'builtin', node: 'master' }, placementAfter: { node: 'n2' } }),
    fourth,
  ])
  assert.equal(decodeLinkBase(bases.get(first)), undefined)
  assert.deepEqual(decodeLinkBase(bases.get(second)), { nodeId: 'n1', cwd: '/w' })
  assert.deepEqual(decodeLinkBase(bases.get(third)), { nodeId: 'n1', cwd: '/w' })
  assert.deepEqual(decodeLinkBase(bases.get(fourth)), { nodeId: 'n2' })
})
