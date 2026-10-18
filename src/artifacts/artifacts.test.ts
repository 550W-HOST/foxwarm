import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateArtifactDocument } from '../../packages/shared/dist/artifacts/registry';
import { parseArtifactReceipt } from '../../packages/shared/dist/artifacts/types';
import { ArtifactStore } from './store';
import { prepareArtifact } from './prepare';
const example = (name: string) => fs.readFile(path.resolve(`skills/${name === 'chart' ? 'data-visualization/examples/training-metrics' : 'react-artifacts/examples/sorting'}.json`), 'utf8').then(JSON.parse);
test('bundled skills publish valid manifests; chart rejects executable/resource-bearing specifications', async () => {
  const chart = await example('chart'); assert.equal(validateArtifactDocument(chart).type, 'chart');
  for (const bad of [{ ...chart, data: { url: 'https://invalid' } }, { ...chart, spec: { ...chart.spec, transform: [{ calculate: 'alert(1)' }] } }, { ...chart, spec: { mark: { type: 'line', color: 'url(https://invalid)' } } }, { ...chart, spec: { mark: 'line', encoding: { color: { value: 'url(https://invalid)' } } } }, { ...chart, schemaVersion: 2 }]) assert.throws(() => validateArtifactDocument(bad));
  assert.throws(() => validateArtifactDocument({ ...chart, spec: { mark: 'image' } }));
  assert.throws(() => validateArtifactDocument({ ...chart, data: [{ constructor: 1 }] }));
  assert.throws(() => validateArtifactDocument({ ...chart, controls: { smoothing: { field: 'success', as: 'success', window: 1 } } }));
  assert.equal(parseArtifactReceipt({ protocolVersion: 1, artifactId: '../../secret' }), undefined);
});
test('immutable snapshots, ownership, optimistic revision conflicts and atomic concurrent updates', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-artifact-'));
  try {
    const store = new ArtifactStore(root, async () => ({})), doc = await example('chart');
    const first = await store.publish('alpha', doc); doc.title = 'Changed';
    assert.equal((await store.read(first.receipt.artifactId, 1, 'alpha')).document.title, 'Training success rate');
    await assert.rejects(store.read(first.receipt.artifactId, 1, 'beta'));
    await assert.rejects(store.publish('beta', doc, first.receipt.artifactId, 1));
    const outcomes = await Promise.allSettled([store.publish('alpha', doc, first.receipt.artifactId, 1), store.publish('alpha', doc, first.receipt.artifactId, 1)]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await store.read(first.receipt.artifactId, 2, 'alpha')).document.title, 'Changed');
    assert.equal((await store.read(first.receipt.artifactId, 1, 'alpha')).document.title, 'Training success rate');
    await assert.rejects(store.read('../escape', 1, 'alpha'));
    assert.equal((await fs.readdir(path.join(root, first.receipt.artifactId))).length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('React compilation accepts local source and fixed runtime, rejects Node/network imports without executing source', async () => {
  const doc = await example('react');
  const compiled = await prepareArtifact(validateArtifactDocument(doc));
  assert.ok(compiled.compiled.includes('Insertion sort')); assert.ok(compiled.compiled.length > 10000);
  for (const specifier of ['node:fs', 'https://invalid.test/pkg.js', '../../secrets', 'child_process']) {
    await assert.rejects(prepareArtifact(validateArtifactDocument({ ...doc, files: { 'App.tsx': `import x from '${specifier}'; export default function App(){return x}` } })), /Import not allowed|Source file not found/);
  }
  assert.throws(() => validateArtifactDocument({ ...doc, files: { '../App.tsx': 'export default ()=>null' } }));
});

test('artifact HTTP reads recheck identity scope and original owner; IDs grant no access', async () => {
  const express = (await import('express')).default;
  const { registerArtifactRoutes } = await import('./routes');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-artifact-http-'));
  const store = new ArtifactStore(root);
  const record = await store.publish('alpha', await example('chart'));
  const sharp = (await import('sharp')).default;
  const { describeImage } = await import('./image');
  const imageBytes = await sharp({ create: { width: 24, height: 18, channels: 3, background: '#397eee' } }).png().toBuffer();
  const image = await store.publish('alpha', await describeImage(imageBytes, 'Figure'), undefined, undefined, { image: imageBytes });
  const app = express();
  registerArtifactRoutes({ app }, async (req, res, sessionId) => {
    if (req.headers.authorization !== 'Bearer synthetic') { res.sendStatus(401); return false; }
    if (sessionId !== 'alpha' && sessionId !== 'beta') { res.sendStatus(403); return false; }
    return true;
  }, store);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/sessions/`;
  const suffix = `/artifacts/${record.receipt.artifactId}/1`;
  try {
    assert.equal((await fetch(base + 'alpha' + suffix)).status, 401);
    assert.equal((await fetch(base + 'outside' + suffix, { headers: { Authorization: 'Bearer synthetic' } })).status, 403);
    assert.equal((await fetch(base + 'beta' + suffix, { headers: { Authorization: 'Bearer synthetic' } })).status, 404);
    const response = await fetch(base + 'alpha' + suffix, { headers: { Authorization: 'Bearer synthetic' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.json() as any).receipt.revision, 1);
    const imageSuffix = `/artifacts/${image.receipt.artifactId}/1/resources/image`;
    assert.equal((await fetch(base + 'alpha' + imageSuffix)).status, 401);
    assert.equal((await fetch(base + 'outside' + imageSuffix, { headers: { Authorization: 'Bearer synthetic' } })).status, 403);
    assert.equal((await fetch(base + 'beta' + imageSuffix, { headers: { Authorization: 'Bearer synthetic' } })).status, 404);
    const imageResponse = await fetch(base + 'alpha' + imageSuffix, { headers: { Authorization: 'Bearer synthetic' } });
    assert.equal(imageResponse.status, 200); assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.equal(imageResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageBytes);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(root, { recursive: true, force: true }); }
});

test('image resources are immutable, independently authorized and never executable formats', async () => {
  const sharp = (await import('sharp')).default;
  const { describeImage } = await import('./image');
  const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#397eee' } }).png().toBuffer();
  const doc = await describeImage(bytes, 'Diagram', 'A blue test image');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fw-image-artifact-'));
  try {
    const store = new ArtifactStore(root);
    const record = await store.publish('alpha', doc, undefined, undefined, { image: bytes });
    assert.deepEqual((await store.resource(record.receipt.artifactId, 1, 'alpha', 'image')).bytes, bytes);
    assert.equal(record.resources.image.mimeType, 'image/png');
    const bytes2 = await sharp({ create: { width: 50, height: 20, channels: 3, background: '#e55c25' } }).png().toBuffer();
    await store.publish('alpha', await describeImage(bytes2, 'Revised diagram'), record.receipt.artifactId, 1, { image: bytes2 });
    assert.deepEqual((await store.resource(record.receipt.artifactId, 1, 'alpha', 'image')).bytes, bytes);
    assert.deepEqual((await store.resource(record.receipt.artifactId, 2, 'alpha', 'image')).bytes, bytes2);
    assert.equal(JSON.stringify(record).includes(bytes.toString('base64')), false, 'metadata does not contain binary payloads');
    await assert.rejects(store.resource(record.receipt.artifactId, 1, 'beta', 'image'));
    await assert.rejects(store.resource(record.receipt.artifactId, 1, 'alpha', '../image'));
    await assert.rejects(store.publish('alpha', { ...doc, width: 99 }, undefined, undefined, { image: bytes }), /metadata/);
    await assert.rejects(describeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'unsafe'), /Only PNG/);
    await assert.rejects(store.publish('alpha', doc), /raster file/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
