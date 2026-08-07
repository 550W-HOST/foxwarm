import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ChannelFile } from '../channel';
import { uploadQQBotFile } from './qqbotMediaUpload';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PART_HOST = 'https://cos.ap-guangzhou.myqcloud.com';

type RequestRecord = { path: string; body: Record<string, unknown> };

async function withTempFile(data: Buffer, name: string, callback: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-qqbot-upload-test-'));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, data);
  try {
    await callback(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function channelFile(filePath: string, name: string, mimeType: string, isImage: boolean): ChannelFile {
  return { path: filePath, name, mimeType, isImage, sizeBytes: 0 };
}

function createMockTransport(blockSize: number, parts: number) {
  const requests: RequestRecord[] = [];
  const puts: Array<{ url: string; body: Buffer; init: RequestInit }> = [];
  const request = async (requestPath: string, body: Record<string, unknown>): Promise<unknown> => {
    requests.push({ path: requestPath, body });
    if (requestPath.endsWith('/upload_prepare')) {
      return {
        upload_id: 'upload-id-1',
        block_size: blockSize,
        parts: Array.from({ length: parts }, (_, index) => ({
          index: index + 1,
          block_size: index === parts - 1 ? blockSize : blockSize,
          presigned_url: `${PART_HOST}/part/${index + 1}?signature=opaque`,
        })),
      };
    }
    if (requestPath.endsWith('/files')) return { file_info: 'opaque-file-info' };
    return {};
  };
  const fetchFn = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const body = init?.body instanceof ReadableStream
      ? Buffer.from(await new Response(init.body).arrayBuffer())
      : Buffer.from(String(init?.body || ''));
    puts.push({ url: String(url), body, init: init || {} });
    return new Response(null, { status: 200 });
  };
  return { request, fetchFn, requests, puts };
}

test('QQ outbound uploader sends C2C PNG through streamed chunk flow with hashes and file_info', async () => {
  const data = Buffer.concat([PNG_HEADER, Buffer.from('png-payload-123')]);
  await withTempFile(data, 'photo.png', async filePath => {
    const transport = createMockTransport(8, 3);
    const result = await uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'photo.png', 'image/png', true), undefined, {
      request: transport.request,
      fetch: transport.fetchFn,
    });

    assert.deepEqual(result, { fileInfo: 'opaque-file-info', fileType: 1, sizeBytes: data.length, isImage: true });
    assert.equal(transport.requests[0].path, '/v2/users/user-openid/upload_prepare');
    assert.equal(transport.requests.at(-1)?.path, '/v2/users/user-openid/files');
    assert.deepEqual(transport.requests.slice(1, -1).map(item => item.path), [
      '/v2/users/user-openid/upload_part_finish',
      '/v2/users/user-openid/upload_part_finish',
      '/v2/users/user-openid/upload_part_finish',
    ]);
    assert.deepEqual(transport.puts.map(item => item.body), [data.subarray(0, 8), data.subarray(8, 16), data.subarray(16)]);
    assert.ok(transport.puts.every(item => item.init.method === 'PUT'));
    assert.ok(transport.puts.every(item => item.init.redirect === 'error'));
    assert.ok(transport.puts.every(item => !(item.init.headers as Record<string, string>).Authorization));
    const prepare = transport.requests[0].body;
    assert.equal(prepare.file_type, 1);
    assert.equal(prepare.file_size, data.length);
    assert.equal(prepare.md5, crypto.createHash('md5').update(data).digest('hex'));
    assert.equal(prepare.sha1, crypto.createHash('sha1').update(data).digest('hex'));
    assert.equal(transport.requests[1].body.md5, crypto.createHash('md5').update(data.subarray(0, 8)).digest('hex'));
    assert.equal(transport.requests[1].body.block_size, 8);
  });
});

