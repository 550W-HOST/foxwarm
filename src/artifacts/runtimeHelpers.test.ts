import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { validateArtifactDocument } from '../../packages/shared/dist/artifacts/registry';
import { parseArtifactReceipt } from '../../packages/shared/dist/artifacts/types';
import { compileReact } from './reactCompiler';
import { describeImage } from './rasterMetadata';

const example = (name: string) => fs.readFile(path.resolve(`skills/${name === 'chart' ? 'data-visualization/examples/training-metrics' : 'react-artifacts/examples/sorting'}.json`), 'utf8').then(JSON.parse);

test('bundled skills publish valid manifests; chart rejects executable/resource-bearing specifications', async () => {
  const chart = await example('chart'); assert.equal(validateArtifactDocument(chart).type, 'chart');
  for (const bad of [{ ...chart, data: { url: 'https://invalid' } }, { ...chart, spec: { ...chart.spec, transform: [{ calculate: 'alert(1)' }] } }, { ...chart, spec: { mark: { type: 'line', color: 'url(https://invalid)' } } }, { ...chart, spec: { mark: 'line', encoding: { color: { value: 'url(https://invalid)' } } } }, { ...chart, schemaVersion: 2 }]) assert.throws(() => validateArtifactDocument(bad));
  assert.throws(() => validateArtifactDocument({ ...chart, spec: { mark: 'image' } }));
  assert.throws(() => validateArtifactDocument({ ...chart, data: [{ constructor: 1 }] }));
  assert.throws(() => validateArtifactDocument({ ...chart, controls: { smoothing: { field: 'success', as: 'success', window: 1 } } }));
  assert.equal(parseArtifactReceipt({ protocolVersion: 1, artifactId: '../../secret' }), undefined);
});

test('React compilation accepts local source and fixed runtime, rejects Node/network imports without executing source', async () => {
  const doc = await example('react');
  const compiled = await compileReact(doc, path.resolve('packages/webui/node_modules'));
  assert.ok(compiled.includes('Insertion sort')); assert.ok(compiled.length > 10000);
  for (const specifier of ['node:fs', 'https://invalid.test/pkg.js', '../../secrets', 'child_process']) {
    await assert.rejects(compileReact({ ...doc, files: { 'App.tsx': `import x from '${specifier}'; export default function App(){return x}` } }, path.resolve('packages/webui/node_modules')), /Import not allowed|Source file not found/);
  }
  assert.throws(() => validateArtifactDocument({ ...doc, files: { '../App.tsx': 'export default ()=>null' } }));
});

test('raster metadata describes supported bytes and rejects executable formats', async () => {
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#397eee' } }).png().toBuffer();
  const doc = await describeImage(bytes, 'Diagram', 'A blue test image');
  assert.equal(doc.mimeType, 'image/png');
  assert.equal(doc.width, 40);
  assert.equal(doc.height, 30);
  assert.equal(doc.alt, 'A blue test image');
  await assert.rejects(describeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'unsafe'), /Only PNG/);
});
