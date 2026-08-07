import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import type { SavedChannelFile } from '../channelFiles';
import { externalizeQueueItemImages } from '../imageBlobs';
import {
  buildQQBotAttachmentPreviewParts,
  materializeQQBotAttachments,
  QQBOT_MEDIA_HARD_MAX_BYTES,
} from './qqbotMedia';

function response(body: any, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function savedFile(name: string, mimeType: string, sizeBytes: number, isImage: boolean): SavedChannelFile {
  return {
    agentName: 'main',
    nodeId: 'master',
    absolutePath: `/tmp/${name}`,
    promptPath: `/tmp/${name}`,
    fileName: name,
    mimeType,
    sizeBytes,
    isImage,
  };
}

test('QQ media preview is safe metadata and keeps attachment order without fetching', () => {
  const parts = buildQQBotAttachmentPreviewParts('caption', [
    { filename: '../../photo.png', content_type: 'image/png', size: 12, url: 'https://multimedia.nt.qq.com.cn/signed?secret=1' },
    { filename: 'report.txt', content_type: 'file', size: 24, url: 'https://multimedia.nt.qq.com.cn/file' },
  ]);

  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, 'caption');
  assert.match(parts[1].text || '', /photo\.png/);
  assert.match(parts[2].text || '', /report\.txt/);
  assert.doesNotMatch(parts[1].text || '', /signed|secret/);
});

test('QQ media materialization downloads a raster image, saves a safe descriptor, and emits transient inline data', async () => {
  const image = await sharp({
    create: { width: 2, height: 1, channels: 3, background: { r: 20, g: 40, b: 60 } },
  }).png().toBuffer();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const saves: Array<{ fileName?: string; isImage?: boolean; sessionId?: string }> = [];

  const parts = await materializeQQBotAttachments({
    content: 'look',
    eventId: 'message-1',
    sessionId: 'session-1',
    attachments: [{
      url: 'https://multimedia.nt.qq.com.cn/download?fileid=1',
      filename: '../../unsafe name.sh',
      content_type: 'image/png',
      size: image.length,
    }],
    deps: {
      fetch: async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        return response(image, 200, { 'content-type': 'image/png', 'content-length': String(image.length) });
      },
      saveInboundSessionFile: async options => {
        saves.push({ fileName: options.fileName, isImage: options.isImage, sessionId: options.sessionId });
        return savedFile(options.fileName || 'image.png', options.mimeType || 'image/png', options.buffer.length, true);
      },
    },
  });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://multimedia.nt.qq.com.cn/download?fileid=1');
  assert.equal(fetchCalls[0].init?.headers && (fetchCalls[0].init?.headers as Record<string, string>).authorization, undefined);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].sessionId, 'session-1');
  assert.equal(saves[0].isImage, true);
  assert.doesNotMatch(saves[0].fileName || '', /[\\/]/);
  assert.match(saves[0].fileName || '', /\.png$/);
  assert.equal(parts[0].text, 'look');
  assert.match(parts[1].text || '', /Image:/);
  assert.equal(parts[1].inlineData?.mimeType, 'image/png');
  assert.equal(Buffer.from(parts[1].inlineData?.data || '', 'base64').toString('hex'), image.toString('hex'));
  assert.equal(parts[1].imageMeta?.width, 2);
  assert.equal(parts[1].imageMeta?.height, 1);
});

test('QQ image queue materialization crosses the durable boundary as an image blob reference', async () => {
  const image = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();
  const result = await externalizeQueueItemImages({
    type: 'user',
    parts: [{
      text: '[Image: photo.png]',
      inlineData: { mimeType: 'image/png', data: image.toString('base64') },
      imageMeta: { imageId: 'qq-image-queue-test', mimeType: 'image/png' },
    }],
  } as any);

  assert.equal(result.changed, true);
  assert.equal(result.item.parts[0].inlineData, undefined);
  assert.match(result.item.parts[0].inlineDataRef?.blobId || '', /^[a-f0-9]{64}\.png$/);
  assert.equal(result.item.parts[0].inlineDataRef?.mimeType, 'image/png');
});

test('QQ media materialization downloads generic files as saved descriptors and preserves order', async () => {
  const saves: Array<{ fileName?: string; isImage?: boolean }> = [];
  const parts = await materializeQQBotAttachments({
    content: 'two files',
    eventId: 'message-2',
    sessionId: 'session-2',
    attachments: [
      { url: 'https://qpic.cn/first', filename: 'first.bin', content_type: 'file' },
      { url: 'https://qpic.cn/second', filename: 'second.txt', content_type: 'text/plain' },
    ],
    deps: {
      fetch: async url => response(Buffer.from(String(url).endsWith('first') ? 'one' : 'two')),
      saveInboundSessionFile: async options => {
        saves.push({ fileName: options.fileName, isImage: options.isImage });
        return savedFile(options.fileName || 'file', options.mimeType || 'application/octet-stream', options.buffer.length, false);
      },
    },
  });

  assert.equal(saves.length, 2);
  assert.deepEqual(saves.map(item => item.fileName), ['first.bin', 'second.txt']);
  assert.deepEqual(saves.map(item => item.isImage), [false, false]);
  assert.match(parts[1].text || '', /first\.bin/);
  assert.match(parts[2].text || '', /second\.txt/);
  assert.equal(parts.some(part => part.inlineData), false);
});

