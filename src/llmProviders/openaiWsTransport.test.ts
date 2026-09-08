import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  clearOpenAIWsCompletedChains,
  getOpenAIWsCompletedChainCountForTests,
  requestOpenAIResponsesWs,
  setOpenAIWsTransportTestHooks,
} from './openaiWsTransport';
import { convertToOpenAIResponsesFormat } from './openai';
import type { Message } from '../types';
import {
  DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
  DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS,
  setStreamingTimeoutTestHooks,
} from '../llmStreamingTimeout';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: any[] = [];
  terminated = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  refs = 0;
  unrefs = 0;
  _socket = { ref: () => { this.refs += 1; }, unref: () => { this.unrefs += 1; } };
  constructor(private readonly responder?: (request: any, socket: FakeSocket) => void, autoOpen = true) {
    super();
    if (autoOpen) process.nextTick(() => {
      this.readyState = WebSocket.OPEN;
      this.emit('open');
    });
  }
  send(value: string) {
    const parsed = JSON.parse(value);
    this.sent.push(parsed);
    process.nextTick(() => this.responder?.(parsed, this));
  }
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
  }
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

class FakeIdleTimers {
  entries: Array<{ callback: () => void; delayMs: number; cleared: boolean; unrefs: number; timer: any }> = [];
  hooks = {
    set: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, cleared: false, unrefs: 0, timer: undefined as any };
      entry.timer = { unref: () => { entry.unrefs += 1; } };
      this.entries.push(entry);
      return entry.timer;
    },
    clear: (timer: any) => {
      const entry = this.entries.find(candidate => timer === candidate.timer);
      if (entry) entry.cleared = true;
    },
  };
}

function captureDiagnostics() {
  const entries: Array<{ level: 'info' | 'warn'; fields: any; message: string }> = [];
  return {
    entries,
    logger: {
      info(fields: any, message: string) { entries.push({ level: 'info', fields, message }); },
      warn(fields: any, message: string) { entries.push({ level: 'warn', fields, message }); },
    } as any,
  };
}

