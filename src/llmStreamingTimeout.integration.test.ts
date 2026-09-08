import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import axios from 'axios';
import {
  DEFAULT_STREAM_FIRST_CONTENT_TIMEOUT_MS,
  SAFETY_BUFFERING_CONTENT_INACTIVITY_TIMEOUT_MS,
  setStreamingTimeoutTestHooks,
} from './llmStreamingTimeout';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-stream-timeout-'));
fs.ensureDirSync(path.join(dataRoot, 'state'));
fs.writeFileSync(path.join(dataRoot, 'state', 'models.yaml'), `default: fixture/model\nproviders:\n  fixture:\n    providerType: openai-responses\n    baseUrl: https://example.test/v1\n    models: [model]\n`);
process.env.FOXWARM_DATA_DIR = dataRoot;

const llmPromise = import('./llm');
const commonPromise = import('./common');

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

test('SSE safety buffering warns and reaches outer LLM timeout error with bounded metadata', async () => {
  const { requestLlmOnce } = await llmPromise;
  const { logger } = await commonPromise;
  const originalPost = axios.post;
  const originalWarn = (logger as any).warn;
  const warnings: Array<{ fields: any; message: string }> = [];
  (logger as any).warn = (fields: any, message: string) => { warnings.push({ fields, message }); };
  setStreamingTimeoutTestHooks({
    set(callback, delayMs) {
      const handle = { unref() {} };
      if (delayMs === SAFETY_BUFFERING_CONTENT_INACTIVITY_TIMEOUT_MS) process.nextTick(callback);
      return handle;
    },
    clear() {},
  });
  (axios as any).post = async () => {
    const stream = new PassThrough();
    process.nextTick(() => stream.write(`data: ${JSON.stringify({
      type: 'response.metadata', sequence_number: 1,
      metadata: { type: 'safety_buffering', use_cases: ['fixture'], reasons: ['review'], retry_model: 'fixture-model' },
    })}\n\n`));
    return { status: 200, statusText: 'OK', headers: {}, data: stream };
  };
  try {
    await assert.rejects(
      requestLlmOnce({
        contents: [{ role: 'user', parts: [{ text: 'fixture' }] }], systemPrompt: '', model: 'fixture/model',
        promptCacheKey: 'safety-buffering-sse', toolDefinitions: [], notifySessionEvents: false,
        registerAbortController: false, maxRetries: 1,
      }),
      /after 600000ms\. Safety buffering metadata: \{"type":"safety_buffering","use_cases":\["fixture"\],"reasons":\["review"\],"retry_model":"fixture-model"\}/,
    );
    const warning = warnings.find(entry => entry.message === 'OpenAI response entered safety buffering; extending the output inactivity timeout to 600000ms.');
    assert.equal(warning?.fields.purpose, 'low-level');
    assert.deepEqual(warning?.fields.metadata, {
      type: 'safety_buffering', use_cases: ['fixture'], reasons: ['review'], retry_model: 'fixture-model',
    });
  } finally {
    (axios as any).post = originalPost;
    (logger as any).warn = originalWarn;
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

test('real Axios active SSE aborts and watchdog timeouts do not emit uncaught stream errors', async () => {
  const modulePath = path.join(__dirname, 'llm.js');
  const script = `
    const http = require('http');
    const fs = require('fs-extra');
    const os = require('os');
    const path = require('path');
    process.once('uncaughtException', error => { console.error('UNCAUGHT:' + error.stack); process.exit(7); });
    process.once('unhandledRejection', error => { console.error('UNHANDLED:' + (error && error.stack || error)); process.exit(8); });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-active-sse-abort-'));
    fs.ensureDirSync(path.join(root, 'state'));
    process.env.FOXWARM_DATA_DIR = root;
    let mode = '';
    let activeAbort;
    const server = http.createServer((_req, res) => {
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (mode === 'chat-stop') {
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] }) + '\\n\\n');
      } else {
        res.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'r', status: 'in_progress' } }) + '\\n\\n');
      }
      if (mode.endsWith('-stop')) setTimeout(() => activeAbort.abort(), 50);
    });
    const fail = (error, code) => {
      console.error(error && error.stack || error);
      server.closeAllConnections?.();
      server.close();
      fs.removeSync(root);
      process.exit(code);
    };
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      fs.writeFileSync(path.join(root, 'state', 'models.yaml'),
        'default: responses/model\\nproviders:\\n' +
        '  responses:\\n    providerType: openai-responses\\n    baseUrl: http://127.0.0.1:' + port + '/v1\\n    models: [model]\\n' +
        '  chat:\\n    providerType: openai-completions\\n    baseUrl: http://127.0.0.1:' + port + '/v1\\n    models: [model]\\n');
      const { requestLlmOnce } = require(${JSON.stringify(modulePath)});
      const request = (model, extra = {}) => requestLlmOnce({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }], systemPrompt: '', model,
        promptCacheKey: mode, toolDefinitions: [], notifySessionEvents: false, registerAbortController: false,
        maxRetries: 1, ...extra,
      });
      try {
        for (const [nextMode, model] of [['responses-stop', 'responses/model'], ['chat-stop', 'chat/model']]) {
          mode = nextMode;
          activeAbort = new AbortController();
          let stopped = false;
          try { await request(model, { abortSignal: activeAbort.signal }); }
          catch (error) { stopped = error && (error.name === 'CanceledError' || error.name === 'AbortError'); }
          if (!stopped) throw new Error(nextMode + ' did not reject as an ordinary abort');
          await new Promise(resolve => setImmediate(resolve));
        }
        mode = 'responses-timeout';
        let timedOut = false;
        try { await request('responses/model', { timeoutMs: 40 }); }
        catch (error) { timedOut = /explicit caller deadline after 40ms/.test(String(error && error.message)); }
        if (!timedOut) throw new Error('active Responses SSE did not reject with the watchdog timeout');
        await new Promise(resolve => setImmediate(resolve));
        server.closeAllConnections?.();
        server.close();
        fs.removeSync(root);
        process.exit(0);
      } catch (error) { fail(error, 9); }
    });
  `;
  const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn(process.execPath, ['-e', script], { cwd: path.dirname(__dirname) });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('exit', code => resolve({ code, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /UNCAUGHT:|UNHANDLED:/);
});
