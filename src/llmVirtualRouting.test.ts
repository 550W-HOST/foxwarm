import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';
import { loadModelsConfigFromObject } from './config';
import { LlmRequestError, classifyHttpFailure, requestLlmOnce } from './llm';
import { resetVirtualRoutingStateForTests } from './modelRouting';

function makeSseStream(events: Array<any | '[DONE]'>): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    for (const event of events) {
      stream.write(`data: ${event === '[DONE]' ? '[DONE]' : JSON.stringify(event)}\n\n`);
    }
    stream.end();
  });
  return stream;
}

function makeRawStream(value: any): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.end(typeof value === 'string' ? value : JSON.stringify(value));
  });
  return stream;
}

function makeChatStream(text: string, options: { reasoning?: string; toolCall?: boolean } = {}): PassThrough {
  const delta: any = { role: 'assistant', content: text };
  if (options.reasoning) delta.reasoning_content = options.reasoning;
  if (options.toolCall) {
    delete delta.content;
    delta.tool_calls = [{
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'read', arguments: '{"filePath":"x"}' },
    }];
  }
  return makeSseStream([
    { choices: [{ index: 0, delta, finish_reason: options.toolCall ? 'tool_calls' : 'stop' }] },
    '[DONE]',
  ]);
}

function makeResponsesStream(kind: 'empty' | 'reasoning' | 'text' | 'tool'): PassThrough {
  const events: any[] = [];
  if (kind === 'reasoning') {
    events.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } });
    events.push({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'thinking only' });
  } else if (kind === 'text') {
    events.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } });
    events.push({ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
    events.push({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'responses ok' });
  } else if (kind === 'tool') {
    events.push({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' } });
    events.push({ type: 'response.function_call_arguments.done', output_index: 0, arguments: '{"filePath":"x"}' });
  }
  events.push({
    type: 'response.completed',
    response: { id: 'resp_1', object: 'response', output: [], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  events.push('[DONE]');
  return makeSseStream(events);
}

const testModelsConfig = loadModelsConfigFromObject({
  default: 'fallback',
  providers: {
    openaiLeaf: {
      providerType: 'openai-completions',
      baseUrl: 'https://openai-leaf.test/v1',
      apiKey: 'openai-secret',
      models: ['chat-model'],
    },
    responsesLeaf: {
      providerType: 'openai',
      baseUrl: 'https://responses-leaf.test/v1',
      apiKey: 'responses-secret',
      models: ['responses-model'],
    },
    anthropicLeaf: {
      providerType: 'anthropic',
      baseUrl: 'https://anthropic-leaf.test',
      apiKey: 'anthropic-secret',
      requestCompression: 'gzip',
      models: ['claude-model'],
    },
    fallback: {
      providerType: 'failover',
      targets: ['openaiLeaf/chat-model', 'anthropicLeaf/claude-model'],
    },
    sticky: {
      providerType: 'session-hash',
      targets: ['openaiLeaf/chat-model', 'anthropicLeaf/claude-model'],
    },
    stickyAlias: {
      providerType: 'session-hash',
      targets: ['openaiLeaf/chat-model'],
    },
    fastFallback: {
      providerType: 'failover',
      targets: ['openaiLeaf/chat-model', 'anthropicLeaf/claude-model'],
      failureThreshold: 1,
      cooldownMs: 600000,
    },
  },
});

test.afterEach(() => resetVirtualRoutingStateForTests());

test('HTTP failure classification is explicit for every configured category', () => {
  for (const status of [401, 403, 404, 408, 429, 500, 503, 529]) {
    assert.deepEqual(classifyHttpFailure(status, { error: 'outage' }), { retryable: true, countable: true });
  }
  for (const status of [400, 413, 422]) {
    assert.deepEqual(classifyHttpFailure(status, { error: 'invalid request' }), { retryable: false, countable: false });
  }
  assert.deepEqual(classifyHttpFailure(400, { code: 'model_not_found' }), { retryable: true, countable: true });
  assert.deepEqual(classifyHttpFailure(418, { error: 'other status' }), { retryable: true, countable: false });
});

async function withImmediateRetryTimers<T>(run: () => Promise<T>): Promise<T> {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  (global as any).setTimeout = (callback: (...args: any[]) => void) => {
    queueMicrotask(callback);
    return { __immediate: true };
  };
  (global as any).clearTimeout = () => {};
  try {
    return await run();
  } finally {
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
  }
}

function baseRequest(model: string, maxRetries?: number) {
  return {
    contents: [{ role: 'user' as const, parts: [{ text: 'hello' }] }],
    systemPrompt: '',
    model,
    modelsConfigOverride: testModelsConfig,
    promptCacheKey: '11111111-2222-3333-4444-555555555555',
    toolDefinitions: [] as any[],
    notifySessionEvents: false,
    registerAbortController: false,
    ...(maxRetries === undefined ? {} : { maxRetries }),
  };
}

test('failover uses outer attempts A x5 then rebuilds a clean Anthropic request for B', async () => {
  const originalPost = axios.post;
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  (axios as any).post = async (url: string, body: any, config: any) => {
    calls.push({ url, body, headers: config.headers });
    if (calls.length <= 5) throw new Error('network outage');
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: { content: [{ type: 'text', text: 'anthropic fallback ok' }] },
    };
  };

  try {
    const result = await withImmediateRetryTimers(() => requestLlmOnce(baseRequest('fallback')));
    assert.equal(calls.length, 6);
    assert.ok(calls.slice(0, 5).every(call => call.url === 'https://openai-leaf.test/v1/chat/completions'));
    assert.equal(calls[5].url, 'https://anthropic-leaf.test/v1/messages');
    assert.equal(calls[5].headers['x-api-key'], 'anthropic-secret');
    assert.equal(calls[5].headers.Authorization, undefined);
    assert.ok(Buffer.isBuffer(calls[5].body));
    assert.equal(calls[5].headers['Content-Encoding'], 'gzip');
    const fallbackBody = JSON.parse(zlib.gunzipSync(calls[5].body).toString('utf8'));
    assert.equal(fallbackBody.model, 'claude-model');
    assert.equal(fallbackBody.stream, undefined);
    assert.equal(fallbackBody.prompt_cache_key, undefined);
    assert.equal(result.text, 'anthropic fallback ok');
    assert.equal(result.modelId, 'anthropicLeaf/claude-model');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('a keyless request generates one request-scoped routing key reused by every attempt', async () => {
  const originalPost = axios.post;
  const cacheKeys: string[] = [];
  (axios as any).post = async (_url: string, body: any) => {
    cacheKeys.push(body.prompt_cache_key);
    if (cacheKeys.length === 1) throw new Error('retry once');
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('ok') };
  };
  try {
    await withImmediateRetryTimers(() => requestLlmOnce({
      ...baseRequest('stickyAlias', 2),
      promptCacheKey: '',
    }));
    assert.match(cacheKeys[0], /^[0-9a-f-]{36}$/);
    assert.deepEqual(cacheKeys, [cacheKeys[0], cacheKeys[0]]);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('empty 2xx response counts toward failover health', async () => {
  const originalPost = axios.post;
  let calls = 0;
  (axios as any).post = async () => {
    calls += 1;
    if (calls === 1) return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('   ') };
    return { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'B after empty A' }] } };
  };
  try {
    const result = await withImmediateRetryTimers(() => requestLlmOnce(baseRequest('fastFallback')));
    assert.equal(calls, 2);
    assert.equal(result.modelId, 'anthropicLeaf/claude-model');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('session-hash resolves the prefix-lineage key once and stays on the same HRW leaf across retries', async () => {
  const originalPost = axios.post;
  const calls: Array<{ url: string; body: any }> = [];
  (axios as any).post = async (url: string, body: any) => {
    calls.push({ url, body });
    if (calls.length === 1) throw new Error('temporary network failure');
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('sticky ok') };
  };
  try {
    const result = await withImmediateRetryTimers(() => requestLlmOnce({
      ...baseRequest('sticky', 2),
      promptCacheKey: 'key-0',
    }));
    assert.equal(result.modelId, 'openaiLeaf/chat-model');
    assert.deepEqual(calls.map(call => call.url), [
      'https://openai-leaf.test/v1/chat/completions',
      'https://openai-leaf.test/v1/chat/completions',
    ]);
    assert.deepEqual(calls.map(call => call.body.prompt_cache_key), ['key-0', 'key-0']);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('last target failure terminates the current request, clears health, and next request starts at A', async () => {
  const originalPost = axios.post;
  const urls: string[] = [];
  (axios as any).post = async (url: string) => {
    urls.push(url);
    if (urls.length <= 2) throw new Error('outage');
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('A recovered') };
  };

  try {
    await withImmediateRetryTimers(async () => {
      await assert.rejects(
        () => requestLlmOnce(baseRequest('fastFallback')),
        (error: unknown) => error instanceof LlmRequestError && error.attempt === 2,
      );
      const result = await requestLlmOnce(baseRequest('fastFallback'));
      assert.equal(result.modelId, 'openaiLeaf/chat-model');
    });
    assert.deepEqual(urls, [
      'https://openai-leaf.test/v1/chat/completions',
      'https://anthropic-leaf.test/v1/messages',
      'https://openai-leaf.test/v1/chat/completions',
    ]);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('HTTP classification keeps request-specific 400/413/422 final and counts model-not-found/401 for failover', async t => {
  const originalPost = axios.post;
  try {
    for (const status of [400, 413, 422]) {
      await t.test(`status ${status} is final without failover`, async () => {
        const urls: string[] = [];
        (axios as any).post = async (url: string) => {
          urls.push(url);
          return { status, statusText: 'Bad Request', headers: {}, data: makeRawStream({ error: { message: 'invalid payload' } }) };
        };
        await assert.rejects(() => requestLlmOnce(baseRequest('fastFallback')), LlmRequestError);
        assert.deepEqual(urls, ['https://openai-leaf.test/v1/chat/completions']);
        resetVirtualRoutingStateForTests();
      });
    }

    for (const [status, body] of [
      [400, { error: { code: 'model_not_found', message: 'model not found' } }],
      [401, { error: { message: 'unauthorized' } }],
    ] as const) {
      await t.test(`status ${status} is countable and fails over`, async () => {
        const urls: string[] = [];
        (axios as any).post = async (url: string) => {
          urls.push(url);
          if (urls.length === 1) return { status, statusText: 'Error', headers: {}, data: makeRawStream(body) };
          return { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'B ok' }] } };
        };
        const result = await withImmediateRetryTimers(() => requestLlmOnce(baseRequest('fastFallback')));
        assert.equal(result.modelId, 'anthropicLeaf/claude-model');
        assert.equal(urls.length, 2);
        resetVirtualRoutingStateForTests();
      });
    }
  } finally {
    (axios as any).post = originalPost;
  }
});

test('abort terminates without counting route health', async () => {
  const originalPost = axios.post;
  let calls = 0;
  (axios as any).post = async () => {
    calls += 1;
    if (calls === 1) {
      const error: any = new Error('stopped');
      error.name = 'AbortError';
      error.code = 'ERR_CANCELED';
      throw error;
    }
    return { status: 200, statusText: 'OK', headers: {}, data: makeChatStream('same A') };
  };
  try {
    await assert.rejects(() => requestLlmOnce(baseRequest('fastFallback')), (error: any) => error?.name === 'AbortError');
    const result = await requestLlmOnce(baseRequest('fastFallback'));
    assert.equal(result.modelId, 'openaiLeaf/chat-model');
  } finally {
    (axios as any).post = originalPost;
  }
});

test('empty, whitespace-only, and reasoning-only responses retry while tool calls succeed', async t => {
  const originalPost = axios.post;
  try {
    await t.test('OpenAI Chat retries whitespace and reasoning-only responses', async () => {
      let calls = 0;
      (axios as any).post = async () => {
        calls += 1;
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: calls === 1 ? makeChatStream('   ', { reasoning: 'thinking only' }) : makeChatStream('chat ok'),
        };
      };
      const result = await withImmediateRetryTimers(() => requestLlmOnce(baseRequest('openaiLeaf/chat-model', 2)));
      assert.equal(calls, 2);
      assert.equal(result.text, 'chat ok');
    });

    await t.test('OpenAI Responses retries reasoning-only output', async () => {
      let calls = 0;
      (axios as any).post = async () => {
        calls += 1;
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: calls === 1 ? makeResponsesStream('reasoning') : makeResponsesStream('text'),
        };
      };
      const result = await withImmediateRetryTimers(() => requestLlmOnce(baseRequest('responsesLeaf/responses-model', 2)));
      assert.equal(calls, 2);
      assert.equal(result.text, 'responses ok');
    });

    await t.test('Anthropic retries thinking-only output', async () => {
      let calls = 0;
      (axios as any).post = async () => {
        calls += 1;
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: calls === 1
            ? { content: [{ type: 'thinking', thinking: 'thinking only' }] }
            : { content: [{ type: 'text', text: 'anthropic ok' }] },
        };
      };
      const result = await withImmediateRetryTimers(() => requestLlmOnce(baseRequest('anthropicLeaf/claude-model', 2)));
      assert.equal(calls, 2);
      assert.equal(result.text, 'anthropic ok');
    });

    for (const [model, response] of [
      ['openaiLeaf/chat-model', () => makeChatStream('')],
      ['responsesLeaf/responses-model', () => makeResponsesStream('empty')],
      ['anthropicLeaf/claude-model', () => ({ content: [] as any[] })],
    ] as const) {
      await t.test(`${model} rejects a fully empty response`, async () => {
        (axios as any).post = async () => ({ status: 200, statusText: 'OK', headers: {}, data: response() });
        await assert.rejects(
          () => requestLlmOnce(baseRequest(model, 1)),
          (error: unknown) => error instanceof LlmRequestError && error.kind === 'response-error',
        );
      });
    }

    for (const [model, response] of [
      ['openaiLeaf/chat-model', () => makeChatStream('', { toolCall: true })],
      ['responsesLeaf/responses-model', () => makeResponsesStream('tool')],
      ['anthropicLeaf/claude-model', () => ({ content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { filePath: 'x' } }] })],
    ] as const) {
      await t.test(`${model} accepts tool-call-only output`, async () => {
        let calls = 0;
        (axios as any).post = async () => {
          calls += 1;
          return { status: 200, statusText: 'OK', headers: {}, data: response() };
        };
        const result = await requestLlmOnce(baseRequest(model, 1));
        assert.equal(calls, 1);
        assert.equal(result.toolCalls?.length, 1);
      });
    }
  } finally {
    (axios as any).post = originalPost;
  }
});
