const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const ts = require('/home/ldmbot/git/foxwarm/packages/webui/node_modules/typescript')

require.extensions['.ts'] = function compileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      strict: true,
    },
    fileName: filename,
  })
  module._compile(outputText, filename)
}

const {
  formatToolResponseText,
  getPrimaryToolResponseText,
} = require('/home/ldmbot/git/foxwarm/packages/webui/src/components/toolResponseFormatting.ts')
const {
  formatObject,
} = require('/home/ldmbot/git/foxwarm/packages/webui/src/components/objectFormatting.ts')

test('structured success tool responses use formatted object preview instead of null', () => {
  const text = getPrimaryToolResponseText({
    name: 'search_tools',
    response: {
      count: 1,
      totalMatched: 1,
      tools: [{ name: 'read', toolId: 'builtin:read' }],
    },
  })

  assert.equal(text, 'count: 1\ntotalMatched: 1\ntools: [{"name":"read","toolId":"builtin:read"}]')
})

test('single-key object formatting still collapses to value only', () => {
  assert.equal(formatObject({ count: 3 }), '3')
  assert.equal(getPrimaryToolResponseText({ name: 'list_mcp_servers', response: { servers: [{ name: 'demo' }] } }), '[{"name":"demo"}]')
})

test('output responses still prefer output over structured fallback', () => {
  assert.equal(getPrimaryToolResponseText({
    name: 'exec',
    response: { output: 'ok', extra: 'ignored in default preview' },
  }), 'ok')
})

test('error responses still format as error text', () => {
  assert.equal(formatToolResponseText({
    name: 'edit',
    response: { error: { message: 'failed', code: 'E_FAIL' } },
  }), '{\n  "message": "failed",\n  "code": "E_FAIL"\n}')
})