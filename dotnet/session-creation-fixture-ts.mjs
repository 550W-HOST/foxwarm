import { execFileSync } from 'node:child_process'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the actual reference allocator without loading application configuration.
const repository = process.env.FOXWARM_TS_ROOT
if (!repository) throw new Error('FOXWARM_TS_ROOT is required')
const revision = '2a25acd671e85e355d5c4eb57f2e5c146ccaab5e'
const text = execFileSync('git', ['show', `${revision}:src/sessionManager.ts`], { cwd: repository, encoding: 'utf8' })
const ast = ts.createSourceFile('sessionManager.ts', text, ts.ScriptTarget.Latest, true)
const names = ['generateSessionId', 'allocateGeneratedSessionId', 'generateAvailableSessionName']
const code = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n')
const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
let raw = ''; for await (const chunk of process.stdin) raw += chunk
const input = JSON.parse(raw)
const results = []
for (const item of input.cases) {
  process.env.TZ = item.zone
  const OriginalDate = Date
  const random = [...item.random]
  const tried = []
  const context = vm.createContext({
    exports: {},
    Date: class extends OriginalDate { constructor() { super(item.time) } },
    Math: Object.assign(Object.create(Math), { random: () => { if (!random.length) throw new Error('random sequence exhausted'); return random.shift() } }),
    isSessionIdReserved: async id => { tried.push(id); return (item.reserved || []).includes(id) },
  })
  vm.runInContext(js + '\nglobalThis.allocate = agent => agent === null ? allocateGeneratedSessionId() : generateAvailableSessionName(agent);', context)
  const allocated = item.allocate ? await context.allocate(item.agent ?? null) : context.exports.generateSessionId()
  results.push({ allocated, tried })
}
console.log(JSON.stringify(results))
