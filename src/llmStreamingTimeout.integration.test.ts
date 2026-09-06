import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import axios from 'axios';
import { DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS, setStreamingTimeoutTestHooks } from './llmStreamingTimeout';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-stream-timeout-'));
fs.ensureDirSync(path.join(dataRoot, 'state'));
fs.writeFileSync(path.join(dataRoot, 'state', 'models.yaml'), `default: fixture/model\nproviders:\n  fixture:\n    providerType: openai-responses\n    baseUrl: https://example.test/v1\n    models: [model]\n`);
process.env.FOXWARM_DATA_DIR = dataRoot;

const llmPromise = import('./llm');

function responsesStream(): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } })}\n\n`);
    stream.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'ok' })}\n\n`);
    stream.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'r2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } })}\n\n`);
    stream.end();
  });
  return stream;
}

after(() => {
  setStreamingTimeoutTestHooks();
  fs.removeSync(dataRoot);
  delete process.env.FOXWARM_DATA_DIR;
});

test('stream timeout aborts only one SSE attempt and normal outer retry succeeds with notifications disabled', async () => {
  const { requestLlmOnce } = await llmPromise;
  const originalPost = axios.post;
  let scheduledFirstContent = 0;
  setStreamingTimeoutTestHooks({
    set(callback, delayMs) {
      const handle = { unref() {} };
      if (delayMs === DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS && scheduledFirstContent++ === 0) {
        process.nextTick(callback);
      }
      return handle;
    },
    clear() {},
  });
  const configs: any[] = [];
  let calls = 0;
  (axios as any).post = async (_url: string, _data: any, config: any) => {
    configs.push(config);
    calls += 1;
    if (calls === 1) {
      return await new Promise((_resolve, reject) => {
        const fail = () => {
          const error: any = new Error('attempt canceled');
          error.name = 'CanceledError';
          error.code = 'ERR_CANCELED';
          reject(error);
        };
        if (config.signal.aborted) fail();
        else config.signal.addEventListener('abort', fail, { once: true });
      });
    }
    return { status: 200, statusText: 'OK', headers: {}, data: responsesStream() };
  };
  try {
    const result = await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemPrompt: '', model: 'fixture/model', promptCacheKey: 'stream-timeout',
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      maxRetries: 2,
    });
    assert.equal(result.text, 'ok');
    assert.equal(calls, 2);
    assert.equal(configs[0].timeout, 0);
    assert.equal(configs[1].timeout, 0);
    assert.notEqual(configs[0].signal, configs[1].signal);
  } finally {
    (axios as any).post = originalPost;
    setStreamingTimeoutTestHooks();
  }
});

test('nonstreaming requests retain five-minute default and honor explicit timeout override', async () => {
  const { requestLlmOnce } = await llmPromise;
  const originalPost = axios.post;
  const timeouts: number[] = [];
  (axios as any).post = async (_url: string, _data: any, config: any) => {
    timeouts.push(config.timeout);
    return { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'ok' }] } };
  };
  const modelEntryOverride = {
    providerKey: 'fixture', providerType: 'anthropic', baseUrl: 'https://example.test', apiKey: '',
    model: 'model', extraFields: {}, extraHeaders: {},
  } as any;
  try {
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'default' }] }], systemPrompt: '', modelEntryOverride,
      promptCacheKey: 'nonstream-default', toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
    });
    await requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'explicit' }] }], systemPrompt: '', modelEntryOverride,
      promptCacheKey: 'nonstream-explicit', toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      timeoutMs: 7_000,
    });
    assert.deepEqual(timeouts, [300_000, 7_000]);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('explicit streaming timeout remains a hard attempt bound and Stop remains an ordinary abort', async () => {
  const { requestLlmOnce } = await llmPromise;
  const originalPost = axios.post;
  const stall = async (_url: string, _data: any, config: any) => await new Promise((_resolve, reject) => {
    const fail = () => {
      const error: any = new Error('attempt canceled');
      error.name = 'CanceledError';
      error.code = 'ERR_CANCELED';
      reject(error);
    };
    if (config.signal.aborted) fail();
    else config.signal.addEventListener('abort', fail, { once: true });
  });
  (axios as any).post = stall;
  try {
    setStreamingTimeoutTestHooks({
      set(callback, delayMs) {
        const handle = { unref() {} };
        if (delayMs === 7_000) process.nextTick(callback);
        return handle;
      },
      clear() {},
    });
    await assert.rejects(
      requestLlmOnce({
        contents: [{ role: 'user', parts: [{ text: 'hard bound' }] }], systemPrompt: '', model: 'fixture/model',
        promptCacheKey: 'hard-bound', toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
        timeoutMs: 7_000, maxRetries: 1,
      }),
      /explicit caller deadline after 7000ms/,
    );

    setStreamingTimeoutTestHooks({ set: () => ({ unref() {} }), clear() {} });
    const controller = new AbortController();
    const stopped = requestLlmOnce({
      contents: [{ role: 'user', parts: [{ text: 'stop' }] }], systemPrompt: '', model: 'fixture/model',
      promptCacheKey: 'stop', toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
      abortSignal: controller.signal, maxRetries: 1,
    });
    process.nextTick(() => controller.abort());
    await assert.rejects(stopped, (error: any) => error?.name === 'CanceledError' && error?.code === 'ERR_CANCELED');
  } finally {
    (axios as any).post = originalPost;
    setStreamingTimeoutTestHooks();
  }
});
