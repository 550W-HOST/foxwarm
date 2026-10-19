import vm from 'node:vm'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Execute behavioral Source with explicit owned storage/provider seams. No application imports.
const repository = process.env.FOXWARM_TS_ROOT
if (!repository) throw new Error('FOXWARM_TS_ROOT is required')
const require = createRequire(path.join(repository, 'package.json'))
let raw = ''; for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)
const modules = new Map(), effects = []
const session = structuredClone(input.session || { id: 'main/source', history: [], meta: {} })
const archive = structuredClone(session.history)
const deps = { getSessionById: () => session, getExistingSession: async () => session,
  saveSession: async () => { effects.push({ save: true }) } }
const logger = { info() {}, error() {}, warn() {}, debug() {} }
const real = new Set(['src/btw.ts', 'src/session/promptCache.ts', 'src/session/messageVisibility.ts', 'src/session/stateValidation.ts',
  'src/utils/promptWrappers.ts', 'src/session/history.ts', 'src/tokenCount.ts', 'src/toolCallArgs.ts',
  'src/tools/resolvedTools.ts', 'src/jsonObjectArgs.ts', 'src/toolExecutor.ts', 'src/toolCallControls.ts'])
function load(file) {
  if (modules.has(file)) return modules.get(file)
  const code = execFileSync('git', ['show', `900ff238e:${file}`], { cwd: repository, encoding: 'utf8' })
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }; modules.set(file, module.exports)
  const dependency = id => {
    if (id.startsWith('node:') || ['crypto', 'path'].includes(id)) return require(id)
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), id)) + '.ts'
    if (real.has(resolved)) return load(resolved)
    if (id.includes('packages/shared/dist/')) return require(path.join(repository, path.posix.normalize(path.posix.join(path.posix.dirname(file), id))))
    if (/common$/.test(id)) return { logger }
    if (/config$/.test(id)) return { COMPACT_KEEP_PERCENT: .3 }
    if (/llm$/.test(id)) return { chat: async (parts, snapshot, iteration, options) => {
      effects.push({ parts, snapshot: structuredClone(snapshot), iteration,
        options: { notifySessionEvents: options.notifySessionEvents,
          registerAbortController: options.registerAbortController, purpose: options.purpose,
          snapshotAuthority: options.snapshotAuthority } })
      if (input.error) throw new Error(input.error)
      return input.result || {}
    } }
    if (/sessionManager$/.test(id)) return { getSession: async () => session,
      saveSession: deps.saveSession, appendSessionMessage: async (_, row) => effects.push({ row }) }
    if (/\/archive$/.test(id)) return { readArchiveMessagesBySeqRange: async (_, start, end) => archive
      .filter(row => row.__meta.seq >= start && row.__meta.seq <= end).map(row => ({ seq: row.__meta.seq, message: row })) }
    if (/metadataStore$/.test(id)) return { captureSessionSemanticState: value => structuredClone(value),
      restoreSessionSemanticState: (value, before) => Object.assign(value, before) }
    if (/stateFile$/.test(id)) return { isSessionAuthorityPostCommitError: () => false }
    if (/permissions$/.test(id)) return { isPermissionNeutralBuiltinDispatcher: () => false }
    return {}
  }
  const expose = file === 'src/toolExecutor.ts' ? '\nmodule.exports.buildToolArgsPreview = buildToolArgsPreview;' : ''
  vm.runInThisContext(`(function(require,module,exports){${js}${expose}\n})`, { filename: file })(dependency, module, module.exports)
  modules.set(file, module.exports)
  return module.exports
}
let result
if (input.operation === 'btw') {
  const btw = load('src/btw.ts')
  const snapshot = btw.cloneSessionForBtw(session)
  const execution = await btw.executeBtwRequest(snapshot, input.question || 'side question')
  result = { execution, display: btw.buildBtwDisplayResult(execution), effects, session }
} else if (input.operation === 'delete') {
  result = { result: await load('src/session/history.ts').deleteMessages(deps, session.id, input.count), session, effects }
} else if (input.operation === 'prune') {
  result = { result: await load('src/session/history.ts').compactToolMessages(deps, session.id, input.keep), session, effects }
} else if (input.operation === 'preview') {
  result = { preview: load('src/toolExecutor.ts').buildToolArgsPreview(input.call) }
} else throw new Error('Unknown operation')
console.log(JSON.stringify(result))
