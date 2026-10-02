import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { DatabaseSync } from 'node:sqlite'

const [file, mode = 'inactive', id = 'target'] = process.argv.slice(2)
const root = process.env.FOXWARM_TS_ROOT
if (!root || !file) throw new Error('Explicit source root and fixture database are required')
const source = fs.readFileSync(path.join(root, 'src/sessionWorkerStoreSchema.ts'), 'utf8').replace(/^import .*$/gm, '')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
class RpcError extends Error { constructor(code, message) { super(message); this.code = code } }
const context = vm.createContext({ exports: {}, DatabaseSync, RpcError, stableSessionWorkerJson: JSON.stringify })
const stable = fs.readFileSync(path.join(root, 'src/sessionWorkerStableJson.ts'), 'utf8').replace(/^import .*$/gm, '')
vm.runInContext(ts.transpileModule(stable, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context)
context.stableSessionWorkerJson = context.exports.stableSessionWorkerJson
vm.runInContext(js, context)
const db = new DatabaseSync(file, mode === 'validate' ? { readOnly: true } : {})
try {
  if (mode === "validate") { context.exports.validateSessionWorkerSchema(db); process.exitCode = 0 }
  else {
  context.exports.configureAndMigrateSessionWorkerDb(db)
  if (mode !== 'orphan') db.prepare('INSERT INTO session_worker_ownership(session_id,generation,state,updated_at) VALUES(?,0,?,0)').run(id, 'inactive')
  db.prepare('INSERT INTO session_worker_mailbox(session_id,intent_id,kind,payload_json,created_at) VALUES(?,?,?,?,0)').run(id, 'one', 'message', '{}')
  if (mode === 'active') db.prepare("UPDATE session_worker_ownership SET state='candidate',incarnation_id='candidate-1' WHERE session_id=?").run(id)
  if (mode === 'canonical') db.prepare('UPDATE session_worker_mailbox SET payload_json=? WHERE session_id=?').run(vm.runInContext('stableSessionWorkerJson({"2": 2, "10": 10, z: [null, true, 1e21, 1e-7, "é\\u2028"], a: -0})', context), id)
  context.exports.validateSessionWorkerSchema(db)
  }
} finally { db.close() }