afterEach(() => {
  setOpenAIWsTransportTestHooks();
  setStreamingTimeoutTestHooks();
});

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
    data: baseData(firstInput), placement: 'local', signal: signal(), hardTimeoutMs: 1000,
  });
  first.finalize([{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ok' }] }]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);

  const suffix = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two' }] }];
  const second = await requestOpenAIResponsesWs({
    url: 'https://example.test/v1/responses', headers: { Authorization: 'Bearer secret' }, concreteIdentity: 'leaf/model',
    data: baseData([...firstInput, { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ok' }] }, ...suffix]),
    placement: 'local', signal: signal(), hardTimeoutMs: 1000,
  });
  assert.equal(sockets.length, 1);
  assert.equal(handshakes[0].url, 'wss://example.test/v1/responses');
  assert.deepEqual(handshakes[0].headers, { Authorization: 'Bearer secret' });
  assert.equal(sockets[0].sent[0].type, 'response.create');
  assert.equal(Object.prototype.hasOwnProperty.call(sockets[0].sent[0], 'response'), false);
  assert.equal(sockets[0].sent[0].max_output_tokens, 100);
  assert.deepEqual(sockets[0].sent[0].input, firstInput);
  assert.equal(sockets[0].sent[0].previous_response_id, undefined);
  assert.deepEqual(sockets[0].sent[1].input, suffix);
  assert.equal(sockets[0].sent[1].previous_response_id, 'resp-1');
  assert.equal(Object.prototype.hasOwnProperty.call(sockets[0].sent[1], 'max_output_tokens'), false);
  second.finalize(false);
});

test('openai-ws diagnostics correlate fresh, reused, completion, discard, and close without request secrets', async () => {
  const diagnostics = captureDiagnostics();
  const sockets: FakeSocket[] = [];
  let clock = 1_000;
  setOpenAIWsTransportTestHooks({
    now: () => ++clock,
    diagnosticLogger: diagnostics.logger,
    socketFactory: () => {
      const socket = new FakeSocket((_request, current) => {
        current.frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'DO_NOT_LOG_CONTENT_SENTINEL' });
        current.frame(completed(`DO_NOT_LOG_RESPONSE_ID_SENTINEL-${current.sent.length}`));
      });
      sockets.push(socket);
      return socket as any;
    },
  });
  const context = { sessionId: 'session-1', purpose: 'chat', llmRequestId: 'request-1', iteration: 3, attempt: 2 };
  const firstInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'DO_NOT_LOG_PROMPT_SENTINEL' }] }];
  const replay = [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'DO_NOT_LOG_CONTENT_SENTINEL' }] }];
  const first = await requestOpenAIResponsesWs({
    url: 'https://example.test/v1/responses?credential=DO_NOT_LOG_URL_SENTINEL',
    headers: { Authorization: 'DO_NOT_LOG_HEADER_SENTINEL' }, concreteIdentity: 'leaf/model',
    data: baseData(firstInput, { instructions: 'DO_NOT_LOG_INSTRUCTION_SENTINEL' }), placement: 'local', signal: signal(),
    hardTimeoutMs: 1000, diagnostics: context,
  });
  first.finalize(replay);
  clock += 25;
  const second = await requestOpenAIResponsesWs({
    url: 'https://example.test/v1/responses?credential=DO_NOT_LOG_URL_SENTINEL',
    headers: { Authorization: 'DO_NOT_LOG_HEADER_SENTINEL' }, concreteIdentity: 'leaf/model',
    data: baseData([...firstInput, ...replay], { instructions: 'DO_NOT_LOG_INSTRUCTION_SENTINEL' }), placement: 'local', signal: signal(),
    hardTimeoutMs: 1000, diagnostics: { ...context, iteration: 4, attempt: 1 },
  });
  second.finalize(false);

  assert.equal(sockets.length, 1);
  const dispatches = diagnostics.entries.filter(entry => entry.message === 'OpenAI Responses WebSocket request dispatched');
  const completions = diagnostics.entries.filter(entry => entry.message === 'OpenAI Responses WebSocket request completed');
  const discards = diagnostics.entries.filter(entry => entry.message === 'OpenAI Responses WebSocket attempt discarded');
  const closes = diagnostics.entries.filter(entry => entry.message.includes('closed locally'));
  assert.equal(dispatches.length, 2);
  assert.equal(completions.length, 2);
  assert.equal(discards.length, 1);
  assert.equal(closes.length, 1);
  assert.ok(dispatches.every(entry => entry.level === 'info'));
  assert.ok(completions.every(entry => entry.level === 'info'));
  assert.equal(discards[0].level, 'warn');
  assert.equal(closes[0].level, 'info');
  assert.equal(dispatches[0].fields.connectionMode, 'fresh');
  assert.equal(dispatches[0].fields.appendFromItemIndex, 0);
  assert.equal(dispatches[1].fields.connectionMode, 'reused');
  assert.equal(dispatches[1].fields.appendFromItemIndex, 2);
  assert.equal(dispatches[1].fields.sentInputItemCount, 0);
  assert.ok(dispatches[1].fields.idleBeforeReuseMs >= 25);
  assert.equal(dispatches[0].fields.socketId, dispatches[1].fields.socketId);
  assert.equal(dispatches[1].fields.sessionId, 'session-1');
  assert.equal(dispatches[1].fields.llmRequestId, 'request-1');
  assert.equal(dispatches[1].fields.iteration, 4);
  assert.equal(dispatches[1].fields.attempt, 1);
  assert.equal(typeof dispatches[0].fields.connectionOpenedAt, 'number');
  assert.equal(typeof dispatches[0].fields.createSentAt, 'number');
  assert.equal(completions[0].fields.frameCount, 2);
  assert.ok(completions[0].fields.frameBytes > 0);
  assert.equal(typeof completions[0].fields.firstFrameElapsedMs, 'number');
  assert.equal(typeof completions[0].fields.firstContentElapsedMs, 'number');
  assert.equal(discards[0].fields.discardCause, 'finalizer-discard');
  assert.equal(closes[0].fields.closeCause, 'finalizer-discard');
  const serialized = JSON.stringify(diagnostics.entries);
  for (const sentinel of ['DO_NOT_LOG_URL_SENTINEL', 'DO_NOT_LOG_HEADER_SENTINEL', 'DO_NOT_LOG_PROMPT_SENTINEL', 'DO_NOT_LOG_INSTRUCTION_SENTINEL', 'DO_NOT_LOG_RESPONSE_ID_SENTINEL', 'DO_NOT_LOG_CONTENT_SENTINEL']) {
    assert.equal(serialized.includes(sentinel), false, `diagnostics leaked ${sentinel}`);
  }
});

