import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import ts from 'typescript'

// Execute frozen Source owners against only caller-owned fixture files. Never import
// the checkout's generated config or instance state.
const revision = 'f84de97ac0d8235d6118a66f7ca0d1a975d64f0b'
const repository = process.env.FOXWARM_TS_ROOT
if (!repository) throw new Error('FOXWARM_TS_ROOT is required')
const require = createRequire(path.join(repository, 'package.json'))
let raw = ''; for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)
const source = file => execFileSync('git', ['show', `${revision}:${file}`], { cwd: repository, encoding: 'utf8' })
const modules = new Map()
const logger = new Proxy({}, { get: () => () => {} })
function evaluate(code, file, dependencies = id => require(id), dirname = path.dirname(file)) {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  const fixtureProcess = { env: input.environment || {}, argv: [], platform: process.platform }
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname,process){${js}\n})`, { filename: file })(dependencies, module, module.exports, file, dirname, fixtureProcess)
  return module.exports
}
function load(file) {
  if (modules.has(file)) return modules.get(file)
  const result = evaluate(source(file), file, id => {
    if (id === '../common') return { logger }
    if (!id.startsWith('.')) return require(id)
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), id))
      .replace('packages/shared/dist/', 'packages/shared/src/') + '.ts'
    return load(resolved)
  }, file === 'src/config.ts' ? path.join(input.applicationRoot, 'lib') : path.dirname(file))
  modules.set(file, result)
  return result
}
function functions(file, names) {
  const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  return ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n')
}
const config = load('src/config.ts')
let result = {
  data: config.DATA_ROOT_DIR, config: config.APP_CONFIG_PATH, models: config.DEFAULT_MODELS_CONFIG_PATH,
  agents: config.AGENTS_DIR, skills: config.SKILLS_DIR, mcp: config.MCP_CONFIG_PATH,
  workspace: config.WORKSPACE_DIR, main: config.getAgentDir('main'), mainMemory: config.MAIN_AGENT_MEMORY_DIR,
  framework: config.AGENTS_SYSTEM_PROMPT_PATH, port: config.HTTP_PORT, webui: config.ENABLE_WEBUI, trigger: config.ENABLE_TRIGGER,
}
if (input.operation === 'authority') {
  const metadata = source('src/session/metadataStore.ts')
  const metadataAst = ts.createSourceFile('metadataStore', metadata, ts.ScriptTarget.Latest, true)
  const fields = metadataAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(metadataAst) === 'SESSION_HISTORY_STATE_FIELDS')).getText(metadataAst)
  const state = source('src/session/stateValidation.ts')
  const stateAst = ts.createSourceFile('stateValidation', state, ts.ScriptTarget.Latest, true)
  const version = stateAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(stateAst) === 'CURRENT_SESSION_STATE_VERSION')).getText(stateAst)
  const serializer = evaluate(version + '\nconst SESSION_STATE_FORMAT_VERSION = exports.CURRENT_SESSION_STATE_VERSION;\n' + fields + '\n'
    + functions('src/session/stateValidation.ts', ['isRecord', 'omitObsoleteContextFrontierItem']) + '\n'
    + functions('src/session/metadataStore.ts', ['pickDefinedFields', 'serializeGoalState', 'serializeSessionStateFields', 'serializeSessionHistoryPayload']), 'actual Source authority serializer')
  result.authority = serializer.serializeSessionHistoryPayload(input.session)
}
if (input.operation === 'access') {
  const access = load('src/accessConfig.ts')
  const normalized = access.normalizeAccessConfig(input.access)
  try {
    access.assertAccessTokensDoNotMatch(normalized, input.instanceToken)
    result.rejected = false
  } catch {
    result.rejected = true
  }
}
if (input.operation === 'metadata') {
  const metadata = load('src/session/agentMetadata.ts')
  await metadata.loadAgentMetadata()
  result.metadata = Object.fromEntries(metadata.listAgentMetadataEntries())
  if (input.update) {
    await metadata.setAgentMetadata(input.update.agent, { ...metadata.getAgentMetadata(input.update.agent), ...input.update.fields })
    result.written = JSON.parse(fs.readFileSync(config.AGENTS_FILE, 'utf8'))
  }
  const validation = evaluate(functions('src/session/agentOps.ts', ['validateAgentName']), 'actual Agent name validation')
  const channel = source('src/channels/webuiChannel.ts')
  const filterStart = channel.indexOf('.filter(entry => {', channel.indexOf("path: '/api/agents'"))
  const filterEnd = channel.indexOf('.map(async entry =>', filterStart)
  const filter = channel.slice(filterStart, filterEnd).trim()
  // Evaluate those names explicitly without loading the rest of the channel runtime.
  const membership = evaluate(`const sessionManager = require('validation'); const logger = require('logger'); exports.list = entries => entries${filter};`, 'actual directory membership', id => id === 'validation' ? validation : logger)
  result.members = membership.list(fs.readdirSync(config.AGENTS_DIR, { withFileTypes: true })).map(entry => entry.name).sort()
}
if (input.operation === 'trigger') {
  const channel = source('src/channels/webuiChannel.ts')
  const start = channel.indexOf('    // External trigger endpoint')
  const end = channel.indexOf('    // WebUI API endpoints', start)
  const routeCode = channel.slice(start, end)
  const routes = []
  const queued = []
  const runtimeText = source('src/sessionRuntimeService.ts')
  const runtimeStart = runtimeText.indexOf('    async queueEvent(input) {')
  const runtimeEnd = runtimeText.indexOf('    async updateSettings(input)', runtimeStart)
  const runtimeCode = `exports.runtime = {${runtimeText.slice(runtimeStart, runtimeEnd)}};`
  const rpcText = source('src/rpc/types.ts'), rpcAst = ts.createSourceFile('rpc', rpcText, ts.ScriptTarget.Latest, true)
  const rpcError = rpcAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'RpcError').getText(rpcAst)
  const runtime = evaluate(`const sessionManager = require('manager'); ${rpcError} ` + functions('src/sessionRuntimeService.ts', ['normalizeSessionId']) + '\n' + runtimeCode,
    'actual runtime event validation', () => ({ queueSessionEvent: async (sessionId, text, type) => queued.push({ sessionId, text, type }) })).runtime
  // Inject only the existing catalog/event ownership dependencies of the real route.
  const assembled = `const {httpServerInstance, sessionManager, sessionRuntime, logger} = require('fixture'); exports.register = function() { ${routeCode} };`
  const fixture = {
    httpServerInstance: { addRoute: route => routes.push(route) },
    sessionManager: { getSessionCatalog: id => (input.sessions || []).includes(id) ? { id } : null },
    sessionRuntime: { queueEvent: (sessionId, text, type) => runtime.queueEvent({ sessionId, text, type }) }, logger,
  }
  evaluate(assembled, 'actual Trigger route', () => fixture).register.call({ enableTrigger: true })
  result.responses = []
  for (const body of input.bodies || []) {
    let status = 200, response
    await routes[0].handler({ body }, { status(code) { status = code; return this }, json(value) { response = value } })
    result.responses.push({ status, body: response })
  }
  result.queued = queued
}
console.log(JSON.stringify(result))
