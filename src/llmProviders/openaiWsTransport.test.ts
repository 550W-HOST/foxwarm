import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  clearOpenAIWsCompletedChains,
  getOpenAIWsCompletedChainCountForTests,
  requestOpenAIResponsesWs,
  setOpenAIWsTransportTestHooks,
} from './openaiWsTransport';
import { convertToOpenAIResponsesFormat } from './openai';
import type { Message } from '../types';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: any[] = [];
  terminated = 0;
  _socket = { unref() {} };
  constructor(private readonly responder?: (request: any, socket: FakeSocket) => void) {
    super();
    process.nextTick(() => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }
  send(value: string) {
    const parsed = JSON.parse(value);
    this.sent.push(parsed);
    process.nextTick(() => this.responder?.(parsed, this));
  }
  close() { this.terminate(); }
  terminate() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.terminated += 1;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006, Buffer.alloc(0));
  }
  frame(value: any) { this.emit('message', Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))); }
}

function completed(id: string, text = 'ok') {
  return {
    type: 'response.completed',
    response: {
      id,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

function baseData(input: any[], overrides: Record<string, any> = {}) {
  return {
    model: 'gpt-test', instructions: 'system', input, tools: [] as any[], tool_choice: 'auto',
    parallel_tool_calls: true, reasoning: { effort: 'high', summary: 'auto' }, max_output_tokens: 100,
    store: false, include: ['reasoning.encrypted_content'], prompt_cache_key: 'cache', ...overrides,
  };
}

const signal = () => new AbortController().signal;

afterEach(() => setOpenAIWsTransportTestHooks());

test('openai-ws sends a full first request then reuses the exact completed prefix with only the suffix', async () => {
  const sockets: FakeSocket[] = [];
  const handshakes: Array<{ url: string; headers: Record<string, any> }> = [];
  setOpenAIWsTransportTestHooks({
    socketFactory: (url, headers) => {
      handshakes.push({ url, headers });
      const socket = new FakeSocket((_request, current) => current.frame(completed(`resp-${sockets.length}`)));
      sockets.push(socket);
      return socket as any;
    },
  });
  const firstInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
  const first = await requestOpenAIResponsesWs({
    url: 'https://example.test/v1/responses', headers: { Authorization: 'Bearer secret' }, concreteIdentity: 'leaf/model',
    data: baseData(firstInput), placement: 'local', signal: signal(), timeoutMs: 1000,
  });
  first.finalize([{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ok' }] }]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);

  const suffix = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two' }] }];
  const second = await requestOpenAIResponsesWs({
    url: 'https://example.test/v1/responses', headers: { Authorization: 'Bearer secret' }, concreteIdentity: 'leaf/model',
    data: baseData([...firstInput, { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ok' }] }, ...suffix]),
    placement: 'local', signal: signal(), timeoutMs: 1000,
  });
  assert.equal(sockets.length, 1);
  assert.equal(handshakes[0].url, 'wss://example.test/v1/responses');
  assert.deepEqual(handshakes[0].headers, { Authorization: 'Bearer secret' });
  assert.equal(sockets[0].sent[0].type, 'response.create');
  assert.equal(Object.prototype.hasOwnProperty.call(sockets[0].sent[0], 'response'), false);
  assert.deepEqual(sockets[0].sent[0].input, firstInput);
  assert.equal(sockets[0].sent[0].previous_response_id, undefined);
  assert.deepEqual(sockets[0].sent[1].input, suffix);
  assert.equal(sockets[0].sent[1].previous_response_id, 'resp-1');
  second.finalize(false);
});

test('openai-ws invariant or connection changes force a fresh full request', async () => {
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }];
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: { Authorization: 'Bearer a' }, concreteIdentity: 'leaf/a', data: baseData(input), placement: 'local', signal: signal(), timeoutMs: 1000 });
  first.finalize([]);
  const second = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: { Authorization: 'Bearer a' }, concreteIdentity: 'leaf/a', data: baseData(input, { max_output_tokens: 101 }), placement: 'local', signal: signal(), timeoutMs: 1000 });
  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[1].sent[0].input, input);
  second.finalize([]);
  const third = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: { Authorization: 'Bearer changed' }, concreteIdentity: 'leaf/a', data: baseData(input, { max_output_tokens: 101 }), placement: 'local', signal: signal(), timeoutMs: 1000 });
  assert.equal(sockets.length, 3);
  third.finalize(false);
});

test('openai-ws full-plan invariants and compact-style history rewrites cannot reuse a chain', async () => {
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const originalInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'original' }] }];
  const cases: Array<{ data?: Record<string, any>; headers?: Record<string, any>; identity?: string }> = [
    { data: { instructions: 'changed system' } },
    { data: { tools: [{ type: 'function', name: 'read', parameters: {} }] } },
    { data: { model: 'other-model' } },
    { data: { reasoning: { effort: 'max', summary: 'auto' } } },
    { data: { max_output_tokens: 101 } },
    { data: { custom_provider_field: 'changed' } },
    { data: { prompt_cache_key: 'other-cache' } },
    { identity: 'other-leaf/model' },
    { headers: { 'x-route': 'other' } },
    { data: { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rewritten compact history' }] }] } },
  ];
  const seed = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: { 'x-route': 'base' }, concreteIdentity: 'leaf/model', data: baseData(originalInput), placement: 'local', signal: signal(), timeoutMs: 1000 });
  seed.finalize([]);
  for (const variant of cases) {
    const fullData = { ...baseData(originalInput), ...(variant.data || {}) };
    const pending = await requestOpenAIResponsesWs({
      url: 'https://a.test/v1/responses', headers: variant.headers || { 'x-route': 'base' },
      concreteIdentity: variant.identity || 'leaf/model', data: fullData,
      placement: 'local', signal: signal(), timeoutMs: 1000,
    });
    const wire = sockets.at(-1)!.sent[0];
    assert.equal(wire.previous_response_id, undefined);
    assert.deepEqual(wire.input, fullData.input);
    pending.finalize([]);
  }
  assert.equal(sockets.length, cases.length + 1);
});

