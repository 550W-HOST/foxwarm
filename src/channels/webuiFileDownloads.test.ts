import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { registerWebUiFileDownloads } from './webuiFileDownloads';

test('file downloads retain authentication, support bounded raster previews, original names, HEAD, and safe missing-file errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-delivery-download-'));
  await fs.writeFile(path.join(dir, 'cached.png'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(dir, 'active.svg'), '<svg/>');
  const app = express();
  registerWebUiFileDownloads({ addRoute(route: any) { app.get(route.path, route.handler); } } as any, req => req.headers['x-test-auth'] === 'ok');
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/download?`;
  const params = (name: string, extra: Record<string, string> = {}) => new URLSearchParams({ path: path.join(dir, name), ...extra });
  try {
    assert.equal((await fetch(url + params('cached.png', { preview: '1' }))).status, 401);
    const headers = { 'x-test-auth': 'ok' };
    const preview = await fetch(url + params('cached.png', { preview: '1' }), { headers });
    assert.equal(preview.headers.get('content-type'), 'image/png'); assert.match(preview.headers.get('content-disposition')!, /^inline/);
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff'); await preview.arrayBuffer();
    const download = await fetch(url + params('cached.png', { filename: 'original.png' }), { headers });
    assert.match(download.headers.get('content-disposition')!, /attachment; filename="original.png"/); await download.arrayBuffer();
    const head = await fetch(url + params('cached.png'), { headers, method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), '3'); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const unsafe = await fetch(url + params('active.svg', { preview: '1', filename: 'pretend.png' }), { headers });
    assert.equal(unsafe.headers.get('content-type'), 'application/octet-stream'); assert.match(unsafe.headers.get('content-disposition')!, /^attachment/); await unsafe.arrayBuffer();
    assert.equal((await fetch(url + params('missing.pdf'), { headers })).status, 404);
    assert.equal((await fetch(url + new URLSearchParams({ path: 'relative' }), { headers })).status, 400);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.remove(dir); }
});
