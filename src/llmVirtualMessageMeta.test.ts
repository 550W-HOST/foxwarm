import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import type { Message, Session } from './types';

test('virtual tool-call and final assistant messages retain requested key and successful concrete leaf', async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-virtual-message-meta-'));
  await fs.outputFile(path.join(dataRoot, 'state', 'models.yaml'), `
default: fallback
providers:
  first:
    providerType: anthropic
    baseUrl: https://first-leaf.test
    apiKey: first-secret
    models: [first-model]
  second:
    providerType: anthropic
    baseUrl: https://second-leaf.test
    apiKey: second-secret
    models: [second-model]
  fallback:
    providerType: failover
    targets: [first/first-model, second/second-model]
    failureThreshold: 1
    cooldownMs: 600000
`);

  const previousDataRoot = process.env.FOXWARM_DATA_DIR;
  process.env.FOXWARM_DATA_DIR = dataRoot;
  const originalPost = axios.post;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const requestUrls: string[] = [];

  try {
    const { chat } = await import('./llm');
    (global as any).setTimeout = (callback: (...args: any[]) => void) => {
      queueMicrotask(callback);
      return { __immediate: true };
    };
    (global as any).clearTimeout = () => {};
    (axios as any).post = async (url: string) => {
      requestUrls.push(url);
      if (url.startsWith('https://first-leaf.test')) {
        throw new Error('first leaf unavailable');
      }
      if (requestUrls.length === 2) {
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          data: {
            content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { filePath: 'README.md' } }],
          },
        };
      }
      return {
        status: 200,
        statusText: 'OK',
        headers: {},
        data: { content: [{ type: 'text', text: 'done' }] },
      };
    };

    const history: Message[] = [];
    const session = {
      id: 'virtual-message-meta',
      history,
      persistentMemorySnapshot: '',
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      busy: false,
      queue: [],
      meta: { lastMessageTime: Date.now() },
      model: 'fallback',
    } as Session;
    const appendMessage = async (message: Message) => { history.push(message); };

    const toolResult = await chat([{ text: 'read it' }], session, 0, {
      appendMessage,
      notifySessionEvents: false,
      registerAbortController: false,
    });
    assert.equal(toolResult.toolCalls?.length, 1);
    history.push({
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'call_1', name: 'read', response: { output: 'ok' } } }],
    });
    await chat(null, session, 1, {
      appendMessage,
      notifySessionEvents: false,
      registerAbortController: false,
    });

    assert.deepEqual(requestUrls, [
      'https://first-leaf.test/v1/messages',
      'https://second-leaf.test/v1/messages',
      'https://second-leaf.test/v1/messages',
    ]);
    assert.deepEqual(history.map(message => message.role), ['user', 'model', 'tool', 'model']);
    const assistantMessages = history.filter(message => message.role === 'model');
    assert.equal(assistantMessages[0].__meta?.modelId, 'second/second-model');
    assert.equal(assistantMessages[0].__meta?.virtualModelKey, 'fallback');
    assert.equal(assistantMessages[1].__meta?.modelId, 'second/second-model');
    assert.equal(assistantMessages[1].__meta?.virtualModelKey, 'fallback');
    assert.equal(history[0].__meta?.modelId, undefined);
    assert.equal(history[0].__meta?.virtualModelKey, undefined);
    assert.equal(history[2].__meta?.modelId, undefined);
    assert.equal(history[2].__meta?.virtualModelKey, undefined);
    assert.equal(JSON.stringify(assistantMessages).includes('first/first-model'), false);
  } finally {
    (axios as any).post = originalPost;
    (global as any).setTimeout = originalSetTimeout;
    (global as any).clearTimeout = originalClearTimeout;
    if (previousDataRoot === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previousDataRoot;
    await fs.remove(dataRoot);
  }
});
