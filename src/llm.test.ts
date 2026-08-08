import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PassThrough } from 'node:stream';

import { DEFAULT_LLM_MAX_RETRIES, LlmRequestError, chat, ensurePromptCacheKey, getLlmRetryDelayMs, redactProviderImagesForLog, requestLlmOnce, sanitizeProviderRequestPayload } from './llm';
import { LOGS_DIR } from './config';
import { formatDate } from './logRotation';
import type { Message, Session } from './types';
import { containsLoneSurrogate } from './utils/unicode';
import * as sessionManager from './sessionManager';
import { loadSessionsMetadataSnapshot, readSessionHistorySnapshot } from './session/metadataStore';
import { putImageBlob, resolveImageBlobPath } from './imageBlobs';
import fs from 'fs-extra';
import { reconstructLlmRequest, setLlmRequestJournalFaultInjectorForTests } from './llmRequestJournal';

const PROMPT_CACHE_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
    assert.equal(assistantMessages[0].__meta?.virtualModelKey, undefined);
    assert.equal(assistantMessages[1].__meta?.virtualModelKey, undefined);
    assert.equal(typeof assistantMessages[0].__meta?.llmRequestId, 'string');
    assert.equal(typeof assistantMessages[1].__meta?.llmRequestId, 'string');
    assert.notEqual(assistantMessages[0].__meta?.llmRequestId, assistantMessages[1].__meta?.llmRequestId);
    assert.equal(assistantMessages[0].__meta?.llmAttempt, 1);
    const reconstructed = await reconstructLlmRequest(assistantMessages[1].__meta?.llmRequestId as string);
    assert.equal(reconstructed.completeness, 'complete');
    if (reconstructed.completeness === 'complete') {
      assert.equal(reconstructed.messages.at(-1)?.role, 'tool');
      assert.equal(reconstructed.attempts[0]?.result?.outcome, 'success');
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
