import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import sharp from 'sharp';
import path from 'path';
import os from 'os';

import { createDefaultCurrentSessionEffects, createModelStreamEventEmitter, CurrentSessionEffects, DEFAULT_LLM_MAX_RETRIES, LlmRequestError, chat, convertToAnthropicFormat, ensurePromptCacheKey, getLlmRetryDelayMs, redactProviderImagesForLog, requestLlmOnce, sanitizeProviderRequestPayload } from './llm';
import { loadModelsConfigFromObject, LOGS_DIR, MAX_OUTPUT } from './config';
import * as configModule from './config';
import { formatDate } from './logRotation';
import type { Message, Session } from './types';
import { containsLoneSurrogate } from './utils/unicode';
import * as sessionManager from './sessionManager';
import { loadSessionsMetadataSnapshot, readSessionHistorySnapshot } from './session/metadataStore';
import { putImageBlob, resolveImageBlobPath } from './imageBlobs';
import fs from 'fs-extra';
import { reconstructLlmRequest, setLlmRequestJournalFaultInjectorForTests } from './llmRequestJournal';
import { LocalSessionTurnHost } from './sessionTurnRunner';
import * as tools from './tools';
import * as llmModule from './llm';
import { nodesManager } from './nodes/manager';
import { getModelStreamDraft } from './modelStreamDraft';
import { collectOpenAIResponsesStream, convertToOpenAIResponsesFormat } from './llmProviders/openai';
import { mergeModelStreamDeltaEvents } from './sessionWorkerHost';
import { isSessionTurnIncomplete } from './sessionContinuation';
import { clearOpenAIWsCompletedChains, getOpenAIWsCompletedChainCountForTests, setOpenAIWsTransportTestHooks } from './llmProviders/openaiWsTransport';
import { isToolAuthorizationPolicyUnavailable, parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests, setToolAuthorizationPolicyPathForTests } from './toolAuthorization';

const PROMPT_CACHE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TEST_MODELS_CONFIG = loadModelsConfigFromObject({
  default: 'openai/gpt-5.2-codex',
  providers: {
    openai: {
      providerType: 'openai-completions',
      baseUrl: 'https://openai.test/v1',
      apiKey: 'test-key',
      models: ['gpt-5.2-codex', 'gpt-5.6-sol'],
    },
    anthropic: {
      providerType: 'anthropic',
      baseUrl: 'https://anthropic.test',
      apiKey: 'test-key',
      models: ['claude-sonnet-4-5'],
    },
    'responses-fixture': {
      providerType: 'openai-responses',
      baseUrl: 'https://responses.test/v1',
      apiKey: 'test-key',
      models: ['model'],
    },
    'responses-image-fixture': {
      providerType: 'openai-responses',
      baseUrl: 'https://responses-image.test/v1',
      apiKey: 'test-key',
      imageGeneration: { enabled: true },
      models: ['model'],
    },
    'responses-keep-fixture': {
      providerType: 'openai-responses',
      baseUrl: 'https://responses-keep.test/v1',
      apiKey: 'test-key',
      keepReasoningOnError: true,
      models: ['enabled', { id: 'disabled', keepReasoningOnError: false }],
    },
    'responses-keep-route': {
      providerType: 'session-hash',
      targets: ['responses-keep-fixture/enabled'],
    },
    'responses-keep-failover': {
      providerType: 'failover',
      targets: ['responses-keep-fixture/enabled', 'responses-fixture/model'],
      failureThreshold: 1,
    },
    'responses-ws-fixture': {
      providerType: 'openai-ws',
      baseUrl: 'https://responses-ws.test/v1',
      apiKey: 'test-key',
      models: ['model'],
    },
    'responses-keep-ws-fixture': {
      providerType: 'openai-ws',
      baseUrl: 'https://responses-keep-ws.test/v1',
      apiKey: 'test-key',
      keepReasoningOnError: true,
      models: ['model'],
    },
  },
});
const originalResolveModelConfig = configModule.resolveModelConfig;
(configModule as any).resolveModelConfig = (sessionModel?: string) => {
  const defaultKey = TEST_MODELS_CONFIG.default;
  const currentKey = sessionModel && TEST_MODELS_CONFIG.models[sessionModel] ? sessionModel : defaultKey;
  const modelEntry = TEST_MODELS_CONFIG.models[currentKey];
  return { modelsConfig: TEST_MODELS_CONFIG, defaultKey, currentKey, modelEntry, contextLimit: modelEntry.contextLimit };
};
after(() => { (configModule as any).resolveModelConfig = originalResolveModelConfig; });

test('default maximum provider output is 32768 tokens', () => {
  assert.equal(MAX_OUTPUT, 32768);
});

test('model stream emitter sends offset deltas and throttles tool arguments until one second or flush', () => {
  let now = 10_000;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const events: any[] = [];
  const runDue = () => {
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].callback();
    }
  };
  const emitter = createModelStreamEventEmitter({
    enabled: true,
    sessionId: 'stream-test',
    iteration: 2,
    llmRequestId: 'request-stream-test',
    now: () => now,
    setTimer: ((callback: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { at: now + delay, callback });
      return id as any;
    }),
    clearTimer: ((id: any) => { timers.delete(id); }),
    currentSessionEffects: { notifySessionEvent: (_id: string, event: any) => events.push(event) } as any,
  });
  emitter.reset();
  emitter.emit({ text: 'Hi', toolCalls: [{ index: 0, id: 'call', name: 'read', arguments: '{"file' }] });
  now += 80;
  runDue();
  assert.deepEqual(events.at(-1).textDelta, { offset: 0, text: 'Hi' });
  assert.equal(events.at(-1).sequenceStart, events.at(-1).sequence);
  assert.equal(events.at(-1).startedAt, 10_000);
  assert.equal(events.at(-1).llmRequestId, 'request-stream-test');
  assert.equal(events.at(-1).toolCallDeltas[0].argumentsDelta, undefined);
  emitter.emit({ text: 'Hi!', toolCalls: [{ index: 0, id: 'call', name: 'read', arguments: '{"filePath":"x"}' }] });
  now += 80;
  runDue();
  assert.deepEqual(events.at(-1).textDelta, { offset: 2, text: '!' });
  assert.equal(events.at(-1).toolCallDeltas, undefined);
  emitter.flush();
  assert.deepEqual(events.at(-1).toolCallDeltas[0].argumentsDelta, { offset: 0, text: '{"filePath":"x"}' });
  assert.equal(events.at(-1).streamVersion, 2);
  assert.equal(getModelStreamDraft('stream-test')?.text, 'Hi!');
  emitter.reset();
  emitter.emit({ parts: [{ outputIndex: 4, kind: 'tool-call' }], toolCalls: [{ index: 4, id: 'ordered', name: 'read', arguments: '{"file' }] });
  now += 80;
  runDue();
  assert.deepEqual(events.at(-1).partDeltas, [{ outputIndex: 4, kind: 'tool-call', added: true }]);
  assert.equal(events.at(-1).toolCallDeltas[0].argumentsDelta, undefined);
  const beforeArgumentUpdate = events.length;
  emitter.emit({ parts: [{ outputIndex: 4, kind: 'tool-call' }], toolCalls: [{ index: 4, id: 'ordered', name: 'read', arguments: '{"filePath":"x"}' }] });
  now += 80;
  runDue();
  assert.equal(events.length, beforeArgumentUpdate);
  emitter.flush();
  assert.deepEqual(events.at(-1).toolCallDeltas[0].argumentsDelta, { offset: 0, text: '{"filePath":"x"}' });
  assert.equal(events.at(-1).partDeltas, undefined);
  emitter.close();
  assert.equal(getModelStreamDraft('stream-test'), null);
});

test('Responses SSE output boundaries survive collector, emitter, Worker coalescing, and owner snapshot', async () => {
  const frames = new PassThrough();
  const events: any[] = [];
  const emitter = createModelStreamEventEmitter({
    enabled: true, sessionId: 'ordered-stream-test', iteration: 0, llmRequestId: 'ordered-request',
    currentSessionEffects: { notifySessionEvent: (_id: string, event: any) => events.push(event) } as any,
  });
  const frame = (event: any) => frames.write(`data: ${JSON.stringify(event)}\n\n`);
  emitter.reset();
  const collecting = collectOpenAIResponsesStream(frames, new AbortController().signal, {
    onProgress: snapshot => { emitter.emit(snapshot); emitter.flush(); },
  });
  frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [], encrypted_content: 'opaque-do-not-stream' } });
  frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'first' });
  frame({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'first' });
  frame({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 1, text: 'second' });
  frame({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } });
  frame({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Drawing' });
  await new Promise(resolve => setImmediate(resolve));
  const snapshot = getModelStreamDraft('ordered-stream-test');
  assert.deepEqual(snapshot?.parts?.map(part => [part.outputIndex, part.kind, part.summaryIndex, part.text, part.phase]), [
    [0, 'reasoning', 0, 'first', undefined], [0, 'reasoning', 1, 'second', undefined],
    [1, 'text', undefined, 'Drawing', 'commentary'],
  ]);
  assert.equal(JSON.stringify(snapshot).includes('opaque-do-not-stream'), false);
  frame({ type: 'response.output_item.added', output_index: 2, item: { type: 'image_generation_call', status: 'in_progress', result: 'image-bytes-not-for-presentation' } });
  frame({ type: 'response.image_generation_call.partial_image', output_index: 2, partial_image_b64: 'preview-bytes-not-for-presentation' });
  frame({ type: 'response.output_item.done', output_index: 2, item: { type: 'image_generation_call', status: 'completed' } });
  frame({ type: 'response.reasoning_summary_text.delta', output_index: 3, summary_index: 0, delta: 'third' });
  frame({ type: 'response.completed', response: { id: 'r1', output: [], usage: { input_tokens: 2, output_tokens: 3 } } });
  frames.end();
  const collected = await collecting;
  emitter.close();
  assert.deepEqual(collected.output.map((item: any) => item.type), ['reasoning', 'message', 'image_generation_call', 'reasoning']);
  assert.deepEqual(collected.output[0].summary.map((part: any) => part.text), ['first', 'second']);
  const updates = events.filter(event => event.type === 'model-stream-update');
  const combined = updates.reduce((previous, current) => mergeModelStreamDeltaEvents(previous, current), undefined);
  assert.equal(combined.sequenceStart, updates[0].sequence);
  assert.equal(combined.sequence, updates.at(-1).sequence);
  assert.deepEqual(combined.partDeltas.map((part: any) => [part.outputIndex, part.kind, part.summaryIndex, part.textDelta?.text, part.phase]), [
    [0, 'reasoning', undefined, undefined, undefined],
    [0, 'reasoning', 0, 'first', undefined], [0, 'reasoning', 1, 'second', undefined],
    [1, 'text', undefined, 'Drawing', 'commentary'],
    [2, 'image-generation', undefined, undefined, undefined],
    [3, 'reasoning', 0, 'third', undefined],
  ]);
  assert.equal(JSON.stringify(updates).includes('image-bytes-not-for-presentation'), false);
  assert.equal(JSON.stringify(updates).includes('preview-bytes-not-for-presentation'), false);
  assert.equal(getModelStreamDraft('ordered-stream-test'), null);
});

test('Anthropic serialization deduplicates repeated ordinary and tool-result images without mutating history', () => {
  const data = Buffer.from('anthropic-provider-dedup').toString('base64');
  const history: Message[] = [
    {
      role: 'user',
      parts: [{ text: '<foxwarm-image name="source.png" node="master" path="/tmp/source.png" />', inlineData: { mimeType: 'image/png', data } }],
    },
    {
      role: 'tool',
      parts: [
        {
          toolUseId: 'call_image',
          inlineData: { mimeType: 'image/png', data },
          imageMeta: { imageId: 'tool-copy', mimeType: 'image/png', width: 4, height: 5 },
        },
        { functionResponse: { tool_use_id: 'call_image', name: 'capture', response: { output: 'done' } } },
      ],
    },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data } }] },
  ];
  const snapshot = structuredClone(history);

  const messages = convertToAnthropicFormat(history, { baseUrl: 'https://anthropic.test' } as any);
  const serialized = JSON.stringify(messages);
  assert.equal(serialized.match(/"type":"image"/g)?.length, 1);
  assert.match(serialized, /id=tool-copy/);
  assert.match(serialized, /deduplicated=true; identical image bytes were present earlier/);
  assert.match(serialized, /\[IMAGE: deduplicated=true\] Identical image bytes were present earlier/);
  assert.deepEqual(history, snapshot);
});

test('Anthropic repeated tool results mark later suppressed image bytes as deduplicated', () => {
  const data = Buffer.from('anthropic-repeated-tool-result').toString('base64');
  const history: Message[] = [{
    role: 'tool',
    parts: [
      { functionResponse: { tool_use_id: 'call_repeat', name: 'capture', response: { output: 'first' } } },
      {
        toolUseId: 'call_repeat',
        inlineData: { mimeType: 'image/png', data },
        imageMeta: { imageId: 'repeat-image', mimeType: 'image/png', width: 2, height: 2 },
      },
      { functionResponse: { tool_use_id: 'call_repeat', name: 'capture', response: { output: 'second' } } },
    ],
  }];

  const messages = convertToAnthropicFormat(history, { baseUrl: 'https://anthropic.test' } as any);
  const serialized = JSON.stringify(messages);
  assert.equal(serialized.match(/"type":"image"/g)?.length, 1);
  assert.equal(serialized.match(/id=repeat-image/g)?.length, 2);
  assert.equal(serialized.match(/deduplicated=true/g)?.length, 1);
  assert.match(serialized, /first/);
  assert.match(serialized, /second/);
});

test('Anthropic generated image history identifies the locally saved image without pretending to see it', () => {
  const history: Message[] = [{ role: 'model', parts: [{
    inlineData: { mimeType: 'image/webp', data: Buffer.from('fixture').toString('base64') },
    imageMeta: { origin: 'generated', imageId: 'ig_anthropic_hint', mimeType: 'image/webp' },
  }] }];
  const projection = convertToAnthropicFormat(history, { baseUrl: 'https://anthropic.test' } as any);
  const serialized = JSON.stringify(projection);
  assert.match(serialized, /does not receive its image content/);
  assert.match(serialized, /\[IMAGE: id=ig_anthropic_hint/);
  assert.match(serialized, /artifacts\/ig_anthropic_hint.webp/);
  assert.doesNotMatch(serialized, /"type":"image"|"type":"base64"/);
});

function makeChatCompletionStream(text = 'ok', usage: Record<string, unknown> = {
  prompt_tokens: 1,
  completion_tokens: 1,
  prompt_tokens_details: { cached_tokens: 0 },
}): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] })}\n\n`);
    stream.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function makeChatReasoningToolCallStream(reasoningFields: Record<string, string>): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(`data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          ...reasoningFields,
          tool_calls: [{
            index: 0,
            id: 'call_reasoning_round_trip',
            type: 'function',
            function: { name: 'read', arguments: '{"filePath":"README.md"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function makeResponsesStream(text = 'ok', usage: Record<string, unknown> = {
  input_tokens: 1,
  output_tokens: 1,
}): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(`data: ${JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', role: 'assistant', content: [] },
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      type: 'response.content_part.added',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      type: 'response.output_text.done',
      output_index: 0,
      content_index: 0,
      text,
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: { output: [], usage },
    })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function makeResponsesPhaseStream(): PassThrough {
  const events: any[] = [
    {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] },
    },
    {
      type: 'response.output_text.done', output_index: 0, content_index: 0,
      text: 'I will inspect that.',
    },
    {
      type: 'response.output_item.added', output_index: 1,
      item: { type: 'function_call', call_id: 'call_phase', name: 'read', arguments: '' },
    },
    {
      type: 'response.function_call_arguments.done', output_index: 1,
      arguments: '{"filePath":"README.md"}',
    },
    {
      type: 'response.output_item.added', output_index: 2,
      item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [] },
    },
    {
      type: 'response.output_text.done', output_index: 2, content_index: 0,
      text: 'Inspection complete.',
    },
    {
      type: 'response.output_item.added', output_index: 3,
      item: { type: 'message', role: 'assistant', phase: 'analysis', content: [] },
    },
    {
      type: 'response.output_text.done', output_index: 3, content_index: 0,
      text: 'Unknown phase.',
    },
    {
      type: 'response.completed',
      response: { output: [], usage: { input_tokens: 1, output_tokens: 8 } },
    },
  ];
  const stream = new PassThrough();
  process.nextTick(() => {
    for (const event of events) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function makeResponsesWebSearchStream(): PassThrough {
  const citation = {
    type: 'url_citation',
    start_index: 0,
    end_index: 5,
    url: 'https://example.com/article',
    title: 'Example article',
  };
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(`data: ${JSON.stringify({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'web_search_call', id: 'ws_123', status: 'completed', action: { type: 'search', query: 'example query' } },
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'message', role: 'assistant', content: [] },
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      type: 'response.content_part.added',
      output_index: 1,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      type: 'response.output_text.done',
      output_index: 1,
      content_index: 0,
      text: 'Hello',
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      type: 'response.output_text.annotation.added',
      output_index: 1,
      content_index: 0,
      annotation_index: 0,
      annotation: citation,
    })}\n\n`);
    stream.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        // Hosted Responses may omit the streamed search call from this
        // condensed final output. The collector must not merge these entries
        // by their compact ordinal positions.
        output: [
          { type: 'reasoning', summary: [] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [citation] }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function makeResponsesSummaryBoundaryStream(): PassThrough {
  const firstSummary = '**Preparing final test report and preview options**';
  const secondSummary = '**Confirming no live deployment without user approval**';
  const events: any[] = [
    {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'reasoning', id: 'rs_summary', summary: [] },
    },
    {
      type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: firstSummary,
    },
    {
      type: 'response.reasoning_summary_part.done', output_index: 0, summary_index: 0,
      part: { type: 'summary_text', text: firstSummary },
    },
    {
      type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 1, text: secondSummary,
    },
    {
      type: 'response.reasoning_summary_part.done', output_index: 0, summary_index: 1,
      part: { type: 'summary_text', text: secondSummary },
    },
    {
      type: 'response.output_item.done', output_index: 0,
      item: {
        type: 'reasoning', id: 'rs_summary', status: 'completed',
        summary: [
          { type: 'summary_text', text: firstSummary },
          { type: 'summary_text', text: secondSummary },
        ],
      },
    },
    {
      type: 'response.output_item.added', output_index: 1,
      item: { type: 'message', id: 'msg_summary', role: 'assistant', content: [] },
    },
    {
      type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'Done',
    },
    {
      type: 'response.completed',
      response: {
        output: [
          {
            type: 'reasoning', id: 'rs_summary', status: 'completed',
            summary: [{ type: 'summary_text', text: `${firstSummary}${secondSummary}` }],
          },
          {
            type: 'message', id: 'msg_summary', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Done' }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  const stream = new PassThrough();
  process.nextTick(() => {
    for (const event of events) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function createOpenAITestSession(id: string): Session {
  return {
    id,
    history: [],
    persistentMemorySnapshot: '<foxwarm-current-model model-id="openai/gpt-5.2-codex" />\n\nsystem prompt',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    model: 'openai/gpt-5.2-codex',
  } as Session;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('local and Session-worker host requests send only potentially available default tools to the provider', async () => {
  const originalPost = axios.post;
  const bodies: any[] = [];
  const policyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wire-tool-policy-'));
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream('filtered') };
  };
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1
defaultAction: allow
rules:
- id: deny-script
  match: { tool: { source: builtin, name: run_script } }
  action: deny
- id: allow-path-read
  match: { tool: { source: node, name: read }, path: { allWithin: "\${agent.dir}" } }
  action: allow
- id: deny-other-read
  match: { tool: { source: node, name: read } }
  action: deny
`));
  try {
    for (const placement of ['local', 'session-worker'] as const) {
      const owner = createOpenAITestSession(makeId(`tool_projection_${placement}`));
      const effects: CurrentSessionEffects = {
        placement,
        appendMessage: async (target, message) => { target.history.push(message); },
        persistSession: async () => {}, notifySessionEvent: () => {},
        registerAbortController: () => {}, clearAbortController: () => {},
        clearWaitById: async () => false,
      };
      assert.equal((await new LocalSessionTurnHost(effects, owner).chat([{ text: 'test tools' }], owner, 0, {
        notifySessionEvents: false, registerAbortController: false,
      })).text, 'filtered');
      const wireNames = bodies.at(-1).tools.map((tool: any) => tool.function.name);
      assert.deepEqual(wireNames, tools.modelFacingDefinitions.filter(tool => tool.name !== 'run_script').map(tool => tool.name));
      assert.ok(wireNames.includes('read'));
      assert.ok(wireNames.includes('call_tool'));
    }
    const unavailableFile = path.join(policyDir, 'invalid-policy.yaml');
    await fs.writeFile(unavailableFile, 'version: unsupported\n');
    setToolAuthorizationPolicyForTests(undefined);
    setToolAuthorizationPolicyPathForTests(unavailableFile);
    const blocked = createOpenAITestSession(makeId('unavailable_policy_projection'));
    await assert.rejects(chat([{ text: 'do not send' }], blocked, 0, {
      appendMessage: async message => { blocked.history.push(message); },
      notifySessionEvents: false, registerAbortController: false,
    }), isToolAuthorizationPolicyUnavailable);
    assert.equal(bodies.length, 2, 'unavailable policy prevents the physical provider request');
  } finally {
    (axios as any).post = originalPost;
    setToolAuthorizationPolicyForTests(undefined);
    setToolAuthorizationPolicyPathForTests(undefined);
    await fs.remove(policyDir);
  }
});