test('openai-ws diagnostics retain bounded upstream close code, reason, and physical attempt context', async () => {
  const diagnostics = captureDiagnostics();
  setOpenAIWsTransportTestHooks({
    diagnosticLogger: diagnostics.logger,
    socketFactory: () => new FakeSocket((_request, current) => {
      current.readyState = WebSocket.CLOSED;
      current.emit('close', 1011, Buffer.from(`upstream websocket proxy failed\n${'x'.repeat(400)}`));
    }) as any,
  });
  await assert.rejects(requestOpenAIResponsesWs({
    url: 'https://example.test/v1/responses', headers: {}, concreteIdentity: 'leaf/model',
    data: baseData([]), placement: 'local', signal: signal(), diagnostics: {
      sessionId: 'session-close', purpose: 'chat', llmRequestId: 'request-close', iteration: 7, attempt: 1,
    },
  }), /closed before completion/);
  const close = diagnostics.entries.find(entry => entry.message === 'OpenAI Responses WebSocket closed by upstream');
  const discard = diagnostics.entries.find(entry => entry.message === 'OpenAI Responses WebSocket attempt discarded');
  assert.ok(close);
  assert.equal(close.level, 'warn');
  assert.equal(close.fields.closeCode, 1011);
  assert.equal(close.fields.closeCause, 'active-upstream-close');
  assert.equal(close.fields.closePhase, 'active');
  assert.match(close.fields.closeReason, /^upstream websocket proxy failed/);
  assert.ok(close.fields.closeReason.length <= 241);
  assert.equal(close.fields.frameCount, 0);
  assert.equal(close.fields.frameBytes, 0);
  assert.equal(typeof close.fields.elapsedSinceCreateMs, 'number');
  assert.equal(close.fields.sessionId, 'session-close');
  assert.equal(close.fields.llmRequestId, 'request-close');
  assert.equal(discard?.fields.discardCause, 'active-upstream-close');
});

test('openai-ws diagnostic sink failures cannot change request or cleanup behavior', async () => {
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({
    diagnosticLogger: {
      info() { throw new Error('diagnostic sink unavailable'); },
      warn() { throw new Error('diagnostic sink unavailable'); },
    } as any,
    socketFactory: () => {
      socket = new FakeSocket((_request, current) => current.frame(completed('sink-failure')));
      return socket as any;
    },
  });
  const pending = await requestOpenAIResponsesWs({
    url: 'https://example.test/v1/responses', headers: {}, concreteIdentity: 'leaf/model',
    data: baseData([]), placement: 'local', signal: signal(),
  });
  pending.finalize(false);
  assert.equal(socket.terminated, 1);
});

