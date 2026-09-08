import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ChannelFile } from '../channel';
import { WeWorkWebhookChannel } from './weworkChannel';

type WsFrame = {
  cmd: string;
  headers: { req_id: string };
  body?: any;
};

type WsReply = {
  errcode?: number;
  errmsg?: string;
  body?: any;
  close?: boolean;
};

const CHUNK_BYTES = 512 * 1024;
const MAX_UPLOAD_BYTES = CHUNK_BYTES * 100;

function channelFile(filePath: string, name: string, sizeBytes: number, isImage: boolean): ChannelFile {
  return {
    path: filePath,
    name,
    sizeBytes,
    isImage,
    mimeType: isImage ? 'image/png' : 'application/octet-stream',
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for condition');
}

async function createWsHarness(
  reply: (frame: WsFrame) => WsReply = frame => {
    if (frame.cmd === 'aibot_upload_media_init') return { body: { upload_id: 'upload-1' } };
    if (frame.cmd === 'aibot_upload_media_finish') return { body: { media_id: 'media-1' } };
    return {};
  },
): Promise<{
  url: string;
  frames: WsFrame[];
  close(): Promise<void>;
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const frames: WsFrame[] = [];
  const clients = new Set<WebSocket>();
  server.on('connection', socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      frames.push(frame);
      const response = reply(frame);
      if (response.close) {
        socket.close(1011, 'test disconnect');
        return;
      }
      socket.send(JSON.stringify({
        headers: { req_id: frame.headers.req_id },
        errcode: response.errcode ?? 0,
        errmsg: response.errmsg ?? 'ok',
        ...(response.body !== undefined ? { body: response.body } : {}),
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    frames,
    async close() {
      for (const client of clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function startWsChannel(url: string, webhookUrl?: string): Promise<WeWorkWebhookChannel> {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-media-test',
    webhookUrl,
    aibot: {
      websocket: {
        enabled: true,
        botId: 'test-bot',
        secret: 'test-secret',
        url,
        heartbeatMs: 60_000,
        reconnectMs: 60_000,
      },
    },
  });
  await channel.start();
  return channel;
}

async function waitForSubscription(frames: WsFrame[]): Promise<void> {
  await waitFor(() => frames.some(frame => frame.cmd === 'aibot_subscribe'));
}

async function createHttpHarness(): Promise<{
  webhookUrl: string;
  requests: Array<{ url: string; body: Buffer }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ url: string; body: Buffer }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requests.push({ url: req.url || '', body: Buffer.concat(chunks) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url?.startsWith('/cgi-bin/webhook/upload_media')
        ? { errcode: 0, media_id: 'legacy-media' }
        : { errcode: 0, errmsg: 'ok' }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    webhookUrl: `http://127.0.0.1:${address.port}/webhook?key=test-key`,
    requests,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

test('WeWork sendFile prefers AIBot WebSocket and uploads multi-chunk files in zero-based order', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-wework-media-'));
  const bytes = Buffer.alloc(CHUNK_BYTES + 17);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const filePath = path.join(tempDir, 'report.bin');
  await writeFile(filePath, bytes);
  const ws = await createWsHarness();
  const httpHarness = await createHttpHarness();
  const channel = await startWsChannel(ws.url, httpHarness.webhookUrl);

  try {
    await waitForSubscription(ws.frames);
    await channel.sendFile('fallback-chat', channelFile(filePath, 'report.bin', bytes.length, false), {
      caption: 'file caption',
      chatId: 'target-chat',
      chatType: 'group',
    });

    const commands = ws.frames.filter(frame => frame.cmd !== 'aibot_subscribe');
    assert.deepEqual(commands.map(frame => frame.cmd), [
      'aibot_upload_media_init',
      'aibot_upload_media_chunk',
      'aibot_upload_media_chunk',
      'aibot_upload_media_finish',
      'aibot_send_msg',
      'aibot_send_msg',
    ]);
    assert.deepEqual(commands[0].body, {
      type: 'file',
      filename: 'report.bin',
      total_size: bytes.length,
      total_chunks: 2,
      md5: crypto.createHash('md5').update(bytes).digest('hex'),
    });
    const chunks = commands.filter(frame => frame.cmd === 'aibot_upload_media_chunk');
    assert.deepEqual(chunks.map(frame => frame.body.chunk_index), [0, 1]);
    assert.deepEqual(Buffer.concat(chunks.map(frame => Buffer.from(frame.body.base64_data, 'base64'))), bytes);
    assert.equal(chunks.every(frame => frame.body.upload_id === 'upload-1'), true);
    assert.deepEqual(commands[4].body, {
      chatid: 'target-chat',
      chat_type: 2,
      msgtype: 'text',
      text: { content: 'file caption' },
    });
    assert.deepEqual(commands[5].body, {
      chatid: 'target-chat',
      chat_type: 2,
      msgtype: 'file',
      file: { media_id: 'media-1' },
    });
    assert.equal(httpHarness.requests.length, 0);
  } finally {
    await channel.stop();
    await ws.close();
    await httpHarness.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('WeWork AIBot WebSocket upload sends images as image media', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-wework-image-'));
  const bytes = Buffer.from('not-a-real-png-but-protocol-bytes');
  const filePath = path.join(tempDir, 'photo.png');
  await writeFile(filePath, bytes);
  const ws = await createWsHarness();
  const channel = await startWsChannel(ws.url);

  try {
    await waitForSubscription(ws.frames);
    await channel.sendFile('image-chat', channelFile(filePath, 'photo.png', bytes.length, true));
    const commands = ws.frames.filter(frame => frame.cmd !== 'aibot_subscribe');
    assert.equal(commands[0].body.type, 'image');
    assert.equal(commands[0].body.total_chunks, 1);
    assert.deepEqual(commands.at(-1)?.body, {
      chatid: 'image-chat',
      msgtype: 'image',
      image: { media_id: 'media-1' },
    });
  } finally {
    await channel.stop();
    await ws.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('WeWork sendFile keeps legacy-only delivery and explicit webhook overrides on the legacy route', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-wework-legacy-'));
  const imagePath = path.join(tempDir, 'photo.png');
  const filePath = path.join(tempDir, 'report.bin');
  await writeFile(imagePath, Buffer.from('image-bytes'));
  await writeFile(filePath, Buffer.from('file-bytes'));
  const httpHarness = await createHttpHarness();
  const ws = await createWsHarness();
  const dualChannel = await startWsChannel(ws.url, httpHarness.webhookUrl);
  const legacyChannel = new WeWorkWebhookChannel({ name: 'legacy-only', webhookUrl: httpHarness.webhookUrl });

  try {
    await waitForSubscription(ws.frames);
    await dualChannel.sendFile('chat-1', channelFile(imagePath, 'photo.png', 11, true), {
      webhookUrl: httpHarness.webhookUrl,
    });
    await legacyChannel.sendFile('chat-2', channelFile(filePath, 'report.bin', 10, false));

    assert.deepEqual(ws.frames.map(frame => frame.cmd), ['aibot_subscribe']);
    assert.equal(httpHarness.requests.length, 3);
    assert.equal(JSON.parse(httpHarness.requests[0].body.toString()).msgtype, 'image');
    assert.equal(httpHarness.requests[1].url.startsWith('/cgi-bin/webhook/upload_media?'), true);
    assert.deepEqual(JSON.parse(httpHarness.requests[2].body.toString()), {
      msgtype: 'file',
      file: { media_id: 'legacy-media' },
    });
  } finally {
    await dualChannel.stop();
    await ws.close();
    await httpHarness.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('WeWork AIBot media upload enforces the protocol size cap before init', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-wework-large-'));
  const filePath = path.join(tempDir, 'too-large.bin');
  await writeFile(filePath, Buffer.alloc(0));
  await truncate(filePath, MAX_UPLOAD_BYTES + 1);
  const ws = await createWsHarness();
  const channel = await startWsChannel(ws.url);

  try {
    await waitForSubscription(ws.frames);
    await assert.rejects(
      channel.sendFile('chat-1', channelFile(filePath, 'too-large.bin', MAX_UPLOAD_BYTES + 1, false)),
      /52428800-byte protocol limit/,
    );
    assert.deepEqual(ws.frames.map(frame => frame.cmd), ['aibot_subscribe']);
  } finally {
    await channel.stop();
    await ws.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('WeWork AIBot media failures stop later stages without legacy fallback', async t => {
  const cases = [
    { name: 'init failure', failCommand: 'aibot_upload_media_init', expected: ['aibot_upload_media_init'] },
    { name: 'chunk failure', failCommand: 'aibot_upload_media_chunk', expected: ['aibot_upload_media_init', 'aibot_upload_media_chunk'] },
    { name: 'finish failure', failCommand: 'aibot_upload_media_finish', expected: ['aibot_upload_media_init', 'aibot_upload_media_chunk', 'aibot_upload_media_finish'] },
    { name: 'send failure', failCommand: 'aibot_send_msg', expected: ['aibot_upload_media_init', 'aibot_upload_media_chunk', 'aibot_upload_media_finish', 'aibot_send_msg'] },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-wework-failure-'));
      const filePath = path.join(tempDir, 'report.bin');
      await writeFile(filePath, Buffer.from('file-bytes'));
      const httpHarness = await createHttpHarness();
      const ws = await createWsHarness(frame => {
        if (frame.cmd === testCase.failCommand) return { errcode: 41001, errmsg: 'injected failure' };
        if (frame.cmd === 'aibot_upload_media_init') return { body: { upload_id: 'upload-1' } };
        if (frame.cmd === 'aibot_upload_media_finish') return { body: { media_id: 'media-1' } };
        return {};
      });
      const channel = await startWsChannel(ws.url, httpHarness.webhookUrl);
      try {
        await waitForSubscription(ws.frames);
        await assert.rejects(
          channel.sendFile('chat-1', channelFile(filePath, 'report.bin', 10, false)),
          /injected failure.*41001/,
        );
        assert.deepEqual(
          ws.frames.filter(frame => frame.cmd !== 'aibot_subscribe').map(frame => frame.cmd),
          testCase.expected,
        );
        assert.equal(httpHarness.requests.length, 0);
      } finally {
        await channel.stop();
        await ws.close();
        await httpHarness.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  }
});

test('WeWork AIBot malformed upload ACKs and disconnects do not continue or fall back', async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'foxwarm-wework-ack-'));
  const filePath = path.join(tempDir, 'report.bin');
  await writeFile(filePath, Buffer.from('file-bytes'));
  const file = channelFile(filePath, 'report.bin', 10, false);

  try {
    await t.test('missing upload_id', async () => {
      const ws = await createWsHarness(frame => frame.cmd === 'aibot_upload_media_init' ? { body: {} } : {});
      const channel = await startWsChannel(ws.url);
      try {
        await waitForSubscription(ws.frames);
        await assert.rejects(channel.sendFile('chat-1', file), /malformed ack without upload_id/);
        assert.deepEqual(ws.frames.filter(frame => frame.cmd !== 'aibot_subscribe').map(frame => frame.cmd), ['aibot_upload_media_init']);
      } finally {
        await channel.stop();
        await ws.close();
      }
    });

    await t.test('missing media_id', async () => {
      const ws = await createWsHarness(frame => {
        if (frame.cmd === 'aibot_upload_media_init') return { body: { upload_id: 'upload-1' } };
        if (frame.cmd === 'aibot_upload_media_finish') return { body: {} };
        return {};
      });
      const channel = await startWsChannel(ws.url);
      try {
        await waitForSubscription(ws.frames);
        await assert.rejects(channel.sendFile('chat-1', file), /malformed ack without media_id/);
        assert.equal(ws.frames.some(frame => frame.cmd === 'aibot_send_msg'), false);
      } finally {
        await channel.stop();
        await ws.close();
      }
    });

    await t.test('disconnect during chunk', async () => {
      const ws = await createWsHarness(frame => {
        if (frame.cmd === 'aibot_upload_media_init') return { body: { upload_id: 'upload-1' } };
        if (frame.cmd === 'aibot_upload_media_chunk') return { close: true };
        return {};
      });
      const channel = await startWsChannel(ws.url);
      try {
        await waitForSubscription(ws.frames);
        await assert.rejects(channel.sendFile('chat-1', file), /WebSocket closed/);
        assert.equal(ws.frames.some(frame => frame.cmd === 'aibot_upload_media_finish'), false);
        assert.equal(ws.frames.some(frame => frame.cmd === 'aibot_send_msg'), false);
      } finally {
        await channel.stop();
        await ws.close();
      }
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