test('openai-ws assistant reasoning, hosted search, and tool-call replay stay in the prefix while function output is sent once', async () => {
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search then read' }] };
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'leaf/model', data: baseData([user]), placement: 'local', signal: signal(), timeoutMs: 1000 });
  const assistant: Message = {
    role: 'model',
    __meta: { modelId: 'leaf/model' },
    parts: [
      { thinking: 'checked', providerMeta: { thinkingSummaries: ['checked'], encryptedThinking: 'encrypted' } },
      { providerMeta: { openaiResponses: { sourceModelId: 'leaf/model', outputItem: { type: 'web_search_call', id: 'ws1', status: 'completed' } } } },
      { text: 'I found it.', providerMeta: { openaiResponses: { sourceModelId: 'leaf/model', annotations: [{ type: 'url_citation', url: 'https://example.test' }] } } },
      { functionCall: { id: 'call1', name: 'read', args: { filePath: 'README.md' } } },
    ],
  };
  const replay = convertToOpenAIResponsesFormat([assistant], 'leaf/model');
  first.finalize(replay);
  const toolOutput = { type: 'function_call_output', call_id: 'call1', output: 'done' };
  const second = await requestOpenAIResponsesWs({
    url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'leaf/model',
    data: baseData([user, ...replay, toolOutput]), placement: 'local', signal: signal(), timeoutMs: 1000,
  });
  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].sent[1].input, [toolOutput]);
  assert.equal(sockets[0].sent[1].input.filter((item: any) => item.type === 'function_call_output').length, 1);
  second.finalize(false);
});

test('openai-ws keeps busy chains outside matching and enforces worker idle limit one', async () => {
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }];
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData(input), placement: 'session-worker', signal: signal(), timeoutMs: 1000 });
  first.finalize([]);
  const busy = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData(input), placement: 'session-worker', signal: signal(), timeoutMs: 1000 });
  const parallel = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData(input), placement: 'session-worker', signal: signal(), timeoutMs: 1000 });
  assert.equal(sockets.length, 2);
  busy.finalize([]);
  parallel.finalize([]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);
  assert.equal(sockets.filter(socket => socket.terminated > 0).length, 1);
});

test('openai-ws rotates a completed chain at the sixty-minute boundary', async () => {
  let clock = 0;
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ now: () => clock, socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const data = baseData([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }]);
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data, placement: 'local', signal: signal(), timeoutMs: 1000 });
  first.finalize([]);
  clock = 60 * 60 * 1000;
  const second = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data, placement: 'local', signal: signal(), timeoutMs: 1000 });
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].terminated, 1);
  second.finalize(false);
});

test('openai-ws abort, malformed frames, and mid-stream close discard the leased socket', async () => {
  for (const mode of ['abort', 'malformed', 'close'] as const) {
    let socket!: FakeSocket;
    setOpenAIWsTransportTestHooks({ socketFactory: () => {
      socket = new FakeSocket((_request, current) => {
        if (mode === 'malformed') current.frame('{bad');
        if (mode === 'close') current.terminate();
      });
      return socket as any;
    }});
    const controller = new AbortController();
    const pending = requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: controller.signal, timeoutMs: 1000 });
    if (mode === 'abort') process.nextTick(() => controller.abort());
    await assert.rejects(pending, mode === 'abort' ? /abort/i : /malformed|closed/i);
    assert.equal(socket.terminated, 1);
    assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  }
});

test('openai-ws failed, error, and incomplete terminal events invalidate the chain', async () => {
  for (const mode of ['failed', 'error', 'incomplete'] as const) {
    let socket!: FakeSocket;
    setOpenAIWsTransportTestHooks({ socketFactory: () => {
      socket = new FakeSocket((_request, current) => {
        if (mode === 'failed') current.frame({ type: 'response.failed', response: { error: { message: 'failed response' } } });
        if (mode === 'error') current.frame({ type: 'response.error', error: { message: 'provider error' } });
        if (mode === 'incomplete') current.frame({ ...completed('incomplete'), response: { ...completed('incomplete').response, status: 'incomplete' } });
      });
      return socket as any;
    }});
    await assert.rejects(
      requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal(), timeoutMs: 1000 }),
      /failed response|provider error|incomplete completion/,
    );
    assert.equal(socket.terminated, 1);
    assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  }
});

test('explicit cleanup closes idle sockets and removes process-owned resources', async () => {
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket((_request, current) => current.frame(completed('r1')));
    return socket as any;
  }});
  const pending = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal(), timeoutMs: 1000 });
  pending.finalize([]);
  clearOpenAIWsCompletedChains();
  assert.equal(socket.terminated, 1);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
});

test('idle socket close removes its completed chain immediately', async () => {
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket((_request, current) => current.frame(completed('r1')));
    return socket as any;
  }});
  const pending = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal(), timeoutMs: 1000 });
  pending.finalize([]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);
  socket.terminate();
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
});