test('openai-ws invariant or connection changes force a fresh full request', async () => {
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }];
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: { Authorization: 'Bearer a' }, concreteIdentity: 'leaf/a', data: baseData(input), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  first.finalize([]);
  const second = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: { Authorization: 'Bearer a' }, concreteIdentity: 'leaf/a', data: baseData(input, { max_output_tokens: 101 }), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  assert.equal(sockets.length, 2);
  assert.deepEqual(sockets[1].sent[0].input, input);
  second.finalize([]);
  const third = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: { Authorization: 'Bearer changed' }, concreteIdentity: 'leaf/a', data: baseData(input, { max_output_tokens: 101 }), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
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
  const seed = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: { 'x-route': 'base' }, concreteIdentity: 'leaf/model', data: baseData(originalInput), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  seed.finalize([]);
  for (const variant of cases) {
    const fullData = { ...baseData(originalInput), ...(variant.data || {}) };
    const pending = await requestOpenAIResponsesWs({
      url: 'https://a.test/v1/responses', headers: variant.headers || { 'x-route': 'base' },
      concreteIdentity: variant.identity || 'leaf/model', data: fullData,
      placement: 'local', signal: signal(), hardTimeoutMs: 1000,
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
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'leaf/model', data: baseData([user]), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  const assistant: Message = {
    role: 'model',
    __meta: { modelId: 'leaf/model' },
    parts: [
      { thinking: 'checked', providerMeta: { thinkingSummaries: ['checked'], encryptedThinking: 'encrypted' } },
      { providerMeta: { openaiResponses: { sourceModelId: 'leaf/model', outputItem: { type: 'web_search_call', id: 'ws1', status: 'completed' } } } },
      { text: 'I found it.', phase: 'commentary', providerMeta: { openaiResponses: { sourceModelId: 'leaf/model', annotations: [{ type: 'url_citation', url: 'https://example.test' }] } } },
      { functionCall: { id: 'call1', name: 'read', args: { filePath: 'README.md' } } },
      { text: 'Read complete.', phase: 'final_answer' },
    ],
  };
  const replay = convertToOpenAIResponsesFormat([assistant], 'leaf/model');
  assert.deepEqual(replay.filter((item: any) => item.type === 'message').map((item: any) => item.phase), ['commentary', 'final_answer']);
  first.finalize(replay);
  const toolOutput = { type: 'function_call_output', call_id: 'call1', output: 'done' };
  const second = await requestOpenAIResponsesWs({
    url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'leaf/model',
    data: baseData([user, ...replay, toolOutput]), placement: 'local', signal: signal(), hardTimeoutMs: 1000,
  });
  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].sent[1].input, [toolOutput]);
  assert.equal(sockets[0].sent[1].input.filter((item: any) => item.type === 'function_call_output').length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(sockets[0].sent[1], 'max_output_tokens'), false);
  second.finalize(false);
});

test('openai-ws continuation omits only the wire cap while failure recovery restores the full cap', async () => {
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket((_request, current) => {
      if (sockets.length === 1 && current.sent.length === 2) current.terminate();
      else current.frame(completed(`r${sockets.length}`));
    });
    sockets.push(socket); return socket as any;
  }});
  const firstInput = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'one' }] }];
  const firstData = baseData(firstInput);
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: firstData, placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  first.finalize([]);
  const nextData = baseData([...firstInput, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two' }] }]);
  await assert.rejects(
    requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: nextData, placement: 'local', signal: signal(), hardTimeoutMs: 1000 }),
    /closed before completion/,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(sockets[0].sent[1], 'max_output_tokens'), false);
  assert.equal(nextData.max_output_tokens, 100);

  const recovered = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: nextData, placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1].sent[0].previous_response_id, undefined);
  assert.equal(sockets[1].sent[0].max_output_tokens, 100);
  assert.equal(nextData.max_output_tokens, 100);
  recovered.finalize(false);
});

test('openai-ws keeps busy chains outside matching and enforces worker idle limit one', async () => {
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }];
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData(input), placement: 'session-worker', signal: signal(), hardTimeoutMs: 1000 });
  first.finalize([]);
  const busy = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData(input), placement: 'session-worker', signal: signal(), hardTimeoutMs: 1000 });
  const parallel = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData(input), placement: 'session-worker', signal: signal(), hardTimeoutMs: 1000 });
  assert.equal(sockets.length, 2);
  busy.finalize([]);
  parallel.finalize([]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);
  assert.equal(sockets.filter(socket => socket.closeCalls.length > 0).length, 1);
  assert.equal(sockets.filter(socket => socket.terminated > 0).length, 0);
});

