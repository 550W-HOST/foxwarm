import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as esbuild from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webuiRoot = path.resolve(__dirname, '..')
const tempDir = await mkdtemp(path.join(tmpdir(), 'foxwarm-mermaid-policy-test-'))
const bundlePath = path.join(tempDir, 'mermaidPolicy.mjs')

await esbuild.build({
  entryPoints: [path.join(webuiRoot, 'src/components/mermaidPolicy.ts')],
  outfile: bundlePath,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
})

const { getMermaidSourcePolicyError } = await import(pathToFileURL(bundlePath).href)

test('quote-aware metadata scanning rejects resource keys after quoted braces', () => {
  for (const resource of ['https://example.invalid/brace-bypass.png', '/reviewer-bypass.png']) {
    const source = `flowchart TD\n A@{ label: "}", img: "${resource}", pos: "t", h: 60 }`
    assert.match(getMermaidSourcePolicyError(source), /image and link resources are disabled/i)
  }
})

test('metadata scanning recognizes quoted resource keys without matching label text', () => {
  for (const key of ['"img"', "'link'", '"\\u0068ref"']) {
    assert.match(
      getMermaidSourcePolicyError(`flowchart TD\nA@{ label: "safe", ${key}: "/resource" }`),
      /image and link resources are disabled/i,
    )
  }

  assert.equal(getMermaidSourcePolicyError('flowchart TD\nA@{ label: "img: is text, and } is safe", shape: "rect" }'), null)
})

test('directive boundaries do not reject legal node IDs or label url text', () => {
  for (const source of [
    'flowchart LR\nclick[Click guide] --> B',
    'flowchart LR\nhref[Href guide] --> B',
    'sequenceDiagram\nA->>B: Call url(foo) safely',
    'flowchart LR\nstyle[Style guide] --> B',
  ]) {
    assert.equal(getMermaidSourcePolicyError(source), null)
  }
})

test('actual resource, interaction, configuration, and styling directives stay rejected', () => {
  const rejected = [
    ['flowchart LR\nclick A href "https://example.invalid"', /Interactive Mermaid links/],
    ['flowchart LR\nA-->B; href A "https://example.invalid"', /Interactive Mermaid links/],
    ['flowchart LR\nstyle A fill:#fff', /styling directives/],
    ['flowchart LR\nclassDef custom fill:#fff', /styling directives/],
    ['flowchart LR\nlinkStyle 0 stroke:#fff', /styling directives/],
    ['%%{init: {"theme":"dark"}}%%\nflowchart LR\nA-->B', /configuration directives/],
    ['---\nconfig:\n  theme: dark\n---\nflowchart LR\nA-->B', /frontmatter/],
  ]

  for (const [source, expected] of rejected) assert.match(getMermaidSourcePolicyError(source), expected)
})