test('QQ media rejects image MIME/magic mismatch without saving inline bytes', async () => {
  let saveCount = 0;
  const parts = await materializeQQBotAttachments({
    content: 'bad image',
    eventId: 'message-3',
    sessionId: 'session-3',
    attachments: [{ url: 'https://qq.com/not-image', filename: 'bad.png', content_type: 'image/png' }],
    deps: {
      fetch: async () => response(Buffer.from('not a png')),
      saveInboundSessionFile: async options => {
        saveCount += 1;
        return savedFile(options.fileName || 'bad.png', options.mimeType || 'image/png', options.buffer.length, true);
      },
    },
  });

  assert.equal(saveCount, 0);
  assert.equal(parts.some(part => part.inlineData), false);
  assert.match(parts[1].text || '', /do not match declared MIME|unsupported|Input buffer/i);
});

test('QQ media bounds header and streamed bytes before saving', async () => {
  let saveCount = 0;
  const oversizedHeader = await materializeQQBotAttachments({
    content: 'large header',
    eventId: 'message-4',
    sessionId: 'session-4',
    attachments: [{ url: 'https://qq.com/large', filename: 'large.txt', content_type: 'file', size: 100 }],
    config: { fileMaxBytes: 50, maxTotalBytes: 200 },
    deps: {
      fetch: async () => {
        throw new Error('header limit should reject before fetch');
      },
      saveInboundSessionFile: async options => {
        saveCount += 1;
        return savedFile(options.fileName || 'large.txt', options.mimeType || 'application/octet-stream', options.buffer.length, false);
      },
    },
  });
  assert.equal(saveCount, 0);
  assert.match(oversizedHeader[1].text || '', /exceeds 50 bytes/);

  const oversizedStream = await materializeQQBotAttachments({
    content: 'large stream',
    eventId: 'message-5',
    sessionId: 'session-5',
    attachments: [{ url: 'https://qq.com/stream', filename: 'stream.txt', content_type: 'file' }],
    config: { fileMaxBytes: 4 },
    deps: {
      fetch: async () => response(new Uint8Array([1, 2, 3, 4, 5])),
      saveInboundSessionFile: async options => {
        saveCount += 1;
        return savedFile(options.fileName || 'stream.txt', options.mimeType || 'application/octet-stream', options.buffer.length, false);
      },
    },
  });
  assert.equal(saveCount, 0);
  assert.match(oversizedStream[1].text || '', /exceeds 4 bytes/);
});

test('QQ media validates allowlisted HTTPS redirects and private hosts before fetch', async () => {
  let calls = 0;
  const privateHost = await materializeQQBotAttachments({
    content: 'private',
    eventId: 'message-6',
    sessionId: 'session-6',
    attachments: [{ url: 'https://127.0.0.1/private', filename: 'x.txt', content_type: 'file' }],
    deps: { fetch: async () => { calls += 1; return response('unexpected'); } },
  });
  assert.equal(calls, 0);
  assert.match(privateHost[1].text || '', /allowlisted|HTTPS/);

  const redirectCalls: string[] = [];
  const redirected = await materializeQQBotAttachments({
    content: 'redirect',
    eventId: 'message-7',
    sessionId: 'session-7',
    attachments: [{ url: 'https://qq.com/redirect', filename: 'x.txt', content_type: 'file' }],
    deps: {
      fetch: async url => {
        redirectCalls.push(String(url));
        return response(null, 302, { location: 'https://10.0.0.1/private' });
      },
    },
  });
  assert.deepEqual(redirectCalls, ['https://qq.com/redirect']);
  assert.match(redirected[1].text || '', /allowlisted|HTTPS/);
});

test('QQ media timeout is bounded and never saves a hanging response', async () => {
  let saveCount = 0;
  const started = Date.now();
  const parts = await materializeQQBotAttachments({
    content: 'timeout',
    eventId: 'message-8',
    sessionId: 'session-8',
    attachments: [{ url: 'https://qq.com/hang', filename: 'x.txt', content_type: 'file' }],
    deps: {
      timeoutMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
      saveInboundSessionFile: async options => {
        saveCount += 1;
        return savedFile(options.fileName || 'x.txt', options.mimeType || 'application/octet-stream', options.buffer.length, false);
      },
    },
  });
  assert.ok(Date.now() - started < 500);
  assert.equal(saveCount, 0);
  assert.match(parts[1].text || '', /timed out|aborted/);
});

test('QQ media config cannot exceed the 200 MiB hard cap', async () => {
  let fetchCount = 0;
  const parts = await materializeQQBotAttachments({
    content: 'hard cap',
    eventId: 'message-9',
    sessionId: 'session-9',
    attachments: [{ url: 'https://qq.com/cap', filename: 'cap.txt', content_type: 'file', size: QQBOT_MEDIA_HARD_MAX_BYTES + 1 }],
    config: { fileMaxBytes: QQBOT_MEDIA_HARD_MAX_BYTES * 2, maxTotalBytes: QQBOT_MEDIA_HARD_MAX_BYTES * 2 },
    deps: {
      fetch: async () => {
        fetchCount += 1;
        return response('small');
      },
    },
  });
  assert.equal(fetchCount, 0);
  assert.match(parts[1].text || '', /200 MiB/);
});