test('openai-ws rotates a completed chain at the sixty-minute boundary', async () => {
  let clock = 0;
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ now: () => clock, socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const data = baseData([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }]);
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data, placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  first.finalize([]);
  clock = 60 * 60 * 1000;
  const second = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data, placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].terminated, 0);
  assert.deepEqual(sockets[0].closeCalls, [{ code: 1000, reason: 'OK' }]);
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
    const pending = requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: controller.signal, hardTimeoutMs: 1000 });
    if (mode === 'abort') process.nextTick(() => controller.abort());
    await assert.rejects(pending, mode === 'abort' ? /abort/i : /malformed|closed/i);
    assert.equal(socket.terminated, 1);
    assert.equal(socket.closeCalls.length, 0);
    assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  }
});

test('openai-ws failed, error, and incomplete terminal events invalidate the chain', async () => {
  for (const mode of ['failed', 'error', 'incomplete', 'compatibility-error'] as const) {
    let socket!: FakeSocket;
    setOpenAIWsTransportTestHooks({ socketFactory: () => {
      socket = new FakeSocket((_request, current) => {
        if (mode === 'failed') current.frame({ type: 'response.failed', response: { error: { message: 'failed response' } } });
        if (mode === 'error') current.frame({ type: 'error', message: 'provider error', status: 500, code: 'server_error' });
        if (mode === 'incomplete') current.frame({ type: 'response.incomplete', response: { status: 'incomplete', error: { message: 'incomplete response', code: 'max_output_tokens' } } });
        if (mode === 'compatibility-error') current.frame({ type: 'response.error', error: { message: 'compatible provider error' } });
      });
      return socket as any;
    }});
    const startedAt = Date.now();
    await assert.rejects(
      requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal(), hardTimeoutMs: 5000 }),
      /failed response|provider error|incomplete response|compatible provider error/,
    );
    assert.ok(Date.now() - startedAt < 1000, `${mode} should reject immediately rather than waiting for timeout`);
    assert.equal(socket.terminated, 1);
    assert.equal(socket.closeCalls.length, 0);
    assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  }
});

test('explicit cleanup closes idle sockets and removes process-owned resources', async () => {
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket((_request, current) => current.frame(completed('r1')));
    return socket as any;
  }});
  const pending = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  pending.finalize([]);
  clearOpenAIWsCompletedChains();
  assert.equal(socket.terminated, 0);
  assert.deepEqual(socket.closeCalls, [{ code: 1000, reason: 'OK' }]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  assert.doesNotThrow(() => socket.emit('error', new Error('late cleanup error')));
  assert.doesNotThrow(() => socket.emit('close', 1000, Buffer.alloc(0)));
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
});

test('idle socket close removes its completed chain immediately', async () => {
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket((_request, current) => current.frame(completed('r1')));
    return socket as any;
  }});
  const pending = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  pending.finalize([]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);
  socket.terminate();
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
});

test('aborting an active WS request rejects normally without an uncaught PassThrough error', async () => {
  const modulePath = path.join(__dirname, 'openaiWsTransport.js');
  const script = `
    const { EventEmitter } = require('events');
    const WebSocket = require('ws');
    const transport = require(${JSON.stringify(modulePath)});
    class FakeSocket extends EventEmitter {
      constructor() { super(); this.readyState = WebSocket.CONNECTING; this._socket = { ref() {}, unref() {} }; process.nextTick(() => { this.readyState = WebSocket.OPEN; this.emit('open'); }); }
      send() {}
      close() { this.terminate(); }
      terminate() { if (this.readyState === WebSocket.CLOSED) return; this.readyState = WebSocket.CLOSED; this.emit('close', 1006, Buffer.alloc(0)); }
    }
    process.once('uncaughtException', error => { console.error('UNCAUGHT:' + error.stack); process.exit(7); });
    transport.setOpenAIWsTransportTestHooks({ socketFactory: () => new FakeSocket() });
    const controller = new AbortController();
    const pending = transport.requestOpenAIResponsesWs({
      url: 'https://example.test/v1/responses', headers: {}, concreteIdentity: 'leaf/model',
      data: { model: 'm', input: [], store: false }, placement: 'local', signal: controller.signal, timeoutMs: 1000,
    });
    setImmediate(() => controller.abort());
    pending.then(
      () => process.exit(8),
      error => setImmediate(() => {
        transport.clearOpenAIWsCompletedChains();
        if (error && error.name === 'AbortError') process.exit(0);
        console.error('WRONG_REJECTION:' + (error && error.stack || error));
        process.exit(9);
      }),
    );
  `;
  const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.dirname(__dirname) });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /UNCAUGHT:/);
});

