import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
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

function pathSaver(onSave: (options: any) => void): (options: any) => Promise<SavedChannelFile> {
  return async options => {
    onSave(options);
    return savedFile(options.fileName || 'file', options.mimeType || 'application/octet-stream', options.sizeBytes, options.isImage === true);
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

test('QQ official video, voice, and nested attachments stay deferred with zero fetch/write', async () => {
  let fetchCount = 0;
  let saveCount = 0;
  const parts = await materializeQQBotAttachments({
    content: 'official attachment fixture',
    eventId: 'official-message-1',
    sessionId: 'session-official-1',
    attachments: [
      { url: 'https://multimedia.nt.qq.com.cn/video', filename: 'clip.mp4', content_type: 'video/mp4', size: 100 },
      { url: 'https://multimedia.nt.qq.com.cn/voice', filename: 'voice.silk', content_type: 'voice', size: 80 },
      {
        url: 'https://multimedia.nt.qq.com.cn/nested', filename: 'nested.bin', content_type: 'file',
        attachments: [{ url: 'https://multimedia.nt.qq.com.cn/child', filename: 'child.png', content_type: 'image/png' }],
      },
    ],
    deps: {
      fetch: async () => {
        fetchCount += 1;
        return response('must not fetch');
      },
      saveInboundSessionFileFromPath: pathSaver(() => { saveCount += 1; }),
    },
  });

  assert.equal(fetchCount, 0);
  assert.equal(saveCount, 0);
  assert.match(parts[1].text || '', /video media is deferred/);
  assert.match(parts[2].text || '', /voice media is deferred/);
  assert.match(parts[3].text || '', /nested QQ media is deferred/);
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
      saveInboundSessionFileFromPath: pathSaver(options => {
        saves.push({ fileName: options.fileName, isImage: options.isImage, sessionId: options.sessionId });
      }),
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
      saveInboundSessionFileFromPath: pathSaver(options => {
        saves.push({ fileName: options.fileName, isImage: options.isImage });
      }),
    },
  });

  assert.equal(saves.length, 2);
  assert.deepEqual(saves.map(item => item.fileName), ['first.bin', 'second.txt']);
  assert.deepEqual(saves.map(item => item.isImage), [false, false]);
  assert.match(parts[1].text || '', /first\.bin/);
  assert.match(parts[2].text || '', /second\.txt/);
  assert.equal(parts.some(part => part.inlineData), false);
});

test('QQ generic near-limit streams into a spool file, publishes from the path, and cleans the spool', async () => {
  const chunk = new Uint8Array(1024);
  const sourceChunks = [chunk, chunk, chunk];
  let chunkIndex = 0;
  let spoolPath = '';
  let publishedSize = 0;
  const parts = await materializeQQBotAttachments({
    content: 'streamed file',
    eventId: 'message-stream',
    sessionId: 'session-stream',
    attachments: [{ url: 'https://qpic.cn/streamed', filename: 'near-limit.bin', content_type: 'file' }],
    config: { fileMaxBytes: 3 * 1024, maxTotalBytes: 3 * 1024 },
    deps: {
      fetch: async () => response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunkIndex < sourceChunks.length) controller.enqueue(sourceChunks[chunkIndex++]);
          else controller.close();
        },
      })),
      saveInboundSessionFileFromPath: async options => {
        spoolPath = options.sourcePath;
        publishedSize = (await fs.stat(options.sourcePath)).size;
        return savedFile(options.fileName || 'near-limit.bin', options.mimeType || 'application/octet-stream', options.sizeBytes, false);
      },
    },
  });

  assert.equal(publishedSize, 3 * 1024);
  assert.equal(parts.some(part => part.inlineData), false);
  await assert.rejects(fs.access(spoolPath), /ENOENT/);
});

test('QQ images above the safe inline cap become generic file descriptors without inline bytes', async () => {
  const saves: Array<{ isImage?: boolean; sizeBytes?: number }> = [];
  const parts = await materializeQQBotAttachments({
    content: 'large image fallback',
    eventId: 'message-large-image',
    sessionId: 'session-large-image',
    attachments: [{ url: 'https://qpic.cn/large-image', filename: 'large.png', content_type: 'image/png' }],
    config: { imageMaxBytes: 4, fileMaxBytes: 8 },
    deps: {
      fetch: async () => response(new Uint8Array([1, 2, 3, 4, 5, 6])),
      saveInboundSessionFileFromPath: pathSaver(options => {
        saves.push({ isImage: options.isImage, sizeBytes: options.sizeBytes });
      }),
    },
  });

  assert.deepEqual(saves, [{ isImage: false, sizeBytes: 6 }]);
  assert.equal(parts.some(part => part.inlineData), false);
  assert.match(parts[1].text || '', /kept as a generic file/);
  assert.match(parts[1].text || '', /no image bytes were sent inline/);
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
      saveInboundSessionFileFromPath: pathSaver(() => {
        saveCount += 1;
      }),
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
      saveInboundSessionFileFromPath: pathSaver(() => {
        saveCount += 1;
      }),
    },
  });
  assert.equal(saveCount, 0);
  assert.match(oversizedHeader[1].text || '', /exceeds 50 bytes/);

  const spoolEntriesBefore = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('foxwarm-qqbot-media-'));
  const oversizedStream = await materializeQQBotAttachments({
    content: 'large stream',
    eventId: 'message-5',
    sessionId: 'session-5',
    attachments: [{ url: 'https://qq.com/stream', filename: 'stream.txt', content_type: 'file' }],
    config: { fileMaxBytes: 4 },
    deps: {
      fetch: async () => response(new Uint8Array([1, 2, 3, 4, 5])),
      saveInboundSessionFileFromPath: pathSaver(() => {
        saveCount += 1;
      }),
    },
  });
  assert.equal(saveCount, 0);
  assert.match(oversizedStream[1].text || '', /exceeds 4 bytes/);
  const spoolEntriesAfter = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('foxwarm-qqbot-media-'));
  assert.deepEqual(spoolEntriesAfter, spoolEntriesBefore);
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
      saveInboundSessionFileFromPath: pathSaver(() => {
        saveCount += 1;
      }),
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