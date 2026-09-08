import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import type { Message, Session } from './types';
import {
  SAFETY_BUFFERING_CONTENT_INACTIVITY_TIMEOUT_MS,
  setStreamingTimeoutTestHooks,
} from './llmStreamingTimeout';

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
  setStreamingTimeoutTestHooks();
  fs.removeSync(dataRoot);
  delete process.env.FOXWARM_DATA_DIR;
});

test('openai-ws safety buffering reaches outer LLM timeout error with metadata and correlated warning', async () => {
  const { requestLlmOnce } = await llmPromise;
  const transport = await transportPromise;
  const diagnostics: Array<{ fields: any; message: string }> = [];
  setStreamingTimeoutTestHooks({
    set(callback, delayMs) {
      const handle = { unref() {} };
      if (delayMs === SAFETY_BUFFERING_CONTENT_INACTIVITY_TIMEOUT_MS) process.nextTick(callback);
      return handle;
    },
    clear() {},
  });
  transport.setOpenAIWsTransportTestHooks({
    diagnosticLogger: {
      info(fields: any, message: string) { diagnostics.push({ fields, message }); },
      warn(fields: any, message: string) { diagnostics.push({ fields, message }); },
    } as any,
    socketFactory: () => {
      const socket = new EventEmitter() as any;
      socket.readyState = WebSocket.CONNECTING;
      socket._socket = { ref() {}, unref() {} };
      socket.send = () => process.nextTick(() => socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.metadata', sequence_number: 1,
        metadata: { type: 'safety_buffering', use_cases: ['fixture'], reasons: ['review'], retry_model: 'fixture-model' },
      }))));
      socket.close = () => {};
      socket.terminate = () => {
        if (socket.readyState === WebSocket.CLOSED) return;
        socket.readyState = WebSocket.CLOSED;
        socket.emit('close', 1006, Buffer.alloc(0));
      };
      process.nextTick(() => { socket.readyState = WebSocket.OPEN; socket.emit('open'); });
      return socket;
    },
  });
  try {
    await assert.rejects(
      requestLlmOnce({
        contents: [{ role: 'user', parts: [{ text: 'fixture' }] }], systemPrompt: '', model: 'socket/model',
        promptCacheKey: 'safety-buffering-ws', toolDefinitions: [], notifySessionEvents: false,
        registerAbortController: false, maxRetries: 1,
      }),
      /after 600000ms\. Safety buffering metadata: \{"type":"safety_buffering","use_cases":\["fixture"\],"reasons":\["review"\],"retry_model":"fixture-model"\}/,
    );
    const warning = diagnostics.find(entry => entry.message === 'OpenAI response entered safety buffering; extending the output inactivity timeout to 600000ms.');
    assert.equal(warning?.fields.purpose, 'low-level');
    assert.equal(typeof warning?.fields.llmRequestId, 'string');
    assert.deepEqual(warning?.fields.metadata, {
      type: 'safety_buffering', use_cases: ['fixture'], reasons: ['review'], retry_model: 'fixture-model',
    });
  } finally {
    transport.setOpenAIWsTransportTestHooks();
    setStreamingTimeoutTestHooks();
  }
});

test('normal chat commits provider replay once and the next turn sends only the new user suffix', async () => {
  const { chat } = await llmPromise;
  const transport = await transportPromise;
  const sockets: FakeSocket[] = [];
  const diagnostics: Array<{ fields: any; message: string }> = [];
  transport.setOpenAIWsTransportTestHooks({
    diagnosticLogger: {
      info(fields: any, message: string) { diagnostics.push({ fields, message }); },
      warn(fields: any, message: string) { diagnostics.push({ fields, message }); },
    } as any,
    socketFactory: () => {
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
  const dispatches = diagnostics.filter(entry => entry.message === 'OpenAI Responses WebSocket request dispatched');
  assert.equal(dispatches.length, 2);
  assert.equal(dispatches[0].fields.sessionId, 'normal');
  assert.equal(dispatches[0].fields.purpose, 'normal-turn');
  assert.equal(dispatches[0].fields.iteration, 0);
  assert.equal(dispatches[1].fields.iteration, 1);
  assert.equal(dispatches[0].fields.attempt, 1);
  assert.match(dispatches[0].fields.llmRequestId, /^[0-9a-f-]{36}$/);
  assert.notEqual(dispatches[0].fields.llmRequestId, dispatches[1].fields.llmRequestId);
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
