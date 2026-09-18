import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import sharp from 'sharp';
import WebSocket from 'ws';
import type { Message, Session } from './types';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-image-transport-'));
fs.ensureDirSync(path.join(dataRoot, 'state'));
fs.writeFileSync(path.join(dataRoot, 'state', 'models.yaml'), `default: ws/model
providers:
  ws:
    providerType: openai-ws
    baseUrl: https://example.test/v1
    apiKey: test-key
    imageGeneration:
      enabled: true
    models: [model]
  http:
    providerType: openai-responses
    baseUrl: https://responses.test/v1
    apiKey: test-key
    imageGeneration:
      enabled: true
    models: [model]
`);
process.env.FOXWARM_DATA_DIR = dataRoot;

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: any[] = [];
  terminated = 0;
  _socket = { ref() {}, unref() {} };
  constructor(private readonly responseFor: (request: any) => any) {
    super();
    process.nextTick(() => { this.readyState = WebSocket.OPEN; this.emit('open'); });
  }
  send(raw: string) {
    const request = JSON.parse(raw);
    this.sent.push(request);
    const response = this.responseFor(request);
    process.nextTick(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response }))));
  }
  close() { this.terminate(); }
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.terminated += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006, Buffer.alloc(0));
  }
}

function session(id: string, model: string): Session {
  return {
    id, history: [], persistentMemorySnapshot: 'system', promptCacheKey: '11111111-2222-4333-8444-555555555555', model,
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: Date.now() },
  } as Session;
}

const llmPromise = import('./llm');
const transportPromise = import('./llmProviders/openaiWsTransport');

after(async () => {
  const transport = await transportPromise;
  transport.setOpenAIWsTransportTestHooks();
  transport.clearOpenAIWsCompletedChains();
  fs.removeSync(dataRoot);
  delete process.env.FOXWARM_DATA_DIR;
});

async function makePng(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 5, g: 60, b: 120 } } }).png().toBuffer();
}

function imageOutput(base64: string, id = 'ig_ws'): any[] {
  return [{ type: 'image_generation_call', id, status: 'completed', output_format: 'png', result: base64 }];
}

