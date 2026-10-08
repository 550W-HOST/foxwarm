import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url), ts = require('typescript'), commit = 'c02388400a05bf173912e36e7d1cfe899c5b948c'
const source = path => execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8', cwd: process.env.FOXWARM_TS_ROOT })
function load(text, path, dependencies = {}) {
  const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, module = { exports: {} }
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename: path })(id => { if (!(id in dependencies)) throw new Error('Unexpected pure fixture import: ' + id); return dependencies[id] }, module, module.exports)
  return module.exports
}
const controls = load(source('src/toolCallControls.ts'), 'src/toolCallControls.ts')
const configText = source('src/config.ts'), ast = ts.createSourceFile('src/config.ts', configText, ts.ScriptTarget.Latest, true)
const normalize = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'normalizeHandoffConfirmationEnabled')
const config = load(normalize.getText(ast), 'src/config.ts selected actual normalizer')
const child = load(source('src/session/childSessionReminder.ts'), 'src/session/childSessionReminder.ts', { '../config': { HANDOFF_CONFIRMATION_ENABLED: false }, '../toolCallControls': controls, '../utils/promptWrappers': { formatFoxwarmSystem: () => { throw new Error('Unused reminder wrapper') } } })
let raw = ''; for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)
const result = { validations: input.args.map(args => { try { controls.validateInterAgentHandoffConfirmation(args); return null } catch (error) { return error.message } }), flags: input.flags.map(app => { try { return config.normalizeHandoffConfirmationEnabled(app.handoffConfirmation) } catch (error) { return { error: error.message } } }), instructions: [false, true].map(enabled => child.buildChildCompletionInstructionForMode('source-parent', enabled)), schemas: [false, true].map(enabled => {
  const definition = controls.addHandoffConfirmationSchema(input.definition, enabled)
  const normal = controls.addToolCancellationSchema(definition)
  return { concrete: { properties: Object.keys(definition.parameters.properties), required: definition.parameters.required || [] }, model: { properties: Object.keys(normal.parameters.properties), required: normal.parameters.required || [] } }
}) }
process.stdout.write(JSON.stringify(result))
