import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const [inputPath, outputPath] = process.argv.slice(2)
const root = process.env.FOXWARM_TS_ROOT
if (!root || !inputPath || !outputPath) throw new Error('Source root and owned fixture paths are required')
const source = await fs.readFile(path.join(root, 'src/channels/webuiChannel.ts'), 'utf8')
const managerSource = await fs.readFile(path.join(root, 'src/sessionManager.ts'), 'utf8')
const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
const manager = ts.createSourceFile('manager.ts', managerSource, ts.ScriptTarget.Latest, true)
const names = ['getWebUiSidebarOrder', 'getSessionTreeParentId', 'compareWebUiSidebarSessions', 'getWebUiSidebarSiblings', 'writeWebUiSidebarOrder', 'resolveOptionalSessionId', 'assertNoSidebarParentCycle']
const functions = names.map(name => {
  const node = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  if (!node) throw new Error('Missing real source function ' + name)
  return node.getText(file)
}).join('\n')
const archive = manager.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'archiveSessions').getText(manager).replace(/^export\s+/, '')
const relationText = await fs.readFile(path.join(root, 'src/session/relations.ts'), 'utf8')
const relationFile = ts.createSourceFile('relations.ts', relationText, ts.ScriptTarget.Latest, true)
const relationFunctions = ['SessionRelationCycleError', 'buildCanonicalChildMap', 'collectSessionDescendants', 'assertNoParentCycle', 'resolveSessionParentId', 'setSessionParent'].map(name => {
  const node = relationFile.statements.find(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === name)
  return node.getText(relationFile).replace(/^export\s+/, '')
}).join('\n')
const handlers = {}
function visit(node) {
  if (ts.isObjectLiteralExpression(node)) {
    const route = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'path')
    const handler = node.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(file) === 'handler')
    if (route && handler && ts.isStringLiteral(route.initializer)) handlers[route.initializer.text.split('/').at(-1)] = handler.initializer.getText(file)
  }
  ts.forEachChild(node, visit)
}
visit(file)
const input = JSON.parse(await fs.readFile(inputPath, 'utf8'))
const sessions = new Map([...input.rows].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))).map(row => [row.id, structuredClone(row)]))
function resolve(requested) {
  if (sessions.has(requested)) return sessions.get(requested)
  const matched = [...sessions.values()].filter(row => row.aliases?.includes(requested))
  return matched.length === 1 ? matched[0] : undefined
}
const context = vm.createContext({ sessions, console, logger: { error() {}, warn() {} }, saveSessionCatalogEntries: async () => {},
  broadcastSessionListUpdate() {}, sessionManager: {
    getSessionCatalog: resolve, getAllSessions: () => sessions, saveSessionCatalogEntries: async () => {},

  }, persistSessionMetadataUpdate: async () => {}, notifySessionUpdated() {} })
vm.runInContext(ts.transpileModule(functions + '\n' + archive + '\n' + relationFunctions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
context.sessionManager.setSessionParent = (id, parent) => context.setSessionParent({ getExistingSession: async requested => resolve(requested) || null,
  saveSession: async () => {}, saveSessionCatalogEntries: async () => {}, notifySessionListUpdated() {} }, id, parent)
context.sessionManager.archiveSessions = context.archiveSessions
context.sessionManager.collectSessionDescendants = id => context.collectSessionDescendants(sessions, id)
const sorted = [...input.rows].sort(context.compareWebUiSidebarSessions).map(row => row.id)
const outcomes = []
for (const operation of input.operations || []) {
  let result
  const res = { status(code) { this.code = code; return this }, json(value) { result = { status: this.code || 200, value }; return this } }
  const text = handlers[operation.action]
  if (!text) throw new Error('Missing real source route ' + operation.action)
  const handler = vm.runInContext(ts.transpileModule('(' + text + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)
  await handler({ params: { sessionId: operation.id }, body: operation.body || {} }, res)
  outcomes.push({ ...result, rows: JSON.parse(JSON.stringify([...sessions.values()])) })
}
await fs.writeFile(outputPath, JSON.stringify({ sorted, outcomes, locale: new Intl.Collator().resolvedOptions() }))
