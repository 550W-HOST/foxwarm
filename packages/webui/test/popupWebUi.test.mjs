import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-popup-webui-test-'))
const bundledPath = path.join(tempDir, 'popupWebUi.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/popupWebUi.ts')],
  outfile: bundledPath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { FOXWARM_POPUP_VERSION, makeFoxwarmPopupUrl, parseFoxwarmPopupTarget } = await import(pathToFileURL(bundledPath).href)

test('parses only versioned single-leaf popup targets', () => {
  assert.deepEqual(parseFoxwarmPopupTarget(`?foxwarmPopup=chat&foxwarmPopupVersion=${FOXWARM_POPUP_VERSION}&sessionId=${encodeURIComponent('agent/task')}&title=Task`), {
    kind: 'chat', sessionId: 'agent/task', title: 'Task',
  })
  assert.deepEqual(parseFoxwarmPopupTarget(`?foxwarmPopup=terminal&foxwarmPopupVersion=${FOXWARM_POPUP_VERSION}&terminalId=term-1&title=Shell`), {
    kind: 'terminal', terminalId: 'term-1', title: 'Shell',
  })
  assert.deepEqual(parseFoxwarmPopupTarget(`?foxwarmPopup=agents&foxwarmPopupVersion=${FOXWARM_POPUP_VERSION}`), { kind: 'agents' })
  assert.deepEqual(parseFoxwarmPopupTarget(`?foxwarmPopup=setup&foxwarmPopupVersion=${FOXWARM_POPUP_VERSION}`), { kind: 'setup' })
  assert.equal(parseFoxwarmPopupTarget('?foxwarmPopup=chat&sessionId=agent/task'), null)
  assert.equal(parseFoxwarmPopupTarget(`?foxwarmPopup=chat&foxwarmPopupVersion=${FOXWARM_POPUP_VERSION}&sessionId=`), null)
  assert.equal(parseFoxwarmPopupTarget(`?foxwarmPopup=terminal&foxwarmPopupVersion=${FOXWARM_POPUP_VERSION}`), null)
  assert.equal(parseFoxwarmPopupTarget(`?foxwarmPopup=sidebar&foxwarmPopupVersion=${FOXWARM_POPUP_VERSION}`), null)
})

test('builds deployment-relative popup URLs without retaining workbench or embed routing state', () => {
  const chat = makeFoxwarmPopupUrl('https://example.test/prefix/ui/?old=1#tab/system%3Asetup', { kind: 'chat', sessionId: 'agent/task', title: 'Task' })
  assert.equal(chat.origin, 'https://example.test')
  assert.equal(chat.pathname, '/prefix/ui/')
  assert.equal(chat.hash, '')
  assert.deepEqual(Object.fromEntries(chat.searchParams), {
    foxwarmPopup: 'chat',
    foxwarmPopupVersion: String(FOXWARM_POPUP_VERSION),
    sessionId: 'agent/task',
    title: 'Task',
  })
  assert.deepEqual(parseFoxwarmPopupTarget(chat.search), { kind: 'chat', sessionId: 'agent/task', title: 'Task' })

  const terminal = makeFoxwarmPopupUrl(chat, { kind: 'terminal', terminalId: 'term-1' })
  assert.deepEqual(Object.fromEntries(terminal.searchParams), {
    foxwarmPopup: 'terminal',
    foxwarmPopupVersion: String(FOXWARM_POPUP_VERSION),
    terminalId: 'term-1',
  })
})