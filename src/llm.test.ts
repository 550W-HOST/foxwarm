import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PassThrough } from 'node:stream';

import { createDefaultCurrentSessionEffects, CurrentSessionEffects, DEFAULT_LLM_MAX_RETRIES, LlmRequestError, chat, ensurePromptCacheKey, getLlmRetryDelayMs, redactProviderImagesForLog, requestLlmOnce, sanitizeProviderRequestPayload } from './llm';
import { LOGS_DIR } from './config';
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
    }

    for (const effort of efforts) {
      await request('anthropic', effort);
      const body = captured.at(-1)?.body;
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
      { type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
      {
        type: 'web_search',
        search_context_size: 'high',
        filters: { allowed_domains: ['example.com'] },
        user_location: { type: 'approximate', country: 'CN', city: 'Shenzhen' },
      },
    ]);
    assert.equal(capturedBodies[0].tool_choice, 'required');
    assert.deepEqual(capturedBodies[1].tools, [
      { type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    ]);
    assert.equal(capturedBodies[1].tool_choice, 'auto');
    assert.deepEqual(capturedBodies[2].tools, [
      { type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } },
    ]);
    assert.equal(capturedBodies[2].tool_choice, 'auto');
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

test('LocalSessionTurnHost executes detached read and set_goal without global source-session lookup', async () => {
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
      { id: 'detached-goal', name: 'set_goal', args: { goal: 'Keep detached ownership', remindEvery: 7 } },
      { id: 'detached-read', name: 'read', args: { filePath } },
    ], { sessionId: session.id, session }, session);
    assert.deepEqual(session.goalState && {
      goal: session.goalState.goal,
      remindEvery: session.goalState.remindEvery,
      anchorSeq: session.goalState.anchorSeq,
    }, { goal: 'Keep detached ownership', remindEvery: 7, anchorSeq: 0 });
    assert.equal(persisted, 1);
    assert.deepEqual(message.parts[0].functionResponse?.response, { output: 'ok' });
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
