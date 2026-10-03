// Invoke the actual Source inbound saver with owned filesystem/config primitives.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
const repository = process.env.FOXWARM_TS_ROOT, require = createRequire(join(repository, 'package.json'))
const ts = require('typescript'), fs = require('fs-extra'), source = await readFile(join(repository, 'src/channelFiles.ts'), 'utf8')
const root = process.argv[2], inputs = JSON.parse(await readFile(process.argv[3], 'utf8')), results = []
await mkdir(root, { recursive: true })
const module = { exports: {} }, markup = require(join(repository, 'packages/shared/dist/foxwarmMarkup.js'))
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
const imports = name => name === './sessionManager' ? { getSessionCatalog: id => ({ id, agent: 'main', currentNode: 'master' }), isSessionEffectivelyIsolated: () => false, getAgentIsolationNode: () => undefined }
  : name === './config' ? { getAgentDir: () => root }
  : name === './nodes/manager' ? { nodesManager: { writeFileToNode: () => { throw new Error('No remote effects') } } }
  : name === '../packages/shared/dist/foxwarmMarkup' ? markup : require(name)
vm.runInNewContext(code, { module, exports: module.exports, require: imports, Buffer, process, console }, { filename: 'channelFiles.ts' })
for (const input of inputs) {
  const bytes = Buffer.from(input.bytes, 'base64'), saved = await module.exports.saveInboundSessionFile({ sessionId: 'owned', platform: 'webui', buffer: bytes, fileName: input.filename, mimeType: input.mime, isImage: input.mime.startsWith('image/') })
  results.push({ ...saved, storedName: saved.absolutePath.slice(saved.absolutePath.lastIndexOf('/') + 1), descriptor: module.exports.buildSavedFileText(saved, saved.isImage ? 'image' : 'file'), exactBytes: (await readFile(saved.absolutePath)).equals(bytes) })
}
await writeFile(process.argv[4], JSON.stringify(results))