test('aborting a real WebSocket during a held opening handshake has no deferred uncaught error', async () => {
  const modulePath = path.join(__dirname, 'openaiWsTransport.js');
  const script = `
    const net = require('net');
    const transport = require(${JSON.stringify(modulePath)});
    const heldSockets = new Set();
    process.once('uncaughtException', error => { console.error('UNCAUGHT:' + error.stack); process.exit(7); });
    process.once('unhandledRejection', error => { console.error('UNHANDLED:' + (error && error.stack || error)); process.exit(8); });
    setTimeout(() => { console.error('TEST_TIMEOUT'); process.exit(10); }, 2000).unref();
    const server = net.createServer(socket => { heldSockets.add(socket); socket.once('close', () => heldSockets.delete(socket)); });
    server.listen(0, '127.0.0.1', async () => {
      const controller = new AbortController();
      const pending = transport.requestOpenAIResponsesWs({
        url: 'ws://127.0.0.1:' + server.address().port + '/v1/responses',
        headers: {}, concreteIdentity: 'held-handshake',
        data: { model: 'm', input: [], store: false }, placement: 'local', signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 25);
      try {
        await pending;
        process.exit(9);
      } catch (error) {
        if (!error || error.name !== 'AbortError') {
          console.error('WRONG_REJECTION:' + (error && error.stack || error));
          process.exit(11);
        }
        setTimeout(() => {
          if (transport.getOpenAIWsCompletedChainCountForTests() !== 0) process.exit(12);
          for (const socket of heldSockets) socket.destroy();
          server.close();
          process.exit(0);
        }, 50);
      }
    });
  `;
  const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.dirname(__dirname) });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /UNCAUGHT:|UNHANDLED:|TEST_TIMEOUT/);
});

test('active and pending-append sockets stay referenced, idle sockets unref, and reuse refs again', async () => {
  const sockets: FakeSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`r${sockets.length}`)));
    sockets.push(socket); return socket as any;
  }});
  const data = baseData([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'one' }] }]);
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data, placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  assert.equal(sockets[0].refs, 1);
  assert.equal(sockets[0].unrefs, 0);
  first.finalize([]);
  assert.equal(sockets[0].unrefs, 1);
  const second = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data, placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  assert.equal(sockets[0].refs, 2);
  second.finalize(false);
});

test('close after response.completed but before assistant append invalidates the pending chain', async () => {
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket((_request, current) => current.frame(completed('pending-close')));
    return socket as any;
  }});
  const pending = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  socket.terminate();
  pending.finalize([]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
});

test('openai-ws first-activity watchdog covers handshake and ignores unrelated response scaffolding', async () => {
  for (const mode of ['handshake', 'scaffolding'] as const) {
    const timers = new FakeIdleTimers();
    setStreamingTimeoutTestHooks(timers.hooks);
    let socket!: FakeSocket;
    setOpenAIWsTransportTestHooks({ socketFactory: () => {
      socket = new FakeSocket(mode === 'scaffolding' ? (_request, current) => {
        current.frame({ type: 'response.created', response: { id: 'r1', status: 'in_progress' } });
        current.frame({ type: 'response.in_progress', response: { id: 'r1', status: 'in_progress' } });
        current.frame({ type: 'response.output_item.added', output_index: 0 });
        current.frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '' });
      } : undefined, mode !== 'handshake');
      return socket as any;
    }});
    const pending = requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal() });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.entries.length, 1);
    assert.equal(timers.entries[0].delayMs, DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS);
    timers.entries[0].callback();
    await assert.rejects(pending, /before first meaningful generated content/);
    assert.equal(socket.terminated, 1);
  }
});

