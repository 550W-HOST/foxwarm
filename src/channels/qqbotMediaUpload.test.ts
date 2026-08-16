import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import type { ChannelFile } from '../channel';
import { QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, uploadQQBotFile } from './qqbotMediaUpload';

const PART_HOST = 'https://cos.ap-guangzhou.myqcloud.com';

async function validPng(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

async function validJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 30, g: 20, b: 10 } } }).jpeg().toBuffer();
}

async function validGif(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } }).gif().toBuffer();
}

async function validWebp(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 40, g: 30, b: 20, alpha: 1 } } }).webp().toBuffer();
}

function validBmp(): Buffer {
  const data = Buffer.alloc(58);
  data.write('BM', 0, 'ascii');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(1, 18);
  data.writeInt32LE(1, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(4, 34);
  data.set([30, 20, 10, 0], 54);
  return data;
}

function pixelTruncatedBmp(): Buffer {
  const data = Buffer.alloc(55);
  data.write('BM', 0, 'ascii');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(1_000, 18);
  data.writeInt32LE(1_000, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(0, 30);
  return data;
}

function paletteLessIndexedBmp(): Buffer {
  const data = Buffer.alloc(58);
  data.write('BM', 0, 'ascii');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(1, 18);
  data.writeInt32LE(1, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(1, 28);
  data.writeUInt32LE(0, 30);
  data.writeUInt32LE(4, 34);
  return data;
}

function invalidCore32Bmp(): Buffer {
  const data = Buffer.alloc(30);
  data.write('BM', 0, 'ascii');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(26, 10);
  data.writeUInt32LE(12, 14);
  data.writeUInt16LE(1, 18);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt16LE(32, 24);
  return data;
}

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

test('QQ outbound uploader sends tiny C2C PNG directly with bounded base64 body', async () => {
  const data = await validPng();
  await withTempFile(data, 'photo.png', async filePath => {
    const transport = createMockTransport(64, 1);
    const result = await uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'photo.bin', 'application/octet-stream', false), undefined, {
      request: transport.request,
      fetch: transport.fetchFn,
    });

    assert.deepEqual(result, { fileInfo: 'opaque-file-info', fileType: 1, sizeBytes: data.length, isImage: true });
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].path, '/v2/users/user-openid/files');
    assert.equal(transport.requests[0].body.file_type, 1);
    assert.equal(transport.requests[0].body.srv_send_msg, false);
    assert.equal(transport.requests[0].body.file_data, data.toString('base64'));
    assert.equal(transport.requests[0].body.file_name, undefined);
    assert.equal(transport.puts.length, 0);
  });
});

test('QQ outbound uploader sends tiny JPEG and generic Group files directly', async () => {
  const jpeg = await validJpeg();
  await withTempFile(jpeg, 'photo.jpg', async jpegPath => {
    const transport = createMockTransport(64, 1);
    const result = await uploadQQBotFile('c2c', 'user-openid', channelFile(jpegPath, 'photo.jpg', 'image/jpeg', false), undefined, {
      request: transport.request,
      fetch: transport.fetchFn,
    });
    assert.equal(result.fileType, 1);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].path, '/v2/users/user-openid/files');
    assert.equal(transport.requests[0].body.file_data, jpeg.toString('base64'));
    assert.equal(transport.puts.length, 0);
  });

  const data = Buffer.from('generic-file-payload');
  await withTempFile(data, 'report.txt', async filePath => {
    const transport = createMockTransport(64, 1);
    const result = await uploadQQBotFile('group', 'group-openid', channelFile(filePath, 'report.txt', 'text/plain', false), undefined, {
      request: transport.request,
      fetch: transport.fetchFn,
    });
    assert.equal(result.fileType, 4);
    assert.equal(result.isImage, false);
    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].path, '/v2/groups/group-openid/files');
    assert.equal(transport.requests[0].body.file_type, 4);
    assert.equal(transport.requests[0].body.srv_send_msg, false);
    assert.equal(transport.requests[0].body.file_name, 'report.txt');
    assert.equal(transport.requests[0].body.file_data, data.toString('base64'));
    assert.equal(transport.puts.length, 0);
  });
});

