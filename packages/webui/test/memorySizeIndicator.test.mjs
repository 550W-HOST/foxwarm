import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(path.join(tmpdir(), 'foxwarm-memory-indicator-'))
after(() => rm(temp, { recursive: true, force: true }))
const output = path.join(temp, 'indicator.cjs')
await build({
  stdin: {
    contents: `import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
      import ContextScrollbar from './src/components/ContextScrollbar';
      export function render(memorySize) {
        global.window = { localStorage: { getItem: () => null } };
        return renderToStaticMarkup(React.createElement(ContextScrollbar, {
          settings: { showScrollbar: true, showMinimap: true }, messages: [], contextLimit: 200000,
          containerId: 'fixture', containerRef: { current: null }, timelineRef: { current: null },
          onNavigate() {}, memorySize,
        }));
      }`,
    resolveDir: root,
    loader: 'tsx',
  },
  outfile: output, bundle: true, format: 'cjs', platform: 'node', target: 'node20', logLevel: 'silent',
})
const { render } = createRequire(import.meta.url)(output)

test('memory indicator reports backend byte and token estimates with its configured threshold', () => {
  const size = { bytes: 2048, estimatedTokens: 1234, contextFraction: .2, thresholdFraction: .1, overThreshold: true }
  const warning = render(size)
  assert.match(warning, /2.0 KB/)
  assert.match(warning, /1,234 tokens/)
  assert.match(warning, /Above the 10% memory limit/)
  assert.match(warning, /data-memory-warning="true"/)
  const normal = render({ ...size, overThreshold: false })
  assert.match(normal, /2.0 KB/)
  assert.doesNotMatch(normal, /Above the/)
  assert.doesNotMatch(normal, /data-memory-warning="true"/)
  assert.doesNotMatch(render(null), /Agent memory:/)
})
