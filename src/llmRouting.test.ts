import test from 'node:test';
import assert from 'node:assert/strict';
import { getOpenAIRequestApi } from './llm';

test('getOpenAIRequestApi routes openai providers to Responses API', () => {
  assert.equal(getOpenAIRequestApi('openai'), 'responses');
  assert.equal(getOpenAIRequestApi('openai-responses'), 'responses');
});

test('getOpenAIRequestApi routes openai-completions to chat/completions', () => {
  assert.equal(getOpenAIRequestApi('openai-completions'), 'chat-completions');
});

test('getOpenAIRequestApi ignores non-openai providers', () => {
  assert.equal(getOpenAIRequestApi('anthropic'), null);
  assert.equal(getOpenAIRequestApi(''), null);
});