test('QQ outbound uploader sends byte-probed GIF, WebP, and BMP through the direct image flow', async () => {
  const fixtures = [
    ['image.gif', await validGif()],
    ['image.webp', await validWebp()],
    ['image.bmp', validBmp()],
  ] as const;
  for (const [name, data] of fixtures) {
    await withTempFile(data, name, async filePath => {
      const transport = createMockTransport(64, 1);
      const result = await uploadQQBotFile(
        'group',
        'group-openid',
        channelFile(filePath, `mislabeled-${name}.bin`, 'application/octet-stream', false),
        undefined,
        { request: transport.request, fetch: transport.fetchFn },
      );
      assert.deepEqual(result, { fileInfo: 'opaque-file-info', fileType: 1, sizeBytes: data.length, isImage: true });
      assert.equal(transport.requests.length, 1);
      assert.equal(transport.requests[0].path, '/v2/groups/group-openid/files');
      assert.deepEqual(transport.requests[0].body, {
        file_type: 1,
        srv_send_msg: false,
        file_data: data.toString('base64'),
      });
      assert.equal(transport.puts.length, 0);
    });
  }
});

test('QQ outbound uploader keeps mislabeled non-image bytes generic', async () => {
  for (const [name, data] of [
    ['fake.gif', Buffer.from('not an image despite every caller hint')],
    ['pixel-truncated.bmp', pixelTruncatedBmp()],
    ['palette-less-indexed.bmp', paletteLessIndexedBmp()],
    ['invalid-core-32.bmp', invalidCore32Bmp()],
  ] as const) {
    await withTempFile(data, name, async filePath => {
      const transport = createMockTransport(64, 1);
      const result = await uploadQQBotFile(
        'c2c',
        'user-openid',
        channelFile(filePath, name, `image/${path.extname(name).slice(1)}`, true),
        undefined,
        { request: transport.request, fetch: transport.fetchFn },
      );
      assert.equal(result.fileType, 4);
      assert.equal(result.isImage, false);
      assert.deepEqual(transport.requests[0].body, {
        file_type: 4,
        srv_send_msg: false,
        file_data: data.toString('base64'),
        file_name: name,
      });
    });
  }
});

test('QQ outbound uploader streams a byte-probed WebP through the chunked image flow unchanged', async () => {
  const webp = await validWebp();
  const data = Buffer.concat([
    webp,
    Buffer.alloc(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES - webp.length, 0),
  ]);
  await withTempFile(data, 'large.webp', async filePath => {
    const transport = createMockTransport(data.length, 1);
    const result = await uploadQQBotFile(
      'group',
      'group-openid',
      channelFile(filePath, 'large.webp', 'application/octet-stream', false),
      undefined,
      { request: transport.request, fetch: transport.fetchFn },
    );
    assert.equal(result.fileType, 1);
    assert.equal(result.isImage, true);
    assert.equal(transport.requests[0].path, '/v2/groups/group-openid/upload_prepare');
    assert.equal(transport.requests[0].body.file_type, 1);
    assert.equal(transport.requests[0].body.file_size, data.length);
    assert.equal(transport.requests[0].body.file_name, 'large.webp');
    assert.deepEqual(transport.requests.at(-1), {
      path: '/v2/groups/group-openid/files',
      body: { upload_id: 'upload-id-1' },
    });
    assert.equal(transport.puts.length, 1);
    assert.deepEqual(transport.puts[0].body, data);
  });
});

test('QQ outbound uploader keeps the exact 5 MiB boundary and larger files on streamed chunk flow', async () => {
  const threshold = QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES;
  for (const [size, name] of [[threshold, 'exact.bin'], [threshold + 1, 'larger.bin']] as const) {
    const data = Buffer.alloc(size, 7);
    await withTempFile(data, name, async filePath => {
      const transport = createMockTransport(threshold + 1, 1);
      const result = await uploadQQBotFile('group', 'group-openid', channelFile(filePath, name, 'application/octet-stream', false), undefined, {
        request: transport.request,
        fetch: transport.fetchFn,
      });
      assert.equal(result.fileType, 4);
      assert.equal(transport.requests[0].path, '/v2/groups/group-openid/upload_prepare');
      assert.equal(transport.requests.at(-1)?.path, '/v2/groups/group-openid/files');
      assert.equal(transport.requests.filter(item => item.path.endsWith('/upload_part_finish')).length, 1);
      assert.equal(transport.puts.length, 1);
      assert.equal(transport.puts[0].body.length, size);
    });
  }
});

