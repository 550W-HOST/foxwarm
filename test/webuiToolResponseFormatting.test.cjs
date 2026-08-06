const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

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

const sharedToolResponseFormatting = require(path.resolve(__dirname, '../packages/shared/src/toolResponseFormatting.ts'))
const {
  formatCompactObjectPreview,
  formatToolResponsePayload: formatToolResponseText,
} = sharedToolResponseFormatting
const formatObject = formatCompactObjectPreview

test('structured success tool responses use formatted object preview instead of null', () => {
  const text = formatToolResponseText({
    count: 1,
    totalMatched: 1,
    tools: [{ name: 'read', toolId: 'builtin:read' }],
  })

  assert.equal(text, 'count: 1\ntotalMatched: 1\ntools: [{name: read, toolId: builtin:read}]')
})

test('single-key non-output objects keep their key in shared yaml-style formatting', () => {
  assert.equal(formatObject({ count: 3 }), '3')
  assert.equal(formatCompactObjectPreview({ count: 3 }), '3')
  assert.equal(formatToolResponseText({ servers: [{ name: 'demo' }] }), 'servers: [{name: demo}]')
})

test('single-key output and content responses still collapse to value only', () => {
  assert.equal(formatToolResponseText({ output: 'ok' }), 'ok')

  assert.equal(formatToolResponseText({ content: 'hello' }), 'content: hello')
})

test('multi-key responses keep sibling fields instead of collapsing to output only', () => {
  assert.equal(formatToolResponseText({ output: 'ok', count: 2 }), 'output: ok\ncount: 2')
})

test('single-key error responses also collapse to value only via formatObject', () => {
  assert.equal(formatToolResponseText({ error: { message: 'failed', code: 'E_FAIL' } }), 'error: {message: failed, code: E_FAIL}')

  assert.equal(formatToolResponseText({ error: 'bad' }), 'error: bad')
})