test('chat forwards the raw Session effort override without materializing a configured default', async () => {
  const originalPost = axios.post;
  let capturedBody: any;
  (axios as any).post = async (_url: string, body: any) => {
    capturedBody = body;
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream('effort ok') };
  };
  const session = createOpenAITestSession(makeId('chat_effort'));
  session.effort = 'none';
  try {
    await chat([{ text: 'hello' }], session, 0, {
      appendMessage: async message => { session.history.push(message); },
      notifySessionEvents: false,
      registerAbortController: false,
    });
    assert.equal(capturedBody.reasoning_effort, 'none');
    delete session.effort;
    await chat([{ text: 'default' }], session, 1, {
      appendMessage: async message => { session.history.push(message); },
      notifySessionEvents: false,
      registerAbortController: false,
    });
    assert.equal(capturedBody.reasoning_effort, 'high');
    assert.equal(Object.prototype.hasOwnProperty.call(session, 'effort'), false);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('sanitizeProviderRequestPayload replaces lone surrogates in nested provider payloads', () => {
  const payload = {
    input: [
      { content: [{ text: `bad ${'\uD83E'} text` }] },
      { content: [{ text: 'valid 🦊 emoji' }] },
    ],
    inlineData: 'QUJDREVGRw==',
  };

  const result = sanitizeProviderRequestPayload(payload);

  assert.equal(result.replacementCount, 1);
  assert.deepEqual(result.paths, ['$.input[0].content[0].text']);
  assert.equal(containsLoneSurrogate(result.value.input[0].content[0].text), false);
  assert.equal(result.value.input[0].content[0].text, 'bad � text');
  assert.equal(result.value.input[1].content[0].text, 'valid 🦊 emoji');
  assert.equal(result.value.inlineData, 'QUJDREVGRw==');
});

test('requestLlmOnce can make a direct provider-specific request without a session object', async () => {
  const originalPost = axios.post;
  let capturedUrl = '';
  let capturedBody: any = null;

  (axios as any).post = async (url: string, data: any) => {
    capturedUrl = url;
    capturedBody = data;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        content: [
          { type: 'text', text: 'anthropic ok' },
        ],
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          cache_read_input_tokens: 1,
        },
      },
    };
  };

  try {
    const result = await requestLlmOnce({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello from direct request' }],
        },
      ],
      systemPrompt: '',
      model: 'anthropic/claude-sonnet-4-5',
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.match(capturedUrl, /\/v1\/messages$/);
    assert.equal(capturedBody.system, '');
    assert.deepEqual(capturedBody.messages, [
      {
        role: 'user',
        content: 'hello from direct request',
      },
    ]);
    assert.equal(result.text, 'anthropic ok');
    assert.equal(result.modelId, 'anthropic/claude-sonnet-4-5');
    assert.deepEqual(result.allParts, [{ text: 'anthropic ok' }]);
    assert.deepEqual(result.usage, {
      inputTokens: 7,
      outputTokens: 3,
      cachedTokens: 1,
    });
  } finally {
    (axios as any).post = originalPost;
  }
});

test('first-class effort defaults high and maps every canonical level across provider protocols', async () => {
  const originalPost = axios.post;
  const captured: Array<{ url: string; body: any }> = [];
  (axios as any).post = async (url: string, body: any) => {
    captured.push({ url, body });
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: url.endsWith('/responses') ? makeResponsesStream()
        : url.endsWith('/chat/completions') ? makeChatCompletionStream()
          : { content: [{ type: 'text', text: 'ok' }] },
    };
  };

  const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
  const entry = (providerType: string) => ({
    providerKey: 'fixture', providerType, baseUrl: 'https://fixture.example/v1', model: 'model',
    effort: { allowed: [...efforts], default: 'high' }, extraFields: {}, extraHeaders: {},
  }) as any;
  const request = async (providerType: string, effort?: typeof efforts[number]) => requestLlmOnce({
    contents: [{ role: 'user', parts: [{ text: 'effort test' }] }],
    systemPrompt: '', modelEntryOverride: entry(providerType), effort,
    toolDefinitions: [], notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
  });

  try {
    await request('openai-responses');
    assert.equal(captured.at(-1)?.body.reasoning.effort, 'high');
    assert.equal(captured.at(-1)?.body.max_output_tokens, MAX_OUTPUT);
    for (const effort of efforts) {
      await request('openai-responses', effort);
      const body = captured.at(-1)?.body;
      assert.equal(body.reasoning.effort, effort);
      if (effort === 'none') {
        assert.equal(body.reasoning.summary, undefined);
        assert.equal(body.include, undefined);
      } else {
        assert.equal(body.reasoning.summary, 'auto');
        assert.deepEqual(body.include, ['reasoning.encrypted_content']);
      }
    }

    for (const effort of efforts) {
      await request('openai-completions', effort);
      assert.equal(captured.at(-1)?.body.reasoning_effort, effort);
      assert.equal(captured.at(-1)?.body.max_tokens, MAX_OUTPUT);
    }

    for (const effort of efforts) {
      await request('anthropic', effort);
      const body = captured.at(-1)?.body;
      assert.equal(body.max_tokens, MAX_OUTPUT);
      assert.equal(JSON.stringify(body).includes('budget_tokens'), false);
      if (effort === 'none') {
        assert.deepEqual(body.thinking, { type: 'disabled' });
        assert.equal(body.output_config?.effort, undefined);
      } else {
        assert.equal(body.output_config.effort, effort);
        assert.equal(body.thinking, undefined);
      }
    }

    await request('custom-anthropic-compatible', 'medium');
    assert.equal(captured.at(-1)?.body.output_config.effort, 'medium');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('first-class effort overrides known extraFields paths last without mutating config objects', async () => {
  const originalPost = axios.post;
  const captured: any[] = [];
  (axios as any).post = async (url: string, body: any) => {
    captured.push(body);
    return {
      status: 200, statusText: 'OK', headers: {},
      data: url.endsWith('/responses') ? makeResponsesStream()
        : url.endsWith('/chat/completions') ? makeChatCompletionStream()
          : { content: [{ type: 'text', text: 'ok' }] },
    };
  };
  const allEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const request = async (modelEntryOverride: any, effort: any) => requestLlmOnce({
    contents: [{ role: 'user', parts: [{ text: 'precedence' }] }], systemPrompt: '',
    modelEntryOverride, effort, toolDefinitions: [], notifySessionEvents: false,
    registerAbortController: false, maxRetries: 1,
  });

  const responses = {
    providerKey: 'fixture', providerType: 'openai-responses', baseUrl: 'https://fixture.example/v1', model: 'responses',
    effort: { allowed: allEfforts, default: 'high' },
    extraFields: {
      reasoning: { effort: 'low', summary: 'detailed', custom: true },
      include: ['custom.output', 'reasoning.encrypted_content'],
      custom_top: 1,
    },
    extraHeaders: {},
  };
  const chat = {
    providerKey: 'fixture', providerType: 'openai-completions', baseUrl: 'https://fixture.example/v1', model: 'chat',
    effort: { allowed: allEfforts, default: 'high' },
    extraFields: { reasoning_effort: 'low', custom_top: 2 }, extraHeaders: {},
  };
  const anthropic = {
    providerKey: 'fixture', providerType: 'anthropic', baseUrl: 'https://fixture.example', model: 'claude',
    effort: { allowed: allEfforts, default: 'high' },
    extraFields: {
      thinking: { type: 'enabled', budget_tokens: 777 },
      output_config: { effort: 'low', custom: true },
      custom_top: 3,
    },
    extraHeaders: {},
  };
  const before = structuredClone({ responses, chat, anthropic });

  try {
    await request(responses, 'max');
    assert.deepEqual(captured.at(-1)?.reasoning, { effort: 'max', summary: 'detailed', custom: true });
    assert.deepEqual(captured.at(-1)?.include, ['custom.output', 'reasoning.encrypted_content']);
    assert.equal(captured.at(-1)?.custom_top, 1);

    await request(responses, 'none');
    assert.deepEqual(captured.at(-1)?.reasoning, { effort: 'none', custom: true });
    assert.deepEqual(captured.at(-1)?.include, ['custom.output']);
    assert.equal(captured.at(-1)?.custom_top, 1);

    await request(chat, 'xhigh');
    assert.equal(captured.at(-1)?.reasoning_effort, 'xhigh');
    assert.equal(captured.at(-1)?.custom_top, 2);

    await request(anthropic, 'max');
    assert.deepEqual(captured.at(-1)?.output_config, { effort: 'max', custom: true });
    assert.deepEqual(captured.at(-1)?.thinking, { type: 'enabled', budget_tokens: 777 });

    await request(anthropic, 'none');
    assert.deepEqual(captured.at(-1)?.thinking, { type: 'disabled' });
    assert.deepEqual(captured.at(-1)?.output_config, { custom: true });
    assert.deepEqual({ responses, chat, anthropic }, before);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('OpenAI Responses opt-in web search is appended to Foxwarm tools and excluded from compact plans', async () => {
  const originalPost = axios.post;
  const capturedBodies: any[] = [];
  const model = {
    providerKey: 'fixture',
    providerType: 'openai-responses',
    baseUrl: 'https://fixture.example',
    apiKey: '',
    model: 'gpt-5.6',
    extraFields: {},
    extraHeaders: {},
    webSearch: {
      enabled: true,
      toolChoice: 'required',
      searchContextSize: 'high',
      allowedDomains: ['example.com'],
      userLocation: { city: 'Shenzhen', country: 'CN' },
    },
  } as any;

  (axios as any).post = async (_url: string, data: any) => {
    capturedBodies.push(data);
    return { status: 200, statusText: 'OK', headers: {}, data: makeResponsesStream() };
  };

  try {
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'search this' }] }],
      systemPrompt: '',
      modelEntryOverride: model,
      toolDefinitions: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      notifySessionEvents: false,
      registerAbortController: false,
    });
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'compact this' }] }],
      systemPrompt: '',
      modelEntryOverride: model,
      purpose: 'compact-plan',
      toolDefinitions: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      notifySessionEvents: false,
      registerAbortController: false,
    });
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'disabled search' }] }],
      systemPrompt: '',
      modelEntryOverride: { ...model, webSearch: { enabled: false, toolChoice: 'required' } },
      toolDefinitions: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.deepEqual(capturedBodies[0].tools, [
      { type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} }, strict: false },
      {
        type: 'web_search',
        search_context_size: 'high',
        filters: { allowed_domains: ['example.com'] },
        user_location: { type: 'approximate', country: 'CN', city: 'Shenzhen' },
      },
    ]);
    assert.equal(capturedBodies[0].tool_choice, 'required');
    assert.deepEqual(capturedBodies[1].tools, [
      { type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} }, strict: false },
    ]);
    assert.equal(capturedBodies[1].tool_choice, 'auto');
    assert.deepEqual(capturedBodies[2].tools, [
      { type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} }, strict: false },
    ]);
    assert.equal(capturedBodies[2].tool_choice, 'auto');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('OpenAI custom function tools explicitly use non-strict mode without changing schema required keys', async () => {
  const originalPost = axios.post;
  const captured: Array<{ url: string; body: any }> = [];
  (axios as any).post = async (url: string, body: any) => {
    captured.push({ url, body });
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: url.endsWith('/responses') ? makeResponsesStream()
        : url.endsWith('/chat/completions') ? makeChatCompletionStream()
          : { content: [{ type: 'text', text: 'ok' }] },
    };
  };

  const parameters = {
    type: 'object',
    properties: {
      suffix: { type: 'string' },
      forceModel: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modelId: { type: 'string' },
          effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
        },
      },
    },
    required: ['suffix'],
  };
  const toolDefinitions = [{ name: 'create_child_session', description: 'Create a child session', parameters }];
  const entry = (providerType: string, webSearch?: any) => ({
    providerKey: 'fixture', providerType, baseUrl: 'https://fixture.example/v1', model: 'model',
    extraFields: {}, extraHeaders: {}, ...(webSearch ? { webSearch } : {}),
  }) as any;

  try {
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'create child' }] }], systemPrompt: '',
      modelEntryOverride: entry('openai-responses', { enabled: true }), toolDefinitions,
      notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
    });
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'create child' }] }], systemPrompt: '',
      modelEntryOverride: entry('openai-completions'), toolDefinitions,
      notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
    });
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'create child' }] }], systemPrompt: '',
      modelEntryOverride: entry('anthropic'), toolDefinitions,
      notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
    });

    const responsesTools = captured[0].body.tools;
    assert.deepEqual(responsesTools[0], {
      type: 'function', name: 'create_child_session', description: 'Create a child session',
      parameters, strict: false,
    });
    assert.deepEqual(responsesTools[0].parameters.required, ['suffix']);
    assert.equal(Object.prototype.hasOwnProperty.call(responsesTools[0].parameters, 'strict'), false);
    assert.deepEqual(responsesTools[1], { type: 'web_search' });
    assert.equal(Object.prototype.hasOwnProperty.call(responsesTools[1], 'strict'), false);

    const chatTool = captured[1].body.tools[0];
    assert.deepEqual(chatTool, {
      type: 'function',
      function: {
        name: 'create_child_session', description: 'Create a child session', parameters, strict: false,
      },
    });
    assert.deepEqual(chatTool.function.parameters.required, ['suffix']);
    assert.equal(Object.prototype.hasOwnProperty.call(chatTool.function.parameters, 'strict'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(chatTool, 'strict'), false);

    assert.deepEqual(captured[2].body.tools[0], {
      name: 'create_child_session', description: 'Create a child session', input_schema: parameters,
    });
    assert.deepEqual(captured[2].body.tools[0].input_schema.required, ['suffix']);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('OpenAI Responses parsing persists native web search output and URL annotations with the producing model', async () => {
  const originalPost = axios.post;
  const model = {
    providerKey: 'fixture',
    providerType: 'openai-responses',
    baseUrl: 'https://fixture.example',
    apiKey: '',
    model: 'gpt-5.6',
    extraFields: {},
    extraHeaders: {},
  } as any;
  (axios as any).post = async () => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: makeResponsesWebSearchStream(),
  });

  try {
    const result = await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'search this' }] }],
      systemPrompt: '',
      modelEntryOverride: model,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.equal(result.toolCalls?.length, 0);
    assert.deepEqual(result.allParts?.map(part => part.providerMeta?.openaiResponses?.outputItem?.type || part.text), [
      'web_search_call',
      'Hello',
    ]);
    assert.equal(result.allParts?.filter(part => typeof part.text === 'string').length, 1);
    assert.equal(result.allParts?.filter(part => part.providerMeta?.openaiResponses?.outputItem).length, 1);
    assert.equal(result.allParts?.[0].providerMeta?.openaiResponses?.sourceModelId, 'fixture/gpt-5.6');
    assert.deepEqual(result.allParts?.[1].providerMeta?.openaiResponses?.annotations, [{
      type: 'url_citation',
      start_index: 0,
      end_index: 5,
      url: 'https://example.com/article',
      title: 'Example article',
    }]);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('OpenAI Responses parsing preserves assistant message phases around function calls', async () => {
  const originalPost = axios.post;
  (axios as any).post = async () => ({
    status: 200, statusText: 'OK', headers: {}, data: makeResponsesPhaseStream(),
  });

  try {
    const result = await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'inspect this' }] }],
      systemPrompt: '',
      modelEntryOverride: {
        providerKey: 'fixture', providerType: 'openai-responses', baseUrl: 'https://fixture.example',
        apiKey: '', model: 'gpt-5.6', extraFields: {}, extraHeaders: {},
      } as any,
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
    });

    assert.deepEqual(result.allParts, [
      { text: 'I will inspect that.', phase: 'commentary' },
      {
        functionCall: {
          id: 'call_phase', name: 'read', args: { filePath: 'README.md' },
          rawArgsText: '{"filePath":"README.md"}',
        },
      },
      { text: 'Inspection complete.', phase: 'final_answer' },
      { text: 'Unknown phase.' },
    ]);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('OpenAI Responses parsing preserves separate thinking summaries and newline display text', async () => {
  const originalPost = axios.post;
  const model = {
    providerKey: 'fixture',
    providerType: 'openai-responses',
    baseUrl: 'https://fixture.example',
    apiKey: '',
    model: 'gpt-5.6',
    extraFields: {},
    extraHeaders: {},
  } as any;
  (axios as any).post = async () => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: makeResponsesSummaryBoundaryStream(),
  });

  try {
    const result = await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'summarize reasoning' }] }],
      systemPrompt: '',
      modelEntryOverride: model,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const reasoningPart = result.allParts?.find(part => part.providerMeta?.thinkingSummaries);
    assert.deepEqual(reasoningPart?.providerMeta?.thinkingSummaries, [
      '**Preparing final test report and preview options**',
      '**Confirming no live deployment without user approval**',
    ]);
    assert.equal(reasoningPart?.thinking,
      '**Preparing final test report and preview options**\n**Confirming no live deployment without user approval**');
    assert.equal(result.text, 'Done');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('a post-response journal failure never retries a successful provider generation', async () => {
  const originalPost = axios.post;
  let callCount = 0;
  (axios as any).post = async () => {
    callCount += 1;
    return { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'one generation' }] } };
  };
  setLlmRequestJournalFaultInjectorForTests((phase, record: any) => {
    if (phase === 'after-jsonl-append' && record.kind === 'attempt-result' && record.outcome === 'success') throw new Error('injected result journal failure');
  });
  try {
    const result = await requestLlmOnce({ contents: [{ role: 'user', parts: [{ text: 'once' }] }], systemPrompt: '', model: 'anthropic/claude-sonnet-4-5', toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    assert.equal(result.text, 'one generation');
    assert.equal(callCount, 1);
    assert.equal(typeof result.llmRequestId, 'string');
  } finally {
    setLlmRequestJournalFaultInjectorForTests(null);
    (axios as any).post = originalPost;
  }
});

test('empty completions are accepted by default and become retryable failures only with disallowEmptyResponse', async () => {
  const originalPost = axios.post;
  let callCount = 0;
  (axios as any).post = async (url: string) => {
    callCount += 1;
    if (url.endsWith('/responses')) {
      const stream = new PassThrough();
      process.nextTick(() => {
        stream.write(`data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              status: 'completed',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: '' }],
            }],
            usage: { input_tokens: 1, output_tokens: 4 },
          },
        })}\n\n`);
        stream.write('data: [DONE]\n\n');
        stream.end();
      });
      return { status: 200, statusText: 'OK', headers: {}, data: stream };
    }
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream('') };
  };
  const entry = (providerType: string, disallowEmptyResponse?: boolean) => ({
    providerKey: 'fixture', providerType, baseUrl: 'https://fixture.example/v1', model: 'model',
    ...(disallowEmptyResponse === undefined ? {} : { disallowEmptyResponse }),
  }) as any;
  const request = (modelEntryOverride: any, maxRetries: number) => requestLlmOnce({
    contents: [{ role: 'user', parts: [{ text: 'ack' }] }], systemPrompt: '', modelEntryOverride,
    toolDefinitions: [], notifySessionEvents: false, registerAbortController: false, maxRetries,
  });

  try {
    const accepted = await request(entry('openai-responses'), 6);
    assert.equal(accepted.text, '');
    assert.deepEqual(accepted.toolCalls, []);
    assert.equal(callCount, 1);

    const acceptedChat = await request(entry('openai-completions'), 6);
    assert.equal(acceptedChat.text, '');
    assert.equal(acceptedChat.toolCalls?.length ?? 0, 0);
    assert.equal(callCount, 2);

    const failures = await Promise.allSettled([
      request(entry('openai-responses', true), 1),
      request(entry('openai-completions', true), 1),
    ]);
    for (const failure of failures) {
      assert.equal(failure.status, 'rejected');
      const error = (failure as PromiseRejectedResult).reason;
      assert.ok(error instanceof LlmRequestError);
      assert.match(error.message, /API request failed after 1 attempts: Model response contained no non-whitespace content or tool call/);
      assert.equal(error.kind, 'response-error');
    }
  } finally {
    (axios as any).post = originalPost;
  }
});