test('QQ outbound direct upload requires a bounded opaque file_info and honors generation fences', async () => {
  const data = Buffer.from('tiny-direct-file');
  await withTempFile(data, 'direct.bin', async filePath => {
    const transport = createMockTransport(64, 1);
    const request = async (requestPath: string, body: Record<string, unknown>, maxResponseBytes?: number): Promise<unknown> => {
      assert.equal(requestPath, '/v2/users/user-openid/files');
      assert.equal(maxResponseBytes, 4 * 1024 * 1024);
      assert.equal(body.file_data, data.toString('base64'));
      return {};
    };
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'direct.bin', 'application/octet-stream', false), undefined, {
        request,
      }),
      /direct media upload returned no file_info/,
    );
    assert.equal(transport.puts.length, 0);

    let requestCount = 0;
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'direct.bin', 'application/octet-stream', false), undefined, {
        request: async () => {
          requestCount += 1;
          return { file_info: 'should-not-send' };
        },
        isCurrent: () => false,
      }),
      /invalidated before final delivery/,
    );
    assert.equal(requestCount, 0);

    let readFenceChecks = 0;
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'direct.bin', 'application/octet-stream', false), undefined, {
        request: async () => {
          requestCount += 1;
          return { file_info: 'should-not-send-after-read' };
        },
        isCurrent: () => ++readFenceChecks < 4,
      }),
      /invalidated before final delivery/,
    );
    assert.equal(requestCount, 0);

    let requestFenceChecks = 0;
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'direct.bin', 'application/octet-stream', false), undefined, {
        request: async () => {
          requestCount += 1;
          return { file_info: 'discarded-after-request' };
        },
        isCurrent: () => ++requestFenceChecks < 5,
      }),
      /invalidated before final delivery/,
    );
    assert.equal(requestCount, 1);
  });
});

test('QQ outbound uploader downgrades oversized raster images to generic files within file cap', async () => {
  const data = await validPng();
  await withTempFile(data, 'large.png', async filePath => {
    const transport = createMockTransport(128, 1);
    const result = await uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'large.png', 'image/png', true), {
      imageMaxBytes: data.length - 1,
      fileMaxBytes: data.length,
    }, { request: transport.request, fetch: transport.fetchFn });
    assert.equal(result.fileType, 4);
    assert.equal(result.isImage, false);
    assert.equal(transport.requests[0].path, '/v2/users/user-openid/files');
    assert.equal(transport.requests[0].body.file_type, 4);
    assert.equal(transport.requests[0].body.srv_send_msg, false);
    assert.equal(transport.requests[0].body.file_name, 'large.png');
    assert.equal(transport.requests[0].body.file_data, data.toString('base64'));
    assert.equal(transport.puts.length, 0);
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

test('QQ outbound uploader rejects a sparse file above the 100 MiB local cap before hashing or probing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-qqbot-upload-sparse-'));
  const filePath = path.join(dir, 'sparse.bin');
  const outboundHardCap = 100 * 1024 * 1024;
  const originalOpen: (...args: any[]) => Promise<any> = fs.open as any;
  let readCalls = 0;
  (fs as any).open = async (...args: any[]) => {
    const handle = await originalOpen(...args);
    const originalRead: (...readArgs: any[]) => any = handle.read.bind(handle) as any;
    handle.read = async (...readArgs: any[]) => {
      readCalls += 1;
      return originalRead(...readArgs);
    };
    return handle;
  };
  try {
    await fs.writeFile(filePath, Buffer.from('sparse'));
    await fs.truncate(filePath, outboundHardCap + 1);
    const transport = createMockTransport(64, 1);
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'sparse.bin', 'application/octet-stream', false), {
        fileMaxBytes: 200 * 1024 * 1024,
      }, transport),
      /configured media limit/,
    );
    assert.equal(transport.requests.length, 0);
    assert.equal(readCalls, 0);
  } finally {
    (fs as any).open = originalOpen;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('QQ outbound uploader rejects non-HTTPS presigned URLs and never performs a PUT', async () => {
  const data = Buffer.alloc(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 1);
  await withTempFile(data, 'payload.bin', async filePath => {
    const transport = createMockTransport(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 1);
    const request = async (requestPath: string, body: Record<string, unknown>): Promise<unknown> => {
      if (requestPath.endsWith('/upload_prepare')) {
        return { upload_id: 'id', block_size: QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, parts: [{ index: 1, presigned_url: 'http://evil.example/part' }] };
      }
      return transport.request(requestPath, body);
    };
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'payload.bin', 'application/octet-stream', false), undefined, {
        request,
        fetch: transport.fetchFn,
      }),
      /unsafe part URL/,
    );
    assert.equal(transport.puts.length, 0);
  });
});

