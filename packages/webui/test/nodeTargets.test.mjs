import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const sourcePath = new URL('../src/nodeTargets.ts', import.meta.url).pathname
const bundle = await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
const { parseWebUiNodeTargets, getNodeTargetAvailability, formatNodeTargetLabel } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)

test('connected protocol-incompatible Nodes remain visible but unavailable to launch surfaces', () => {
  const nodes = parseWebUiNodeTargets({ nodes: [{
    id: 'old-node', type: 'cli-node', displayName: 'Old Node', online: true,
    services: { 'vscode-fs': 1, 'vscode-pty': 1 },
    protocolCompatibility: {
      status: 'upgrade-required', client: { min: 3, max: 3 }, master: { min: 1, max: 2 }, legacyClient: false,
    },
  }] })
  const oldNode = nodes.find(node => node.id === 'old-node')
  assert.ok(oldNode)
  assert.equal(oldNode.online, true)
  assert.equal(oldNode.protocolStatus, 'upgrade-required')
  assert.deepEqual(getNodeTargetAvailability(oldNode, 'vscode-fs'), { available: false, reason: 'upgrade required' })
  assert.match(formatNodeTargetLabel(oldNode, 'vscode-pty'), /Old Node \(old-node\) · upgrade required/)
})

test('negotiated legacy v1 remains a ready launch target', () => {
  const node = parseWebUiNodeTargets({ nodes: [{
    id: 'legacy-ready', online: true, services: { 'vscode-fs': 1, 'vscode-pty': 1 },
    protocolCompatibility: {
      status: 'compatible', client: { min: 1, max: 1 }, master: { min: 1, max: 2 }, legacyClient: true, negotiated: 1,
    },
  }] }).find(item => item.id === 'legacy-ready')
  assert.ok(node)
  assert.equal(node.protocolStatus, 'compatible')
  assert.deepEqual(getNodeTargetAvailability(node, 'vscode-fs'), { available: true })
  assert.match(formatNodeTargetLabel(node, 'vscode-pty'), /legacy-ready · online/)
})

test('offline incompatible status remains distinct from connected quarantine', () => {
  const node = parseWebUiNodeTargets({ nodes: [{
    id: 'offline-old', online: false, services: {},
    protocolCompatibility: { status: 'upgrade-required', client: { min: 3, max: 3 }, master: { min: 1, max: 2 } },
  }] }).find(item => item.id === 'offline-old')
  assert.ok(node)
  assert.deepEqual(getNodeTargetAvailability(node, 'vscode-fs'), { available: false, reason: 'offline · upgrade required' })
})