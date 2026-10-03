import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const [root, inputPath, outputPath] = process.argv.slice(2)
const repository = process.env.FOXWARM_TS_ROOT
if (!repository || !root || !inputPath || !outputPath) throw new Error('Explicit source root and owned fixture paths are required')
// Establish synthetic state before any source module is evaluated. Do not import instance config.
process.env.FOXWARM_DATA_DIR = path.join(root, 'data')
process.env.FOXWARM_VECTOR_ENABLED = 'false'
const require = createRequire(path.join(repository, 'package.json'))
const config = {
  STATE_DIR: path.join(root, 'data', 'state'), WORKSPACE_DIR: path.join(root, 'workspace'),
  getAgentDir: name => name === 'main' ? path.join(root, 'workspace') : path.join(root, 'workspace', 'agents', name),
  getAgentMemoryDir: name => path.join(name === 'main' ? path.join(root, 'workspace') : path.join(root, 'workspace', 'agents', name), 'memory'),
}
class RpcError extends Error { constructor(code, message, data) { super(message); this.code = code; this.data = data } }
const modules = new Map()
function load(file) {
  if (modules.has(file)) return modules.get(file).exports
  const source = execFileSync('git', ['show', `35b8420664044e32f516dded7f5c1c9a39cc1688:${file}`], { cwd: repository, encoding: 'utf8' })
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} }; modules.set(file, module)
  const dependencies = id => {
    if (id === './config' || id === '../config') return config
    if (id === '../../packages/shared/dist/agentPathVariables') return load('packages/shared/src/agentPathVariables.ts')
    if (id === './utils/pathResolve') return load('src/utils/pathResolve.ts')
    if (id === './tools/placement') return load('src/tools/placement.ts')
    if (id === './rpc') return { RpcError }
    if (id === './nodeFileTransfer') return { resolveNodeTransferPath() { throw new Error('Transfer effects are outside this pure fixture') } }
    if (id === './applyPatch') return { parseApplyPatchInput() { throw new Error('Patch effect parsing is exercised by the actual host resolver') } }
    if (id === './mcpInboundConfig') return { requireVerifiedMcpInboundExternalId() { throw new Error('No external principal exists in this fixture') } }
    return require(id)
  }
  // Execute actual source in one realm so js-yaml plain records retain their true prototypes.
  vm.runInThisContext(`(function(exports,require,module,__filename,__dirname){${js}\n})`, { filename: file })(module.exports, dependencies, module, file, path.dirname(file))
  return module.exports
}
const auth = load('src/toolAuthorization.ts'); const permissions = load('src/permissions.ts')
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const output = input.map(test => {
  try {
    if (Object.hasOwn(test, 'legacy')) return { valid: true, rules: permissions.normalizeAgentToolRules(test.legacy) }
    if (test.defaults) return { valid: true, allowed: permissions.isDefaultIsolatedCapabilityAllowed(test.defaults.identity, 'alpha', 'unimplemented-recorded-node', undefined, 'master', test.defaults.args || {}, !!test.defaults.discovery) }
    const policy = auth.parseToolAuthorizationPolicyBytes(test.bytes ? Buffer.from(test.bytes, 'base64') : test.yaml)
    auth.setToolAuthorizationPolicyForTests(policy)
    const checks = (test.requests || []).map(request => ({ evaluation: auth.evaluateToolAuthorizationPolicy(policy, request), visible: auth.isToolAuthorizationPotentiallyVisibleSync(request, request.projection || {}), needsTarget: auth.toolAuthorizationNeedsSessionTarget(policy, request) }))
    return { valid: true, policy, checks }
  } catch (error) { return { valid: false, error: String(error.message) } }
})
fs.writeFileSync(outputPath, JSON.stringify(output))
