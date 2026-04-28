import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { requestLlmOnce, sanitizeProviderRequestPayload } from './llm';
import { containsLoneSurrogate } from './utils/unicode';

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
