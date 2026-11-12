require('../../../scripts/test/test-process-env.cjs').initializeTestEnvironment();
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { streamReadFile, streamWriteFile } from './fileStream';

test('FIFO reads fail promptly without exhausting the filesystem thread pool', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-file-fifo-'));
  try {
    const fifo = path.join(root, 'source');
    execFileSync('mkfifo', [fifo]);
    const connection = { host: 'http://127.0.0.1:1', nodeId: 'test-node', authToken: 'test-token', signal: new AbortController().signal };
    const request = { transferId: 'fifo', filePath: fifo, agentName: 'main', restrictToAgentDir: false };
    const reads = Array.from({ length: 4 }, () => assert.rejects(streamReadFile(connection, request), /Not a file/));
    await Promise.race([
      Promise.all([...reads, fs.stat(root)]),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('FIFO read blocked filesystem work')), 3000).unref()),
    ]);
  } finally {
    await fs.remove(root);
  }
});

test('streaming transfer reports endpoint HTTP errors in both directions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-file-status-'));
  const source = path.join(root, 'source');
  await fs.writeFile(source, Buffer.alloc(128 * 1024));
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(Number(req.url!.split('/').at(-1)));
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const connection = { host: `http://127.0.0.1:${(server.address() as any).port}`, nodeId: 'test-node', authToken: 'token', signal: new AbortController().signal };
  try {
    for (const status of [404, 405, 413, 502]) {
      const request = { transferId: String(status), filePath: source, agentName: 'main', restrictToAgentDir: false };
      await assert.rejects(streamReadFile(connection, request), new RegExp(`File transfer endpoint returned HTTP ${status}`));
      await assert.rejects(
        streamWriteFile(connection, { ...request, filePath: path.join(root, `target-${status}`), overwrite: false, sizeBytes: 128 * 1024 }),
        new RegExp(`File transfer endpoint returned HTTP ${status}`),
      );
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.remove(root);
  }
});

