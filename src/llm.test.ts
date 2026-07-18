import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PassThrough } from 'node:stream';

import { DEFAULT_LLM_MAX_RETRIES, LlmRequestError, chat, ensurePromptCacheKey, getLlmRetryDelayMs, requestLlmOnce, sanitizeProviderRequestPayload } from './llm';
import { LOGS_DIR } from './config';
import { formatDate } from './logRotation';
import type { Message, Session } from './types';
import { containsLoneSurrogate } from './utils/unicode';
import * as sessionManager from './sessionManager';
import { loadSessionsMetadataSnapshot, readSessionHistorySnapshot } from './session/metadataStore';

const PROMPT_CACHE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeChatCompletionStream(text = 'ok'): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] })}\n\n`);
    stream.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function createOpenAITestSession(id: string): Session {
  return {
    id,
    history: [],
    persistentMemorySnapshot: 'system prompt',
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
  const createdFiles: string[] = [];
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
    createdFiles.push(...files.filter(file => !beforeFiles.has(file)));
    const responseFile = createdFiles.find(file => file.endsWith('_res.json'));
    assert.ok(responseFile, 'expected response log file');
    const logged = JSON.parse(await fs.readFile(path.join(recentDir, responseFile!), 'utf8'));
    assert.equal(logged.body.choices[0].message.content, 'raw-ok');
    assert.match(logged.rawStream.body, /data: .*raw-ok/);
    assert.ok(logged.rawStream.sseBlocks.some((block: string) => block.includes('raw-ok')));
  } finally {
    (axios as any).post = originalPost;
    await Promise.all(createdFiles.map(file => fs.rm(path.join(recentDir, file), { force: true }).catch(() => {})));
  }
});

test('requestLlmOnce keeps failed raw stream attempts in moved error logs', async () => {
  const originalPost = axios.post;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const recentDir = path.join(LOGS_DIR, 'recent');
  const errorDir = path.join(LOGS_DIR, `${formatDate()}-error`);
  const beforeRecent = new Set<string>();
  const beforeError = new Set<string>();
  let newRecentFiles: string[] = [];
  let newErrorFiles: string[] = [];
  const retryEvents: any[] = [];
  await fs.mkdir(recentDir, { recursive: true });
  await fs.mkdir(errorDir, { recursive: true });
  for (const file of await fs.readdir(recentDir).catch((): string[] => [])) beforeRecent.add(file);
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
    newRecentFiles = (await fs.readdir(recentDir).catch((): string[] => [])).filter(file => !beforeRecent.has(file));
    assert.equal(newRecentFiles.some(file => file.endsWith('_res.json')), false, 'failed response log should move out of recent');
    newErrorFiles = (await fs.readdir(errorDir)).filter(file => !beforeError.has(file));
    const responseFile = newErrorFiles.find(file => file.endsWith('_res.json'));
    assert.ok(responseFile, 'expected moved error response log');
    const logged = JSON.parse(await fs.readFile(path.join(errorDir, responseFile!), 'utf8'));
    assert.match(logged.attempts[0].error, /stream exploded after partial/);
    assert.match(logged.attempts[0].rawStream.body, /partial-before-fail/);
    assert.ok(logged.attempts[0].rawStream.sseBlocks.some((block: string) => block.includes('partial-before-fail')));
  } finally {
    (axios as any).post = originalPost;
    await Promise.all(newRecentFiles.map(file => fs.rm(path.join(recentDir, file), { force: true }).catch(() => {})));
    await Promise.all(newErrorFiles.map(file => fs.rm(path.join(errorDir, file), { force: true }).catch(() => {})));
  }
});

test('requestLlmOnce retries 5 times by default with increasing retry delays', async () => {
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
    assert.deepEqual(retryEvents.map(event => event.nextAttempt), [2, 3, 4, 5]);
    assert.deepEqual(retryEvents.map(event => event.delayMs), [
      getLlmRetryDelayMs(1),
      getLlmRetryDelayMs(2),
      getLlmRetryDelayMs(3),
      getLlmRetryDelayMs(4),
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

test('chat strips session message __meta, including context block metadata, before provider request', async () => {
  const originalPost = axios.post;
  let capturedBody: any = null;
  const session = createOpenAITestSession('context_block_meta_strip_session');
  session.model = 'anthropic/claude-sonnet-4-5';
  session.history.push({
    role: 'model',
    parts: [{ text: '[CTX-BLOCK L1 B#3 raw#1-#2] summary' }],
    __meta: {
      timestamp: 123,
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
    await chat(null, session, 0, {
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