test('a canonical empty model text from chat survives the next Responses request serialization', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('empty_replay'));
  session.model = 'openai/gpt-5.6-sol';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="openai/gpt-5.6-sol" />\n\n';
  let responsesBody: any;
  (axios as any).post = async (url: string, body: any) => {
    if (url.endsWith('/chat/completions')) {
      return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream('') };
    }
    responsesBody = body;
    const stream = new PassThrough();
    process.nextTick(() => {
      stream.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{
            type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
            content: [{ type: 'output_text', text: 'continued' }],
          }],
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      })}\n\n`);
      stream.write('data: [DONE]\n\n');
      stream.end();
    });
    return { status: 200, statusText: 'OK', headers: {}, data: stream };
  };

  try {
    await chat([{ text: 'acknowledge' }], session, 0, {
      appendMessage: async message => { session.history.push(message); },
      notifySessionEvents: false,
      registerAbortController: false,
      toolDefinitions: [],
    });
    assert.deepEqual(session.history.map(message => ({ role: message.role, parts: message.parts })), [
      { role: 'user', parts: [{ text: 'acknowledge' }] },
      { role: 'model', parts: [{ text: '' }] },
    ]);

    session.history.push({ role: 'user', parts: [{ text: 'follow up' }] });
    await requestLlmOnce({
      contents: session.history,
      systemPrompt: '',
      modelEntryOverride: {
        providerKey: 'responses-fixture', providerType: 'openai-responses',
        baseUrl: 'https://fixture.example/v1', model: 'model',
      } as any,
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
    });

    assert.deepEqual(responsesBody.input, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'acknowledge' }] },
      { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'follow up' }] },
    ]);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('all provider protocols hydrate canonical image refs only in outbound payloads and diagnostics redact them', async t => {
  const originalPost = axios.post;
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const ref = await putImageBlob({ buffer: Buffer.from(imageBase64, 'base64'), mimeType: 'image/png', imageId: 'provider_call#1' });
  const canonical: Message[] = [
    { role: 'user', parts: [{ text: 'capture an image' }] },
    { role: 'model', parts: [{ functionCall: { id: 'provider_call', name: 'screenshot', args: {} } }] },
    {
      role: 'tool',
      parts: [
        { functionResponse: { tool_use_id: 'provider_call', name: 'screenshot', response: { output: 'captured' } } },
        { toolUseId: 'provider_call', inlineDataRef: ref, imageMeta: { imageId: ref.imageId } },
      ],
    },
  ];
  const captured: any[] = [];
  const models = {
    responses: { providerKey: 'fixture', providerType: 'openai-responses', baseUrl: 'https://fixture.example', apiKey: '', model: 'responses', extraFields: {}, extraHeaders: {} },
    chat: { providerKey: 'fixture', providerType: 'openai-completions', baseUrl: 'https://fixture.example', apiKey: '', model: 'chat', extraFields: {}, extraHeaders: {} },
    anthropic: { providerKey: 'fixture', providerType: 'anthropic', baseUrl: 'https://fixture.example', apiKey: '', model: 'claude', extraFields: {}, extraHeaders: {} },
  } as const;

  try {
    await t.test('OpenAI Responses', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.push(data);
        return { status: 200, statusText: 'OK', headers: {}, data: makeResponsesStream() };
      };
      await requestLlmOnce({ contents: canonical, systemPrompt: '', modelEntryOverride: models.responses as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });
    await t.test('OpenAI Chat Completions', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.push(data);
        return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream() };
      };
      await requestLlmOnce({ contents: canonical, systemPrompt: '', modelEntryOverride: models.chat as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });
    await t.test('Anthropic Messages', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.push(data);
        return { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } };
      };
      await requestLlmOnce({ contents: canonical, systemPrompt: '', modelEntryOverride: models.anthropic as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });

    assert.equal(captured.length, 3);
    for (const payload of captured) {
      assert.equal(JSON.stringify(payload).includes(imageBase64), true);
      assert.equal(JSON.stringify(payload).includes('provider_call'), true);
      assert.equal(JSON.stringify(redactProviderImagesForLog(payload)).includes(imageBase64), false);
    }
    assert.equal(canonical[0].parts[0].inlineData, undefined, 'provider hydration must not mutate canonical messages');
  } finally {
    (axios as any).post = originalPost;
    if (ref.blobId) await fs.remove(resolveImageBlobPath(ref.blobId));
  }
});

test('all provider protocols receive the same provider-safe HEIC hydration clone', async t => {
  const originalPost = axios.post;
  const fixturePath = path.resolve(__dirname, '..', 'src', 'testFixtures', 'synthetic-3x2.heic');
  const originalBytes = await fs.readFile(fixturePath);
  const ref = await putImageBlob({ buffer: originalBytes, mimeType: 'image/heif', imageId: 'provider_heif#1' });
  const canonical: Message[] = [{
    role: 'user',
    parts: [{ inlineDataRef: ref, imageMeta: { imageId: ref.imageId, mimeType: ref.mimeType } }],
  }];
  const canonicalSnapshot = structuredClone(canonical);
  const captured: any[] = [];
  const models = {
    responses: { providerKey: 'fixture', providerType: 'openai-responses', baseUrl: 'https://fixture.example', apiKey: '', model: 'responses', extraFields: {}, extraHeaders: {} },
    chat: { providerKey: 'fixture', providerType: 'openai-completions', baseUrl: 'https://fixture.example', apiKey: '', model: 'chat', extraFields: {}, extraHeaders: {} },
    anthropic: { providerKey: 'fixture', providerType: 'anthropic', baseUrl: 'https://fixture.example', apiKey: '', model: 'claude', extraFields: {}, extraHeaders: {} },
  } as const;

  try {
    await t.test('OpenAI Responses', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.push(data);
        return { status: 200, statusText: 'OK', headers: {}, data: makeResponsesStream() };
      };
      await requestLlmOnce({ contents: canonical, systemPrompt: '', modelEntryOverride: models.responses as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });
    await t.test('OpenAI Chat Completions', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.push(data);
        return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream() };
      };
      await requestLlmOnce({ contents: canonical, systemPrompt: '', modelEntryOverride: models.chat as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });
    await t.test('Anthropic Messages', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.push(data);
        return { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } };
      };
      await requestLlmOnce({ contents: canonical, systemPrompt: '', modelEntryOverride: models.anthropic as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });

    assert.equal(captured.length, 3);
    for (const payload of captured) {
      const serialized = JSON.stringify(payload);
      assert.equal(serialized.includes('image/webp'), true);
      assert.equal(/image\/(?:heic|heif)/.test(serialized), false);
      assert.equal(serialized.includes(originalBytes.toString('base64')), false);
    }
    assert.deepEqual(canonical, canonicalSnapshot);
  } finally {
    (axios as any).post = originalPost;
    if (ref.blobId) await fs.remove(resolveImageBlobPath(ref.blobId));
  }
});

test('malformed claimed HEIC fails before a provider HTTP request', async () => {
  const originalPost = axios.post;
  let callCount = 0;
  (axios as any).post = async () => {
    callCount += 1;
    throw new Error('provider should not be called');
  };
  const ref = await putImageBlob({
    buffer: Buffer.from('not a HEIF container'),
    mimeType: 'image/heic',
    imageId: 'malformed-provider-image',
  });
  try {
    await assert.rejects(
      () => requestLlmOnce({
        contents: [{ role: 'user', parts: [{ inlineDataRef: ref }] }],
        systemPrompt: '',
        modelEntryOverride: { providerKey: 'fixture', providerType: 'openai-responses', baseUrl: 'https://fixture.example', apiKey: '', model: 'responses', extraFields: {}, extraHeaders: {} } as any,
        toolDefinitions: [],
        notifySessionEvents: false,
        registerAbortController: false,
      }),
      /Unable to normalize HEIC\/HEIF image malformed-provider-image for provider/,
    );
    assert.equal(callCount, 0);
  } finally {
    (axios as any).post = originalPost;
    if (ref.blobId) await fs.remove(resolveImageBlobPath(ref.blobId));
  }
});

test('all provider protocols filter historical reasoning only for a proven different concrete model', async t => {
  const originalPost = axios.post;
  const destinationModelId = 'fixture/destination';
  const history: Message[] = [
    { role: 'user', parts: [{ text: 'history start' }], __meta: { timestamp: 1, seq: 1 } },
    {
      role: 'model',
      parts: [
        { thinking: 'same thinking', providerMeta: { thinkingSummaries: ['same summary'], encryptedThinking: 'same encrypted', signature: 'same signature' } },
        {
          providerMeta: {
            openaiResponses: {
              sourceModelId: destinationModelId,
              outputItem: { type: 'web_search_call', id: 'same-search', status: 'completed' },
            },
          },
        },
        {
          text: 'same citation text',
          providerMeta: {
            openaiResponses: {
              sourceModelId: destinationModelId,
              annotations: [{ type: 'url_citation', url: 'https://same.example' }],
            },
          },
        },
        { text: 'same text' },
      ],
      providerMeta: { providerSpecificFields: { reasoning_signature: 'same opaque' }, sourceModelId: destinationModelId },
      __meta: { modelId: destinationModelId, timestamp: 2, seq: 2, usage: { cachedTokens: 0, inputTokens: 1, outputTokens: 1, reasoningTokens: 1 } },
    },
    { role: 'user', parts: [{ text: 'different follows' }] },
    {
      role: 'model',
      parts: [
        { thinking: 'different thinking', providerMeta: { thinkingSummaries: ['different summary'], encryptedThinking: 'different encrypted', signature: 'different signature' } },
        {
          providerMeta: {
            openaiResponses: {
              sourceModelId: destinationModelId,
              outputItem: { type: 'web_search_call', id: 'different-search', status: 'completed' },
            },
          },
        },
        {
          text: 'different citation text',
          providerMeta: {
            openaiResponses: {
              sourceModelId: destinationModelId,
              annotations: [{ type: 'url_citation', url: 'https://different.example' }],
            },
          },
        },
        { text: 'different text' },
      ],
      // Deliberately conflicts with the authoritative message provenance: a
      // different message model must remove the whole opaque metadata object.
      providerMeta: { providerSpecificFields: { reasoning_signature: 'different opaque' }, sourceModelId: destinationModelId },
      __meta: { modelId: 'other/old-model', timestamp: 3, seq: 3 },
    },
    { role: 'user', parts: [{ text: 'legacy follows' }] },
    {
      role: 'model',
      parts: [
        { thinking: 'legacy thinking', providerMeta: { thinkingSummaries: ['legacy summary'], encryptedThinking: 'legacy encrypted', signature: 'legacy signature' } },
        { text: 'legacy text' },
      ],
      providerMeta: { providerSpecificFields: { reasoning_signature: 'legacy opaque' }, sourceModelId: destinationModelId },
    },
    { role: 'model', parts: [{ thinking: 'pure different thinking', providerMeta: { thinkingSummaries: ['pure different summary'], encryptedThinking: 'pure different encrypted', signature: 'pure different signature' } }], __meta: { modelId: 'other/old-model' } },
    {
      role: 'model',
      parts: [
        { thinking: 'mixed different thinking', providerMeta: { thinkingSummaries: ['mixed different summary'], encryptedThinking: 'mixed different encrypted', signature: 'mixed different signature' } },
        { text: 'mixed different text' },
        { functionCall: { id: 'call_filter', name: 'read', args: { filePath: 'README.md' } } },
      ],
      providerMeta: { providerSpecificFields: { reasoning_signature: 'mixed different opaque' }, sourceModelId: destinationModelId },
      __meta: { modelId: 'other/old-model' },
    },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'call_filter', name: 'read', response: { output: 'tool output' } } }] },
  ];
  const originalHistory = structuredClone(history);
  const captured = new Map<string, any>();
  const models = {
    responses: { providerKey: 'fixture', providerType: 'openai-responses', baseUrl: 'https://fixture.example', apiKey: '', model: 'destination', extraFields: {}, extraHeaders: {} },
    chat: { providerKey: 'fixture', providerType: 'openai-completions', baseUrl: 'https://fixture.example', apiKey: '', model: 'destination', extraFields: {}, extraHeaders: {} },
    anthropic: { providerKey: 'fixture', providerType: 'anthropic', baseUrl: 'https://fixture.example', apiKey: '', model: 'destination', extraFields: {}, extraHeaders: {} },
  } as const;

  try {
    await t.test('OpenAI Responses', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.set('responses', data);
        return { status: 200, statusText: 'OK', headers: {}, data: makeResponsesStream() };
      };
      await requestLlmOnce({ contents: history, systemPrompt: '', modelEntryOverride: models.responses as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });
    await t.test('OpenAI Chat Completions', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.set('chat', data);
        return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream() };
      };
      await requestLlmOnce({ contents: history, systemPrompt: '', modelEntryOverride: models.chat as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });
    await t.test('Anthropic Messages', async () => {
      (axios as any).post = async (_url: string, data: any) => {
        captured.set('anthropic', data);
        return { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'ok' }] } };
      };
      await requestLlmOnce({ contents: history, systemPrompt: '', modelEntryOverride: models.anthropic as any, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false });
    });

    assert.deepEqual(history, originalHistory, 'attempt filtering must not mutate caller or persisted history');
    for (const payload of captured.values()) {
      const serialized = JSON.stringify(payload);
      assert.equal(serialized.includes('__meta'), false);
      assert.equal(serialized.includes('same thinking') || serialized.includes('same summary'), true);
      assert.equal(serialized.includes('legacy thinking') || serialized.includes('legacy summary'), true);
      assert.equal(serialized.includes('different thinking'), false);
      assert.equal(serialized.includes('different summary'), false);
      assert.equal(serialized.includes('different encrypted'), false);
      assert.equal(serialized.includes('different signature'), false);
      assert.equal(serialized.includes('different opaque'), false);
      assert.equal(serialized.includes('pure different'), false);
      assert.equal(serialized.includes('mixed different thinking'), false);
      assert.equal(serialized.includes('different text'), true);
      assert.equal(serialized.includes('mixed different text'), true);
      assert.equal(serialized.includes('call_filter'), true);
      assert.equal(serialized.includes('tool output'), true);
    }

    const responseReasoning = captured.get('responses').input.filter((item: any) => item.type === 'reasoning');
    assert.deepEqual(responseReasoning.map((item: any) => item.encrypted_content), ['same encrypted', 'legacy encrypted']);
    const responseSerialized = JSON.stringify(captured.get('responses').input);
    assert.match(responseSerialized, /same-search/);
    assert.match(responseSerialized, /https:\/\/same\.example/);
    assert.doesNotMatch(responseSerialized, /different-search/);
    assert.doesNotMatch(responseSerialized, /https:\/\/different\.example/);

    const chatAssistants = captured.get('chat').messages.filter((message: any) => message.role === 'assistant');
    assert.equal(chatAssistants.length, 4, 'the known-different reasoning-only model message is omitted');
    assert.deepEqual(chatAssistants.filter((message: any) => message.reasoning_content).map((message: any) => message.reasoning_content), ['same thinking', 'legacy thinking']);
    assert.deepEqual(chatAssistants.filter((message: any) => message.provider_specific_fields).map((message: any) => message.provider_specific_fields.reasoning_signature), ['same opaque', 'legacy opaque']);
    assert.equal(chatAssistants.some((message: any) => Array.isArray(message.tool_calls) && message.tool_calls[0]?.id === 'call_filter'), true);

    const anthropicBlocks = captured.get('anthropic').messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
    assert.deepEqual(anthropicBlocks.filter((block: any) => block.type === 'thinking').map((block: any) => block.signature), ['same signature', 'legacy signature']);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('OpenAI Responses and Chat Completions preserve whole output usage and map official reasoning components', async t => {
  const originalPost = axios.post;
  const responsesModel = {
    providerKey: 'fixture', providerType: 'openai-responses', baseUrl: 'https://fixture.example', apiKey: '', model: 'responses', extraFields: {}, extraHeaders: {},
  } as any;
  const chatModel = {
    providerKey: 'fixture', providerType: 'openai-completions', baseUrl: 'https://fixture.example', apiKey: '', model: 'chat', extraFields: {}, extraHeaders: {},
  } as any;

  try {
    await t.test('Responses uses usage.output_tokens_details.reasoning_tokens', async () => {
      (axios as any).post = async () => ({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: makeResponsesStream('responses ok', {
          input_tokens: 17,
          output_tokens: 13,
          input_tokens_details: { cached_tokens: 5 },
          output_tokens_details: { reasoning_tokens: 8 },
        }),
      });

      const result = await requestLlmOnce({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        systemPrompt: '',
        modelEntryOverride: responsesModel,
        toolDefinitions: [],
        notifySessionEvents: false,
        registerAbortController: false,
      });

      assert.deepEqual(result.usage, {
        inputTokens: 12,
        outputTokens: 13,
        cachedTokens: 5,
        reasoningTokens: 8,
      });
    });

    await t.test('Chat Completions uses usage.completion_tokens_details.reasoning_tokens', async () => {
      (axios as any).post = async () => ({
        status: 200,
        statusText: 'OK',
        headers: {},
        data: makeChatCompletionStream('chat ok', {
          prompt_tokens: 17,
          completion_tokens: 13,
          prompt_tokens_details: { cached_tokens: 5 },
          completion_tokens_details: { reasoning_tokens: 8 },
        }),
      });

      const result = await requestLlmOnce({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        systemPrompt: '',
        modelEntryOverride: chatModel,
        toolDefinitions: [],
        notifySessionEvents: false,
        registerAbortController: false,
      });

      assert.deepEqual(result.usage, {
        inputTokens: 12,
        outputTokens: 13,
        cachedTokens: 5,
        reasoningTokens: 8,
      });
    });
  } finally {
    (axios as any).post = originalPost;
  }
});

test('chat persists a provider-reported reasoning component on model message usage without changing totals', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession('reasoning_usage_message_meta_session');
  const appendedMessages: Message[] = [];

  (axios as any).post = async () => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: makeChatCompletionStream('reasoned answer', {
      prompt_tokens: 17,
      completion_tokens: 13,
      prompt_tokens_details: { cached_tokens: 5 },
      completion_tokens_details: { reasoning_tokens: 8 },
    }),
  });

  try {
    await chat([{ text: 'hello' }], session, 0, {
      appendMessage: async (message: Message) => {
        appendedMessages.push(message);
        session.history.push(message);
      },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const modelMessage = appendedMessages.find(message => message.role === 'model');
    assert.deepEqual(modelMessage?.__meta?.usage, {
      inputTokens: 12,
      outputTokens: 13,
      cachedTokens: 5,
      reasoningTokens: 8,
    });
    assert.deepEqual(session.stats, {
      totalCachedTokens: 5,
      totalInputTokens: 12,
      totalOutputTokens: 13,
      lastUsage: null,
    });
  } finally {
    (axios as any).post = originalPost;
  }
});

test('assistant post-commit hook runs once only after append and its failure cannot retry provider or change history', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('committed_media_hook'));
  let providerCalls = 0;
  let deliveries = 0;
  (axios as any).post = async () => {
    providerCalls++;
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream('done') };
  };
  try {
    const result = await chat([{ text: 'hello' }], session, 0, {
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      appendMessage: async message => {
        if (message.role === 'model') assert.equal(deliveries, 0);
        session.history.push(message);
      },
      onCommittedAssistantMessage: message => {
        deliveries++;
        assert.strictEqual(session.history.at(-1), message);
        throw new Error('synthetic file adapter failure');
      },
    });
    assert.equal(result.text, 'done');
    assert.equal(providerCalls, 1);
    assert.equal(deliveries, 1);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);

    const failureSession = createOpenAITestSession(makeId('committed_media_hook_failed_append'));
    let dispatched = 0;
    await assert.rejects(() => chat([{ text: 'hello' }], failureSession, 0, {
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      appendMessage: async message => {
        if (message.role === 'model') throw new Error('synthetic assistant append failure');
        failureSession.history.push(message);
      },
      onCommittedAssistantMessage: () => { dispatched++; },
    }), /synthetic assistant append failure/);
    assert.equal(dispatched, 0);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('normal Responses commentary commits before later reasoning and completes with only its uncommitted suffix', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('responses_live_commentary'));
  session.model = 'responses-fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-fixture/model" />\n\nsystem prompt';
  const stream = new PassThrough();
  const deliveries: string[] = [];
  const appended: Message[] = [];
  let requestCount = 0;
  (axios as any).post = async () => {
    requestCount++;
    return { status: 200, statusText: 'OK', headers: {}, data: stream };
  };
  const frame = (event: any) => stream.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const pending = chat([{ text: 'draw a figure' }], session, 0, {
      toolDefinitions: [], registerAbortController: false,
      appendMessage: async message => { appended.push(message); session.history.push(message); },
      onIntermediateAssistantText: text => {
        assert.equal(session.history.filter(message => message.role === 'model').length, 1);
        deliveries.push(text);
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [], encrypted_content: 'opaque' } });
    frame({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'before' });
    frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'before' }], encrypted_content: 'opaque' } });
    frame({ type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', content: [] } });
    frame({ type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'Drawing now' });
    frame({ type: 'response.output_item.done', output_index: 1,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Drawing now' }] } });
    for (let tries = 0; tries < 60 && deliveries.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(deliveries, ['Drawing now']);
    assert.equal(requestCount, 1);
    assert.deepEqual(appended.filter(message => message.role === 'model')[0].parts.map(part => part.thinking || part.text), ['before', 'Drawing now']);
    assert.deepEqual(appended.filter(message => message.role === 'model')[0].__meta?.llmSegment,
      { outputStart: 0, outputEndExclusive: 2, complete: false });
    assert.deepEqual(getModelStreamDraft(session.id)?.parts?.map(part => part.outputIndex), []);
    frame({ type: 'response.output_item.added', output_index: 2, item: { type: 'reasoning', summary: [] } });
    frame({ type: 'response.reasoning_summary_text.done', output_index: 2, summary_index: 0, text: 'after' });
    frame({ type: 'response.output_item.done', output_index: 2,
      item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'after' }] } });
    frame({ type: 'response.output_item.added', output_index: 3, item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [] } });
    frame({ type: 'response.output_text.done', output_index: 3, content_index: 0, text: '' });
    frame({ type: 'response.output_item.done', output_index: 3,
      item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '' }] } });
    frame({ type: 'response.completed', response: { output: [], usage: { input_tokens: 5, output_tokens: 9 } } });
    stream.end();
    const result = await pending;
    assert.equal(result.text, '');
    assert.equal(appended.filter(message => message.role === 'model').length, 2);
    const finalMessage = appended.at(-1)!;
    assert.deepEqual(finalMessage.parts.map(part => part.thinking ?? part.text), ['after', '']);
    assert.deepEqual(finalMessage.__meta?.llmSegment, { outputStart: 2, outputEndExclusive: 4, complete: true });
    assert.deepEqual(finalMessage.__meta?.usage, { inputTokens: 5, outputTokens: 9, cachedTokens: 0 });
    assert.equal(appended.filter(message => message.__meta?.usage).length, 1);
    assert.equal(session.stats.totalOutputTokens, 9);
  } finally {
    (axios as any).post = originalPost;
    stream.destroy();
  }
});

test('partial Responses failure retries as a new journaled request from committed history within the original budget', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('responses_partial_retry'));
  session.model = 'responses-fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-fixture/model" />\n\nsystem prompt';
  const resolvedPath = '/display-only/agent/tmp/seed.txt';
  const previousToolMessage: Message = { role: 'tool', parts: [{ functionResponse: {
    tool_use_id: 'seed-read', name: 'read', response: { output: 'Seed read output' },
    __meta: { resolvedPaths: [{ raw: 'seed.txt', resolved: resolvedPath, nodeId: 'master' }] },
  } }] };
  session.history.push(
    { role: 'model', parts: [{ functionCall: { id: 'seed-read', name: 'read', args: { filePath: 'seed.txt' } } }] },
    previousToolMessage,
  );
  const firstStream = new PassThrough();
  const requestBodies: any[] = [];
  const retryEvents: any[] = [];
  const deliveries: string[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    requestBodies.push(body);
    return { status: 200, statusText: 'OK', headers: {},
      data: requestBodies.length === 1 ? firstStream : makeResponsesStream('Final after retry'),
    };
  };
  const frame = (event: any) => firstStream.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const pending = chat([{ text: 'continue after progress' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, maxRetries: 2,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: text => { deliveries.push(text); },
      onRetry: event => { retryEvents.push(event); },
    });
    await new Promise(resolve => setImmediate(resolve));
    frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } });
    frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'First committed' });
    frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'First committed' }] } });
    for (let tries = 0; tries < 60 && deliveries.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(deliveries, ['First committed']);
    firstStream.destroy(new Error('synthetic upstream stream loss'));
    const result = await pending;
    assert.equal(result.text, 'Final after retry');
    assert.equal(requestBodies.length, 2);
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].nextAttempt, 2);
    assert.equal(JSON.stringify(requestBodies[0].input).includes('First committed'), false);
    assert.equal(JSON.stringify(requestBodies[1].input).includes('First committed'), true);
    for (const body of requestBodies) assert.equal(JSON.stringify(body).includes(resolvedPath), false);
    assert.deepEqual(previousToolMessage.parts[0].functionResponse?.__meta?.resolvedPaths,
      [{ raw: 'seed.txt', resolved: resolvedPath, nodeId: 'master' }], 'durable UI history retains Code target');
    const modelMessages = session.history.filter(message => message.role === 'model' && message.__meta?.llmRequestId);
    assert.equal(modelMessages.length, 2);
    const firstRequestId = modelMessages[0].__meta?.llmRequestId as string;
    const nextRequestId = modelMessages[1].__meta?.llmRequestId as string;
    assert.notEqual(firstRequestId, nextRequestId);
    assert.equal(modelMessages[1].__meta?.llmAttempt, 1);
    const firstJournal = await reconstructLlmRequest(firstRequestId);
    const nextJournal = await reconstructLlmRequest(nextRequestId);
    assert.equal(firstJournal.completeness, 'complete');
    assert.equal(nextJournal.completeness, 'complete');
    if (firstJournal.completeness === 'complete' && nextJournal.completeness === 'complete') {
      assert.equal(firstJournal.attempts[0].result?.outcome, 'failure');
      assert.equal(nextJournal.attempts[0].result?.outcome, 'success');
      assert.equal(JSON.stringify(nextJournal.messages).includes('First committed'), true);
      assert.equal(JSON.stringify(firstJournal.messages).includes(resolvedPath), false);
      assert.equal(JSON.stringify(nextJournal.messages).includes(resolvedPath), false,
        'retry request rebuilt from committed history must also remove display-only paths');
      assert.equal(JSON.stringify(nextJournal.messages).includes('Seed read output'), true);
    }
  } finally {
    (axios as any).post = originalPost;
    firstStream.destroy();
  }
});

test('opted-in completed encrypted reasoning survives a broken Responses stream and reaches a new request and journal', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('responses_reasoning_checkpoint_retry'));
  session.model = 'responses-keep-route';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-keep-route" />\n\nsystem prompt';
  const firstStream = new PassThrough();
  const bodies: any[] = [];
  const delivered: string[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    return { status: 200, statusText: 'OK', headers: {},
      data: bodies.length === 1 ? firstStream : makeResponsesStream('After retry') };
  };
  const frame = (event: any) => firstStream.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const pending = chat([{ text: 'reason first' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, maxRetries: 2,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: text => { delivered.push(text); },
    });
    for (let tries = 0; tries < 100 && bodies.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bodies.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'private-rs-id', summary: [] } });
    frame({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'thinking first' });
    frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', id: 'private-rs-id', summary: [{ type: 'summary_text', text: 'thinking first' }], encrypted_content: 'opaque-checkpoint' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    firstStream.destroy(new Error('synthetic network stream loss'));
    const result = await pending;
    assert.equal(result.text, 'After retry');
    assert.equal(bodies.length, 2);
    const models = session.history.filter(message => message.role === 'model');
    assert.equal(models.length, 2);
    assert.deepEqual(models[0].__meta?.llmSegment, { outputStart: 0, outputEndExclusive: 1, complete: false });
    assert.equal(models[0].__meta?.modelId, 'responses-keep-fixture/enabled');
    assert.equal(models[0].parts[0].providerMeta?.encryptedThinking, 'opaque-checkpoint');
    assert.deepEqual(delivered, [], 'opaque reasoning checkpoint sends no empty Channel text');
    const firstId = models[0].__meta?.llmRequestId as string;
    const nextId = result.llmRequestId!;
    assert.notEqual(firstId, nextId);
    assert.equal(models[1].__meta?.llmRequestId, nextId);
    const secondInput = JSON.stringify(bodies[1].input);
    assert.ok(secondInput.includes('opaque-checkpoint'));
    assert.equal(secondInput.includes('private-rs-id'), false, 'native replay does not include provider reasoning IDs');
    const firstJournal = await reconstructLlmRequest(firstId);
    const secondJournal = await reconstructLlmRequest(nextId);
    assert.equal(firstJournal.completeness, 'complete');
    assert.equal(secondJournal.completeness, 'complete');
    if (firstJournal.completeness === 'complete' && secondJournal.completeness === 'complete') {
      assert.equal(firstJournal.attempts[0].result?.outcome, 'failure');
      assert.equal(secondJournal.attempts[0].result?.outcome, 'success');
      assert.ok(JSON.stringify(secondJournal.messages).includes('opaque-checkpoint'));
    }
  } finally { (axios as any).post = originalPost; firstStream.destroy(); }
});

test('reasoning checkpoints require an opted-in concrete model and contiguous completed encrypted output', async () => {
  const originalPost = axios.post;
  const reasoning = (index: number, encrypted?: string) => ({ type: 'response.output_item.done', output_index: index,
    item: { type: 'reasoning', summary: [{ type: 'summary_text', text: `summary ${index}` }],
      ...(encrypted ? { encrypted_content: encrypted } : {}) } });
  const cases = [
    { model: 'responses-fixture/model', events: [reasoning(0, 'private-default')], kept: 0 },
    { model: 'responses-keep-fixture/disabled', events: [reasoning(0, 'private-disabled')], kept: 0 },
    { model: 'responses-keep-fixture/enabled', events: [reasoning(0)], kept: 0 },
    { model: 'responses-keep-fixture/enabled', events: [
      { type: 'response.output_item.added', output_index: 0,
        item: { type: 'reasoning', encrypted_content: 'not-yet-complete' } },
    ], kept: 0 },
    { model: 'responses-keep-fixture/enabled', events: [reasoning(1, 'not-contiguous')], kept: 0 },
    { model: 'responses-keep-fixture/enabled', events: [
      { type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', call_id: 'not-executed', name: 'read', arguments: '{}' } },
      reasoning(1, 'after-unexecuted-tool'),
    ], kept: 0 },
    { model: 'responses-keep-fixture/enabled', events: [reasoning(0, 'safe-first'), reasoning(1), reasoning(2, 'must-not-skip-summary')], kept: 1 },
    { model: 'responses-keep-fixture/enabled', events: [reasoning(0, 'safe-before-image'),
      { type: 'response.output_item.added', output_index: 1, item: { type: 'image_generation_call', status: 'in_progress' } }], kept: 1 },
  ];
  try {
    for (const [caseIndex, entry] of cases.entries()) {
      const session = createOpenAITestSession(makeId(`reasoning_error_case_${caseIndex}`));
      session.model = entry.model;
      session.persistentMemorySnapshot = `<foxwarm-current-model model-id="${entry.model}" />\n\nsystem prompt`;
      const stream = new PassThrough();
      let requests = 0;
      let deliveries = 0;
      (axios as any).post = async () => { requests++; return { status: 200, statusText: 'OK', headers: {}, data: stream }; };
      const frame = (event: any) => stream.write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        const pending = chat([{ text: 'work' }], session, 0, {
          toolDefinitions: [], registerAbortController: false, maxRetries: 1,
          appendMessage: async message => { session.history.push(message); },
          onIntermediateAssistantText: () => { deliveries++; },
        });
        for (let tries = 0; tries < 100 && requests === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(requests, 1);
        await new Promise(resolve => setImmediate(resolve));
        for (const event of entry.events) frame(event);
        frame({ type: 'response.failed', response: { error: { message: 'upstream interrupted' } } });
        stream.end();
        await assert.rejects(pending, error => error instanceof LlmRequestError);
        const models = session.history.filter(message => message.role === 'model');
        assert.equal(models.length, entry.kept, `${entry.model} / ${caseIndex}`);
        if (entry.kept) {
          assert.deepEqual(models[0].__meta?.llmSegment, { outputStart: 0, outputEndExclusive: 1, complete: false });
          assert.ok(models[0].parts[0].providerMeta?.encryptedThinking);
          assert.equal(isSessionTurnIncomplete(session.history), true);
        }
        assert.equal(deliveries, 0);
        assert.equal(requests, 1, 'no attempt remains for automatic retry');
      } finally { stream.destroy(); }
    }
  } finally { (axios as any).post = originalPost; }
});

test('a failed stream checkpoints only reasoning after already committed commentary', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('responses_commentary_then_reasoning_error'));
  session.model = 'responses-keep-fixture/enabled';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-keep-fixture/enabled" />\n\nsystem prompt';
  const firstStream = new PassThrough();
  const bodies: any[] = [];
  const delivered: string[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    return { status: 200, statusText: 'OK', headers: {}, data: bodies.length === 1 ? firstStream : makeResponsesStream('Finished') };
  };
  const frame = (event: any) => firstStream.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const pending = chat([{ text: 'show work' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, maxRetries: 2,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: text => { delivered.push(text); },
    });
    for (let tries = 0; tries < 100 && bodies.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bodies.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Drawing' }] } });
    for (let tries = 0; tries < 100 && delivered.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(delivered, ['Drawing']);
    frame({ type: 'response.output_item.done', output_index: 1,
      item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'After drawing' }], encrypted_content: 'opaque-after-commentary' } });
    frame({ type: 'response.failed', response: { error: { message: 'upstream interrupted' } } });
    firstStream.end();
    await pending;
    const models = session.history.filter(message => message.role === 'model');
    assert.equal(models.length, 3);
    assert.deepEqual(models.map(message => message.__meta?.llmSegment), [
      { outputStart: 0, outputEndExclusive: 1, complete: false },
      { outputStart: 1, outputEndExclusive: 2, complete: false },
      undefined,
    ]);
    assert.equal(models[0].parts[0].text, 'Drawing');
    assert.equal(models[1].parts[0].providerMeta?.encryptedThinking, 'opaque-after-commentary');
    assert.deepEqual(delivered, ['Drawing']);
    assert.equal(bodies.length, 2);
    const input = JSON.stringify(bodies[1].input);
    assert.equal(input.split('Drawing').length - 1, 1);
    assert.equal(input.split('opaque-after-commentary').length - 1, 1);
  } finally { (axios as any).post = originalPost; firstStream.destroy(); }
});

test('successful Responses reasoning is not segmented; Stop and local append failure never checkpoint or retry', async () => {
  const originalPost = axios.post;
  try {
    for (const mode of ['success', 'stop', 'local-failure'] as const) {
      const session = createOpenAITestSession(makeId(`responses_reasoning_${mode}`));
      session.model = 'responses-keep-fixture/enabled';
      session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-keep-fixture/enabled" />\n\nsystem prompt';
      const stream = new PassThrough();
      const stop = new AbortController();
      let calls = 0;
      let retries = 0;
      let deliveries = 0;
      (axios as any).post = async () => { calls++; return { status: 200, statusText: 'OK', headers: {}, data: stream }; };
      const frame = (event: any) => stream.write(`data: ${JSON.stringify(event)}\n\n`);
      try {
        const pending = chat([{ text: 'work' }], session, 0, {
          toolDefinitions: [], registerAbortController: false, abortSignal: stop.signal, maxRetries: 2,
          appendMessage: async message => {
            if (mode === 'local-failure' && message.role === 'model') throw new Error('checkpoint storage failed');
            session.history.push(message);
          },
          onIntermediateAssistantText: () => { deliveries++; },
          onRetry: () => { retries++; },
        });
        for (let tries = 0; tries < 100 && calls === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(calls, 1);
        await new Promise(resolve => setImmediate(resolve));
        frame({ type: 'response.output_item.done', output_index: 0,
          item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'complete reasoning' }], encrypted_content: 'opaque-success' } });
        if (mode === 'success') {
          frame({ type: 'response.output_item.done', output_index: 1,
            item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Final' }] } });
          frame({ type: 'response.completed', response: { output: [], usage: { input_tokens: 3, output_tokens: 4 } } });
          stream.end();
          await pending;
          const models = session.history.filter(message => message.role === 'model');
          assert.equal(models.length, 1);
          assert.equal(models[0].__meta?.llmSegment, undefined);
          assert.equal(models[0].parts[0].providerMeta?.encryptedThinking, 'opaque-success');
          assert.deepEqual(models[0].__meta?.usage, { inputTokens: 3, outputTokens: 4, cachedTokens: 0 });
        } else {
          if (mode === 'stop') {
            await new Promise(resolve => setTimeout(resolve, 20));
            stop.abort();
            await assert.rejects(pending, (error: any) => error?.name === 'AbortError');
          } else {
            frame({ type: 'response.failed', response: { error: { message: 'upstream interrupted' } } });
            stream.end();
            await assert.rejects(pending, /checkpoint storage failed/);
          }
          assert.equal(session.history.some(message => message.role === 'model'), false);
          assert.equal(calls, 1);
          assert.equal(retries, 0);
        }
        assert.equal(deliveries, 0);
      } finally { stream.destroy(); }
    }
  } finally { (axios as any).post = originalPost; }
});

test('a completed Responses payload rejected during local image validation does not become an interrupted reasoning checkpoint', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('responses_complete_local_validation_error'));
  session.model = 'responses-keep-fixture/enabled';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-keep-fixture/enabled" />\n\nsystem prompt';
  let calls = 0;
  (axios as any).post = async () => {
    calls++;
    const stream = new PassThrough();
    process.nextTick(() => {
      for (const event of [
        { type: 'response.output_item.done', output_index: 0,
          item: { type: 'reasoning', encrypted_content: 'must-not-checkpoint', summary: [] as any[] } },
        { type: 'response.output_item.done', output_index: 1,
          item: { type: 'image_generation_call', status: 'completed', result: 'not-a-raster-image' } },
        { type: 'response.completed', response: { output: [] as any[], usage: { input_tokens: 2, output_tokens: 3 } } },
      ]) stream.write(`data: ${JSON.stringify(event)}\n\n`);
      stream.end();
    });
    return { status: 200, statusText: 'OK', headers: {}, data: stream };
  };
  try {
    await assert.rejects(() => chat([{ text: 'work' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, maxRetries: 1,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: () => {},
    }), error => error instanceof LlmRequestError);
    assert.equal(calls, 1);
    assert.equal(session.history.some(message => message.role === 'model'), false);
  } finally { (axios as any).post = originalPost; }
});

test('OpenAI Responses WebSocket stream loss saves opted-in encrypted reasoning before a fresh attempt', async () => {
  class BrokenSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    sent: any[] = [];
    _socket = { ref() {}, unref() {} };
    constructor(private readonly first: boolean) {
      super();
      process.nextTick(() => { this.readyState = WebSocket.OPEN; this.emit('open'); });
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
      process.nextTick(() => {
        if (this.first) {
          this.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_item.done', output_index: 0,
            item: { type: 'reasoning', id: 'ws-private-id', summary: [], encrypted_content: 'ws-opaque' } })));
          this.readyState = WebSocket.CLOSED;
          this.emit('close', 1006, Buffer.from('upstream closed'));
        } else {
          this.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_item.done', output_index: 0,
            item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'WS recovered' }] } })));
          this.emit('message', Buffer.from(JSON.stringify({ type: 'response.completed', response: {
            id: 'ws-complete-after-retry', output: [], usage: { input_tokens: 3, output_tokens: 4 },
          } })));
        }
      });
    }
    close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000, Buffer.alloc(0)); }
    terminate() { this.close(); }
  }
  const sockets: BrokenSocket[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new BrokenSocket(sockets.length === 0);
    sockets.push(socket);
    return socket as any;
  } });
  const session = createOpenAITestSession(makeId('responses_ws_reasoning_error'));
  session.model = 'responses-keep-ws-fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-keep-ws-fixture/model" />\n\nsystem prompt';
  try {
    const result = await chat([{ text: 'reason over socket' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, maxRetries: 2,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: () => {},
    });
    assert.equal(result.text, 'WS recovered');
    assert.equal(sockets.length, 2);
    const input = JSON.stringify(sockets[1].sent[0].input);
    assert.ok(input.includes('ws-opaque'));
    assert.equal(input.includes('ws-private-id'), false);
    assert.equal(session.history.filter(message => message.role === 'model').length, 2);
    assert.deepEqual(session.history.find(message => message.role === 'model')?.__meta?.llmSegment,
      { outputStart: 0, outputEndExclusive: 1, complete: false });
  } finally { setOpenAIWsTransportTestHooks(); clearOpenAIWsCompletedChains(); }
});

test('error-checkpoint encrypted reasoning stays out of a different concrete failover wire request', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('responses_reasoning_failover_filter'));
  session.model = 'responses-keep-failover';
  session.effort = 'low';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-keep-failover" />\n\nsystem prompt';
  const first = new PassThrough();
  const bodies: any[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    return { status: 200, statusText: 'OK', headers: {},
      data: bodies.length === 1 ? first : makeResponsesStream('Other leaf finished') };
  };
  const frame = (event: any) => first.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const pending = chat([{ text: 'switch after error' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, maxRetries: 2,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: () => {},
      prepareRetry: async () => {
        assert.equal(session.history.at(-1)?.parts[0]?.providerMeta?.encryptedThinking, 'only-original-leaf',
          'the previous error-time reasoning checkpoint settles before owner preparation');
        session.history.push({ role: 'user', parts: [{ text: 'failover queued correction' }] });
        return true;
      },
    });
    for (let tries = 0; tries < 100 && bodies.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(bodies.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'reasoning', encrypted_content: 'only-original-leaf', summary: [] } });
    frame({ type: 'response.failed', response: { error: { message: 'upstream interrupted' } } });
    first.end();
    assert.equal((await pending).text, 'Other leaf finished');
    assert.equal(bodies.length, 2);
    const models = session.history.filter(message => message.role === 'model');
    assert.equal(models[0].__meta?.modelId, 'responses-keep-fixture/enabled');
    assert.equal(models[1].__meta?.modelId, 'responses-fixture/model');
    assert.equal(models[0].parts[0].providerMeta?.encryptedThinking, 'only-original-leaf');
    assert.equal(JSON.stringify(bodies[1].input).includes('only-original-leaf'), false);
    assert.equal(JSON.stringify(bodies[1].input).split('failover queued correction').length - 1, 1);
    assert.deepEqual(bodies.map(body => body.reasoning.effort), ['low', 'low']);
    assert.equal(models[1].__meta?.virtualModelKey, 'responses-keep-failover');
    assert.equal(models[1].__meta?.llmAttempt, 1);
  } finally { (axios as any).post = originalPost; first.destroy(); }
});

test('Responses commentary followed by no further items commits usage-only completion without invented final text', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('responses_metadata_completion'));
  session.model = 'responses-fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-fixture/model" />\n\nsystem prompt';
  (axios as any).post = async () => {
    const stream = new PassThrough();
    process.nextTick(() => {
      for (const event of [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Still working' },
        { type: 'response.output_item.done', output_index: 0,
          item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Still working' }] } },
        { type: 'response.completed', response: { output: [] as any[], usage: { input_tokens: 3, output_tokens: 4 } } },
      ]) stream.write(`data: ${JSON.stringify(event)}\n\n`);
      stream.end();
    });
    return { status: 200, statusText: 'OK', headers: {}, data: stream };
  };
  try {
    const texts: string[] = [];
    const result = await chat([{ text: 'one item' }], session, 0, {
      toolDefinitions: [], registerAbortController: false,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: text => { texts.push(text); },
    });
    const models = session.history.filter(message => message.role === 'model');
    assert.deepEqual(texts, ['Still working']);
    assert.equal(result.text, '');
    assert.equal(models.length, 2);
    assert.deepEqual(models[1].parts, []);
    assert.deepEqual(models[1].__meta?.llmSegment, { outputStart: 1, outputEndExclusive: 1, complete: true });
    assert.deepEqual(models[1].__meta?.usage, { inputTokens: 3, outputTokens: 4, cachedTokens: 0 });
    assert.equal(convertToOpenAIResponsesFormat([models[1]], 'responses-fixture/model').length, 0);
    assert.equal(isSessionTurnIncomplete(session.history), false);
  } finally { (axios as any).post = originalPost; }
});

test('native image in a committed commentary prefix is externalized and delivered once, not replayed by the final suffix', async () => {
  const originalPost = axios.post;
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
  const session = createOpenAITestSession(makeId('responses_prefix_image'));
  session.model = 'responses-fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-fixture/model" />\n\nsystem prompt';
  const media: Message[] = [];
  const text: string[] = [];
  const stream = new PassThrough();
  let providerCalls = 0;
  (axios as any).post = async () => {
    providerCalls++;
    return { status: 200, statusText: 'OK', headers: {}, data: stream };
  };
  const frame = (event: any) => stream.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const pending = chat([{ text: 'draw' }], session, 0, {
      toolDefinitions: [], registerAbortController: false,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: value => { text.push(value); },
      onCommittedAssistantMessage: message => {
        if (message.parts.some(part => part.imageMeta?.origin === 'generated')) {
          assert.ok(session.history.includes(message));
          media.push(message);
        }
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } });
    frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Drawing' });
    frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Drawing' }] } });
    for (let tries = 0; tries < 60 && text.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(text, ['Drawing']);
    frame({ type: 'response.output_item.added', output_index: 1, item: { type: 'image_generation_call', id: 'ig_fixture', status: 'in_progress' } });
    frame({ type: 'response.image_generation_call.partial_image', output_index: 1, partial_image_b64: 'do-not-send' });
    frame({ type: 'response.output_item.done', output_index: 1,
      item: { type: 'image_generation_call', id: 'ig_fixture', status: 'completed', output_format: 'png', result: png.toString('base64') } });
    frame({ type: 'response.output_item.added', output_index: 2, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } });
    frame({ type: 'response.output_text.done', output_index: 2, content_index: 0, text: 'Ready' });
    frame({ type: 'response.output_item.done', output_index: 2,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Ready' }] } });
    for (let tries = 0; tries < 60 && media.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(media.length, 1);
    assert.deepEqual(text, ['Drawing', 'Ready']);
    assert.equal(media[0].parts.filter(part => part.imageMeta?.origin === 'generated').length, 1);
    frame({ type: 'response.output_item.added', output_index: 3, item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [] } });
    frame({ type: 'response.output_text.done', output_index: 3, content_index: 0, text: '' });
    frame({ type: 'response.output_item.done', output_index: 3,
      item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: '' }] } });
    frame({ type: 'response.completed', response: { output: [], usage: { input_tokens: 4, output_tokens: 9 } } });
    stream.end();
    const result = await pending;
    assert.equal(result.text, '');
    assert.equal(providerCalls, 1);
    assert.equal(media.length, 1);
    assert.equal(session.history.filter(message => message.role === 'model').length, 3);
    assert.deepEqual(session.history.at(-1)?.parts, [{ text: '', phase: 'final_answer' }]);
    assert.equal(session.history.filter(message => message.__meta?.usage).length, 1);
  } finally {
    (axios as any).post = originalPost;
    stream.destroy();
    await Promise.all(media.flatMap(message => message.parts)
      .filter(part => part.inlineDataRef?.blobId)
      .map(part => fs.remove(resolveImageBlobPath(part.inlineDataRef!.blobId!))));
  }
});

test('streamed commentary segments share the physical image-count and decoded-byte budgets', async () => {
  const originalPost = axios.post;
  const tiny = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
  const large = await sharp({ create: { width: 2500, height: 2500, channels: 4,
    background: { r: 4, g: 8, b: 12, alpha: 1 } } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(large.length < 32 * 1024 * 1024 && large.length * 3 > 64 * 1024 * 1024);

  async function runScenario(image: Buffer, batches: number[], expectedImages: number, reason: string) {
    const session = createOpenAITestSession(makeId('responses_segmented_image_budget'));
    session.model = 'responses-image-fixture/model';
    session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-image-fixture/model" />\n\nsystem prompt';
    const stream = new PassThrough();
    const media: Message[] = [];
    let requestCount = 0;
    (axios as any).post = async (_url: string, body: any) => {
      requestCount++;
      assert.ok(body.tools?.some((tool: any) => tool.type === 'image_generation'));
      return { status: 200, statusText: 'OK', headers: {}, data: stream };
    };
    const frame = (event: any) => stream.write(`data: ${JSON.stringify(event)}\n\n`);
    let outputIndex = 0;
    const emitBatch = (section: number) => {
      for (let itemNumber = 0; itemNumber < batches[section]; itemNumber++) {
        const index = outputIndex++;
        frame({ type: 'response.output_item.added', output_index: index,
          item: { type: 'image_generation_call', status: 'in_progress' } });
        frame({ type: 'response.output_item.done', output_index: index,
          item: { type: 'image_generation_call', status: 'completed', output_format: 'png', result: image.toString('base64') } });
      }
      const index = outputIndex++;
      frame({ type: 'response.output_item.added', output_index: index,
        item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } });
      frame({ type: 'response.output_item.done', output_index: index,
        item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: `batch ${section}` }] } });
    };
    try {
      const pending = chat([{ text: 'draw images' }], session, 0, {
        toolDefinitions: [], registerAbortController: false, notifySessionEvents: false, maxRetries: 1,
        appendMessage: async message => { session.history.push(message); },
        onIntermediateAssistantText: () => {},
        onCommittedAssistantMessage: message => {
          if (message.parts.some(part => part.imageMeta?.origin === 'generated')) media.push(message);
        },
      });
      await new Promise(resolve => setImmediate(resolve));
      emitBatch(0);
      for (let tries = 0; tries < 250 && media.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(media.length, 1, 'first completed commentary segment delivered its images while the stream stayed open');
      emitBatch(1);
      frame({ type: 'response.completed', response: { output: [], usage: { input_tokens: 4, output_tokens: 8 } } });
      stream.end();
      await pending;
      const persisted = session.history.filter(message => message.role === 'model').flatMap(message => message.parts);
      const imageParts = persisted.filter(part => part.imageMeta?.origin === 'generated');
      const delivered = media.flatMap(message => message.parts).filter(part => part.imageMeta?.origin === 'generated');
      assert.equal(requestCount, 1);
      assert.equal(imageParts.length, expectedImages);
      assert.equal(delivered.length, expectedImages);
      assert.equal(new Set(imageParts.map(part => part.imageMeta?.imageId)).size, expectedImages,
        'fallback image identities use absolute provider output indices across commits');
      assert.ok(persisted.some(part => part.text?.includes(reason)), 'excess image is reported without a Blob');
    } finally {
      stream.destroy();
      await Promise.all([...new Set(session.history.flatMap(message => message.parts)
        .map(part => part.inlineDataRef?.blobId).filter((id): id is string => !!id))]
        .map(id => fs.remove(resolveImageBlobPath(id))));
    }
  }

  try {
    await runScenario(tiny, [4, 5], 8, '8-image limit');
    await runScenario(large, [2, 1], 2, 'cumulative limit');
  } finally { (axios as any).post = originalPost; }
});

test('a non-image WebSocket completion reuses the chain after two assistant segments are committed in output order', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer();
  class TestSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    sent: any[] = [];
    _socket = { ref() {}, unref() {} };
    constructor(private readonly respond: (request: any, socket: TestSocket) => void) {
      super();
      process.nextTick(() => { this.readyState = WebSocket.OPEN; this.emit('open'); });
    }
    send(raw: string) { const request = JSON.parse(raw); this.sent.push(request); process.nextTick(() => this.respond(request, this)); }
    frame(event: any) { this.emit('message', Buffer.from(JSON.stringify(event))); }
    close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000, Buffer.alloc(0)); }
    terminate() { this.close(); }
  }
  const session = createOpenAITestSession(makeId('responses_ws_segments'));
  session.model = 'responses-ws-fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-ws-fixture/model" />\n\nsystem prompt';
  const sockets: TestSocket[] = [];
  let finishFirst: (() => void) | undefined;
  const intermediate: string[] = [];
  setOpenAIWsTransportTestHooks({ socketFactory: () => {
    const socket = new TestSocket((_request, current) => {
      const number = current.sent.length;
      if (number === 1) {
        for (const event of [
          { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [], encrypted_content: 'opaque' } },
          { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'before' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'before' }], encrypted_content: 'opaque' } },
          { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } },
          { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'Drawing' },
          { type: 'response.output_item.done', output_index: 1, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Drawing' }] } },
        ]) current.frame(event);
        finishFirst = () => {
          current.frame({ type: 'response.output_item.added', output_index: 2, item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [] } });
          current.frame({ type: 'response.output_text.done', output_index: 2, content_index: 0, text: 'Finished' });
          current.frame({ type: 'response.output_item.done', output_index: 2, item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Finished' }] } });
          current.frame({ type: 'response.completed', response: { id: 'ws-first', output: [], usage: { input_tokens: 3, output_tokens: 7 } } });
        };
      } else if (number === 2) {
        current.frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [] } });
        current.frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Next turn' });
        current.frame({ type: 'response.completed', response: { id: 'ws-next', output: [], usage: { input_tokens: 5, output_tokens: 2 } } });
      } else {
        current.frame({ type: 'response.output_item.added', output_index: 0,
          item: { type: 'image_generation_call', id: 'ig_ws_fixture', status: 'in_progress' } });
        current.frame({ type: 'response.output_item.done', output_index: 0,
          item: { type: 'image_generation_call', id: 'ig_ws_fixture', status: 'completed', output_format: 'png', result: png.toString('base64') } });
        current.frame({ type: 'response.completed', response: { id: 'ws-image', output: [], usage: { input_tokens: 7, output_tokens: 5 } } });
      }
    });
    sockets.push(socket);
    return socket as any;
  } });
  const options = {
    toolDefinitions: [] as any[], registerAbortController: false,
    appendMessage: async (message: Message) => { session.history.push(message); },
    onIntermediateAssistantText: (text: string) => { intermediate.push(text); },
  };
  try {
    const first = chat([{ text: 'first turn' }], session, 0, options);
    for (let tries = 0; tries < 80 && intermediate.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(intermediate, ['Drawing']);
    assert.ok(finishFirst);
    finishFirst!();
    assert.equal((await first).text, 'Finished');
    assert.equal(session.history.filter(message => message.role === 'model').length, 2);
    assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);
    assert.equal((await chat([{ text: 'next turn' }], session, 1, options)).text, 'Next turn');
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].sent.length, 2);
    assert.equal(sockets[0].sent[1].previous_response_id, 'ws-first');
    assert.equal(sockets[0].sent[1].input.length, 1);
    assert.equal(sockets[0].sent[1].input[0].content[0].text, 'next turn');
    const deliveredImages: Message[] = [];
    await chat([{ text: 'image turn' }], session, 2, {
      ...options,
      onCommittedAssistantMessage: message => { if (message.parts.some(part => part.imageMeta?.origin === 'generated')) deliveredImages.push(message); },
    });
    assert.equal(deliveredImages.length, 1);
    assert.equal(sockets[0].sent.length, 3);
    assert.equal(getOpenAIWsCompletedChainCountForTests(), 0, 'generated images still discard the WebSocket chain');
    await Promise.all(deliveredImages.flatMap(message => message.parts)
      .filter(part => part.inlineDataRef?.blobId)
      .map(part => fs.remove(resolveImageBlobPath(part.inlineDataRef!.blobId!))));
  } finally {
    setOpenAIWsTransportTestHooks();
    clearOpenAIWsCompletedChains();
  }
});

test('local commentary append failures do not retry the provider or deliver uncommitted text', async () => {
  const originalPost = axios.post;
  let providerCalls = 0;
  let deliveries = 0;
  const stream = () => {
    const output = new PassThrough();
    process.nextTick(() => {
      for (const event of [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Do not send before save' },
        { type: 'response.output_item.done', output_index: 0,
          item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Do not send before save' }] } },
      ]) output.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    return output;
  };
  (axios as any).post = async () => {
    providerCalls++;
    return { status: 200, statusText: 'OK', headers: {}, data: stream() };
  };
  try {
    for (const postCommit of [false, true]) {
      const session = createOpenAITestSession(makeId('responses_commit_failure'));
      session.model = 'responses-fixture/model';
      session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-fixture/model" />\n\nsystem prompt';
      const beforeCalls = providerCalls;
      const postCommitError: any = new Error('synthetic authoritative append failure');
      if (postCommit) postCommitError.authorityCommitted = true;
      await assert.rejects(() => chat([{ text: 'work' }], session, 0, {
        toolDefinitions: [], registerAbortController: false, maxRetries: 2,
        appendMessage: async message => {
          if (message.role === 'model' && !postCommit) throw postCommitError;
          session.history.push(message);
          if (message.role === 'model' && postCommit) throw postCommitError;
        },
        onIntermediateAssistantText: () => { deliveries++; },
      }), /synthetic authoritative append failure/);
      assert.equal(providerCalls, beforeCalls + 1);
      assert.equal(session.history.filter(message => message.role === 'model').length, postCommit ? 1 : 0);
      assert.equal(deliveries, 0);
    }
  } finally { (axios as any).post = originalPost; }
});

test('Responses function calls before and after commentary keep provider order without early tool publication', async () => {
  const originalPost = axios.post;
  try {
    for (const callFirst of [true, false]) {
      const session = createOpenAITestSession(makeId('responses_tool_boundary'));
      session.model = 'responses-fixture/model';
      session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-fixture/model" />\n\nsystem prompt';
      const stream = new PassThrough();
      const delivered: string[] = [];
      const calls: Array<{ role: string; names: string[] }> = [];
      (axios as any).post = async () => ({ status: 200, statusText: 'OK', headers: {}, data: stream });
      const frame = (event: any) => stream.write(`data: ${JSON.stringify(event)}\n\n`);
      const commentaryAt = callFirst ? 1 : 0;
      const callAt = callFirst ? 0 : 1;
      const commentary = () => {
        frame({ type: 'response.output_item.added', output_index: commentaryAt,
          item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } });
        frame({ type: 'response.output_text.done', output_index: commentaryAt, content_index: 0, text: 'Reading' });
        frame({ type: 'response.output_item.done', output_index: commentaryAt,
          item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Reading' }] } });
      };
      const tool = () => {
        frame({ type: 'response.output_item.added', output_index: callAt,
          item: { type: 'function_call', call_id: 'call_fixture', name: 'read', arguments: '' } });
        frame({ type: 'response.function_call_arguments.done', output_index: callAt, arguments: '{"filePath":"README.md"}' });
        frame({ type: 'response.output_item.done', output_index: callAt,
          item: { type: 'function_call', call_id: 'call_fixture', name: 'read', arguments: '{"filePath":"README.md"}' } });
      };
      try {
        const pending = chat([{ text: 'read this' }], session, 0, {
          toolDefinitions: [], registerAbortController: false,
          appendMessage: async message => {
            calls.push({ role: message.role, names: message.parts.filter(part => part.functionCall).map(part => part.functionCall!.name) });
            session.history.push(message);
          },
          onIntermediateAssistantText: text => { delivered.push(text); },
        });
        await new Promise(resolve => setImmediate(resolve));
        if (callFirst) tool();
        commentary();
        if (!callFirst) {
          for (let tries = 0; tries < 60 && delivered.length === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
          assert.deepEqual(delivered, ['Reading']);
          assert.deepEqual(calls.filter(call => call.role === 'model').map(call => call.names), [[]]);
          tool();
        }
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(calls.filter(call => call.role === 'model').length, callFirst ? 0 : 1);
        if (callFirst) assert.deepEqual(delivered, []);
        frame({ type: 'response.completed', response: { output: [], usage: { input_tokens: 3, output_tokens: 5 } } });
        stream.end();
        const result = await pending;
        assert.deepEqual(result.toolCalls?.map(call => call.id), ['call_fixture']);
        const messages = session.history.filter(message => message.role === 'model');
        assert.equal(messages.length, callFirst ? 1 : 2);
        assert.equal(messages.flatMap(message => message.parts).filter(part => part.functionCall).length, 1);
        assert.equal(messages.flatMap(message => message.parts).filter(part => part.text === 'Reading').length, 1);
        assert.deepEqual(messages.flatMap(message => message.parts).map(part => part.functionCall ? 'call' : part.text ? 'commentary' : 'other'),
          callFirst ? ['call', 'commentary'] : ['commentary', 'call']);
      } finally { stream.destroy(); }
    }
  } finally { (axios as any).post = originalPost; }
});

test('Stop after a committed Responses prefix leaves the durable text without manufacturing completion or retry', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('responses_stop_after_prefix'));
  session.model = 'responses-fixture/model';
  session.persistentMemorySnapshot = '<foxwarm-current-model model-id="responses-fixture/model" />\n\nsystem prompt';
  const stop = new AbortController();
  const stream = new PassThrough();
  let calls = 0;
  let deliveries = 0;
  (axios as any).post = async () => { calls++; return { status: 200, statusText: 'OK', headers: {}, data: stream }; };
  const frame = (event: any) => stream.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const pending = chat([{ text: 'start and stop' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, abortSignal: stop.signal,
      appendMessage: async message => { session.history.push(message); },
      onIntermediateAssistantText: () => { deliveries++; },
    });
    await new Promise(resolve => setImmediate(resolve));
    frame({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [] } });
    frame({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Saving progress' });
    frame({ type: 'response.output_item.done', output_index: 0,
      item: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Saving progress' }] } });
    for (let tries = 0; tries < 60 && deliveries === 0; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(deliveries, 1);
    stop.abort();
    await assert.rejects(pending, (error: any) => error?.name === 'AbortError');
    assert.equal(calls, 1);
    assert.equal(session.history.filter(message => message.role === 'model').length, 1);
    assert.deepEqual(session.history.at(-1)?.__meta?.llmSegment,
      { outputStart: 0, outputEndExclusive: 1, complete: false });
    assert.equal(getModelStreamDraft(session.id), null);
  } finally { (axios as any).post = originalPost; stream.destroy(); }
});

test('LocalSessionTurnHost runs detached normal chat through explicit current-session effects', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('detached_turn_effects'));
  const appended: Message[] = [];
  const events: any[] = [];
  const registered: AbortController[] = [];
  const cleared: AbortController[] = [];
  let persistCount = 0;
  const originalHotEffects = {
    appendSessionMessage: sessionManager.appendSessionMessage,
    getAllSessions: sessionManager.getAllSessions,
    saveSession: sessionManager.saveSession,
    notifySessionEvent: sessionManager.notifySessionEvent,
    registerSessionAbortController: sessionManager.registerSessionAbortController,
    clearSessionAbortController: sessionManager.clearSessionAbortController,
  };
  const unexpectedGlobalEffect = () => { throw new Error('detached chat touched global current-session hot state'); };
  class StatefulEffects implements CurrentSessionEffects {
    placement = 'local' as const;
    async appendMessage(target: Session, message: Message) {
      assert.equal(this, effects);
      assert.equal(target, session);
      appended.push(message);
      target.history.push(message);
    }
    async persistSession(target: Session) {
      assert.equal(this, effects);
      assert.equal(target, session);
      persistCount += 1;
    }
    notifySessionEvent(sessionId: string, event: any) {
      assert.equal(this, effects);
      assert.equal(sessionId, session.id);
      events.push(event);
    }
    registerAbortController(sessionId: string, controller: AbortController) {
      assert.equal(this, effects);
      assert.equal(sessionId, session.id);
      registered.push(controller);
    }
    clearAbortController(sessionId: string, controller: AbortController) {
      assert.equal(this, effects);
      assert.equal(sessionId, session.id);
      cleared.push(controller);
    }
    async clearWaitById() { return false; }
  }
  const effects = new StatefulEffects();

  (axios as any).post = async () => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: makeChatCompletionStream('detached answer'),
  });
  (sessionManager as any).appendSessionMessage = unexpectedGlobalEffect;
  (sessionManager as any).getAllSessions = unexpectedGlobalEffect;
  (sessionManager as any).saveSession = unexpectedGlobalEffect;
  (sessionManager as any).notifySessionEvent = unexpectedGlobalEffect;
  (sessionManager as any).registerSessionAbortController = unexpectedGlobalEffect;
  (sessionManager as any).clearSessionAbortController = unexpectedGlobalEffect;

  try {
    assert.equal(await sessionManager.getExistingSession(session.id), null);
    const result = await new LocalSessionTurnHost(effects).chat([{ text: 'detached hello' }], session, 0, {
      toolDefinitions: [],
    });
    assert.equal(result.text, 'detached answer');
    assert.deepEqual(appended.map(message => message.role), ['user', 'model']);
    assert.equal(persistCount, 1);
    assert.equal(events.some(event => event.type === 'model-stream-reset'), true);
    assert.equal(events.some(event => event.type === 'model-stream-update'), true);
    assert.equal(registered.length, 1);
    assert.deepEqual(cleared, registered);
    assert.equal(await sessionManager.getExistingSession(session.id), null);
  } finally {
    (axios as any).post = originalPost;
    Object.assign(sessionManager, originalHotEffects);
  }
});

test('LocalSessionTurnHost uses one caller effects owner while explicit append remains highest priority', async () => {
  const session = createOpenAITestSession(makeId('turn_effects_precedence'));
  const originalChat = (llmModule as any).chat;
  const hostAppends: Message[] = [];
  const callerAppends: Message[] = [];
  const explicitAppends: Message[] = [];
  const makeEffects = (target: Message[]): CurrentSessionEffects => ({
    placement: 'local',
    appendMessage: async (_session, message) => { target.push(message); },
    persistSession: async () => {},
    notifySessionEvent: () => {},
    registerAbortController: () => {},
    clearAbortController: () => {},
    clearWaitById: async () => false,
  });
  const hostEffects = makeEffects(hostAppends);
  const callerEffects = makeEffects(callerAppends);
  (llmModule as any).chat = async (_parts: any, _session: Session, _iteration: number, options: any) => {
    assert.equal(options.currentSessionEffects, callerEffects);
    await options.appendMessage({ role: 'user', parts: [{ text: 'probe' }] });
    return { text: 'ok' };
  };

  try {
    const host = new LocalSessionTurnHost(hostEffects);
    await host.chat(null, session, 0, { currentSessionEffects: callerEffects });
    assert.equal(hostAppends.length, 0);
    assert.equal(callerAppends.length, 1);

    await host.chat(null, session, 0, {
      currentSessionEffects: callerEffects,
      appendMessage: async message => { explicitAppends.push(message); },
    });
    assert.equal(callerAppends.length, 1);
    assert.equal(explicitAppends.length, 1);
  } finally {
    (llmModule as any).chat = originalChat;
  }
});

test('LocalSessionTurnHost clears explicit wait through injected effects when a sibling tool fails', async () => {
  const sessionId = makeId('turn_effects_wait_clear');
  const session = await sessionManager.getSession(sessionId);
  const originalWait = (tools as any).wait;
  const cleared: Array<{ sessionId: string | undefined; waitId: string }> = [];
  const effects = {
    ...createDefaultCurrentSessionEffects(),
    cleared,
    async clearWaitById(targetId: string | undefined, waitId: string) {
      this.cleared.push({ sessionId: targetId, waitId });
      return true;
    },
  };
  (tools as any).wait = async () => ({
    output: 'ok',
    __toolLoopControl: { stopCurrentTurn: true },
    __toolPostAction: { explicitWaitId: 'detached-wait-token' },
  });

  try {
    const message = await new LocalSessionTurnHost(effects).executeTools([
      { id: 'explicit-wait', name: 'wait', args: {} },
      { id: 'sibling-error', name: 'read', args: { filePath: `/missing-effects-${Date.now()}` } },
    ], { sessionId, session }, session);
    assert.deepEqual(cleared, [{ sessionId, waitId: 'detached-wait-token' }]);
    assert.equal((message as any).__toolLoopControl, undefined);
  } finally {
    (tools as any).wait = originalWait;
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('LocalSessionTurnHost executes detached read and compact setting without global source-session lookup', async () => {
  const session = createOpenAITestSession(makeId('detached_tool_owner'));
  session.agent = 'main';
  const dirPath = await fs.mkdtemp('/tmp/foxwarm-detached-tools-');
  const filePath = `${dirPath}/probe.txt`;
  await fs.writeFile(filePath, 'detached read ok');
  assert.equal(sessionManager.getAllSessions().has(session.id), false);

  const originals = {
    getSession: sessionManager.getSession,
    getExistingSession: sessionManager.getExistingSession,
    saveSession: sessionManager.saveSession,
    getCurrentNode: nodesManager.getCurrentNode,
  };
  const unexpectedLookup = () => { throw new Error('detached tool execution touched the global source-session map'); };
  (sessionManager as any).getSession = unexpectedLookup;
  (sessionManager as any).getExistingSession = unexpectedLookup;
  (sessionManager as any).saveSession = unexpectedLookup;
  (nodesManager as any).getCurrentNode = unexpectedLookup;
  let persisted = 0;
  const effects = createDefaultCurrentSessionEffects();
  effects.persistSession = async target => {
    assert.equal(target, session);
    persisted += 1;
  };

  try {
    const message = await new LocalSessionTurnHost(effects).executeTools([
      { id: 'detached-setting', name: 'set_session_compact_threshold', args: { thresholdTokens: 12345 } },
      { id: 'detached-read', name: 'read', args: { filePath } },
    ], { sessionId: session.id, session }, session);
    assert.equal(session.compactThresholdTokens, 12345);
    assert.equal(persisted, 1);
    assert.match(String((message.parts[0].functionResponse?.response as any)?.output), /12345/);
    assert.match(String((message.parts[1].functionResponse?.response as any)?.output), /detached read ok/);
    assert.equal(sessionManager.getAllSessions().has(session.id), false);
  } finally {
    Object.assign(sessionManager, {
      getSession: originals.getSession,
      getExistingSession: originals.getExistingSession,
      saveSession: originals.saveSession,
    });
    (nodesManager as any).getCurrentNode = originals.getCurrentNode;
    await fs.remove(dirPath);
  }
});

test('executeTools without effects resolves and uses the exact global source Session', async () => {
  const sessionId = makeId('legacy_tool_context');
  const session = await sessionManager.getSession(sessionId);
  const ownerDir = await fs.mkdtemp('/tmp/foxwarm-legacy-owner-');
  const cloneDir = await fs.mkdtemp('/tmp/foxwarm-legacy-clone-');
  session.cwd = ownerDir;
  session.currentNode = 'master';
  await sessionManager.saveSession(sessionId);
  await fs.writeFile(`${ownerDir}/probe.txt`, 'authoritative owner read');
  await fs.writeFile(`${cloneDir}/probe.txt`, 'untrusted clone read');
  const clone = { ...session, cwd: cloneDir };
  const originalGetCurrentNode = nodesManager.getCurrentNode;
  const originalImageWrite = (tools as any).image_write_to_file;
  (nodesManager as any).getCurrentNode = () => { throw new Error('legacy owner routing re-read current node'); };
  (tools as any).image_write_to_file = async (_args: any, ctx: any) => {
    assert.equal(ctx.session, session);
    assert.equal(ctx.session.cwd, ownerDir);
    assert.equal(ctx.runtimeNodeId, 'remote-explicit');
    return 'explicit owner route';
  };

  try {
    const message = await llmModule.executeTools([
      { id: 'legacy-read', name: 'read', args: { filePath: 'probe.txt' } },
      { id: 'legacy-explicit', name: 'image_write_to_file', args: { id: 'image-id', filePath: '/tmp/image.png', node: 'remote-explicit' } },
    ], { sessionId, session: clone }, clone as any);
    assert.match(String((message.parts[0].functionResponse?.response as any)?.output), /authoritative owner read/);
    assert.doesNotMatch(String((message.parts[0].functionResponse?.response as any)?.output), /untrusted clone read/);
    assert.deepEqual(message.parts[1].functionResponse?.response, { output: 'explicit owner route' });
  } finally {
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (tools as any).image_write_to_file = originalImageWrite;
    await fs.remove(ownerDir);
    await fs.remove(cloneDir);
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('executeTools without effects cannot bypass authoritative isolation with a same-ID clone', async () => {
  const sessionId = makeId('legacy_isolated_owner');
  const agentName = makeId('legacy_isolated_agent');
  const session = await sessionManager.getSession(sessionId);
  session.agent = agentName;
  session.currentNode = 'master';
  await sessionManager.saveSession(sessionId);
  await sessionManager.setAgentMetadata(agentName, { isolated: true, isolatedNode: 'bound-node' });
  const clone = { ...session, agent: 'main', currentNode: 'master' };

  try {
    const message = await llmModule.executeTools([
      { id: 'isolated-clone-read', name: 'read', args: { filePath: '/tmp/outside-owner.txt' } },
    ], { sessionId, session: clone }, clone as any);
    assert.match(String((message.parts[0].functionResponse?.response as any)?.error), /[Ii]solated/);
  } finally {
    await sessionManager.setAgentMetadata(agentName, { isolated: false }).catch(() => {});
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('executeTools rejects effects/source owner mismatch before lookup or effects', async () => {
  const owner = createOpenAITestSession(makeId('effects_owner_a'));
  owner.cwd = '/owner-a-cwd';
  const sourceId = makeId('effects_source_b');
  const originalGetExistingSession = sessionManager.getExistingSession;
  const originalGetCurrentNode = nodesManager.getCurrentNode;
  (sessionManager as any).getExistingSession = () => { throw new Error('mismatch performed source lookup'); };
  (nodesManager as any).getCurrentNode = () => { throw new Error('mismatch performed node lookup'); };
  let effectCalls = 0;
  const effects = createDefaultCurrentSessionEffects();
  effects.persistSession = async () => { effectCalls += 1; };
  effects.clearWaitById = async () => { effectCalls += 1; return false; };

  try {
    await assert.rejects(
      () => new LocalSessionTurnHost(effects).executeTools([
        { id: 'mismatch-read', name: 'read', args: { filePath: 'probe.txt' } },
      ], { sessionId: sourceId, session: owner }, owner),
      new RegExp(`source session .*${sourceId}.* does not match authoritative Session .*${owner.id}`),
    );
    assert.equal(effectCalls, 0);
  } finally {
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
  }
});

test('executeTools without effects rejects a missing source without creating it', async () => {
  const missingId = makeId('missing_tool_owner');
  const clone = createOpenAITestSession(missingId);
  assert.equal(sessionManager.getAllSessions().has(missingId), false);
  await assert.rejects(
    () => llmModule.executeTools([
      { id: 'missing-read', name: 'read', args: { filePath: '/tmp/missing-owner.txt' } },
    ], { sessionId: missingId, session: clone }, clone),
    new RegExp(`source session .*${missingId}.* was not found`),
  );
  assert.equal(sessionManager.getAllSessions().has(missingId), false);
});

test('OpenAI Chat Completions canonical parsing accepts compatible reasoning fields with established precedence', async t => {
  const originalPost = axios.post;
  const model = {
    providerKey: 'fixture',
    providerType: 'openai-completions',
    baseUrl: 'https://fixture.example',
    apiKey: '',
    model: 'reasoning-model',
    extraFields: {},
    extraHeaders: {},
  } as any;

  const parse = async (reasoningFields: Record<string, string>) => {
    (axios as any).post = async () => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: makeChatReasoningToolCallStream(reasoningFields),
    });
    return requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'inspect the repository' }] }],
      systemPrompt: '',
      modelEntryOverride: model,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });
  };

  try {
    await t.test('uses the aggregate message.reasoning fallback with a streamed tool call', async () => {
      const result = await parse({ reasoning: 'Reasoning fallback' });
      assert.deepEqual(result.allParts?.filter(part => part.thinking || part.functionCall), [
        { thinking: 'Reasoning fallback' },
        {
          functionCall: {
            id: 'call_reasoning_round_trip',
            name: 'read',
            args: { filePath: 'README.md' },
            rawArgsText: '{"filePath":"README.md"}',
          },
        },
      ]);
    });

    await t.test('preserves the established message.reasoning_content field', async () => {
      const result = await parse({ reasoning_content: 'Established reasoning content' });
      assert.equal(result.allParts?.find(part => part.thinking)?.thinking, 'Established reasoning content');
    });

    await t.test('prefers reasoning_content when both aggregate fields are non-empty', async () => {
      const result = await parse({
        reasoning_content: 'Established reasoning content',
        reasoning: 'Compatible reasoning fallback',
      });
      assert.deepEqual(result.allParts?.filter(part => part.thinking), [
        { thinking: 'Established reasoning content' },
      ]);
    });
  } finally {
    (axios as any).post = originalPost;
  }
});

test('chat round-trips streamed reasoning through canonical thinking and the existing reasoning_content request field', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession('chat_reasoning_round_trip_session');
  const requestBodies: any[] = [];
  let requestIndex = 0;

  (axios as any).post = async (_url: string, data: any) => {
    requestBodies.push(data);
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: requestIndex++ === 0
        ? makeChatReasoningToolCallStream({ reasoning: 'Inspect the repository before editing.' })
        : makeChatCompletionStream('continued'),
    };
  };

  try {
    const firstResult = await chat([{ text: 'call a tool' }], session, 0, {
      appendMessage: async (message: Message) => {
        session.history.push(message);
      },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });
    assert.equal(firstResult.toolCalls?.[0]?.id, 'call_reasoning_round_trip');
    assert.equal(
      session.history.find(message => message.role === 'model')?.parts.find(part => part.thinking)?.thinking,
      'Inspect the repository before editing.',
    );

    session.history.push({
      role: 'tool',
      parts: [{
        functionResponse: {
          tool_use_id: 'call_reasoning_round_trip',
          name: 'read',
          response: { output: 'repository contents' },
        },
      }],
    });
    await chat(null, session, 1, {
      appendMessage: async (message: Message) => {
        session.history.push(message);
      },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const priorAssistant = requestBodies[1].messages.find((message: any) =>
      message.role === 'assistant'
      && message.tool_calls?.[0]?.id === 'call_reasoning_round_trip',
    );
    assert.equal(priorAssistant.reasoning_content, 'Inspect the repository before editing.');
    assert.equal('reasoning' in priorAssistant, false);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('chat persists streamed provider-specific fields and only the same concrete model receives them later', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession('provider_specific_fields_round_trip_session');
  const requestBodies: any[] = [];
  let requestIndex = 0;

  const makeToolCallStream = (): PassThrough => {
    const stream = new PassThrough();
    process.nextTick(() => {
      stream.write(`data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            provider_specific_fields: { reasoning_signature: 'sig-round-trip' },
            tool_calls: [{
              index: 0,
              id: 'call_round_trip',
              type: 'function',
              function: { name: 'read', arguments: '{"filePath":"README.md"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })}\n\n`);
      stream.write(`data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      })}\n\n`);
      stream.write('data: [DONE]\n\n');
      stream.end();
    });
    return stream;
  };

  (axios as any).post = async (_url: string, data: any) => {
    requestBodies.push(data);
    const current = requestIndex++;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: current === 0 ? makeToolCallStream() : makeChatCompletionStream('ok'),
    };
  };

  try {
    const firstResult = await chat([{ text: 'call a tool' }], session, 0, {
      appendMessage: async (message: Message) => {
        session.history.push(message);
      },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.equal(firstResult.toolCalls?.[0]?.id, 'call_round_trip', 'tool-call-only responses remain usable');
    const persistedAssistant = session.history.find(message => message.role === 'model');
    assert.deepEqual(persistedAssistant?.providerMeta, {
      providerSpecificFields: { reasoning_signature: 'sig-round-trip' },
      sourceModelId: 'openai/gpt-5.2-codex',
    });

    const sameModel = {
      providerKey: 'openai',
      providerType: 'openai-completions',
      baseUrl: 'https://same.example',
      apiKey: '',
      model: 'gpt-5.2-codex',
      extraFields: {},
      extraHeaders: {},
    } as any;
    await requestLlmOnce({
      contents: session.history,
      systemPrompt: '',
      modelEntryOverride: sameModel,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const otherModel = {
      ...sameModel,
      providerKey: 'other',
      baseUrl: 'https://other.example',
    };
    await requestLlmOnce({
      contents: session.history,
      systemPrompt: '',
      modelEntryOverride: otherModel,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const sameAssistant = requestBodies[1].messages.find((message: any) => message.role === 'assistant');
    assert.deepEqual(sameAssistant.provider_specific_fields, { reasoning_signature: 'sig-round-trip' });
    const otherAssistant = requestBodies[2].messages.find((message: any) => message.role === 'assistant');
    assert.equal('provider_specific_fields' in otherAssistant, false);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('Anthropic request serialization normalizes consecutive internal user messages without changing history boundaries', async () => {
  const originalPost = axios.post;
  let capturedBody: any = null;

  (axios as any).post = async (_url: string, data: any) => {
    capturedBody = data;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { content: [{ type: 'text', text: 'ok' }] },
    };
  };

  try {
    const contents: Message[] = [
      { role: 'user', parts: [{ text: 'queued channel user' }] },
      { role: 'user', parts: [{ system: 'queued intersession notice' }] },
    ];
    await requestLlmOnce({
      contents,
      systemPrompt: '',
      model: 'anthropic/claude-sonnet-4-5',
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.equal(contents.length, 2);
    assert.equal(capturedBody.messages.length, 1);
    assert.equal(capturedBody.messages[0].role, 'user');
    const serializedText = capturedBody.messages[0].content.map((part: any) => part.text).join('\n');
    assert.match(serializedText, /queued channel user/);
    assert.match(serializedText, /queued intersession notice/);
    assert.equal((serializedText.match(/queued channel user/g) || []).length, 1);
    assert.equal((serializedText.match(/queued intersession notice/g) || []).length, 1);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('Anthropic tool serialization keeps the persisted timing marker first in its tool result', async () => {
  const originalPost = axios.post;
  let capturedBody: any = null;
  (axios as any).post = async (_url: string, data: any) => {
    capturedBody = data;
    return { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'ok' }] } };
  };

  try {
    await requestLlmOnce({
      contents: [{
        role: 'model',
        parts: [{ functionCall: { id: 'call_1', name: 'image_tool', args: {} } }],
      }, {
        role: 'tool',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' }, toolUseId: 'call_1' },
          {
            functionResponse: {
              tool_use_id: 'call_1',
              name: 'image_tool',
              previousLlmRequest: { time: '2026-07-27 05:00:00 +0800', durationMs: 8200 },
              response: { output: '' },
            },
          },
        ],
      }],
      systemPrompt: '',
      modelEntryOverride: {
        providerKey: 'fixture', providerType: 'anthropic', baseUrl: 'https://fixture.example', apiKey: '', model: 'fixture', extraFields: {}, extraHeaders: {},
      } as any,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });
    const result = capturedBody.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((part: any) => part.type === 'tool_result');
    assert.ok(Array.isArray(result.content));
    assert.match(result.content[0].text, /prevLLMReqTime="8.2s"/);
    assert.equal(result.content.filter((part: any) => String(part.text || '').includes('prevLLMReqTime')).length, 1);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('OpenAI chat completions requests omit empty system messages and preserve non-empty prompts', async () => {
  const originalPost = axios.post;
  const capturedUrls: string[] = [];
  const capturedBodies: any[] = [];

  (axios as any).post = async (url: string, data: any) => {
    capturedUrls.push(url);
    capturedBodies.push(data);
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: makeChatCompletionStream(),
    };
  };

  const modelEntryOverride = {
    providerKey: 'compatible',
    providerType: 'openai-completions',
    baseUrl: 'https://compatible.example/v1',
    apiKey: 'test-key',
    model: 'compatible-model',
    extraFields: {},
    extraHeaders: {},
  } as any;

  try {
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'empty system prompt' }] }],
      systemPrompt: '',
      modelEntryOverride,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'whitespace-only system prompt' }] }],
      systemPrompt: '   ',
      modelEntryOverride,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'non-empty system prompt' }] }],
      systemPrompt: 'You are a helpful assistant.',
      modelEntryOverride,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.deepEqual(capturedUrls, [
      'https://compatible.example/v1/chat/completions',
      'https://compatible.example/v1/chat/completions',
      'https://compatible.example/v1/chat/completions',
    ]);
    assert.deepEqual(capturedBodies[0].messages, [
      { role: 'user', content: 'empty system prompt' },
    ]);
    assert.deepEqual(capturedBodies[1].messages, [
      { role: 'user', content: 'whitespace-only system prompt' },
    ]);
    assert.deepEqual(capturedBodies[2].messages, [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'non-empty system prompt' },
    ]);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('requestLlmOnce logs raw stream body with parsed streaming response', async () => {
  const originalPost = axios.post;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const beforeFiles = new Set<string>();
  let ownFiles: string[] = [];
  const recentDir = path.join(LOGS_DIR, 'recent');
  await fs.mkdir(recentDir, { recursive: true });
  for (const file of await fs.readdir(recentDir).catch((): string[] => [])) beforeFiles.add(file);

  (axios as any).post = async () => ({
    status: 200,
    statusText: 'OK',
    headers: { 'x-test': 'raw-stream' },
    data: makeChatCompletionStream('raw-ok'),
  });

  try {
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemPrompt: '',
      model: 'openai/gpt-5.2-codex',
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const files = await fs.readdir(recentDir);
    const createdFiles = files.filter(file => !beforeFiles.has(file));
    let responseFile: string | undefined;
    for (const file of createdFiles.filter(file => file.endsWith('_res.json'))) {
      const candidate = JSON.parse(await fs.readFile(path.join(recentDir, file), 'utf8'));
      if (candidate.body?.choices?.[0]?.message?.content === 'raw-ok') {
        responseFile = file;
        break;
      }
    }
    assert.ok(responseFile, 'expected response log file');
    ownFiles = [responseFile!, responseFile!.replace(/_res\.json$/, '_req.json')];
    const logged = JSON.parse(await fs.readFile(path.join(recentDir, responseFile!), 'utf8'));
    assert.equal(logged.body.choices[0].message.content, 'raw-ok');
    assert.match(logged.rawStream.body, /data: .*raw-ok/);
    assert.ok(logged.rawStream.sseBlocks.some((block: string) => block.includes('raw-ok')));
  } finally {
    (axios as any).post = originalPost;
    await Promise.all(ownFiles.map(file => fs.rm(path.join(recentDir, file), { force: true }).catch(() => {})));
  }
});