test('response deadlines do not impose a total upload deadline', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-file-timeout-'));
  const source = path.join(root, 'source');
  await fs.writeFile(source, Buffer.alloc(128 * 1024));
  const large = path.join(root, 'large');
  const file = await fs.open(large, 'w');
  await fs.ftruncate(file, 64 * 1024 * 1024);
  await fs.close(file);
  const server = http.createServer((req, res) => {
    if (req.url === '/node/transfer/healthy') {
      req.pause();
      setTimeout(() => req.resume(), 32_000);
      req.on('end', () => res.end());
    } else if (req.url === '/node/transfer/healthy-download') {
      res.writeHead(200, { 'Content-Length': 128 * 1024 });
      res.flushHeaders();
      setTimeout(() => res.end(Buffer.alloc(128 * 1024)), 32_000);
    } else if (req.url === '/node/transfer/stalled-download') {
      res.writeHead(200, { 'Content-Length': 128 * 1024 });
      res.flushHeaders();
    } else req.resume();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const fallback = setTimeout(() => controller.abort(), 90_000);
  const connection = { host: `http://127.0.0.1:${(server.address() as any).port}`, nodeId: 'test-node', authToken: 'token', signal: controller.signal };
  try {
    const read = { transferId: 'upload', filePath: source, agentName: 'main', restrictToAgentDir: false };
    const started = Date.now();
    await Promise.all([
      assert.rejects(streamReadFile(connection, read), /endpoint did not respond within 30 seconds/),
      assert.rejects(
        streamWriteFile(connection, { ...read, transferId: 'download', filePath: path.join(root, 'target'), overwrite: false, sizeBytes: 128 * 1024 }),
        /endpoint did not respond within 30 seconds/,
      ),
      streamReadFile(connection, { ...read, transferId: 'healthy', filePath: large }),
      streamWriteFile(connection, {
        ...read, transferId: 'healthy-download', filePath: path.join(root, 'healthy-target'), overwrite: false, sizeBytes: 128 * 1024,
      }),
      assert.rejects(
        streamWriteFile(connection, { ...read, transferId: 'stalled-download', filePath: path.join(root, 'stalled-target'), overwrite: false, sizeBytes: 128 * 1024 }),
        (error: Error) => error.name !== 'AbortError',
      ),
    ]);
    assert(Date.now() - started >= 59_000);
    assert.deepEqual((await fs.readdir(root)).sort(), ['healthy-target', 'large', 'source']);
  } finally {
    clearTimeout(fallback);
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.remove(root);
  }
});

test('streaming file transfer uses authenticated HTTP, exact lengths and atomic publication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-file-stream-'));
  const length = 101 * 1024 * 1024 + 17;
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  const handle = await fs.open(source, 'w');
  await fs.ftruncate(handle, length);
  await fs.close(handle);
  const expected = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(source)) expected.update(chunk as Buffer);
  const digest = expected.digest('hex');
  let uploadCount = 0;
  let receivedHash = '';
  let slowStarted!: () => void;
  const slowReady = new Promise<void>(resolve => { slowStarted = resolve; });
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers['x-foxwarm-node'], 'test-node');
    assert.equal(req.headers.authorization, 'Bearer test-token');
    if (req.method === 'PUT' && req.url === '/base/node/transfer/boundary') {
      assert.equal(req.headers['content-length'], '65536');
      for await (const _chunk of req) { /* drain */ }
      res.end();
    } else if (req.method === 'PUT') {
      assert.equal(req.url, '/base/node/transfer/upload');
      assert.equal(req.headers['content-length'], String(length));
      const hash = crypto.createHash('sha256');
      for await (const chunk of req) { uploadCount += chunk.length; hash.update(chunk); }
      receivedHash = hash.digest('hex');
      res.end();
    } else if (req.url === '/base/node/transfer/slow') {
      res.writeHead(200, { 'Content-Length': length });
      res.write(Buffer.alloc(1024));
      slowStarted();
    } else if (req.url === '/base/node/transfer/broken') {
      res.writeHead(200, { 'Content-Length': length });
      res.write(Buffer.alloc(1024));
      res.destroy();
    } else {
      assert.equal(req.url, '/base/node/transfer/download');
      res.writeHead(200, { 'Content-Length': length });
      fs.createReadStream(source).pipe(res);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const controller = new AbortController();
  const connection = { host: `http://127.0.0.1:${port}/base`, nodeId: 'test-node', authToken: 'test-token', signal: controller.signal };
  const request = { transferId: 'upload', filePath: source, agentName: 'main', restrictToAgentDir: false };
  try {
    assert.equal(await streamReadFile(connection, request), undefined);
    assert.equal(uploadCount, length);
    assert.equal(receivedHash, digest);
    const result = await streamWriteFile(connection, { ...request, transferId: 'download', filePath: target, overwrite: false, sizeBytes: length });
    assert.equal(result.sha256, digest);
    assert.equal((await fs.stat(target)).size, length);
    await assert.rejects(streamWriteFile(connection, { ...request, transferId: 'download', filePath: target, overwrite: false, sizeBytes: length }), /already exists/);
    await assert.rejects(streamWriteFile(connection, { ...request, transferId: 'broken', filePath: target, overwrite: true, sizeBytes: length }));
    assert.equal((await fs.stat(target)).size, length);
    const cancelling = new AbortController();
    const pending = streamWriteFile({ ...connection, signal: cancelling.signal }, { ...request, transferId: 'slow', filePath: target, overwrite: true, sizeBytes: length });
    await slowReady;
    cancelling.abort();
    await assert.rejects(pending);
    assert.equal((await fs.stat(target)).size, length);
    assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'target']);
    const small = path.join(root, 'small');
    await fs.writeFile(small, Buffer.alloc(65535, 42));
    const inline = await streamReadFile(connection, { ...request, filePath: small });
    assert.equal(inline?.sizeBytes, 65535);
    await fs.writeFile(small, Buffer.alloc(65536));
    // At the boundary the Node starts HTTP rather than returning a JSON payload.
    assert.equal(await streamReadFile(connection, { ...request, filePath: small, transferId: 'boundary' }), undefined);
  } finally {
    controller.abort();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.remove(root);
  }
});

test('small streamed reads resolve a relative path against the Session cwd when the frame supplies one', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-file-cwd-'));
  try {
    await fs.writeFile(path.join(root, 'in.txt'), 'from cwd');
    const connection = { host: 'http://127.0.0.1:1', nodeId: 'test-node', authToken: 'test-token', signal: new AbortController().signal };
    const base = { transferId: 'cwd', filePath: 'in.txt', agentName: 'main', restrictToAgentDir: false };
    const file = await streamReadFile(connection, { ...base, sessionCwd: root });
    assert.equal(Buffer.from(file!.dataBase64, 'base64').toString(), 'from cwd');
    await assert.rejects(streamReadFile(connection, base), /ENOENT|no such file/i);
  } finally {
    await fs.remove(root);
  }
});
