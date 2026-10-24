import vm from 'node:vm'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Frozen behavioral Source, with owned dependency seams. No application/config imports.
const revision = 'cc1bfe7095541bc91df7840571413aea3c61cee7'
const repository = process.env.FOXWARM_TS_ROOT
if (!repository) throw new Error('FOXWARM_TS_ROOT is required')
const require = createRequire(path.join(repository, 'package.json'))
let raw = ''; for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)
const effects = [], replies = []
const models = { models: { 'local/wire': {}, 'local/other': {}, local: {}, 'second/wire': {}, second: {}, virtual: {} }, displayModels: input.displayModels || ['local/wire', 'local/other', 'virtual'] }
const config = { MODEL_EFFORTS: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], COMPACT_KEEP_PERCENT: .3,
  resolveModelConfig: () => ({ modelsConfig: models, currentKey: 'local/wire' }) }
let binding = input.binding
const session = { id: 'main/source', agent: 'peer', model: 'local/wire', currentNode: 'master', history: [], messageCount: 0 }
const manager = {
  getSessionByChannel: () => binding, getSessionCatalog: () => null,
  validateChildSessionSuffix: suffix => { if (!/^[a-zA-Z0-9_-]+$/.test(suffix)) throw new Error('Invalid suffix') },
  validateSessionName: name => { if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid session name') },
  validateAgentName: name => { if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('Invalid agent name') },
  buildChildSessionId: (_, suffix) => 'main/source_' + suffix, generateSessionId: () => 'generated',
  forkSession: async (id, suffix, child, options) => { effects.push({ action: 'fork', id, suffix, child, options }); return 'main/child' },
  resolveSpawnedSessionModelEffort: (session, model, effort) => ({ model, effort }),
  createSessionInAgent: async options => { effects.push({ action: 'create', options }); return { sessionId: 'peer/new' } },
  detachChannel: () => effects.push({ action: 'detach' }), attachChannelDurably: async (_, __, id) => { effects.push({ action: 'attach', id }); return id },
}
const runtime = {
  getSession: async () => session, getHistory: async () => ({ messages: input.messages || [] }),
  enqueue: async (id, item) => effects.push({ action: 'enqueue', id, item }),
  notifyManualForkCreated: async (...args) => effects.push({ action: 'notice', args }),
  requestCompaction: async (_, keep) => { effects.push({ action: 'compact', keep }); return { kind: 'empty' } },
}
const modules = new Map()
function load(file) {
  if (modules.has(file)) return modules.get(file)
  const code = execFileSync('git', ['show', `${revision}:${file}`], { cwd: repository, encoding: 'utf8' })
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const dependency = id => {
    if (/\/config$/.test(id)) return config
    if (/\/sessionManager$/.test(id)) return manager
    if (/\/sessionRuntime$/.test(id)) return runtime
    if (/\/timers$/.test(id)) return { createTimer: async options => {
      if (options.cron) require('cron-parser').parseExpression(options.cron)
      effects.push({ action: 'timer', options }); return { id: 'synthetic', nextRunAt: 1 }
    } }
    if (/\/isolatedCheck$/.test(id)) return { checkTimerPermission: async () => {} }
    if (/\/skills$/.test(id)) return { listSkills: async options => { effects.push({ action: 'skills', ...options }); return [] } }
    if (/\/channel$/.test(id)) return { getChannelId: () => 'telegram', getChannelType: () => 'telegram', getConversationId: () => 'fixture' }
    if (/\/sessionControlFeedback$/.test(id)) return { replySessionControl: (_, __, ___, text) => replies.push(text) }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), id)) + '.ts'
    if (['src/commands.ts', 'src/commandHandler.ts', 'src/commands/helpers.ts', 'src/commands/types.ts', 'src/commands/autocomplete.ts', 'src/commands/sessionCmd.ts', 'src/commands/timerCmd.ts'].includes(resolved)) return load(resolved)
    if (id === 'fs-extra') return require(id)
    return {}
  }
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename: file })(dependency, module, module.exports)
  modules.set(file, module.exports)
  return module.exports
}
const helpers = load('src/commands/helpers.ts')
const sessions = load('src/commands/sessionCmd.ts')
const commands = load('src/commands.ts').COMMANDS
let result
if (input.operation === 'parsers') {
  const capture = fn => { try { return { value: fn() } } catch (error) { return { error: error.message } } }
  result = {
    selections: (input.selections || []).map(value => helpers.resolveCommandModelSelection(value)),
    create: input.create.map(tokens => sessions.parseSessionCreateFlags(tokens)),
    efforts: input.efforts.map(tokens => helpers.parseEffortFlag(tokens)),
    thresholds: input.thresholds.map(value => capture(() => helpers.parseCompactThresholdInput(value))),
    moves: input.moves.map(tokens => capture(() => helpers.parseSessionMoveArgs(tokens))),
    timers: input.timers.map(tokens => capture(() => helpers.parseTimerFlags(tokens))),
  }
} else {
  const handler = new (load('src/commandHandler.ts').CommandHandler)({ isAuthorized: () => true })
  const ctx = { reply: text => replies.push(text), platform: 'telegram', channelId: 'telegram', chatId: 'fixture' }
  if (input.explicit) await commands[input.command].handler(ctx, input.args || [], session.id, session, input.raw)
  else await handler.handleCommand(ctx, input.command, input.args || [], input.raw)
  result = { effects, replies }
}
console.log(JSON.stringify(result))
