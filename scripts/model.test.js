#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CliUsageError, parseArgs, runModelCli } = require('./model.js');
const { run } = require('./foxwarm.js');

function captureStream() {
  let value = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    },
  });
  return { stream, value: () => value };
}

function runtime(overrides = {}) {
  return {
    loadModelsConfig: () => ({
      default: 'provider/model',
      displayModels: ['provider/model'],
      models: {
        'provider/model': {
          providerType: 'openai',
          model: 'model',
          baseUrl: 'https://example.invalid/v1',
        },
      },
    }),
    requestLlmOnce: async options => ({ text: 'ok', modelId: options.model, usage: null }),
    ...overrides,
  };
}

test('parseArgs rejects unknown options, missing values, and invalid timeouts', () => {
  assert.throws(() => parseArgs(['--wat']), error => error instanceof CliUsageError && /Unknown/.test(error.message));
  assert.throws(() => parseArgs(['--model']), error => error instanceof CliUsageError && /requires a value/.test(error.message));
  assert.throws(() => parseArgs(['--timeout', 'NaN']), error => error instanceof CliUsageError && /positive number/.test(error.message));
  assert.throws(() => parseArgs(['--timeout', '-1']), error => error instanceof CliUsageError && /requires a value/.test(error.message));
});

test('model CLI forwards the prompt and options to the production request API contract', async () => {
  const output = captureStream();
  let captured;
  const exitCode = await runModelCli(
    ['--model', 'provider/model', '--system', 'system', '--timeout', '7', '--prompt', 'hello', '--json'],
    {
      stdout: output.stream,
      runtimeLoader: () => runtime({
        requestLlmOnce: async options => {
          captured = options;
          return { text: 'answer', modelId: 'provider/model', usage: { inputTokens: 1, outputTokens: 2 } };
        },
      }),
    },
  );

  assert.equal(exitCode, 0);
  assert.equal(captured.model, 'provider/model');
  assert.equal(captured.systemPrompt, 'system');
  assert.equal(captured.timeoutMs, 7000);
  assert.deepEqual(captured.contents, [{ role: 'user', parts: [{ text: 'hello' }] }]);
  assert.deepEqual(captured.toolDefinitions, []);
  assert.equal(JSON.parse(output.value()).text, 'answer');
});

test('model CLI reads stdin and rejects unknown model keys and empty responses', async () => {
  const stdin = new PassThrough();
  stdin.end('from stdin');
  const output = captureStream();
  assert.equal(await runModelCli([], { stdin, stdout: output.stream, runtimeLoader: () => runtime() }), 0);
  assert.equal(output.value(), 'ok\n');

  await assert.rejects(
    () => runModelCli(['--model', 'missing', '--prompt', 'x'], { runtimeLoader: () => runtime() }),
    error => error instanceof CliUsageError && /Unknown model key/.test(error.message),
  );
  await assert.rejects(
    () => runModelCli(['--prompt', 'x'], {
      runtimeLoader: () => runtime({ requestLlmOnce: async () => ({ text: '' }) }),
    }),
    /empty text response/,
  );
});

test('top-level CLI returns nonzero for unknown subcommands without spawning a child', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  assert.equal(await run(['unknown'], { stdout: stdout.stream, stderr: stderr.stream }), 2);
  assert.match(stderr.value(), /Unknown subcommand/);
});

test('built CLI uses production openai routing and Responses request formatting', async t => {
  const libLlm = path.join(__dirname, '..', 'lib', 'llm.js');
  if (!fs.existsSync(libLlm)) {
    t.skip('run npm run build before this integration test');
    return;
  }

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-model-cli-'));
  fs.mkdirSync(path.join(dataRoot, 'state'), { recursive: true });
  let requestPath = '';
  let requestBody = null;
  const server = http.createServer((request, response) => {
    requestPath = request.url;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'route-ok' },
        { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'route-ok' },
        { type: 'response.completed', response: { id: 'resp_test', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
      ];
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  fs.writeFileSync(path.join(dataRoot, 'state', 'models.yaml'), `default: test/model\nproviders:\n  test:\n    providerType: openai\n    baseUrl: http://127.0.0.1:${port}\n    models: [model]\n`);

  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'foxwarm.js'), 'model', '--prompt', 'hello', '--timeout', '5'], {
      env: { ...process.env, FOXWARM_DATA_DIR: dataRoot, FOXWARM_NO_CONSOLE_LOG: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    assert.equal(stdout.trim(), 'route-ok');
    assert.equal(requestPath, '/responses');
    assert.equal(requestBody.stream, true);
    assert.equal(requestBody.instructions, '');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