test('openai-ws meaningful deltas switch to and reset the two-minute inactivity watchdog', async () => {
  const timers = new FakeIdleTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket((_request, current) => {
      current.frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'a' });
      current.frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'a' });
      current.frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'b' });
    });
    return socket as any;
  }});
  const pending = requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal() });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.entries.map(entry => entry.delayMs), [
    DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS,
    DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
    DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
  ]);
  assert.equal(timers.entries[0].cleared, true);
  assert.equal(timers.entries[1].cleared, true);
  timers.entries[1].callback();
  assert.equal(socket.terminated, 0);
  timers.entries[2].callback();
  await assert.rejects(pending, /between meaningful generated content increments after 120000ms/);
  assert.equal(socket.terminated, 1);
});

test('openai-ws reasoning-summary-only deltas reset inactivity without a presentation subscriber', async () => {
  const timers = new FakeIdleTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket((_request, current) => {
      current.frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'first' });
      current.frame({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'first' });
      current.frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: ' second' });
    });
    return socket as any;
  }});
  const pending = requestOpenAIResponsesWs({
    url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a',
    data: baseData([]), placement: 'local', signal: signal(),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.entries.map(entry => entry.delayMs), [
    DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS,
    DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
    DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
  ]);
  assert.equal(timers.entries[0].cleared, true);
  assert.equal(timers.entries[1].cleared, true);
  timers.entries[1].callback();
  assert.equal(socket.terminated, 0);
  timers.entries[2].callback();
  await assert.rejects(pending, /between meaningful generated content increments after 120000ms/);
  assert.equal(socket.terminated, 1);
});

test('openai-ws valid output-item added and done events reset inactivity while invalid scaffolding does not', async () => {
  const timers = new FakeIdleTimers();
  setStreamingTimeoutTestHooks(timers.hooks);
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    socket = new FakeSocket((_request, current) => {
      current.frame({ type: 'response.created', response: { id: 'r1', status: 'in_progress' } });
      current.frame({ type: 'response.output_item.added', output_index: 0 });
      current.frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'read', arguments: '' } });
      current.frame({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '' });
      current.frame({ type: 'response.metadata', response_id: 'r1', sequence_number: 4, metadata: { type: 'safety_buffering' } });
      current.frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'read', arguments: '' } });
    });
    return socket as any;
  }});
  const pending = requestOpenAIResponsesWs({
    url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a',
    data: baseData([]), placement: 'local', signal: signal(),
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(timers.entries.map(entry => entry.delayMs), [
    DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS,
    DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
    DEFAULT_STREAM_CONTENT_INACTIVITY_TIMEOUT_MS,
  ]);
  assert.equal(timers.entries[0].cleared, true);
  assert.equal(timers.entries[1].cleared, true);
  timers.entries[1].callback();
  assert.equal(socket.terminated, 0);
  timers.entries[2].callback();
  await assert.rejects(pending, /between meaningful generated content increments after 120000ms/);
  assert.equal(socket.terminated, 1);
});

test('completed idle chains actively expire and close after ten minutes without another request', async () => {
  const timers = new FakeIdleTimers();
  const diagnostics = captureDiagnostics();
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ idleTimers: timers.hooks, diagnosticLogger: diagnostics.logger, socketFactory: () => {
    socket = new FakeSocket((_request, current) => current.frame(completed('idle-expiry')));
    return socket as any;
  }});
  const pending = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data: baseData([]), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  assert.equal(timers.entries.length, 0);
  pending.finalize([]);
  assert.equal(timers.entries.length, 1);
  assert.equal(timers.entries[0].delayMs, 10 * 60 * 1000);
  assert.equal(timers.entries[0].unrefs, 1);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);
  timers.entries[0].callback();
  assert.equal(socket.terminated, 0);
  assert.deepEqual(socket.closeCalls, [{ code: 1000, reason: 'OK' }]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  assert.doesNotThrow(() => socket.emit('error', new Error('late close-handshake error')));
  assert.equal(socket.terminated, 0);
  assert.doesNotThrow(() => socket.emit('close', 1000, Buffer.alloc(0)));
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  const close = diagnostics.entries.find(entry => entry.message === 'OpenAI Responses WebSocket closed locally');
  assert.equal(close?.fields.closeCause, 'idle-timeout');
  assert.equal(close?.fields.closePhase, 'idle');
  assert.equal(typeof close?.fields.idleDurationMs, 'number');
});