test('requestLlmOnce keeps failed raw stream attempts in moved error logs', async () => {
  const originalPost = axios.post;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const recentDir = path.join(LOGS_DIR, 'recent');
  const errorDir = path.join(LOGS_DIR, `${formatDate()}-error`);
  const beforeError = new Set<string>();
  let ownErrorFiles: string[] = [];
  const retryEvents: any[] = [];
  await fs.mkdir(recentDir, { recursive: true });
  await fs.mkdir(errorDir, { recursive: true });
  for (const file of await fs.readdir(errorDir).catch((): string[] => [])) beforeError.add(file);

  (axios as any).post = async () => {
    const stream = new PassThrough();
    process.nextTick(() => {
      stream.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'partial-before-fail' }, finish_reason: null }] })}\n\n`);
      stream.write(`data: ${JSON.stringify({ error: { message: 'stream exploded after partial' } })}\n\n`);
      stream.end();
    });
    return { status: 200, statusText: 'OK', headers: {}, data: stream };
  };

  try {
    await assert.rejects(
      () => requestLlmOnce({
        contents: [{ role: 'user', parts: [{ text: 'hello fail' }] }],
        systemPrompt: '',
        model: 'openai/gpt-5.2-codex',
        toolDefinitions: [],
        notifySessionEvents: false,
        registerAbortController: false,
        maxRetries: 1,
        onRetry: event => { retryEvents.push(event); },
      }),
      (error: unknown) => error instanceof LlmRequestError && /API request failed after 1 attempts/.test(error.message),
    );

    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0].final, true);
    assert.equal(retryEvents[0].attempt, 1);
    assert.equal(retryEvents[0].kind, 'request-error');
    const newErrorFiles = (await fs.readdir(errorDir)).filter(file => !beforeError.has(file));
    let responseFile: string | undefined;
    for (const file of newErrorFiles.filter(file => file.endsWith('_res.json'))) {
      const candidate = JSON.parse(await fs.readFile(path.join(errorDir, file), 'utf8'));
      if (candidate.attempts?.some((attempt: any) => /stream exploded after partial/.test(attempt.error || ''))) {
        responseFile = file;
        break;
      }
    }
    assert.ok(responseFile, 'expected moved error response log');
    assert.equal(await fs.stat(path.join(recentDir, responseFile!)).then(() => true, () => false), false, 'this failed response log should move out of recent');
    ownErrorFiles = [
      responseFile!,
      responseFile!.replace(/_res\.json$/, '_req.json'),
    ];
    const logged = JSON.parse(await fs.readFile(path.join(errorDir, responseFile!), 'utf8'));
    assert.match(logged.attempts[0].error, /stream exploded after partial/);
    assert.match(logged.attempts[0].rawStream.body, /partial-before-fail/);
    assert.ok(logged.attempts[0].rawStream.sseBlocks.some((block: string) => block.includes('partial-before-fail')));
  } finally {
    (axios as any).post = originalPost;
    await Promise.all(ownErrorFiles.map(file => fs.rm(path.join(errorDir, file), { force: true }).catch(() => {})));
  }
});

test('requestLlmOnce uses 6 total attempts by default with increasing retry delays', async () => {
  const originalPost = axios.post;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const retryEvents: any[] = [];
  const sleepDelays: number[] = [];
  let callCount = 0;

  (global as any).setTimeout = (callback: (...args: any[]) => void, delay?: number) => {
    sleepDelays.push(Number(delay || 0));
    queueMicrotask(callback);
    return { __foxwarmImmediateTimer: true };
  };
  (global as any).clearTimeout = () => {};

  (axios as any).post = async () => {
    callCount++;
    if (callCount < DEFAULT_LLM_MAX_RETRIES) {
      throw new Error(`temporary failure ${callCount}`);
    }
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: makeChatCompletionStream('retry-ok'),
    };
  };

  try {
    const result = await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'hello retry' }] }],
      systemPrompt: '',
      model: 'openai/gpt-5.2-codex',
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
      onRetry: event => { retryEvents.push(event); },
    });

    assert.equal(result.text, 'retry-ok');
    assert.equal(callCount, DEFAULT_LLM_MAX_RETRIES);
    assert.deepEqual(retryEvents.map(event => event.nextAttempt), [2, 3, 4, 5, 6]);
    assert.deepEqual(retryEvents.map(event => event.delayMs), [
      getLlmRetryDelayMs(1),
      getLlmRetryDelayMs(2),
      getLlmRetryDelayMs(3),
      getLlmRetryDelayMs(4),
      getLlmRetryDelayMs(5),
    ]);
    assert.deepEqual(sleepDelays, retryEvents.map(event => event.delayMs));
  } finally {
    (axios as any).post = originalPost;
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
  }
});

test('chat propagates final request failure without appending fake Error model text', async () => {
  const originalPost = axios.post;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const retryEvents: any[] = [];
  const session = createOpenAITestSession('chat_final_failure_session');

  (global as any).setTimeout = (callback: (...args: any[]) => void, _delay?: number) => {
    queueMicrotask(callback);
    return { __foxwarmImmediateTimer: true };
  };
  (global as any).clearTimeout = () => {};
  (axios as any).post = async () => {
    throw new Error('persistent provider outage');
  };

  try {
    await assert.rejects(
      () => chat([{ text: 'please try' }], session, 0, {
        appendMessage: async (message: Message) => { session.history.push(message); },
        notifySessionEvents: false,
        registerAbortController: false,
        onRetry: event => { retryEvents.push(event); },
      }),
      (error: unknown) => error instanceof LlmRequestError && /persistent provider outage/.test(error.message),
    );

    assert.equal(retryEvents.length, DEFAULT_LLM_MAX_RETRIES);
    assert.equal(retryEvents[retryEvents.length - 1].final, true);
    assert.deepEqual(session.history.map(message => message.role), ['user']);
    assert.equal(session.history.some(message => message.role === 'model' && /^Error:/.test(message.parts[0]?.text || '')), false);
  } finally {
    (axios as any).post = originalPost;
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
  }
});

test('normal Chat Completions and Anthropic retry preparation rebuilds committed input without the Responses prefix hook', async t => {
  for (const model of ['openai/gpt-5.2-codex', 'anthropic/claude-sonnet-4-5']) {
    await t.test(model, async () => {
      const originalPost = axios.post;
      const session = createOpenAITestSession(makeId('retry_prepared_history'));
      session.model = model;
      session.persistentMemorySnapshot = `<foxwarm-current-model model-id="${model}" />\n\nsystem prompt`;
      const bodies: any[] = [];
      const resets: any[] = [];
      let prepared = 0;
      (axios as any).post = async (_url: string, body: any) => {
        bodies.push(body);
        if (bodies.length === 1) throw new Error('retry this transport failure');
        return { status: 200, statusText: 'OK', headers: {}, data: model.startsWith('anthropic/')
          ? { content: [{ type: 'text', text: 'prepared answer' }] } : makeChatCompletionStream('prepared answer') };
      };
      try {
        const result = await chat([{ text: 'initial input' }], session, 0, {
          toolDefinitions: [], registerAbortController: false, maxRetries: 2,
          currentSessionEffects: { ...createDefaultCurrentSessionEffects(), persistSession: async () => {}, notifySessionEvent: (_id, event) => { resets.push(event); } },
          appendMessage: async message => { session.history.push(message); },
          prepareRetry: async signal => {
            assert.equal(signal.aborted, false);
            assert.equal(bodies.length, 1);
            prepared++;
            session.history.push({ role: 'user', parts: [{ text: 'queued correction' }] });
            return true;
          },
        });
        assert.equal(prepared, 1);
        assert.equal(bodies.length, 2);
        assert.equal(result.llmAttempt, 1, 'changed context starts a new logical request, not a new physical budget');
        assert.equal(JSON.stringify(bodies[0]).includes('queued correction'), false);
        assert.equal(JSON.stringify(bodies[1]).split('queued correction').length - 1, 1);
        const identities = resets.filter(event => event.type === 'model-stream-reset').map(event => event.llmRequestId);
        assert.equal(identities.length, 2);
        assert.notEqual(identities[0], identities[1]);
        const journal = await reconstructLlmRequest(result.llmRequestId!);
        assert.equal(journal.completeness, 'complete');
        if (journal.completeness === 'complete') {
          assert.equal(JSON.stringify(journal.messages).split('queued correction').length - 1, 1);
          assert.equal(journal.attempts.length, 1);
        }
      } finally { (axios as any).post = originalPost; }
    });
  }
});

test('unchanged retry preparation preserves logical identity and the existing physical budget', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('retry_unchanged_history'));
  let requests = 0;
  let prepared = 0;
  (axios as any).post = async () => {
    if (++requests === 1) throw new Error('one transient failure');
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream('unchanged retry') };
  };
  try {
    const result = await chat([{ text: 'initial input' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, notifySessionEvents: false, maxRetries: 2,
      appendMessage: async message => { session.history.push(message); },
      prepareRetry: async () => { prepared++; return false; },
    });
    assert.equal(requests, 2);
    assert.equal(prepared, 1);
    assert.equal(result.llmAttempt, 2);
    const journal = await reconstructLlmRequest(result.llmRequestId!);
    assert.equal(journal.completeness, 'complete');
    if (journal.completeness === 'complete') {
      assert.deepEqual(journal.attempts.map(attempt => attempt.result?.outcome), ['failure', 'success']);
    }
  } finally { (axios as any).post = originalPost; }
});

test('retry preparation is awaited, propagates local failure, and rechecks cancellation without another provider send', async t => {
  for (const cancelled of [false, true]) {
    await t.test(cancelled ? 'cancel while awaiting owner' : 'strict preparation failure', async () => {
      const originalPost = axios.post;
      const session = createOpenAITestSession(makeId('retry_prepare_blocks_dispatch'));
      const abort = new AbortController();
      const localFailure = new Error('strict owner append failed');
      let requests = 0;
      let prepared = 0;
      (axios as any).post = async () => { requests++; throw new Error('initial provider outage'); };
      try {
        await assert.rejects(() => chat([{ text: 'input' }], session, 0, {
          toolDefinitions: [], registerAbortController: false, notifySessionEvents: false, maxRetries: 3,
          abortSignal: abort.signal,
          appendMessage: async message => { session.history.push(message); },
          onRetry: () => { throw new Error('best-effort notification failed'); },
          prepareRetry: async () => {
            prepared++;
            await new Promise(resolve => setImmediate(resolve));
            if (cancelled) { abort.abort(); return false; }
            throw localFailure;
          },
        }), error => cancelled ? llmModule.isAbortError(error) : error === localFailure);
        assert.equal(requests, 1);
        assert.equal(prepared, 1, 'local preparation must not be retried or swallowed like a notification');
      } finally { (axios as any).post = originalPost; }
    });
  }
});

test('cancellation after owner preparation prevents retry dispatch and retains ordinary abort journaling', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('retry_cancel_before_dispatch'));
  const abort = new AbortController();
  const resets: any[] = [];
  let requests = 0;
  (axios as any).post = async () => { requests++; throw new Error('initial provider outage'); };
  try {
    await assert.rejects(() => chat([{ text: 'input' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, maxRetries: 2, abortSignal: abort.signal,
      appendMessage: async message => { session.history.push(message); },
      prepareRetry: async () => false,
      currentSessionEffects: { ...createDefaultCurrentSessionEffects(), persistSession: async () => {},
        notifySessionEvent: (_id, event) => {
          if (event.type !== 'model-stream-reset') return;
          resets.push(event);
          if (resets.length === 2) abort.abort();
        },
      },
    }), llmModule.isAbortError);
    assert.equal(requests, 1);
    assert.equal(resets.length, 2);
    const journal = await reconstructLlmRequest(resets[0].llmRequestId);
    assert.equal(journal.completeness, 'complete');
    if (journal.completeness === 'complete') {
      assert.deepEqual(journal.attempts.map(attempt => attempt.result?.outcome), ['failure', 'abort']);
    }
  } finally { (axios as any).post = originalPost; }
});

test('exhausted and nonretryable failures and detached or compact calls never prepare ordinary retry input', async t => {
  for (const mode of ['exhausted', 'nonretryable', 'btw', 'compact-plan', 'detached']) {
    await t.test(mode, async () => {
      const originalPost = axios.post;
      const session = createOpenAITestSession(makeId('retry_prepare_scope'));
      let requests = 0;
      let prepared = 0;
      (axios as any).post = async () => {
        requests++;
        if (mode === 'nonretryable') {
          const stream = new PassThrough();
          stream.end('invalid request');
          return { status: 400, statusText: 'Bad Request', headers: {}, data: stream };
        }
        throw new Error('provider outage');
      };
      try {
        await assert.rejects(() => chat([{ text: 'input' }], session, 0, {
          toolDefinitions: [], registerAbortController: false, notifySessionEvents: false,
          maxRetries: mode === 'exhausted' ? 1 : 2,
          ...(mode === 'btw' || mode === 'compact-plan' ? { purpose: mode as 'btw' | 'compact-plan' } : {}),
          ...(mode === 'detached' ? { snapshotAuthority: 'detached' as const } : {}),
          appendMessage: async message => { session.history.push(message); },
          prepareRetry: async () => { prepared++; return true; },
        }), error => error instanceof LlmRequestError);
        assert.equal(prepared, 0);
        assert.equal(requests, mode === 'exhausted' || mode === 'nonretryable' ? 1 : 2);
      } finally { (axios as any).post = originalPost; }
    });
  }
});

test('changed retry input does not reset the exhausted provider attempt budget', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('retry_changed_budget'));
  let requests = 0;
  let prepared = 0;
  (axios as any).post = async () => { requests++; throw new Error('persistent outage'); };
  try {
    await assert.rejects(() => chat([{ text: 'input' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, notifySessionEvents: false, maxRetries: 2,
      appendMessage: async message => { session.history.push(message); },
      prepareRetry: async () => {
        prepared++;
        session.history.push({ role: 'user', parts: [{ text: 'new correction' }] });
        return true;
      },
    }), (error: unknown) => error instanceof LlmRequestError && error.attempt === 2);
    assert.equal(requests, 2);
    assert.equal(prepared, 1, 'terminal exhaustion cannot consume another batch');
  } finally { (axios as any).post = originalPost; }
});

test('chat journals only historical concrete model provenance and strips all __meta from provider payloads', async () => {
  const originalPost = axios.post;
  let capturedBody: any = null;
  const session = createOpenAITestSession('context_block_meta_strip_session');
  session.model = 'anthropic/claude-sonnet-4-5';
  session.history.push({
    role: 'model',
    parts: [{ text: '[CTX-BLOCK L1 B#3 raw#1-#2] summary' }],
    __meta: {
      timestamp: 123,
      seq: 7,
      modelId: 'anthropic/claude-sonnet-4-5',
      virtualModelKey: 'fallback',
      usage: { cachedTokens: 1, inputTokens: 2, outputTokens: 3, reasoningTokens: 1 },
      contextBlock: {
        id: 3,
        level: 1,
        rawStartSeq: 1,
        rawEndSeq: 2,
        sourceKind: 'message',
        sourceStart: 1,
        sourceEnd: 2,
      },
    },
  });

  (axios as any).post = async (_url: string, data: any) => {
    capturedBody = data;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      },
    };
  };

  try {
    const result = await chat(null, session, 0, {
      appendMessage: async (message: Message) => { session.history.push(message); },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.deepEqual(capturedBody.messages, [{
      role: 'assistant',
      content: '[CTX-BLOCK L1 B#3 raw#1-#2] summary',
    }]);
    assert.equal(JSON.stringify(capturedBody).includes('contextBlock'), false);
    assert.equal(JSON.stringify(capturedBody).includes('__meta'), false);
    const reconstructed = await reconstructLlmRequest(result.llmRequestId!);
    assert.equal(reconstructed.completeness, 'complete');
    if (reconstructed.completeness === 'complete') {
      assert.deepEqual(reconstructed.messages[0].__meta, { modelId: 'anthropic/claude-sonnet-4-5' });
      assert.equal(JSON.stringify(reconstructed.messages[0]).includes('contextBlock'), false);
      assert.equal(JSON.stringify(reconstructed.messages[0]).includes('reasoningTokens'), false);
      assert.equal(JSON.stringify(reconstructed.messages[0]).includes('virtualModelKey'), false);
    }
  } finally {
    (axios as any).post = originalPost;
  }
});

test('requestLlmOnce excludes presentation paths and ToolScript activity from provider requests and journals', async () => {
  const originalPost = axios.post;
  let capturedBody: any;
  const displayPath = '/display-only/agent-file.txt';
  const displayCall = 'display-only-nested-tool';
  const contents: Message[] = [
    { role: 'model', parts: [{ functionCall: { id: 'read-file', name: 'read', args: { filePath: 'file.txt' } } }] },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'read-file', name: 'read', response: { output: 'contents' },
      __meta: { resolvedPaths: [{ raw: 'file.txt', resolved: displayPath, nodeId: 'master' }] } } }] },
    { role: 'model', parts: [{ functionCall: { id: 'script', name: 'run_script', args: { code: 'def main(args):\n    return 0' } } }] },
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 'script', name: 'run_script',
      response: { status: 'completed', runId: 'tsr_fixture', result: 0 },
      __meta: { toolScriptSubCalls: [{ id: 'tss_1', name: displayCall, status: 'completed', startedAt: 1 }] } } }] },
    { role: 'user', parts: [{ text: 'next request' }] },
  ];
  const original = structuredClone(contents);
  try {
    for (const providerType of ['openai-completions', 'openai-responses', 'anthropic']) {
      (axios as any).post = async (_url: string, body: any) => {
        capturedBody = body;
        const data = providerType === 'openai-completions' ? makeChatCompletionStream('ok')
          : providerType === 'openai-responses' ? makeResponsesStream('ok')
          : { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } };
        return { status: 200, statusText: 'OK', headers: {}, data };
      };
      const result = await requestLlmOnce({ contents, systemPrompt: '',
        model: 'fixture/chat', modelEntryOverride: { providerKey: 'fixture', providerType,
          baseUrl: 'https://fixture.example', apiKey: '', model: 'chat', extraFields: {}, extraHeaders: {} } as any,
        toolDefinitions: [], maxRetries: 1, notifySessionEvents: false, registerAbortController: false,
      });
      const request = JSON.stringify(capturedBody);
      assert.equal(request.includes(displayPath), false, providerType);
      assert.equal(request.includes(displayCall), false, providerType);
      assert.equal(request.includes('toolScriptSubCalls'), false, providerType);
      assert.ok(request.includes('tsr_fixture'), providerType);
      const journal = await reconstructLlmRequest(result.llmRequestId!);
      assert.equal(journal.completeness, 'complete');
      assert.equal(JSON.stringify(journal).includes(displayPath), false, providerType);
      assert.equal(JSON.stringify(journal).includes(displayCall), false, providerType);
      assert.deepEqual(contents, original, 'request preparation must not rewrite persisted/UI history');
    }
  } finally { (axios as any).post = originalPost; }
});

test('requestLlmOnce scrubs reserved provider image helper keys before journal and wire serialization', async () => {
  const originalPost = axios.post;
  let capturedBody: any = null;
  const identityValue = 'forged-provider-image-identity-value';
  const deduplicatedValue = 'forged-provider-image-deduplicated-value';
  const contents: Message[] = [{
    role: 'user',
    parts: [{
      text: 'direct inline request',
      inlineData: { mimeType: 'image/png', data: Buffer.from('direct-inline-image').toString('base64') },
      __providerImageIdentity: identityValue,
      __providerImageDeduplicated: deduplicatedValue,
    }],
  }];
  const snapshot = structuredClone(contents);

  (axios as any).post = async (_url: string, body: any) => {
    capturedBody = body;
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream('journal scrub ok') };
  };

  try {
    const result = await requestLlmOnce({
      contents,
      systemPrompt: '',
      model: 'fixture/chat',
      modelEntryOverride: {
        providerKey: 'fixture', providerType: 'openai-completions', baseUrl: 'https://fixture.example', apiKey: '', model: 'chat', extraFields: {}, extraHeaders: {},
      } as any,
      toolDefinitions: [],
      maxRetries: 1,
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const wire = JSON.stringify(capturedBody);
    assert.equal(wire.includes('__providerImage'), false);
    assert.equal(wire.includes(identityValue), false);
    assert.equal(wire.includes(deduplicatedValue), false);
    const reconstructed = await reconstructLlmRequest(result.llmRequestId!);
    assert.equal(reconstructed.completeness, 'complete');
    const journal = JSON.stringify(reconstructed);
    assert.equal(journal.includes('__providerImage'), false);
    assert.equal(journal.includes(identityValue), false);
    assert.equal(journal.includes(deduplicatedValue), false);
    assert.deepEqual(contents, snapshot, 'request-local scrub must not mutate caller input');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('chat stores each model request usage and model id on its assistant message metadata', async () => {
  const originalPost = axios.post;
  const appendedMessages: Message[] = [];
  let callCount = 0;

  const session: Session = {
    id: 'usage_message_meta_session',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    model: 'anthropic/claude-sonnet-4-5',
  } as Session;

  (axios as any).post = async () => {
    callCount++;
    if (callCount === 1) {
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        data: {
          content: [
            { type: 'tool_use', id: 'call_1', name: 'read', input: { filePath: 'README.md' } },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 5,
            cache_read_input_tokens: 2,
          },
        },
      };
    }

    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {
        content: [
          { type: 'text', text: 'done' },
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 3,
          cache_read_input_tokens: 4,
        },
      },
    };
  };

  const appendMessage = async (message: Message) => {
    appendedMessages.push(message);
    session.history.push(message);
  };

  try {
    await chat([{ text: 'please read' }], session, 0, {
      appendMessage,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    session.history.push({
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'call_1', name: 'read', response: { output: 'ok' } } }],
    });

    await chat(null, session, 1, {
      appendMessage,
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    const assistantMessages = appendedMessages.filter(message => message.role === 'model');
    assert.equal(assistantMessages.length, 2);
    assert.equal(assistantMessages[0].__meta?.modelId, 'anthropic/claude-sonnet-4-5');
    assert.equal(assistantMessages[1].__meta?.modelId, 'anthropic/claude-sonnet-4-5');
    assert.equal(assistantMessages[0].__meta?.virtualModelKey, undefined);
    assert.equal(assistantMessages[1].__meta?.virtualModelKey, undefined);
    assert.equal(typeof assistantMessages[0].__meta?.llmRequestId, 'string');
    assert.equal(typeof assistantMessages[1].__meta?.llmRequestId, 'string');
    assert.notEqual(assistantMessages[0].__meta?.llmRequestId, assistantMessages[1].__meta?.llmRequestId);
    assert.equal(assistantMessages[0].__meta?.llmAttempt, 1);
    for (const assistantMessage of assistantMessages) {
      const timing = assistantMessage.__meta?.llmRequestTiming;
      assert.ok(timing, 'successful assistant messages persist request timing');
      assert.equal(Number.isFinite(timing.startedAt), true);
      assert.equal(Number.isFinite(timing.completedAt), true);
      assert.equal(Number.isFinite(timing.durationMs), true);
      assert.ok(timing.completedAt >= timing.startedAt);
      assert.ok(timing.durationMs >= 0);
      assert.ok(Math.abs((timing.completedAt - timing.startedAt) - timing.durationMs) < 0.001);
    }
    const reconstructed = await reconstructLlmRequest(assistantMessages[1].__meta?.llmRequestId as string);
    assert.equal(reconstructed.completeness, 'complete');
    if (reconstructed.completeness === 'complete') {
      assert.equal(reconstructed.messages.at(-1)?.role, 'tool');
      assert.equal(reconstructed.attempts[0]?.result?.outcome, 'success');
      assert.equal(typeof reconstructed.attempts[0]?.result?.result?.previousLlmRequest?.durationMs, 'number');
    }
    assert.deepEqual(assistantMessages[0].__meta?.usage, {
      inputTokens: 12,
      outputTokens: 5,
      cachedTokens: 2,
    });
    assert.deepEqual(assistantMessages[1].__meta?.usage, {
      inputTokens: 20,
      outputTokens: 3,
      cachedTokens: 4,
    });
    assert.equal(appendedMessages.find(message => message.role === 'user')?.__meta?.usage, undefined);
    assert.equal(appendedMessages.find(message => message.role === 'user')?.__meta?.modelId, undefined);
    assert.deepEqual(session.stats, {
      totalCachedTokens: 6,
      totalInputTokens: 32,
      totalOutputTokens: 8,
      lastUsage: null,
    });
  } finally {
    (axios as any).post = originalPost;
  }
});

test('ensurePromptCacheKey assigns a stable low-sensitivity key per session', () => {
  const sessionA = createOpenAITestSession('prompt_cache_key_session_a');
  const sessionB = createOpenAITestSession('prompt_cache_key_session_b');

  const first = ensurePromptCacheKey(sessionA);
  const second = ensurePromptCacheKey(sessionA);
  const independent = ensurePromptCacheKey(sessionB);

  assert.equal(first, second);
  assert.equal(sessionA.promptCacheKey, first);
  assert.match(first, PROMPT_CACHE_KEY_PATTERN);
  assert.doesNotMatch(first, /prompt_cache_key_session_a/);
  assert.notEqual(first, independent);
});

test('model templates expand TURN_ID alongside SESSION_CACHE_KEY', async () => {
  const originalPost = axios.post;
  let capturedData: any;
  let capturedConfig: any;
  const model = {
    providerKey: 'fixture',
    providerType: 'openai-completions',
    baseUrl: 'https://fixture.example',
    apiKey: '',
    model: 'chat',
    extraFields: {
      foxwarm_metadata: {
        session: '${SESSION_CACHE_KEY}',
        turn: '${TURN_ID}',
      },
    },
    extraHeaders: {
      'x-foxwarm-session': '${SESSION_CACHE_KEY}',
      'x-foxwarm-turn': '${TURN_ID}',
    },
  } as any;

  (axios as any).post = async (_url: string, data: any, config: any) => {
    capturedData = data;
    capturedConfig = config;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: makeChatCompletionStream(),
    };
  };

  try {
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'template expansion' }] }],
      systemPrompt: '',
      modelEntryOverride: model,
      promptCacheKey: 'session-cache-key',
      turnId: 'session-turn-id',
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.equal(capturedData.foxwarm_metadata.session, 'session-cache-key');
    assert.equal(capturedData.foxwarm_metadata.turn, 'session-turn-id');
    assert.equal(capturedConfig.headers['x-foxwarm-session'], 'session-cache-key');
    assert.equal(capturedConfig.headers['x-foxwarm-turn'], 'session-turn-id');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('chat uses the stored prompt cache key for OpenAI requests', async () => {
  const originalPost = axios.post;
  const capturedBodies: any[] = [];
  const session = createOpenAITestSession('stored_prompt_cache_session');
  session.promptCacheKey = '11111111-2222-3333-4444-555555555555';

  (axios as any).post = async (_url: string, data: any) => {
    capturedBodies.push(data);
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: makeChatCompletionStream(),
    };
  };

  try {
    await chat([{ text: 'hello one' }], session, 0, {
      appendMessage: async (message: Message) => { session.history.push(message); },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });
    await chat([{ text: 'hello two' }], session, 1, {
      appendMessage: async (message: Message) => { session.history.push(message); },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.equal(capturedBodies.length, 2);
    assert.equal(capturedBodies[0].prompt_cache_key, '11111111-2222-3333-4444-555555555555');
    assert.equal(capturedBodies[1].prompt_cache_key, '11111111-2222-3333-4444-555555555555');
    assert.equal(session.promptCacheKey, '11111111-2222-3333-4444-555555555555');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('chat lazily generates and reuses a prompt cache key for legacy sessions', async () => {
  const originalPost = axios.post;
  const capturedBodies: any[] = [];
  const session = createOpenAITestSession('legacy_prompt_cache_session');
  delete session.promptCacheKey;

  (axios as any).post = async (_url: string, data: any) => {
    capturedBodies.push(data);
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: makeChatCompletionStream(),
    };
  };

  try {
    await chat([{ text: 'hello legacy one' }], session, 0, {
      appendMessage: async (message: Message) => { session.history.push(message); },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });
    const generatedKey = session.promptCacheKey;

    await chat([{ text: 'hello legacy two' }], session, 1, {
      appendMessage: async (message: Message) => { session.history.push(message); },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.match(generatedKey || '', PROMPT_CACHE_KEY_PATTERN);
    assert.equal(capturedBodies[0].prompt_cache_key, generatedKey);
    assert.equal(capturedBodies[1].prompt_cache_key, generatedKey);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('chat persists a generated prompt cache key for stored legacy sessions', async () => {
  const originalPost = axios.post;
  const sessionId = makeId('legacy_prompt_cache_persisted');
  let capturedBody: any = null;

  (axios as any).post = async (_url: string, data: any) => {
    capturedBody = data;
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: makeChatCompletionStream(),
    };
  };

  try {
    await sessionManager.loadSessions();
    await sessionManager.createSession(sessionId, {
      id: sessionId,
      agent: 'main',
      history: [],
      persistentMemorySnapshot: 'system prompt',
      promptCacheKey: '',
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      busy: false,
      queue: [],
      meta: { lastMessageTime: Date.now() },
      model: 'openai/gpt-5.2-codex',
    } as Session);

    const session = await sessionManager.getSession(sessionId);
    delete session.promptCacheKey;

    await chat([{ text: 'persist legacy key' }], session, 0, {
      appendMessage: async (message: Message) => { session.history.push(message); },
      toolDefinitions: [],
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.equal(capturedBody.prompt_cache_key, session.promptCacheKey);
    assert.match(session.promptCacheKey || '', PROMPT_CACHE_KEY_PATTERN);
    const historySnapshot = await readSessionHistorySnapshot(sessionId);
    assert.equal(historySnapshot?.promptCacheKey, session.promptCacheKey);
    const metadataSnapshot = await loadSessionsMetadataSnapshot();
    assert.equal(metadataSnapshot.data.sessions?.[sessionId]?.promptCacheKey, undefined);
  } finally {
    (axios as any).post = originalPost;
    await sessionManager.deleteSession(sessionId).catch(() => {});
  }
});

test('compact-plan provider schemas export direct/file fields and returned calls retain raw text or structured input', async () => {
  const { COMPACT_PLAN_TOOL_DEFINITION } = await import('./session/compactPlan');
  const originalPost = axios.post;
  const raw = ' { "replaceAsBlocks": [\r\n';
  const structured = { replaceAsBlocks: [{ level: 1, sourceKind: 'message', sourceStart: 1, sourceEnd: 99, summary: 'structured invalid range' }] };
  const cases = [
    { provider: 'openai-completions', payload: () => ({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'compact-provider', type: 'function', function: { name: 'submit_compact_plan', arguments: raw } }] }, finish_reason: 'tool_calls' }] }) },
    { provider: 'openai-responses', payload: () => ({ type: 'response.completed', response: { id: 'compact-response', output: [{ type: 'function_call', call_id: 'compact-provider', name: 'submit_compact_plan', arguments: raw }], usage: { input_tokens: 1, output_tokens: 1 } } }) },
    { provider: 'anthropic', payload: () => ({ content: [{ type: 'tool_use', id: 'compact-provider', name: 'submit_compact_plan', input: structured }] }) },
  ];
  try {
    for (const fixture of cases) {
      let exportedSchema: any;
      (axios as any).post = async (_url: string, body: any) => {
        exportedSchema = fixture.provider === 'anthropic' ? body.tools[0].input_schema
          : fixture.provider === 'openai-completions' ? body.tools[0].function.parameters : body.tools[0].parameters;
        const payload = fixture.payload();
        let data: any = payload;
        if (fixture.provider !== 'anthropic') {
          const stream = new PassThrough();
          process.nextTick(() => { stream.end(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`); });
          data = stream;
        }
        return { status: 200, statusText: 'OK', headers: {}, data };
      };
      const result = await requestLlmOnce({
        contents: [{ role: 'user', parts: [{ text: 'compact candidates' }] }], systemPrompt: '',
        modelEntryOverride: { providerKey: 'fixture', providerType: fixture.provider, baseUrl: 'https://fixture.example/v1', model: 'model', extraFields: {}, extraHeaders: {} } as any,
        toolDefinitions: [COMPACT_PLAN_TOOL_DEFINITION], purpose: 'compact-plan',
        notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
      });
      assert.deepEqual(exportedSchema, COMPACT_PLAN_TOOL_DEFINITION.parameters);
      assert.equal(exportedSchema.required, undefined);
      assert.equal((exportedSchema as any).oneOf, undefined);
      assert.equal((exportedSchema as any).anyOf, undefined);
      assert.equal(exportedSchema.properties.argsFilePath.type, 'string');
      assert.deepEqual(exportedSchema.properties.replaceAsBlocks.oneOf.map((item: any) => item.type), ['array', 'string']);
      const call = result.toolCalls[0];
      assert.equal(call, result.allParts.find(part => part.functionCall)?.functionCall);
      if (fixture.provider === 'anthropic') {
        assert.deepEqual(call.args, structured);
        assert.equal(call.rawArgsText, undefined);
        assert.equal(call.argsParseError, undefined);
      } else {
        assert.equal(call.rawArgsText, raw);
        assert.match(call.argsParseError || '', /Invalid tool arguments JSON/);
        assert.deepEqual(call.args, {});
      }
    }
  } finally { (axios as any).post = originalPost; }
});


