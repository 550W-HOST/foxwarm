import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PassThrough } from 'node:stream';

import { chat, ensurePromptCacheKey, requestLlmOnce, sanitizeProviderRequestPayload } from './llm';
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

test('chat stores each model request usage on its assistant message metadata', async () => {
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