test('completed-idle recycling completes a real WebSocket close handshake with code 1000', async () => {
  const timers = new FakeIdleTimers();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const serverClose = new Promise<{ code: number; reason: string }>(resolve => {
    server.once('connection', socket => {
      socket.once('message', () => socket.send(JSON.stringify(completed('real-close'))));
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    });
  });
  setOpenAIWsTransportTestHooks({ idleTimers: timers.hooks });
  try {
    const pending = await requestOpenAIResponsesWs({
      url: `ws://127.0.0.1:${address.port}/v1/responses`, headers: {}, concreteIdentity: 'real-close',
      data: baseData([]), placement: 'local', signal: signal(), hardTimeoutMs: 1000,
    });
    pending.finalize([]);
    assert.equal(timers.entries.length, 1);
    timers.entries[0].callback();
    assert.deepEqual(await serverClose, { code: 1000, reason: 'OK' });
    assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('reuse cancels the old idle timer and successful release starts a fresh idle period', async () => {
  const timers = new FakeIdleTimers();
  let socket!: FakeSocket;
  setOpenAIWsTransportTestHooks({ idleTimers: timers.hooks, socketFactory: () => {
    socket = new FakeSocket((_request, current) => current.frame(completed(`reuse-${current.sent.length}`)));
    return socket as any;
  }});
  const data = baseData([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'reuse' }] }]);
  const first = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data, placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  first.finalize([]);
  const oldTimer = timers.entries[0];
  const second = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: 'a', data, placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
  assert.equal(oldTimer.cleared, true);
  assert.equal(timers.entries.length, 1);
  oldTimer.callback();
  assert.equal(socket.terminated, 0);
  assert.equal(socket.closeCalls.length, 0);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  second.finalize([]);
  assert.equal(timers.entries.length, 2);
  assert.equal(timers.entries[1].cleared, false);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);
  timers.entries[1].callback();
  assert.equal(socket.terminated, 0);
  assert.equal(socket.closeCalls.length, 1);
});

test('LRU eviction and pool clear cancel every affected idle timer', async () => {
  const timers = new FakeIdleTimers();
  const diagnostics = captureDiagnostics();
  const sockets: FakeSocket[] = [];
  let clock = 0;
  setOpenAIWsTransportTestHooks({ idleTimers: timers.hooks, now: () => ++clock, diagnosticLogger: diagnostics.logger, socketFactory: () => {
    const socket = new FakeSocket((_request, current) => current.frame(completed(`lru-${sockets.length}`)));
    sockets.push(socket);
    return socket as any;
  }});
  for (let index = 0; index < 6; index += 1) {
    const pending = await requestOpenAIResponsesWs({ url: 'https://a.test/v1/responses', headers: {}, concreteIdentity: `leaf-${index}`, data: baseData([]), placement: 'local', signal: signal(), hardTimeoutMs: 1000 });
    pending.finalize([]);
  }
  assert.equal(timers.entries.length, 6);
  assert.equal(timers.entries[0].cleared, true);
  assert.equal(sockets[0].terminated, 0);
  assert.deepEqual(sockets[0].closeCalls, [{ code: 1000, reason: 'OK' }]);
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 5);
  clearOpenAIWsCompletedChains();
  assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
  assert.ok(timers.entries.every(entry => entry.cleared));
  assert.ok(sockets.every(socket => socket.terminated === 0));
  assert.ok(sockets.every(socket => socket.closeCalls.length === 1));
  const closeCauses = diagnostics.entries
    .filter(entry => entry.message === 'OpenAI Responses WebSocket closed locally')
    .map(entry => entry.fields.closeCause);
  assert.equal(closeCauses.filter(cause => cause === 'lru-eviction').length, 1);
  assert.equal(closeCauses.filter(cause => cause === 'pool-clear').length, 5);
});