test('normal task request context reaches provider/retry but never canonical history, and disappears when no longer active', async () => {
  const originalPost = axios.post;
  const session = createOpenAITestSession(makeId('request_only_task_context'));
  const bodies: any[] = [];
  let active = true;
  let contexts = 0;
  (axios as any).post = async (_url: string, body: any) => {
    bodies.push(body);
    if (bodies.length === 1) { active = false; throw new Error('retry after task completion'); }
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatCompletionStream('Task-aware answer') };
  };
  try {
    await chat([{ text: 'Continue real input' }], session, 0, {
      toolDefinitions: [], registerAbortController: false, maxRetries: 2,
      currentSessionEffects: { ...createDefaultCurrentSessionEffects(), persistSession: async () => {} },
      appendMessage: async message => { session.history.push(message); },
      requestContext: async () => { contexts++; return active ? [{ role: 'user', parts: [{ system: '<foxwarm-system kind="task-reminder">task_fixture — Active task (active)</foxwarm-system>' }] }] : []; },
    });
    assert.equal(contexts, 2);
    assert.equal(bodies.length, 2);
    assert.match(JSON.stringify(bodies[0]), /task_fixture/);
    assert.doesNotMatch(JSON.stringify(bodies[1]), /task_fixture/);
    assert.doesNotMatch(JSON.stringify(session.history), /task_fixture|task-reminder/);
    assert.deepEqual(session.history.map(message => message.role), ['user', 'model']);
  } finally { (axios as any).post = originalPost; }
});