function responseSse(output: any[], text?: string): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(`data: ${JSON.stringify({ type: 'response.completed', response: {
      id: 'http-response', status: 'completed', output, usage: { input_tokens: 3, output_tokens: 4 },
    } })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

test('openai-ws discards the chain after a generated image and replays full local history next turn', async () => {
  const { chat } = await llmPromise;
  const transport = await transportPromise;
  const png = await makePng();
  const base64 = png.toString('base64');
  const sockets: FakeSocket[] = [];
  transport.setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket(() => ({
      id: `ws-response-${sockets.length}`,
      status: 'completed',
      output: imageOutput(base64, 'ig_first'),
      usage: { input_tokens: 2, output_tokens: 2 },
    }));
    sockets.push(socket);
    return socket as any;
  }});

  const current = session('ws-image', 'ws/model');
  const append = async (message: Message) => { current.history.push(message); };
  await chat([{ text: 'draw a duck' }], current, 0, {
    appendMessage: append, notifySessionEvents: false, registerAbortController: false, toolDefinitions: [],
  });
  // The image response must not leave a reusable chain behind.
  assert.equal(transport.getOpenAIWsCompletedChainCountForTests(), 0);

  await chat([{ text: 'make the tail thinner' }], current, 1, {
    appendMessage: append, notifySessionEvents: false, registerAbortController: false, toolDefinitions: [],
  });

  assert.equal(sockets.length, 2);
  const secondWire = sockets[1].sent[0];
  assert.equal(secondWire.previous_response_id, undefined);
  const replay = (secondWire.input || []).find((item: any) => item?.type === 'image_generation_call');
  assert.ok(replay, 'the second request must replay the native image call');
  assert.equal(replay.result, base64);
  assert.equal(replay.id, 'ig_first');
  // The same blob is not also serialized as a duplicate assistant image input.
  const assistantImageInputs = (secondWire.input || []).filter((item: any) =>
    item?.type === 'message' && JSON.stringify(item).includes('input_image'));
  assert.deepEqual(assistantImageInputs, []);
  // Canonical history keeps the blob reference, never the base64.
  const modelMessage = current.history.find(message => message.role === 'model')!;
  assert.equal(JSON.stringify(modelMessage).includes(base64), false);
  assert.ok(modelMessage.parts[0].inlineDataRef?.blobId);
  transport.clearOpenAIWsCompletedChains();
});

test('normal text responses after an image turn still reuse the WebSocket chain', async () => {
  const { chat } = await llmPromise;
  const transport = await transportPromise;
  const png = await makePng();
  const base64 = png.toString('base64');
  const sockets: FakeSocket[] = [];
  let servedImage = false;
  transport.setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket(() => {
      if (!servedImage) {
        servedImage = true;
        return { id: 'ws-image-once', status: 'completed', output: imageOutput(base64, 'ig_then_text') };
      }
      return {
        id: `ws-text-${socket.sent.length}`,
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }],
      };
    });
    sockets.push(socket);
    return socket as any;
  }});

  const current = session('ws-after-image', 'ws/model');
  const append = async (message: Message) => { current.history.push(message); };
  await chat([{ text: 'image please' }], current, 0, {
    appendMessage: append, notifySessionEvents: false, registerAbortController: false, toolDefinitions: [],
  });
  assert.equal(transport.getOpenAIWsCompletedChainCountForTests(), 0);
  await chat([{ text: 'now just talk' }], current, 1, {
    appendMessage: append, notifySessionEvents: false, registerAbortController: false, toolDefinitions: [],
  });
  await chat([{ text: 'and again' }], current, 2, {
    appendMessage: append, notifySessionEvents: false, registerAbortController: false, toolDefinitions: [],
  });
  // The image turn forced a fresh socket; the following text turns reuse it.
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].sent[1].previous_response_id, 'ws-text-1');
  transport.clearOpenAIWsCompletedChains();
});

test('HTTP SSE and WebSocket yield the same ChatResult and Blob semantics for one fixture', async () => {
  const { requestLlmOnce } = await llmPromise;
  const transport = await transportPromise;
  const png = await makePng();
  const base64 = png.toString('base64');

  const httpEntry = {
    providerKey: 'http', providerType: 'openai-responses', canonicalModelKey: 'http/model',
    baseUrl: 'https://responses.test/v1', model: 'model', extraFields: {}, extraHeaders: {},
    effort: { allowed: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
    imageGeneration: { enabled: true, outputFormat: 'png' },
  } as any;

  const originalPost = axios.post;
  (axios as any).post = async () => ({ status: 200, statusText: 'OK', headers: {}, data: responseSse(imageOutput(base64, 'ig_parity')) });
  let httpResult: any;
  try {
    httpResult = await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'draw' }] }], systemPrompt: '', modelEntryOverride: httpEntry,
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
    });
  } finally {
    (axios as any).post = originalPost;
  }

  const wsEntry = { ...httpEntry, providerKey: 'ws', canonicalModelKey: 'ws/model', providerType: 'openai-ws' };
  transport.setOpenAIWsTransportTestHooks({ socketFactory: () => new FakeSocket(() => ({
    id: 'ws-parity', status: 'completed', output: imageOutput(base64, 'ig_parity'),
  })) as any });
  const wsResult = await requestLlmOnce({
    contents: [{ role: 'user', parts: [{ text: 'draw' }] }], systemPrompt: '', modelEntryOverride: wsEntry,
    toolDefinitions: [], notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
  });

  for (const result of [httpResult, wsResult]) {
    assert.equal(result.text, '');
    assert.deepEqual(result.toolCalls, []);
    const images = (result.allParts || []).filter((part: any) => !!part.inlineDataRef);
    assert.equal(images.length, 1);
    assert.equal(images[0].imageMeta.origin, 'generated');
    assert.equal(images[0].imageMeta.sha256, images[0].inlineDataRef.sha256);
    assert.equal((images[0].providerMeta.openaiResponses.outputItem as any).result, undefined);
  }
  transport.clearOpenAIWsCompletedChains();
});
