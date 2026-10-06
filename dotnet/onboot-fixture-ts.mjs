import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url), ts = require('typescript'), commit = '35b8420664044e32f516dded7f5c1c9a39cc1688'
const source = file => execFileSync('git', ['show', `${commit}:${file}`], { encoding: 'utf8', cwd: process.env.FOXWARM_TS_ROOT })
function load(code, file, dependencies = {}) {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, module = { exports: {} }
  vm.runInThisContext(`(function(require,module,exports){${js}\n})`, { filename: file })(id => { if (!(id in dependencies)) throw new Error('Unexpected pure source import: ' + id); return dependencies[id] }, module, module.exports)
  return module.exports
}
function functions(file, names) {
  const text = source(file), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  return ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n')
}
const attributes = load(source('packages/shared/src/foxwarmMarkup.ts'), 'packages/shared/src/foxwarmMarkup.ts')
const wrappers = load(source('src/utils/promptWrappers.ts'), 'src/utils/promptWrappers.ts', { '../../packages/shared/dist/foxwarmMarkup': attributes })
let raw = ''; for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)
const emptyConfig = { default: '', models: {} }
const configText = source('src/config.ts'), configAst = ts.createSourceFile('src/config.ts', configText, ts.ScriptTarget.Latest, true)
const declaration = name => configAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(configAst) === name)).getText(configAst)
const effortConstants = load(declaration('MODEL_EFFORTS'), 'actual effort constants')
const presentation = load(source('src/session/modelEffortPresentation.ts'), 'src/session/modelEffortPresentation.ts', { '../config': { MODEL_EFFORTS: effortConstants.MODEL_EFFORTS, loadModelsConfig: () => emptyConfig } })
const contextCode = `const APP_CONFIG = ${JSON.stringify(input.app || {})}; const COMPACTION_CONFIG = { compactThresholdPercent: ${input.threshold || .85} }; function loadModelsConfig() { return ${JSON.stringify(emptyConfig)}; }
` + declaration('CONTEXT_LIMIT') + '\n' + declaration('COMPACT_THRESHOLD_PERCENT') + '\n' + functions('src/config.ts', ['resolveModelConfig']) + '\n' + functions('src/session/history.ts', ['getDefaultCompactThresholdTokens', 'getEffectiveCompactThresholdTokens'])
const context = load(contextCode, 'actual context owner and threshold functions')
console.log(JSON.stringify({ wrapper: wrappers.formatFoxwarmMessage({ type: 'onboot', eventType: 'onboot', time: input.time, hint: 'onboot session event' }, 'ONBOOT: ' + input.content), emptyPresentation: presentation.buildSessionModelEffortPresentation(input.session || {}, emptyConfig), emptyThreshold: context.getEffectiveCompactThresholdTokens(input.session || {}) }))