test('QQ outbound uploader uses destination-specific Group routes and generic file type', async () => {
  const data = Buffer.from('generic-file-payload');
  await withTempFile(data, 'report.txt', async filePath => {
    const transport = createMockTransport(64, 1);
    const result = await uploadQQBotFile('group', 'group-openid', channelFile(filePath, 'report.txt', 'text/plain', false), undefined, {
      request: transport.request,
      fetch: transport.fetchFn,
    });
    assert.equal(result.fileType, 4);
    assert.equal(result.isImage, false);
    assert.equal(transport.requests[0].path, '/v2/groups/group-openid/upload_prepare');
    assert.equal(transport.requests.at(-1)?.path, '/v2/groups/group-openid/files');
    assert.equal(transport.requests[1].path, '/v2/groups/group-openid/upload_part_finish');
    assert.equal(transport.requests[1].body.part_index, 1);
  });
});

test('QQ outbound uploader downgrades oversized raster images to generic files within file cap', async () => {
  const data = Buffer.concat([PNG_HEADER, Buffer.alloc(20, 7)]);
  await withTempFile(data, 'large.png', async filePath => {
    const transport = createMockTransport(128, 1);
    const result = await uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'large.png', 'image/png', true), {
      imageMaxBytes: data.length - 1,
      fileMaxBytes: data.length,
    }, { request: transport.request, fetch: transport.fetchFn });
    assert.equal(result.fileType, 4);
    assert.equal(result.isImage, false);
    assert.equal(transport.requests[0].body.file_type, 4);
  });
});

test('QQ outbound uploader rejects over-cap files before upload_prepare', async () => {
  const data = Buffer.from('too-large');
  await withTempFile(data, 'too-large.bin', async filePath => {
    const transport = createMockTransport(64, 1);
    await assert.rejects(
      uploadQQBotFile('group', 'group-openid', channelFile(filePath, 'too-large.bin', 'application/octet-stream', false), {
        fileMaxBytes: data.length - 1,
      }, transport),
      /configured media limit/,
    );
    assert.equal(transport.requests.length, 0);
    assert.equal(transport.puts.length, 0);
  });
});

test('QQ outbound uploader rejects untrusted presigned hosts and never performs a PUT', async () => {
  const data = Buffer.from('payload');
  await withTempFile(data, 'payload.bin', async filePath => {
    const transport = createMockTransport(64, 1);
    const request = async (requestPath: string, body: Record<string, unknown>): Promise<unknown> => {
      if (requestPath.endsWith('/upload_prepare')) {
        return { upload_id: 'id', block_size: 64, parts: [{ index: 1, presigned_url: 'https://evil.example/part' }] };
      }
      return transport.request(requestPath, body);
    };
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'payload.bin', 'application/octet-stream', false), undefined, {
        request,
        fetch: transport.fetchFn,
      }),
      /untrusted part URL/,
    );
    assert.equal(transport.puts.length, 0);
  });
});

test('QQ outbound uploader rejects malformed or incomplete prepare parts before any PUT', async () => {
  const data = Buffer.from('payload');
  await withTempFile(data, 'payload.bin', async filePath => {
    const transport = createMockTransport(64, 1);
    const request = async (requestPath: string, body: Record<string, unknown>): Promise<unknown> => {
      if (requestPath.endsWith('/upload_prepare')) {
        return {
          upload_id: 'id',
          block_size: 2,
          parts: [{ index: 2, presigned_url: `${PART_HOST}/part/2` }],
        };
      }
      return transport.request(requestPath, body);
    };
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'payload.bin', 'application/octet-stream', false), undefined, {
        request,
        fetch: transport.fetchFn,
      }),
      /incomplete part list/,
    );
    assert.equal(transport.puts.length, 0);
  });
});

test('QQ outbound uploader does not use fs.readFile or whole-file base64 for part bodies', async () => {
  const data = Buffer.concat([PNG_HEADER, Buffer.alloc(80, 1)]);
  const originalReadFile = fs.readFile;
  (fs as any).readFile = async () => { throw new Error('whole-file readFile must not be used'); };
  try {
    await withTempFile(data, 'stream.png', async filePath => {
      const transport = createMockTransport(32, 3);
      await uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'stream.png', 'image/png', true), undefined, {
        request: transport.request,
        fetch: transport.fetchFn,
      });
      assert.equal(transport.puts.reduce((sum, item) => sum + item.body.length, 0), data.length);
    });
  } finally {
    (fs as any).readFile = originalReadFile;
  }
});