test('QQ outbound uploader rejects malformed or incomplete prepare parts before any PUT', async () => {
  const data = Buffer.alloc(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 2);
  await withTempFile(data, 'payload.bin', async filePath => {
    const transport = createMockTransport(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 1);
    const request = async (requestPath: string, body: Record<string, unknown>): Promise<unknown> => {
      if (requestPath.endsWith('/upload_prepare')) {
        return {
          upload_id: 'id',
          block_size: QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES,
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
      /out-of-order parts/,
    );
    assert.equal(transport.puts.length, 0);
  });
});

test('QQ outbound uploader rejects a zero prepare block size without treating it as one part', async () => {
  const data = Buffer.alloc(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 5);
  await withTempFile(data, 'zero-block.bin', async filePath => {
    const transport = createMockTransport(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 1);
    const request = async (requestPath: string, body: Record<string, unknown>): Promise<unknown> => {
      if (requestPath.endsWith('/upload_prepare')) {
        return {
          upload_id: 'id',
          block_size: 0,
          parts: [{ index: 1, presigned_url: `${PART_HOST}/part/1` }],
        };
      }
      return transport.request(requestPath, body);
    };
    await assert.rejects(
      uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'zero-block.bin', 'application/octet-stream', false), undefined, {
        request,
        fetch: transport.fetchFn,
      }),
      /invalid block_size/,
    );
    assert.equal(transport.puts.length, 0);
  });
});

test('QQ outbound uploader does not use fs.readFile or whole-file base64 for part bodies', async () => {
  const data = Buffer.alloc(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 1);
  const originalReadFile = fs.readFile;
  (fs as any).readFile = async () => { throw new Error('whole-file readFile must not be used'); };
  try {
    await withTempFile(data, 'stream.png', async filePath => {
      const transport = createMockTransport(Math.ceil(data.length / 3), 3);
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

test('QQ outbound uploader bounds one stalled presigned PUT, aborts it, and closes every file handle', async () => {
  const data = Buffer.alloc(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 3);
  await withTempFile(data, 'stalled.bin', async filePath => {
    const originalOpen: (...args: any[]) => Promise<any> = fs.open as any;
    let openCount = 0;
    let closeCount = 0;
    let abortCount = 0;
    let putCount = 0;
    (fs as any).open = async (...args: any[]) => {
      const handle = await originalOpen(...args);
      openCount += 1;
      const originalClose: (...closeArgs: any[]) => any = handle.close.bind(handle) as any;
      handle.close = async (...closeArgs: any[]) => {
        closeCount += 1;
        return originalClose(...closeArgs);
      };
      return handle;
    };
    const transport = createMockTransport(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 1);
    const stalledFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (!String(url).startsWith(PART_HOST)) return transport.fetchFn(url, init);
      putCount += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortCount += 1;
          reject(new Error('aborted'));
        }, { once: true });
      });
    };
    try {
      await assert.rejects(
        uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'stalled.bin', 'application/octet-stream', false), undefined, {
          request: transport.request,
          fetch: stalledFetch,
          partTimeoutMs: 10,
        }),
        /timed out/,
      );
    } finally {
      (fs as any).open = originalOpen;
    }
    assert.equal(putCount, 1);
    assert.equal(abortCount, 1);
    assert.equal(closeCount, openCount);
  });
});

test('QQ outbound uploader cancels unused success/error PUT response bodies without retrying', async () => {
  const data = Buffer.alloc(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 4);
  for (const status of [200, 500]) {
    await withTempFile(data, `response-${status}.bin`, async filePath => {
      const transport = createMockTransport(QQBOT_MEDIA_DIRECT_UPLOAD_THRESHOLD_BYTES, 1);
      let cancelCount = 0;
      let putCount = 0;
      const responseBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelCount += 1;
        },
      });
      const responseFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        if (!String(url).startsWith(PART_HOST)) return transport.fetchFn(url, init);
        putCount += 1;
        return new Response(responseBody, { status });
      };
      const operation = uploadQQBotFile('c2c', 'user-openid', channelFile(filePath, 'response.bin', 'application/octet-stream', false), undefined, {
        request: transport.request,
        fetch: responseFetch,
      });
      if (status === 200) {
        await operation;
        assert.equal(cancelCount, 1);
      } else {
        await assert.rejects(operation, /media part upload failed/);
        assert.equal(cancelCount, 1);
      }
      assert.equal(putCount, 1);
    });
  }
});
