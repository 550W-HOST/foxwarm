// Real Source programmatic read on a caller-owned file, without installation imports.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const root = process.env.FOXWARM_TS_ROOT
if (!root) throw new Error('FOXWARM_TS_ROOT is required')
const ts = require(path.join(root, 'node_modules/typescript'))
require.extensions['.ts'] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(code, filename)
}
let text = ''
for await (const part of process.stdin) text += part
const input = JSON.parse(text)
const { read } = require(path.join(root, 'packages/shared/src/nodeTools.ts'))
const reply = await read({ filePath: input.filePath }, input.programmatic === false ? {} : { programmatic: true })
console.log(JSON.stringify(reply))
