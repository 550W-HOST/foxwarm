import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const [root, input, output] = process.argv.slice(2)
const repository = process.env.FOXWARM_TS_ROOT
if (!repository || !root || !input || !output) throw new Error('Explicit source and owned fixture paths are required')
const source = execFileSync('git', ['show', 'b9c6f93f93d3e8d45f8256245a903f200d0bd8c2:src/taskStore.ts'], { cwd: repository, encoding: 'utf8' })
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
const module = { exports: {} }
vm.runInThisContext(`(function(exports,require,module){${js}\n})`, { filename: 'src/taskStore.ts' })(module.exports, createRequire(path.join(repository, 'package.json')), module)
const aliases = new Map([['old', 'alpha'], ['self', 'alpha']])
const resolve = id => aliases.get(id) || id
const store = new module.exports.TaskStore(path.join(root, 'source-tasks.sqlite'), { resolveSessionId: resolve, sessionAliases: id => [...aliases].filter(([, value]) => value === id).map(([key]) => key) })
const ids = new Map()
const checks = JSON.parse(fs.readFileSync(input, 'utf8')).map(step => {
  if (step.move) { for (const [key, value] of aliases) if (value === step.move[0]) aliases.set(key, step.move[1]); aliases.set(step.move[0], step.move[1]); return null }
  const args = { ...step.args }
  if (args.taskId) args.taskId = ids.get(args.taskId) || args.taskId
  try {
    const result = step.user ? store.executeAsUser(args) : store.execute(args, step.actor, step.limit, undefined, step.scopeIds)
    if (step.key) ids.set(step.key, result.task.id)
    if (result.tasks) return { total: result.total, omitted: result.omitted, count: result.tasks.length, ...(step.limit ? {} : { tasks: result.tasks.map(task => [task.title, task.createdByKind, task.createdBySessionId, task.ownerSessionId, task.status]).sort((a, b) => a[0].localeCompare(b[0])) }) }
    return { owner: result.task.ownerSessionId, creator: result.task.createdBySessionId, status: result.task.status }
  } catch (error) { return { error: error.code } }
})
store.close()
fs.writeFileSync(output, JSON.stringify(checks))
