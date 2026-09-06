import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import type { Message, Session } from './types';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-openai-ws-chat-'));
fs.ensureDirSync(path.join(dataRoot, 'state'));
fs.writeFileSync(path.join(dataRoot, 'state', 'models.yaml'), `default: socket/model\nproviders:\n  socket:\n    providerType: openai-ws\n    baseUrl: https://example.test/v1\n    apiKey: test-key\n    models: [model]\n`);
process.env.FOXWARM_DATA_DIR = dataRoot;

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: any[] = [];
  terminated = 0;
  _socket = { unref() {} };
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

function session(id: string): Session {
  return {
    id, history: [], persistentMemorySnapshot: 'system', promptCacheKey: 'cache-key', model: 'socket/model',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [], meta: { lastMessageTime: Date.now() },
  } as Session;
}

const llmPromise = import('./llm');
const transportPromise = import('./llmProviders/openaiWsTransport');

after(async () => {
  const transport = await transportPromise;
  transport.setOpenAIWsTransportTestHooks();
  fs.removeSync(dataRoot);
  delete process.env.FOXWARM_DATA_DIR;
});

test('normal chat commits provider replay once and the next turn sends only the new user suffix', async () => {
  const { chat } = await llmPromise;
  const transport = await transportPromise;
  const sockets: FakeSocket[] = [];
  transport.setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket(() => ({
      id: `response-${sockets.length}-${socket.sent.length}`,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }],
      usage: { input_tokens: 2, output_tokens: 1 },
    }));
    sockets.push(socket);
    return socket as any;
  }});
  const current = session('normal');
  const append = async (message: Message) => { current.history.push(message); };
  await chat([{ text: 'first' }], current, 0, { appendMessage: append, notifySessionEvents: false, registerAbortController: false, toolDefinitions: [] });
  await chat([{ text: 'second' }], current, 1, { appendMessage: append, notifySessionEvents: false, registerAbortController: false, toolDefinitions: [] });
  assert.equal(sockets.length, 1);
  const secondWire = sockets[0].sent[1];
  assert.equal(secondWire.previous_response_id, 'response-1-1');
  assert.deepEqual(secondWire.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] }]);
  transport.clearOpenAIWsCompletedChains();
});

test('assistant append failure and direct low-level requests discard completed sockets', async () => {
  const { chat, requestLlmOnce } = await llmPromise;
  const transport = await transportPromise;
  const sockets: FakeSocket[] = [];
  transport.setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket(() => ({
      id: `response-${sockets.length}`,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }],
    }));
    sockets.push(socket);
    return socket as any;
  }});
  await assert.rejects(
    chat([{ text: 'fail append' }], session('append-failure'), 0, {
      appendMessage: async message => { if (message.role === 'model') throw new Error('append failed'); },
      notifySessionEvents: false, registerAbortController: false, toolDefinitions: [],
    }),
    /append failed/,
  );
  assert.equal(sockets[0].terminated, 1);
  assert.equal(transport.getOpenAIWsCompletedChainCountForTests(), 0);

  await requestLlmOnce({
    contents: [{ role: 'user', parts: [{ text: 'direct' }] }], systemPrompt: 'system', model: 'socket/model',
    promptCacheKey: 'direct-key', toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
  });
  assert.equal(sockets[1].terminated, 1);
  assert.equal(transport.getOpenAIWsCompletedChainCountForTests(), 0);
});

test('refusal normalization conservatively refuses chain reuse', async () => {
  const { chat } = await llmPromise;
  const transport = await transportPromise;
  let socket!: FakeSocket;
  transport.setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket(() => ({
      id: 'refusal-response',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'cannot comply' }] }],
    }));
    return socket as any;
  }});
  const current = session('refusal');
  await chat([{ text: 'request' }], current, 0, {
    appendMessage: async message => { current.history.push(message); },
    notifySessionEvents: false, registerAbortController: false, toolDefinitions: [],
  });
  assert.equal(socket.terminated, 1);
  assert.equal(transport.getOpenAIWsCompletedChainCountForTests(), 0);
});

test('malformed function-call arguments conservatively refuse chain reuse', async () => {
  const { chat } = await llmPromise;
  const transport = await transportPromise;
  let socket!: FakeSocket;
  transport.setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket(() => ({
      id: 'malformed-function-response',
      output: [{ type: 'function_call', call_id: 'call-bad', name: 'read', arguments: '{bad' }],
    }));
    return socket as any;
  }});
  const current = session('malformed-function');
  await chat([{ text: 'request' }], current, 0, {
    appendMessage: async message => { current.history.push(message); },
    notifySessionEvents: false, registerAbortController: false, toolDefinitions: [],
  });
  assert.equal(socket.terminated, 1);
  assert.equal(transport.getOpenAIWsCompletedChainCountForTests(), 0);
});

test('openai-ws rejects transport-owned extra fields, provider storage, and HTTP request compression', async () => {
  const { requestLlmOnce } = await llmPromise;
  const base: {
    contents: Message[]; systemPrompt: string; toolDefinitions: any[];
    notifySessionEvents: boolean; registerAbortController: boolean;
  } = {
    contents: [{ role: 'user', parts: [{ text: 'invalid' }] }], systemPrompt: '', toolDefinitions: [],
    notifySessionEvents: false, registerAbortController: false,
  };
  const entry = (extra: Record<string, any>) => ({
    providerKey: 'fixture', providerType: 'openai-ws', baseUrl: 'https://example.test/v1',
    apiKey: '', model: 'model', extraHeaders: {}, extraFields: {}, ...extra,
  });
  await assert.rejects(
    requestLlmOnce({ ...base, modelEntryOverride: entry({ extraFields: { input: [] } }) as any }),
    /transport-owned field: input/,
  );
  await assert.rejects(
    requestLlmOnce({ ...base, modelEntryOverride: entry({ extraFields: { conversation: 'provider-state' } }) as any }),
    /transport-owned field: conversation/,
  );
  await assert.rejects(
    requestLlmOnce({ ...base, modelEntryOverride: entry({ extraFields: { store: true } }) as any }),
    /requires store:false/,
  );
  await assert.rejects(
    requestLlmOnce({ ...base, modelEntryOverride: entry({ requestCompression: 'gzip' }) as any }),
    /requestCompression is not supported/,
  );
});
